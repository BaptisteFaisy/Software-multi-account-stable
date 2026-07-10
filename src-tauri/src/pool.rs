//! Pool manager natif : transforme les comptes Codex (CODEX_HOME/auth.json) en une
//! API OpenAI-compatible (/v1/chat/completions) avec rotation + proxy par compte.
//!
//! Flux : requête /v1/chat/completions -> choix d'un compte sain -> refresh token si
//! besoin -> forward vers le backend Codex Responses -> reformatage SSE en chat.completion.chunk.

use crate::{
    metrics,
    settings::{expand_home, AccountProfile, AppSettings, PoolConfig},
};
use async_stream::stream;
use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose, Engine as _};
use bytes::Bytes;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tower_http::cors::CorsLayer;

const CODEX_CLIENT_ID_FALLBACK: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_URL: &str = "https://auth.openai.com/oauth/token";

// ----------------------------------------------------------------------------
// temps / jwt
// ----------------------------------------------------------------------------

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Deserialize)]
struct JwtClaims {
    exp: Option<i64>,
    client_id: Option<String>,
}

fn decode_jwt_claims(token: &str) -> Option<JwtClaims> {
    let mut parts = token.splitn(3, '.');
    parts.next();
    let payload = match parts.next() {
        Some(p) => p,
        None => return None,
    };
    let decoded = general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| general_purpose::STANDARD_NO_PAD.decode(payload))
        .ok();
    let decoded = match decoded {
        Some(d) => d,
        None => return None,
    };
    serde_json::from_slice::<JwtClaims>(&decoded).ok()
}

fn decode_jwt(token: &str) -> (Option<i64>, Option<String>) {
    decode_jwt_claims(token)
        .map(|c| (c.exp, c.client_id))
        .unwrap_or((None, None))
}

// ----------------------------------------------------------------------------
// compte
// ----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AccountStatus {
    Idle,
    Busy,
    Refreshing,
    Cooling,
    Banned,
    Missing,
}

#[derive(Debug, Clone)]
struct PoolAccount {
    id: String,
    label: String,
    codex_home: String,
    proxy_url: Option<String>,
    access_token: String,
    refresh_token: String,
    account_id: String,
    access_exp: Option<i64>,
    client_id: Option<String>,
    status: AccountStatus,
    cooldown_until: Option<i64>,
    last_used: Option<i64>,
    served: u64,
    errors: u64,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: String,
    pub label: String,
    pub codex_home: String,
    pub has_proxy: bool,
    pub proxy_masked: String,
    pub account_id: String,
    pub has_tokens: bool,
    pub has_refresh_token: bool,
    pub oauth_client: String,
    pub access_exp: Option<i64>,
    pub status: AccountStatus,
    pub cooldown_until: Option<i64>,
    pub last_used: Option<i64>,
    pub served: u64,
    pub errors: u64,
    pub last_error: Option<String>,
}

impl PoolAccount {
    fn view(&self) -> AccountView {
        AccountView {
            id: self.id.clone(),
            label: self.label.clone(),
            codex_home: self.codex_home.clone(),
            has_proxy: self.proxy_url.is_some(),
            proxy_masked: mask_proxy(self.proxy_url.as_deref().unwrap_or("")),
            account_id: self.account_id.clone(),
            has_tokens: !self.access_token.is_empty(),
            has_refresh_token: !self.refresh_token.is_empty(),
            oauth_client: oauth_client_label(self.client_id.as_deref()),
            access_exp: self.access_exp,
            status: self.status.clone(),
            cooldown_until: self.cooldown_until,
            last_used: self.last_used,
            served: self.served,
            errors: self.errors,
            last_error: self.last_error.clone(),
        }
    }

    fn is_dispatchable(&self, now: i64) -> bool {
        match self.status {
            AccountStatus::Idle => !self.access_token.is_empty(),
            AccountStatus::Cooling => self.cooldown_until.map_or(true, |c| c <= now),
            _ => false,
        }
    }
}

fn oauth_client_label(client_id: Option<&str>) -> String {
    match client_id {
        Some(CODEX_CLIENT_ID_FALLBACK) => "codex".to_string(),
        Some("app_2SKx67EdpoN0G6j64rFvigXD") => "platform".to_string(),
        Some(_) => "other".to_string(),
        None => "unknown".to_string(),
    }
}

fn mask_proxy(value: &str) -> String {
    if value.is_empty() {
        return "sans proxy".to_string();
    }
    value.replacen(|c: char| c == '@', "***@", 1)
}

struct Acquired {
    index: usize,
    account_id: String,
    proxy_url: Option<String>,
}

// ----------------------------------------------------------------------------
// pool manager
// ----------------------------------------------------------------------------

pub struct PoolManager {
    config: PoolConfig,
    accounts: Mutex<Vec<PoolAccount>>,
    clients: Mutex<HashMap<String, reqwest::Client>>,
    cursor: AtomicUsize,
    started_at: i64,
}

impl PoolManager {
    pub fn build(settings: &AppSettings) -> Result<Self, String> {
        let mut accounts = Vec::with_capacity(settings.accounts.len());
        for profile in &settings.accounts {
            accounts.push(load_account(profile, settings));
        }
        Ok(PoolManager {
            config: settings.pool.clone(),
            accounts: Mutex::new(accounts),
            clients: Mutex::new(HashMap::new()),
            cursor: AtomicUsize::new(0),
            started_at: now_ts(),
        })
    }

    pub fn config(&self) -> &PoolConfig {
        &self.config
    }

    pub fn status_view(&self) -> Vec<AccountView> {
        match self.accounts.lock() {
            Ok(guard) => guard.iter().map(PoolAccount::view).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn started_at(&self) -> i64 {
        self.started_at
    }

    fn client_for(&self, proxy_url: &Option<String>) -> reqwest::Client {
        let key = proxy_url.clone().unwrap_or_default();
        if let Some(c) = self.clients.lock().ok().and_then(|m| m.get(&key).cloned()) {
            return c;
        }
        let client = build_client(proxy_url, self.config.request_timeout_secs);
        if let Ok(mut m) = self.clients.lock() {
            m.insert(key, client.clone());
        }
        client
    }

    fn acquire(&self) -> Result<Acquired, (StatusCode, String)> {
        let mut guard = self.accounts.lock().map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "pool verrouille".to_string(),
            )
        })?;
        let n = guard.len();
        if n == 0 {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "aucun compte dans le pool".to_string(),
            ));
        }
        let now = now_ts();
        let start = self.cursor.fetch_add(1, Ordering::Relaxed) % n;
        for offset in 0..n {
            let idx = (start + offset) % n;
            let a = &mut guard[idx];
            if !a.is_dispatchable(now) {
                continue;
            }
            a.status = AccountStatus::Busy;
            a.last_used = Some(now);
            a.served += 1;
            return Ok(Acquired {
                index: idx,
                account_id: a.account_id.clone(),
                proxy_url: a.proxy_url.clone(),
            });
        }
        let earliest = guard
            .iter()
            .filter_map(|a| a.cooldown_until)
            .min()
            .unwrap_or(0);
        Err((
            StatusCode::SERVICE_UNAVAILABLE,
            format!("aucun compte disponible (earliest recovers at unix {earliest})"),
        ))
    }

    fn release_ok(&self, index: usize) {
        if let Ok(mut g) = self.accounts.lock() {
            if let Some(a) = g.get_mut(index) {
                a.status = AccountStatus::Idle;
                a.cooldown_until = None;
            }
        }
    }

    fn release_err(&self, index: usize, code: u16, msg: String) {
        let now = now_ts();
        if let Ok(mut g) = self.accounts.lock() {
            if let Some(a) = g.get_mut(index) {
                a.errors += 1;
                a.last_error = Some(msg.clone());
                match code {
                    401 | 403 => a.status = AccountStatus::Banned,
                    429 => {
                        a.status = AccountStatus::Cooling;
                        a.cooldown_until = Some(now + self.config.cooldown_secs_429 as i64);
                    }
                    c if c >= 500 => {
                        a.status = AccountStatus::Cooling;
                        a.cooldown_until = Some(now + 30);
                    }
                    _ => {
                        a.status = AccountStatus::Cooling;
                        a.cooldown_until = Some(now + 15);
                    }
                }
            }
        }
    }

    fn set_status(&self, index: usize, status: AccountStatus) {
        if let Ok(mut g) = self.accounts.lock() {
            if let Some(a) = g.get_mut(index) {
                a.status = status;
            }
        }
    }

    fn access_token_of(&self, index: usize) -> Option<String> {
        self.accounts
            .lock()
            .ok()
            .and_then(|g| g.get(index).map(|a| a.access_token.clone()))
    }

    /// Rafraichit l'access_token via le refresh_token si l'expiration est proche.
    async fn ensure_fresh(&self, index: usize) {
        let snapshot = match self.accounts.lock() {
            Ok(g) => {
                let a = match g.get(index) {
                    Some(a) => a,
                    None => return,
                };
                let exp = a.access_exp.unwrap_or(0);
                if !a.access_token.is_empty() && exp - now_ts() > 120 {
                    return;
                }
                (
                    a.refresh_token.clone(),
                    a.client_id
                        .clone()
                        .unwrap_or_else(|| self.config.client_id_override.clone()),
                    a.proxy_url.clone(),
                    a.codex_home.clone(),
                )
            }
            Err(_) => return,
        };
        let (refresh_token, client_id, proxy_url, codex_home) = snapshot;
        if refresh_token.is_empty() || client_id.is_empty() {
            return;
        }
        self.set_status(index, AccountStatus::Refreshing);
        let client = self.client_for(&proxy_url);
        match refresh_access_token(&client, &refresh_token, &client_id).await {
            Ok(refreshed) => {
                let (exp, cid) = decode_jwt(&refreshed.access_token);
                if let Ok(home) = expand_home(&codex_home) {
                    let _ = persist_auth(&home, &refreshed);
                }
                if let Ok(mut g) = self.accounts.lock() {
                    if let Some(a) = g.get_mut(index) {
                        a.access_token = refreshed.access_token;
                        if !refreshed.refresh_token.is_empty() {
                            a.refresh_token = refreshed.refresh_token;
                        }
                        a.access_exp = exp;
                        if a.client_id.is_none() {
                            a.client_id = cid.or(Some(client_id.clone()));
                        }
                        a.status = AccountStatus::Busy;
                    }
                }
            }
            Err(_) => {
                self.set_status(index, AccountStatus::Busy);
            }
        }
    }
}

fn load_account(profile: &AccountProfile, settings: &AppSettings) -> PoolAccount {
    let proxy_url = if settings.proxy_controls_enabled {
        profile
            .proxy_id
            .as_ref()
            .and_then(|id| settings.proxies.iter().find(|p| p.id == *id))
            .map(|p| p.proxy_url.clone())
    } else {
        None
    };

    let home = match expand_home(&profile.codex_home) {
        Ok(p) => p,
        Err(_) => {
            return missing_account(profile, proxy_url);
        }
    };
    let auth_path = home.join("auth.json");
    let content = match std::fs::read_to_string(&auth_path) {
        Ok(c) => c,
        Err(_) => return missing_account(profile, proxy_url),
    };
    let value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return missing_account(profile, proxy_url),
    };
    let tokens = value.get("tokens");
    let access_token = tokens
        .and_then(|t| t.get("access_token"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let refresh_token = tokens
        .and_then(|t| t.get("refresh_token"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let account_id = tokens
        .and_then(|t| t.get("account_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let (access_exp, client_id) = if access_token.is_empty() {
        (None, None)
    } else {
        let (exp, cid) = decode_jwt(&access_token);
        (
            exp,
            cid.or_else(|| Some(CODEX_CLIENT_ID_FALLBACK.to_string())),
        )
    };

    PoolAccount {
        id: profile.id.clone(),
        label: profile.label.clone(),
        codex_home: profile.codex_home.clone(),
        proxy_url,
        status: if access_token.is_empty() {
            AccountStatus::Missing
        } else {
            AccountStatus::Idle
        },
        access_token,
        refresh_token,
        account_id,
        access_exp,
        client_id,
        cooldown_until: None,
        last_used: None,
        served: 0,
        errors: 0,
        last_error: None,
    }
}

fn missing_account(profile: &AccountProfile, proxy_url: Option<String>) -> PoolAccount {
    PoolAccount {
        id: profile.id.clone(),
        label: profile.label.clone(),
        codex_home: profile.codex_home.clone(),
        proxy_url,
        access_token: String::new(),
        refresh_token: String::new(),
        account_id: String::new(),
        access_exp: None,
        client_id: None,
        status: AccountStatus::Missing,
        cooldown_until: None,
        last_used: None,
        served: 0,
        errors: 0,
        last_error: Some("auth.json introuvable".to_string()),
    }
}

// ----------------------------------------------------------------------------
// refresh token
// ----------------------------------------------------------------------------

#[derive(Debug)]
struct Refreshed {
    access_token: String,
    refresh_token: String,
}

#[derive(Deserialize)]
struct RefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

async fn refresh_access_token(
    client: &reqwest::Client,
    refresh_token: &str,
    client_id: &str,
) -> Result<Refreshed, String> {
    let body = format!(
        "grant_type=refresh_token&client_id={client_id}&refresh_token={refresh_token}&scope=openid profile email offline_access"
    );
    let resp = client
        .post(REFRESH_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("refresh status {}", resp.status()));
    }
    let parsed: RefreshResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(Refreshed {
        refresh_token: parsed
            .refresh_token
            .unwrap_or_else(|| refresh_token.to_string()),
        access_token: parsed.access_token,
    })
}

fn persist_auth(home: &std::path::Path, refreshed: &Refreshed) -> Result<(), String> {
    let auth_path = home.join("auth.json");
    let content = std::fs::read_to_string(&auth_path).map_err(|e| e.to_string())?;
    let mut value: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    if let Some(tokens) = value.get_mut("tokens").and_then(|t| t.as_object_mut()) {
        tokens["access_token"] = serde_json::Value::String(refreshed.access_token.clone());
        tokens["refresh_token"] = serde_json::Value::String(refreshed.refresh_token.clone());
    }
    value["last_refresh"] = serde_json::Value::String(now_rfc3339());
    let tmp = home.join("auth.json.pool-tmp");
    std::fs::write(
        &tmp,
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &auth_path).map_err(|e| e.to_string())
}

fn now_rfc3339() -> String {
    let secs = now_ts();
    format!("{}Z", secs)
}

// ----------------------------------------------------------------------------
// http client
// ----------------------------------------------------------------------------

fn build_client(proxy_url: &Option<String>, timeout_secs: u64) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs.max(30)))
        .user_agent("codex_cli_rs/0.45.0");
    if let Some(p) = proxy_url {
        if !p.is_empty() {
            if let Ok(proxy) = reqwest::Proxy::all(p) {
                builder = builder.proxy(proxy);
            }
        }
    }
    builder.build().unwrap_or_else(|_| reqwest::Client::new())
}

// ----------------------------------------------------------------------------
// conversion chat/completions <-> Codex Responses
// ----------------------------------------------------------------------------

#[derive(Deserialize)]
struct ChatRequest {
    #[serde(default)]
    model: String,
    #[serde(default)]
    messages: Vec<ChatMessage>,
    #[serde(default)]
    stream: Option<bool>,
}

#[derive(Deserialize)]
struct ChatMessage {
    #[serde(default)]
    role: String,
    #[serde(default)]
    content: serde_json::Value,
}

fn message_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|part| {
                let kind = part.get("type")?.as_str()?;
                if matches!(kind, "text" | "input_text" | "output_text") {
                    part.get("text")?.as_str().map(String::from)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(""),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn build_codex_body(chat: &ChatRequest, config: &PoolConfig) -> serde_json::Value {
    let mut instructions = Vec::new();
    let mut input = Vec::new();
    for m in &chat.messages {
        let text = message_text(&m.content);
        if text.is_empty() {
            continue;
        }
        match m.role.as_str() {
            "system" | "developer" => instructions.push(text),
            "assistant" => input.push(serde_json::json!({
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": text }]
            })),
            _ => input.push(serde_json::json!({
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": text }]
            })),
        }
    }
    let model = if chat.model.is_empty() {
        config.default_model.clone()
    } else {
        chat.model.clone()
    };
    serde_json::json!({
        "model": model,
        "instructions": instructions.join("\n\n"),
        "input": input,
        "tools": [],
        "tool_choice": "auto",
        "parallel_tool_calls": false,
        "reasoning": { "effort": config.reasoning_effort },
        "store": false,
        "stream": chat.stream.unwrap_or(false),
        "include": ["reasoning.encrypted.content"]
    })
}

fn estimate_chat_input_tokens(chat: &ChatRequest) -> u64 {
    let message_tokens = chat
        .messages
        .iter()
        .map(|message| {
            metrics::estimate_text_tokens(&message_text(&message.content)).saturating_add(4)
        })
        .sum::<u64>();
    message_tokens.saturating_add(metrics::estimate_text_tokens(&chat.model))
}

fn extract_delta(value: &serde_json::Value) -> Option<String> {
    let kind = value.get("type")?.as_str()?;
    match kind {
        "response.output_text.delta" => value
            .get("delta")
            .and_then(|d| d.as_str())
            .map(String::from),
        _ => None,
    }
}

fn is_completed(value: &serde_json::Value) -> bool {
    value
        .get("type")
        .and_then(|t| t.as_str())
        .map(|t| matches!(t, "response.completed" | "response.failed"))
        .unwrap_or(false)
}

fn is_error_event(value: &serde_json::Value) -> Option<String> {
    let kind = value.get("type")?.as_str()?;
    if matches!(kind, "error" | "response.failed" | "response.incomplete") {
        Some(
            value
                .get("message")
                .and_then(|m| m.as_str())
                .or_else(|| value.get("error").and_then(|e| e.as_str()))
                .unwrap_or("upstream error")
                .to_string(),
        )
    } else {
        None
    }
}

fn parse_data_line(event: &str) -> Option<serde_json::Value> {
    for line in event.lines() {
        let line = line.trim();
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                return Some(v);
            }
        }
    }
    None
}

// ----------------------------------------------------------------------------
// reponses api
// ----------------------------------------------------------------------------

pub fn router(mgr: Arc<PoolManager>) -> Router {
    Router::new()
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/models", get(models))
        .route("/admin/status", get(admin_status))
        // NB: pas de `/healthz` ici. Le routeur du pool est monte a la racine via
        // `.merge()`, et le serveur principal expose deja `GET /healthz`
        // (`api_healthz`, avec version/commit/readiness). Enregistrer un second
        // `/healthz` faisait paniquer axum au demarrage ("Overlapping method
        // route. Handler for `GET /healthz` already exists").
        .layer(CorsLayer::very_permissive())
        .with_state(mgr)
}

fn check_api_key(headers: &HeaderMap, config: &PoolConfig) -> Result<(), (StatusCode, String)> {
    let expected = config.api_key.trim();
    if expected.is_empty() {
        return Ok(());
    }
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let provided = bearer.strip_prefix("Bearer ").unwrap_or(bearer).trim();
    if provided == expected {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, "clé API invalide".to_string()))
    }
}

fn api_error(code: StatusCode, message: &str) -> Response {
    let body = serde_json::json!({
        "error": { "message": message, "type": "pool_error", "code": code.as_u16() }
    });
    (code, Json(body)).into_response()
}

async fn models(State(mgr): State<Arc<PoolManager>>) -> impl IntoResponse {
    let model = mgr.config().default_model.clone();
    let now = now_ts();
    Json(serde_json::json!({
        "object": "list",
        "data": [
            { "id": model, "object": "model", "created": now, "owned_by": "codex-pool" },
            { "id": "gpt-5.5", "object": "model", "created": now, "owned_by": "codex-pool" },
            { "id": "gpt-5-codex", "object": "model", "created": now, "owned_by": "codex-pool" }
        ]
    }))
}

async fn admin_status(State(mgr): State<Arc<PoolManager>>) -> impl IntoResponse {
    let views = mgr.status_view();
    let total = views.len();
    let idle = views
        .iter()
        .filter(|a| a.status == AccountStatus::Idle)
        .count();
    Json(serde_json::json!({
        "running": true,
        "started_at": mgr.started_at(),
        "base_url": format!("http://localhost:{}", mgr.config().port),
        "model": mgr.config().default_model,
        "total": total,
        "idle": idle,
        "accounts": views
    }))
}

async fn chat_completions(
    State(mgr): State<Arc<PoolManager>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if let Err((code, msg)) = check_api_key(&headers, mgr.config()) {
        return api_error(code, &msg);
    }

    let chat: ChatRequest = match serde_json::from_slice(&body) {
        Ok(c) => c,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, &format!("json invalide: {e}")),
    };

    let stream_requested = chat.stream.unwrap_or(false);
    let model = if chat.model.is_empty() {
        mgr.config().default_model.clone()
    } else {
        chat.model.clone()
    };
    let request_started = metrics::now_ts();
    let estimated_input_tokens = estimate_chat_input_tokens(&chat);

    let acquired = match mgr.acquire() {
        Ok(a) => a,
        Err((code, msg)) => return api_error(code, &msg),
    };

    mgr.ensure_fresh(acquired.index).await;
    let access_token = match mgr.access_token_of(acquired.index) {
        Some(t) if !t.is_empty() => t,
        _ => {
            mgr.release_err(acquired.index, 401, "token absent".to_string());
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "compte sans token");
        }
    };

    let codex_body = build_codex_body(&chat, mgr.config());
    let client = mgr.client_for(&acquired.proxy_url);
    let upstream = format!(
        "{}/backend-api/codex/responses",
        mgr.config().upstream.trim_end_matches('/')
    );

    let session_id = format!("sess-{}", now_ts());
    let resp = client
        .post(&upstream)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("chatgpt-account-id", &acquired.account_id)
        .header("OpenAI-Beta", "responses=experimental")
        .header("originator", "codex_cli_rs")
        .header("session_id", &session_id)
        .header("Accept", "text/event-stream")
        .json(&codex_body)
        .send()
        .await;

    let upstream_resp = match resp {
        Ok(r) => r,
        Err(e) => {
            mgr.release_err(acquired.index, 502, e.to_string());
            return api_error(
                StatusCode::BAD_GATEWAY,
                &format!("upstream injoignable: {e}"),
            );
        }
    };

    let status_code = upstream_resp.status().as_u16();
    if !(200..300).contains(&status_code) {
        let text = upstream_resp.text().await.unwrap_or_default();
        mgr.release_err(acquired.index, status_code, text.clone());
        return api_error(
            map_upstream_status(status_code),
            &format!("upstream {}: {}", status_code, truncate(&text, 400)),
        );
    }

    let chat_id = format!("chatcmpl-pool-{}-{}", now_ts(), acquired.index);

    if stream_requested {
        let byte_stream = upstream_resp.bytes_stream();
        let record_model = model.clone();
        let out = stream! {
            let created = now_ts();
            let mut buf = String::new();
            let mut input = byte_stream;
            let mut finished = false;
            let mut output_text = String::new();
            let mut observed_usage: Option<metrics::TokenUsage> = None;
            let mut record_status_code = 200_u16;
            while let Some(chunk) = input.next().await {
                let bytes = match chunk {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = e.to_string();
                        record_status_code = 502;
                        let frame = serde_json::json!({
                            "id": chat_id, "object": "chat.completion.chunk",
                            "created": created, "model": model,
                            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }]
                        });
                        yield Ok::<Bytes, std::io::Error>(Bytes::from(
                            format!("data: {frame}\n\n"),
                        ));
                        break;
                    }
                };
                buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buf.find("\n\n") {
                    let event: String = buf.drain(..pos + 2).collect();
                    let parsed = match parse_data_line(&event) {
                        Some(v) => v,
                        None => continue,
                    };
                    if let Some(usage) = metrics::extract_token_usage(&parsed) {
                        observed_usage = Some(usage);
                    }
                    if let Some(err) = is_error_event(&parsed) {
                        record_status_code = 502;
                        let frame = serde_json::json!({
                            "id": chat_id, "object": "chat.completion.chunk",
                            "created": created, "model": model,
                            "choices": [{ "index": 0, "delta": { "content": format!("\n[erreur] {err}") }, "finish_reason": "stop" }]
                        });
                        yield Ok(Bytes::from(format!("data: {frame}\n\n")));
                        finished = true;
                        break;
                    }
                    if let Some(delta) = extract_delta(&parsed) {
                        output_text.push_str(&delta);
                        let frame = serde_json::json!({
                            "id": chat_id, "object": "chat.completion.chunk",
                            "created": created, "model": model,
                            "choices": [{ "index": 0, "delta": { "content": delta }, "finish_reason": null }]
                        });
                        yield Ok(Bytes::from(format!("data: {frame}\n\n")));
                    }
                    if is_completed(&parsed) {
                        finished = true;
                        break;
                    }
                }
                if finished {
                    break;
                }
            }
            let stop = serde_json::json!({
                "id": chat_id, "object": "chat.completion.chunk",
                "created": now_ts(), "model": model,
                "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }]
            });
            yield Ok(Bytes::from(format!("data: {stop}\n\n")));
            yield Ok(Bytes::from("data: [DONE]\n\n"));

            let tokens_estimated = observed_usage.is_none();
            let usage = observed_usage.unwrap_or_else(|| {
                metrics::TokenUsage::estimated(
                    estimated_input_tokens,
                    metrics::estimate_text_tokens(&output_text),
                )
            });
            let _ = metrics::record_api_usage(metrics::ApiUsageRecord {
                model: record_model,
                started_at: request_started,
                ended_at: metrics::now_ts(),
                status_code: record_status_code,
                usage,
                tokens_estimated,
            });
        };

        mgr.release_ok(acquired.index);
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .header(
                "x-pool-account",
                HeaderValue::from_str(&acquired.account_id).unwrap_or(HeaderValue::from_static("")),
            )
            .body(Body::from_stream(out))
            .unwrap_or_else(|_| api_error(StatusCode::INTERNAL_SERVER_ERROR, "stream"))
    } else {
        let full = match collect_full(upstream_resp, &model).await {
            Ok(text) => text,
            Err(e) => {
                mgr.release_err(acquired.index, 502, e.clone());
                return api_error(StatusCode::BAD_GATEWAY, &e);
            }
        };
        mgr.release_ok(acquired.index);
        let tokens_estimated = full.usage.is_none();
        let usage = full.usage.unwrap_or_else(|| {
            metrics::TokenUsage::estimated(
                estimated_input_tokens,
                metrics::estimate_text_tokens(&full.text),
            )
        });
        let _ = metrics::record_api_usage(metrics::ApiUsageRecord {
            model: model.clone(),
            started_at: request_started,
            ended_at: metrics::now_ts(),
            status_code: 200,
            usage,
            tokens_estimated,
        });
        let payload = serde_json::json!({
            "id": chat_id,
            "object": "chat.completion",
            "created": now_ts(),
            "model": model,
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": full.text },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": usage.input_tokens,
                "completion_tokens": usage.output_tokens,
                "total_tokens": usage.total_tokens,
                "prompt_tokens_details": { "cached_tokens": usage.cached_input_tokens }
            }
        });
        Json(payload).into_response()
    }
}

struct FullText {
    text: String,
    usage: Option<metrics::TokenUsage>,
}

async fn collect_full(upstream_resp: reqwest::Response, _model: &str) -> Result<FullText, String> {
    let mut buf = String::new();
    let mut text = String::new();
    let mut usage = None;
    let mut stream = upstream_resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = buf.find("\n\n") {
            let event: String = buf.drain(..pos + 2).collect();
            let parsed = match parse_data_line(&event) {
                Some(v) => v,
                None => continue,
            };
            if let Some(err) = is_error_event(&parsed) {
                return Err(err);
            }
            if let Some(parsed_usage) = metrics::extract_token_usage(&parsed) {
                usage = Some(parsed_usage);
            }
            if let Some(delta) = extract_delta(&parsed) {
                text.push_str(&delta);
            }
        }
    }
    Ok(FullText { text, usage })
}

fn map_upstream_status(code: u16) -> StatusCode {
    match code {
        429 => StatusCode::TOO_MANY_REQUESTS,
        401 | 403 => StatusCode::BAD_GATEWAY,
        c if c >= 500 => StatusCode::BAD_GATEWAY,
        _ => StatusCode::BAD_GATEWAY,
    }
}

fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        value.to_string()
    } else {
        format!("{}…", &value[..max])
    }
}
