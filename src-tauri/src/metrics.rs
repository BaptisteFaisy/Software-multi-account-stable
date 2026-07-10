use crate::terminal::TerminalManager;
use chrono::{Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;

static USAGE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageStore {
    #[serde(default)]
    days: BTreeMap<String, UsageDay>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageDay {
    #[serde(default)]
    agent_run_seconds: u64,
    #[serde(default)]
    agent_runs: u64,
    #[serde(default)]
    api_requests: u64,
    #[serde(default)]
    api_errors: u64,
    #[serde(default)]
    api_seconds: u64,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    cached_input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
    #[serde(default)]
    estimated_requests: u64,
    #[serde(default)]
    cost_usd: f64,
    #[serde(default)]
    last_updated: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDashboard {
    generated_at: i64,
    total_agent_seconds: u64,
    total_agent_runs: u64,
    active_agent_count: usize,
    total_api_requests: u64,
    total_api_errors: u64,
    total_tokens: u64,
    total_cost_usd: f64,
    today: UsageDayView,
    days: Vec<UsageDayView>,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDayView {
    date: String,
    agent_run_seconds: u64,
    agent_runs: u64,
    api_requests: u64,
    api_errors: u64,
    api_seconds: u64,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
    estimated_requests: u64,
    cost_usd: f64,
}

#[derive(Debug, Clone)]
pub struct ActiveAgentRun {
    pub started_at: i64,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

impl TokenUsage {
    pub fn estimated(input_tokens: u64, output_tokens: u64) -> Self {
        TokenUsage {
            input_tokens,
            cached_input_tokens: 0,
            output_tokens,
            total_tokens: input_tokens.saturating_add(output_tokens),
        }
    }

    fn normalized(mut self) -> Self {
        if self.total_tokens == 0 {
            self.total_tokens = self.input_tokens.saturating_add(self.output_tokens);
        }
        self.cached_input_tokens = self.cached_input_tokens.min(self.input_tokens);
        self
    }
}

#[derive(Debug, Clone)]
pub struct ApiUsageRecord {
    pub model: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub status_code: u16,
    pub usage: TokenUsage,
    pub tokens_estimated: bool,
}

struct ModelRates {
    input_per_million: f64,
    cached_input_per_million: f64,
    output_per_million: f64,
}

#[tauri::command]
pub fn usage_dashboard(terminal: State<'_, TerminalManager>) -> Result<UsageDashboard, String> {
    load_usage_dashboard(terminal.inner().active_agent_runs())
}

pub fn usage_dashboard_for_server(
    active_runs: Vec<ActiveAgentRun>,
) -> Result<UsageDashboard, String> {
    load_usage_dashboard(active_runs)
}

pub fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

pub fn record_agent_run(
    _account_id: &str,
    _account_label: &str,
    started_at: i64,
    ended_at: i64,
) -> Result<(), String> {
    if ended_at <= started_at {
        return Ok(());
    }

    update_store(|store| {
        let day = store.days.entry(day_key(started_at)).or_default();
        day.agent_runs = day.agent_runs.saturating_add(1);
        day.agent_run_seconds = day
            .agent_run_seconds
            .saturating_add((ended_at - started_at) as u64);
        day.last_updated = ended_at;
    })
}

/// Coût estimé en USD pour une consommation de tokens sur un modèle donné.
/// `cached_input_tokens` est traité comme un sous-ensemble de `input_tokens`
/// (facturé au tarif cache), et `output_tokens` inclut déjà les tokens de
/// raisonnement. Réutilisé par le suivi d'usage global (pool) et par compte
/// (rollouts Codex).
pub fn cost_for_usage(
    model: &str,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
) -> f64 {
    let rates = rates_for_model(model);
    let cached = cached_input_tokens.min(input_tokens);
    let billable_input = input_tokens.saturating_sub(cached);
    (billable_input as f64 * rates.input_per_million
        + cached as f64 * rates.cached_input_per_million
        + output_tokens as f64 * rates.output_per_million)
        / 1_000_000.0
}

pub fn record_api_usage(record: ApiUsageRecord) -> Result<(), String> {
    let usage = record.usage.normalized();
    let cost_usd = cost_for_usage(
        &record.model,
        usage.input_tokens,
        usage.cached_input_tokens,
        usage.output_tokens,
    );

    update_store(|store| {
        let day = store.days.entry(day_key(record.started_at)).or_default();
        day.api_requests = day.api_requests.saturating_add(1);
        if record.status_code >= 400 {
            day.api_errors = day.api_errors.saturating_add(1);
        }
        day.api_seconds = day
            .api_seconds
            .saturating_add(record.ended_at.saturating_sub(record.started_at) as u64);
        day.input_tokens = day.input_tokens.saturating_add(usage.input_tokens);
        day.cached_input_tokens = day
            .cached_input_tokens
            .saturating_add(usage.cached_input_tokens);
        day.output_tokens = day.output_tokens.saturating_add(usage.output_tokens);
        day.total_tokens = day.total_tokens.saturating_add(usage.total_tokens);
        if record.tokens_estimated {
            day.estimated_requests = day.estimated_requests.saturating_add(1);
        }
        day.cost_usd += cost_usd;
        day.last_updated = record.ended_at;
    })
}

pub fn extract_token_usage(value: &serde_json::Value) -> Option<TokenUsage> {
    let usage = value.get("usage").or_else(|| {
        value
            .get("response")
            .and_then(|response| response.get("usage"))
    })?;

    let input_tokens = number_at_any(usage, &["input_tokens", "prompt_tokens"]);
    let output_tokens = number_at_any(usage, &["output_tokens", "completion_tokens"]);
    let total_tokens = number_at_any(usage, &["total_tokens"]);
    let cached_input_tokens = nested_number_at_any(
        usage,
        &[
            &["input_tokens_details", "cached_tokens"],
            &["prompt_tokens_details", "cached_tokens"],
            &["cached_input_tokens"],
        ],
    );

    if input_tokens == 0 && output_tokens == 0 && total_tokens == 0 {
        return None;
    }

    Some(
        TokenUsage {
            input_tokens,
            cached_input_tokens,
            output_tokens,
            total_tokens,
        }
        .normalized(),
    )
}

pub fn estimate_text_tokens(text: &str) -> u64 {
    let chars = text.chars().count() as u64;
    if chars == 0 {
        0
    } else {
        (chars + 3) / 4
    }
}

fn load_usage_dashboard(active_runs: Vec<ActiveAgentRun>) -> Result<UsageDashboard, String> {
    let _guard = usage_lock()
        .lock()
        .map_err(|_| "usage verrouille".to_string())?;
    let store = read_store(&usage_path()?)?;
    let now = now_ts();
    let today_key = day_key(now);
    let mut days = store.days;

    {
        let today = days.entry(today_key.clone()).or_default();
        for run in &active_runs {
            let seconds = now.saturating_sub(run.started_at) as u64;
            today.agent_run_seconds = today.agent_run_seconds.saturating_add(seconds);
            today.agent_runs = today.agent_runs.saturating_add(1);
        }
    }

    let today = days
        .get(&today_key)
        .map(|day| day_view(&today_key, day))
        .unwrap_or_else(|| UsageDayView {
            date: today_key,
            ..UsageDayView::default()
        });

    let day_views = month_to_date_days(&days, now);
    let total_agent_seconds = day_views.iter().map(|day| day.agent_run_seconds).sum();
    let total_agent_runs = day_views.iter().map(|day| day.agent_runs).sum();
    let total_api_requests = day_views.iter().map(|day| day.api_requests).sum();
    let total_api_errors = day_views.iter().map(|day| day.api_errors).sum();
    let total_tokens = day_views.iter().map(|day| day.total_tokens).sum();
    let total_cost_usd = day_views.iter().map(|day| day.cost_usd).sum();

    Ok(UsageDashboard {
        generated_at: now,
        total_agent_seconds,
        total_agent_runs,
        active_agent_count: active_runs.len(),
        total_api_requests,
        total_api_errors,
        total_tokens,
        total_cost_usd,
        today,
        days: day_views,
    })
}

fn day_view(date: &str, day: &UsageDay) -> UsageDayView {
    UsageDayView {
        date: date.to_string(),
        agent_run_seconds: day.agent_run_seconds,
        agent_runs: day.agent_runs,
        api_requests: day.api_requests,
        api_errors: day.api_errors,
        api_seconds: day.api_seconds,
        input_tokens: day.input_tokens,
        cached_input_tokens: day.cached_input_tokens,
        output_tokens: day.output_tokens,
        total_tokens: day.total_tokens,
        estimated_requests: day.estimated_requests,
        cost_usd: day.cost_usd,
    }
}

fn month_to_date_days(days: &BTreeMap<String, UsageDay>, now: i64) -> Vec<UsageDayView> {
    let local_now = Local
        .timestamp_opt(now, 0)
        .single()
        .unwrap_or_else(Local::now);
    let year = local_now.year();
    let month = local_now.month();
    let today = local_now.day();

    (1..=today)
        .map(|day| {
            let date = format!("{year:04}-{month:02}-{day:02}");
            days.get(&date)
                .map(|usage_day| day_view(&date, usage_day))
                .unwrap_or_else(|| UsageDayView {
                    date,
                    ..UsageDayView::default()
                })
        })
        .collect()
}

fn update_store(mut update: impl FnMut(&mut UsageStore)) -> Result<(), String> {
    let _guard = usage_lock()
        .lock()
        .map_err(|_| "usage verrouille".to_string())?;
    let path = usage_path()?;
    let mut store = read_store(&path)?;
    update(&mut store);
    write_store(&path, &store)
}

fn read_store(path: &Path) -> Result<UsageStore, String> {
    if !path.exists() {
        return Ok(UsageStore::default());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str::<UsageStore>(&content).map_err(|error| error.to_string())
}

fn write_store(path: &Path, store: &UsageStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn usage_lock() -> &'static Mutex<()> {
    USAGE_LOCK.get_or_init(|| Mutex::new(()))
}

fn usage_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("usage.json"))
}

fn app_config_dir() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("CST_DATA_DIR") {
        return Ok(PathBuf::from(value).join("logs"));
    }

    let base = if let Some(value) = env::var_os("APPDATA") {
        PathBuf::from(value)
    } else if let Some(value) = env::var_os("XDG_CONFIG_HOME") {
        PathBuf::from(value)
    } else {
        home_dir()?.join(".config")
    };

    Ok(base.join("codex-switch-terminal"))
}

fn home_dir() -> Result<PathBuf, String> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "Impossible de trouver le dossier utilisateur".to_string())
}

fn day_key(timestamp: i64) -> String {
    Local
        .timestamp_opt(timestamp, 0)
        .single()
        .unwrap_or_else(Local::now)
        .format("%Y-%m-%d")
        .to_string()
}

fn rates_for_model(model: &str) -> ModelRates {
    let lower = model.to_ascii_lowercase();
    if lower.contains("codex") {
        return ModelRates {
            input_per_million: 1.75,
            cached_input_per_million: 0.175,
            output_per_million: 14.0,
        };
    }

    if lower.contains("chat-latest") {
        return ModelRates {
            input_per_million: 5.0,
            cached_input_per_million: 0.5,
            output_per_million: 30.0,
        };
    }

    ModelRates {
        input_per_million: 2.5,
        cached_input_per_million: 0.25,
        output_per_million: 15.0,
    }
}

fn number_at_any(value: &serde_json::Value, keys: &[&str]) -> u64 {
    for key in keys {
        if let Some(number) = value.get(*key).and_then(json_u64) {
            return number;
        }
    }
    0
}

fn nested_number_at_any(value: &serde_json::Value, paths: &[&[&str]]) -> u64 {
    for path in paths {
        let mut current = value;
        let mut found = true;
        for key in *path {
            match current.get(*key) {
                Some(next) => current = next,
                None => {
                    found = false;
                    break;
                }
            }
        }
        if found {
            if let Some(number) = json_u64(current) {
                return number;
            }
        }
    }
    0
}

fn json_u64(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
        .or_else(|| value.as_f64().map(|number| number.max(0.0) as u64))
}
