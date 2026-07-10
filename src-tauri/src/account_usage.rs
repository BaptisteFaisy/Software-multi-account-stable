//! Suivi de la consommation de tokens **par compte**, reconstruite à partir des
//! logs de session que le CLI Codex écrit dans `CODEX_HOME/sessions/AAAA/MM/JJ/
//! rollout-*.jsonl`.
//!
//! Contrairement au dashboard global (`metrics.rs`) qui ne voit que le trafic
//! transitant par le pool, cette source fonctionne pour **tous** les comptes,
//! y compris ceux utilisés interactivement via `codex login` : chaque compte a
//! son propre `CODEX_HOME`, donc les rollouts sont naturellement partitionnés
//! par compte.
//!
//! Format d'un événement pertinent (JSONL, une ligne = un événement) :
//! ```json
//! {"timestamp":"2026-07-08T19:20:14.673Z","type":"event_msg",
//!  "payload":{"type":"token_count","info":{
//!     "total_token_usage":{"input_tokens":..,"cached_input_tokens":..,
//!         "output_tokens":..,"reasoning_output_tokens":..,"total_tokens":..},
//!     "last_token_usage":{..}}}}
//! ```
//! `total_token_usage` est **cumulatif** sur la session : le dernier événement
//! `token_count` du fichier donne le total final de la session. Le modèle est
//! lu dans les événements `turn_context` (`payload.model`).

use crate::metrics;
use crate::settings::{self, expand_home, AccountProfile, AppSettings};
use chrono::{Local, TimeZone};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    thread,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageDashboard {
    pub generated_at: i64,
    pub total_tokens: u64,
    pub total_cost_usd: f64,
    pub total_sessions: u64,
    pub accounts: Vec<AccountUsageView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageView {
    pub id: String,
    pub label: String,
    pub codex_home: String,
    pub has_tokens: bool,
    pub session_count: u64,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub today_tokens: u64,
    pub today_cost_usd: f64,
    pub month_tokens: u64,
    pub month_cost_usd: f64,
    pub first_activity: Option<i64>,
    pub last_activity: Option<i64>,
    pub days: Vec<AccountUsageDay>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageDay {
    pub date: String,
    pub sessions: u64,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
}

const MAX_DAYS_RETURNED: usize = 60;

#[tauri::command]
pub async fn account_token_usage() -> Result<AccountUsageDashboard, String> {
    let settings = settings::load_settings_for_terminal()?;
    tauri::async_runtime::spawn_blocking(move || build_dashboard(&settings))
        .await
        .map_err(|error| error.to_string())
}

pub fn account_token_usage_dashboard() -> Result<AccountUsageDashboard, String> {
    let settings = settings::load_settings_for_terminal()?;
    Ok(build_dashboard(&settings))
}

fn build_dashboard(settings: &AppSettings) -> AccountUsageDashboard {
    let default_model = settings.pool.default_model.clone();

    // Un thread par compte : le scan des rollouts est purement I/O disque et
    // indépendant d'un compte à l'autre (cf. `account_limit_views`).
    let handles = settings
        .accounts
        .iter()
        .cloned()
        .map(|account| {
            let default_model = default_model.clone();
            thread::spawn(move || account_usage_view(&account, &default_model))
        })
        .collect::<Vec<_>>();

    let mut accounts = handles
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .collect::<Vec<_>>();

    accounts.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));

    let total_tokens = accounts.iter().map(|a| a.total_tokens).sum();
    let total_cost_usd = accounts.iter().map(|a| a.cost_usd).sum();
    let total_sessions = accounts.iter().map(|a| a.session_count).sum();

    AccountUsageDashboard {
        generated_at: metrics::now_ts(),
        total_tokens,
        total_cost_usd,
        total_sessions,
        accounts,
    }
}

#[derive(Default, Clone, Copy)]
struct TokenTotals {
    input: u64,
    cached: u64,
    output: u64,
    reasoning: u64,
    total: u64,
}

impl TokenTotals {
    fn add(&mut self, other: &TokenTotals) {
        self.input = self.input.saturating_add(other.input);
        self.cached = self.cached.saturating_add(other.cached);
        self.output = self.output.saturating_add(other.output);
        self.reasoning = self.reasoning.saturating_add(other.reasoning);
        self.total = self.total.saturating_add(other.total);
    }
}

#[derive(Default)]
struct DayAgg {
    totals: TokenTotals,
    cost: f64,
    sessions: u64,
}

/// Résultat du scan d'un seul fichier rollout (une session).
struct SessionUsage {
    day: String,
    totals: TokenTotals,
    cost: f64,
    ts: Option<i64>,
}

fn account_usage_view(account: &AccountProfile, default_model: &str) -> AccountUsageView {
    let has_tokens = settings::account_has_auth_tokens(account);

    let sessions_dir = match expand_home(&account.codex_home) {
        Ok(home) => home.join("sessions"),
        Err(error) => return error_view(account, has_tokens, error),
    };

    let mut files = Vec::new();
    if sessions_dir.is_dir() {
        collect_rollouts(&sessions_dir, &mut files);
    }

    let mut all_time = TokenTotals::default();
    let mut total_cost = 0.0_f64;
    let mut session_count = 0_u64;
    let mut first_activity: Option<i64> = None;
    let mut last_activity: Option<i64> = None;
    let mut per_day: BTreeMap<String, DayAgg> = BTreeMap::new();

    for file in &files {
        let Some(session) = scan_rollout_file(file, default_model) else {
            continue;
        };

        session_count += 1;
        all_time.add(&session.totals);
        total_cost += session.cost;

        if let Some(ts) = session.ts {
            first_activity = Some(first_activity.map_or(ts, |current| current.min(ts)));
            last_activity = Some(last_activity.map_or(ts, |current| current.max(ts)));
        }

        let entry = per_day.entry(session.day.clone()).or_default();
        entry.totals.add(&session.totals);
        entry.cost += session.cost;
        entry.sessions += 1;
    }

    let today = Local::now().format("%Y-%m-%d").to_string();
    let month_prefix = today.get(0..7).unwrap_or("").to_string();

    let mut today_tokens = 0_u64;
    let mut today_cost = 0.0_f64;
    let mut month_tokens = 0_u64;
    let mut month_cost = 0.0_f64;
    for (date, agg) in &per_day {
        if date == &today {
            today_tokens = today_tokens.saturating_add(agg.totals.total);
            today_cost += agg.cost;
        }
        if !month_prefix.is_empty() && date.starts_with(&month_prefix) {
            month_tokens = month_tokens.saturating_add(agg.totals.total);
            month_cost += agg.cost;
        }
    }

    let mut days = per_day
        .into_iter()
        .map(|(date, agg)| AccountUsageDay {
            date,
            sessions: agg.sessions,
            input_tokens: agg.totals.input,
            cached_input_tokens: agg.totals.cached,
            output_tokens: agg.totals.output,
            reasoning_output_tokens: agg.totals.reasoning,
            total_tokens: agg.totals.total,
            cost_usd: agg.cost,
        })
        .collect::<Vec<_>>();
    // Trié par date croissante (BTreeMap) ; on ne renvoie que les plus récents.
    if days.len() > MAX_DAYS_RETURNED {
        days.drain(0..days.len() - MAX_DAYS_RETURNED);
    }

    AccountUsageView {
        id: account.id.clone(),
        label: account.label.clone(),
        codex_home: account.codex_home.clone(),
        has_tokens,
        session_count,
        input_tokens: all_time.input,
        cached_input_tokens: all_time.cached,
        output_tokens: all_time.output,
        reasoning_output_tokens: all_time.reasoning,
        total_tokens: all_time.total,
        cost_usd: total_cost,
        today_tokens,
        today_cost_usd: today_cost,
        month_tokens,
        month_cost_usd: month_cost,
        first_activity,
        last_activity,
        days,
        error: None,
    }
}

fn error_view(account: &AccountProfile, has_tokens: bool, error: String) -> AccountUsageView {
    AccountUsageView {
        id: account.id.clone(),
        label: account.label.clone(),
        codex_home: account.codex_home.clone(),
        has_tokens,
        session_count: 0,
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
        cost_usd: 0.0,
        today_tokens: 0,
        today_cost_usd: 0.0,
        month_tokens: 0,
        month_cost_usd: 0.0,
        first_activity: None,
        last_activity: None,
        days: Vec::new(),
        error: Some(error),
    }
}

pub(crate) fn collect_rollouts(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollouts(&path, out);
        } else if is_rollout_file(&path) {
            out.push(path);
        }
    }
}

pub(crate) fn is_rollout_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        .unwrap_or(false)
}

/// Lit un rollout et renvoie l'usage final de la session (dernier
/// `total_token_usage`), le modèle (dernier `turn_context`) et l'horodatage du
/// dernier événement `token_count`. Renvoie `None` si aucun `token_count`
/// n'est présent (session avortée / sans échange).
fn scan_rollout_file(path: &Path, default_model: &str) -> Option<SessionUsage> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut model: Option<String> = None;
    let mut final_totals: Option<TokenTotals> = None;
    let mut final_ts: Option<i64> = None;

    let mut buffer = String::new();
    let mut handle = reader;
    loop {
        buffer.clear();
        // Lecture ligne par ligne : les lignes de messages peuvent être très
        // volumineuses, mais on ne parse en JSON que les petites lignes
        // `turn_context` / `token_count` (filtre `contains` peu coûteux).
        match handle.read_line(&mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }

        if buffer.contains("\"type\":\"turn_context\"") {
            if let Ok(value) = serde_json::from_str::<Value>(buffer.trim_end()) {
                if let Some(found) = value
                    .pointer("/payload/model")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    model = Some(found.to_string());
                }
            }
            continue;
        }

        if buffer.contains("\"type\":\"token_count\"") {
            if let Ok(value) = serde_json::from_str::<Value>(buffer.trim_end()) {
                if let Some(usage) = value.pointer("/payload/info/total_token_usage") {
                    final_totals = Some(parse_totals(usage));
                    if let Some(ts) = value
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .and_then(parse_rfc3339_to_unix)
                    {
                        final_ts = Some(ts);
                    }
                }
            }
        }
    }

    let totals = final_totals?;
    let model = model.unwrap_or_else(|| default_model.to_string());
    let cost = metrics::cost_for_usage(&model, totals.input, totals.cached, totals.output);
    let day = day_from_rollout_name(path)
        .or_else(|| final_ts.map(local_day))
        .unwrap_or_else(|| "inconnu".to_string());

    Some(SessionUsage {
        day,
        totals,
        cost,
        ts: final_ts,
    })
}

fn parse_totals(value: &Value) -> TokenTotals {
    let input = u64_at(value, "input_tokens");
    let cached = u64_at(value, "cached_input_tokens");
    let output = u64_at(value, "output_tokens");
    let reasoning = u64_at(value, "reasoning_output_tokens");
    let total_raw = u64_at(value, "total_tokens");
    let total = if total_raw == 0 {
        input.saturating_add(output)
    } else {
        total_raw
    };

    TokenTotals {
        input,
        cached,
        output,
        reasoning,
        total,
    }
}

fn u64_at(value: &Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(|item| {
            item.as_u64()
                .or_else(|| item.as_i64().and_then(|number| u64::try_from(number).ok()))
                .or_else(|| item.as_f64().map(|number| number.max(0.0) as u64))
        })
        .unwrap_or(0)
}

/// Le nom de fichier `rollout-2026-07-08T21-19-10-<uuid>.jsonl` encode l'heure
/// de début **locale**, ce qui donne directement le bon jour pour le
/// regroupement (pas de conversion de fuseau à faire).
fn day_from_rollout_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let rest = name.strip_prefix("rollout-")?;
    let date = rest.get(0..10)?;
    let bytes = date.as_bytes();
    if bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        Some(date.to_string())
    } else {
        None
    }
}

fn parse_rfc3339_to_unix(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|datetime| datetime.timestamp())
}

fn local_day(ts: i64) -> String {
    Local
        .timestamp_opt(ts, 0)
        .single()
        .unwrap_or_else(Local::now)
        .format("%Y-%m-%d")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn fresh_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("cst-usage-{}-{}", std::process::id(), n));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn day_from_rollout_name_extracts_local_date() {
        assert_eq!(
            day_from_rollout_name(Path::new("x/rollout-2026-07-08T21-19-10-uuid.jsonl")).as_deref(),
            Some("2026-07-08")
        );
        assert_eq!(day_from_rollout_name(Path::new("rollout-bad.jsonl")), None);
        assert_eq!(day_from_rollout_name(Path::new("notarollout.jsonl")), None);
    }

    #[test]
    fn parse_totals_falls_back_to_input_plus_output() {
        let value: Value =
            serde_json::from_str(r#"{"input_tokens":100,"output_tokens":10}"#).unwrap();
        let totals = parse_totals(&value);
        assert_eq!(totals.input, 100);
        assert_eq!(totals.output, 10);
        assert_eq!(totals.total, 110);
    }

    #[test]
    fn scan_rollout_takes_last_cumulative_total_and_model() {
        let dir = fresh_dir();
        let file = dir.join("rollout-2026-07-08T21-19-10-test.jsonl");
        let content = [
            r#"{"timestamp":"2026-07-08T19:19:59.318Z","type":"turn_context","payload":{"model":"gpt-5-codex"}}"#,
            r#"{"timestamp":"2026-07-08T19:20:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":2,"total_tokens":110}}}}"#,
            r#"{"timestamp":"2026-07-08T19:20:14.673Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":50,"output_tokens":40,"reasoning_output_tokens":8,"total_tokens":340}}}}"#,
        ]
        .join("\n");
        fs::write(&file, content).unwrap();

        let session = scan_rollout_file(&file, "gpt-4").expect("session");
        assert_eq!(session.day, "2026-07-08");
        assert_eq!(session.totals.input, 300);
        assert_eq!(session.totals.cached, 50);
        assert_eq!(session.totals.output, 40);
        assert_eq!(session.totals.reasoning, 8);
        assert_eq!(session.totals.total, 340);
        assert!(session.ts.is_some());
        // Modèle lu dans turn_context (codex), pas le défaut passé "gpt-4" :
        // (250*1.75 + 50*0.175 + 40*14)/1e6
        assert!((session.cost - 0.00100625).abs() < 1e-9);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_rollout_without_token_count_returns_none() {
        let dir = fresh_dir();
        let file = dir.join("rollout-2026-07-08T10-00-00-empty.jsonl");
        // La 2e ligne mentionne "token_count" en texte libre : ne doit PAS
        // être comptée (le filtre cible `"type":"token_count"`).
        let content = r#"{"type":"session_meta","payload":{}}
{"type":"message","payload":{"content":"parler de token_count ici ne compte pas"}}"#;
        fs::write(&file, content).unwrap();

        assert!(scan_rollout_file(&file, "gpt-5-codex").is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
