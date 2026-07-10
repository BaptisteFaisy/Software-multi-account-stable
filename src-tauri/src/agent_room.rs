//! **Agent Room** — un salon de communication inter-agents.
//!
//! Chaque terminal lance un agent Codex isole (un PTY, un `CODEX_HOME` par
//! compte). Ce module expose un petit **serveur MCP en HTTP streamable** que
//! tous les agents rejoignent (via une entree `[mcp_servers.agent_room]` dans
//! leur `config.toml`, cf. `codex mcp add`). Les agents peuvent alors :
//! - se voir (`list_agents`, `whoami`),
//! - poster dans le salon commun (`send_message`),
//! - s'envoyer des messages prives (`send_message` avec `to`),
//! - lire ce qui les concerne (`read_messages`, `wait_for_messages`).
//!
//! IDENTITE / AUTH : `config.toml` est PAR HOME (partage entre terminaux d'un
//! meme compte), mais la valeur du bearer token est lue dans une variable
//! d'environnement du process au runtime (`bearer_token_env_var`). L'app injecte
//! donc un `CST_ROOM_TOKEN` UNIQUE par PTY ; le serveur mappe token -> agent, ce
//! qui distingue deux terminaux d'un meme compte. Un token inconnu => 401.
//!
//! Le token est SECRET (il vaut identite + auth) et n'est jamais expose aux
//! autres agents : chaque agent possede en plus un identifiant PUBLIC (`ident`,
//! ex. `agent-3`) qui sert d'adresse pour les messages prives.
//!
//! Ce module implemente a la main le sous-ensemble MCP necessaire (JSON-RPC sur
//! `POST /mcp`) : `initialize`, `notifications/initialized`, `ping`,
//! `tools/list`, `tools/call`. Pas de SSE cote serveur (les reponses tiennent en
//! une requete), donc pas de dependance MCP externe.

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Write as _},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;

/// Version du protocole MCP annoncee par defaut si le client n'en propose pas.
const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";
/// Identite reservee de l'operateur humain (l'UI de l'app).
pub const OPERATOR_IDENT: &str = "operator";
/// Longueur max d'un message (framing / anti-abus).
const MESSAGE_MAX_CHARS: usize = 8000;
/// Rate-limit par agent (token-bucket) : capacite et recharge par seconde.
const SEND_BUCKET_CAPACITY: f64 = 20.0;
const SEND_BUCKET_REFILL_PER_SEC: f64 = 1.0;
/// Bornes du long-poll `wait_for_messages` (millisecondes).
const WAIT_DEFAULT_MS: u64 = 25_000;
const WAIT_MAX_MS: u64 = 55_000;
/// Nom du fichier journal persiste.
const LOG_FILE: &str = "messages.jsonl";

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Modele
// ---------------------------------------------------------------------------

/// Metadonnees fournies par l'app quand elle enregistre un agent avant de lancer
/// son terminal.
#[derive(Debug, Clone, Default)]
pub struct AgentMeta {
    pub agent_id: String,
    pub account_id: String,
    pub label: String,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    /// Identifiant public d'adressage (jamais le token secret).
    pub ident: String,
    pub agent_id: String,
    pub account_id: String,
    pub label: String,
    pub cwd: Option<String>,
    pub present: bool,
    pub joined_at: i64,
    pub last_seen: i64,
    // Etat du token-bucket d'envoi (jamais serialise ni expose).
    #[serde(skip)]
    send_tokens: f64,
    #[serde(skip)]
    bucket_refilled_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MsgKind {
    /// Message diffuse a tout le salon.
    Room,
    /// Message prive (DM) adresse a un agent precis.
    Dm,
    /// Message systeme (arrivee/depart d'un agent).
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMessage {
    pub id: u64,
    pub ts: i64,
    /// Ident public de l'emetteur.
    pub from: String,
    pub from_label: String,
    /// Ident public du destinataire pour un DM ; `None` = diffusion salon.
    #[serde(default)]
    pub to: Option<String>,
    pub kind: MsgKind,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub agents: Vec<AgentInfo>,
    pub present: usize,
    pub total_messages: usize,
    pub cursor: u64,
}

// ---------------------------------------------------------------------------
// Etat du salon
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct RoomState {
    inner: Arc<RoomInner>,
}

struct RoomInner {
    /// token secret -> agent.
    agents: Mutex<HashMap<String, AgentInfo>>,
    /// Journal ordonne de tous les messages (salon + DM + systeme).
    log: Mutex<Vec<RoomMessage>>,
    next_id: AtomicU64,
    ident_seq: AtomicU64,
    /// Notifie l'id du dernier message poste (pour le long-poll wait_for_messages).
    notify: broadcast::Sender<u64>,
    /// Observabilite : nombre de handshakes `initialize` et de `tools/list`
    /// recus (preuve qu'un client MCP a bien parle au serveur).
    initialize_count: AtomicU64,
    tools_list_count: AtomicU64,
    /// Repertoire de persistance (`.../agent-room`) ; `None` = memoire seule.
    data_dir: Option<PathBuf>,
    /// Serialise les ecritures dans le journal JSONL.
    io_lock: Mutex<()>,
    /// CODEX_HOME deja provisionnes cette session (evite de rappeler
    /// `codex mcp get/add` a chaque lancement de terminal).
    provisioned: Mutex<HashSet<String>>,
}

impl RoomState {
    /// Salon en memoire seule (tests / usage transitoire).
    pub fn new() -> Self {
        Self::build(None)
    }

    /// Salon persiste dans `<dir>/messages.jsonl` (honore `CST_DATA_DIR` cote
    /// appelant). Recharge l'historique existant et reprend la numerotation.
    pub fn with_data_dir(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        let state = Self::build(Some(dir));
        state.load_log();
        state
    }

    fn build(data_dir: Option<PathBuf>) -> Self {
        let (notify, _rx) = broadcast::channel(256);
        RoomState {
            inner: Arc::new(RoomInner {
                agents: Mutex::new(HashMap::new()),
                log: Mutex::new(Vec::new()),
                next_id: AtomicU64::new(1),
                ident_seq: AtomicU64::new(1),
                notify,
                initialize_count: AtomicU64::new(0),
                tools_list_count: AtomicU64::new(0),
                data_dir,
                io_lock: Mutex::new(()),
                provisioned: Mutex::new(HashSet::new()),
            }),
        }
    }

    /// Provisionne un `CODEX_HOME` (idempotent, avec cache par session) : ajoute
    /// l'entree `[mcp_servers.agent_room]` via `codex mcp add` si absente.
    pub fn provision_home(&self, codex_bin: &str, codex_home: &Path, url: &str) -> Result<(), String> {
        let key = codex_home.to_string_lossy().to_lowercase();
        if self
            .inner
            .provisioned
            .lock()
            .map(|set| set.contains(&key))
            .unwrap_or(false)
        {
            return Ok(());
        }
        provision(codex_bin, codex_home, url)?;
        if let Ok(mut set) = self.inner.provisioned.lock() {
            set.insert(key);
        }
        Ok(())
    }

    /// Retire l'entree du salon d'un `CODEX_HOME` et oublie le cache associe.
    pub fn deprovision_home(&self, codex_bin: &str, codex_home: &Path) {
        deprovision(codex_bin, codex_home);
        let key = codex_home.to_string_lossy().to_lowercase();
        if let Ok(mut set) = self.inner.provisioned.lock() {
            set.remove(&key);
        }
    }

    fn log_path(&self) -> Option<PathBuf> {
        self.inner.data_dir.as_ref().map(|d| d.join(LOG_FILE))
    }

    /// Recharge le journal JSONL au demarrage : restaure les messages et
    /// positionne `next_id` juste apres le plus grand id vu.
    fn load_log(&self) {
        let Some(path) = self.log_path() else { return };
        let Ok(file) = fs::File::open(&path) else { return };
        let reader = BufReader::new(file);
        let mut max_id = 0_u64;
        let mut restored = Vec::new();
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(message) = serde_json::from_str::<RoomMessage>(trimmed) {
                max_id = max_id.max(message.id);
                restored.push(message);
            }
        }
        if let Ok(mut log) = self.inner.log.lock() {
            *log = restored;
        }
        self.inner.next_id.store(max_id + 1, Ordering::SeqCst);
    }

    /// Ajoute une ligne au journal JSONL (best-effort, sous `io_lock`).
    fn persist(&self, message: &RoomMessage) {
        let Some(path) = self.log_path() else { return };
        let Ok(line) = serde_json::to_string(message) else {
            return;
        };
        let _guard = self.inner.io_lock.lock();
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(file, "{line}");
        }
    }

    /// (initialize_count, tools_list_count) — utile pour le statut et les tests.
    pub fn handshake_counts(&self) -> (u64, u64) {
        (
            self.inner.initialize_count.load(Ordering::Relaxed),
            self.inner.tools_list_count.load(Ordering::Relaxed),
        )
    }

    /// Enregistre un agent et renvoie son **token secret** (a injecter dans
    /// `CST_ROOM_TOKEN` du PTY). Idempotent si le meme token est fourni.
    pub fn register(&self, meta: AgentMeta) -> String {
        let token = format!("agt_{}", uuid::Uuid::new_v4().simple());
        let ident = self.next_ident(&meta.label);
        let now = now_ts();
        let info = AgentInfo {
            ident: ident.clone(),
            agent_id: meta.agent_id,
            account_id: meta.account_id,
            label: if meta.label.is_empty() {
                ident.clone()
            } else {
                meta.label
            },
            cwd: meta.cwd,
            present: true,
            joined_at: now,
            last_seen: now,
            send_tokens: SEND_BUCKET_CAPACITY,
            bucket_refilled_at: now,
        };
        let label = info.label.clone();
        if let Ok(mut agents) = self.inner.agents.lock() {
            agents.insert(token.clone(), info);
        }
        self.post(&ident, &label, None, MsgKind::System, format!("{label} a rejoint le salon"));
        token
    }

    /// Marque un agent comme parti (garde l'historique pour resoudre les labels).
    pub fn deregister(&self, token: &str) {
        let departed = if let Ok(mut agents) = self.inner.agents.lock() {
            match agents.get_mut(token) {
                Some(info) if info.present => {
                    info.present = false;
                    info.last_seen = now_ts();
                    Some((info.ident.clone(), info.label.clone()))
                }
                _ => None,
            }
        } else {
            None
        };
        if let Some((ident, label)) = departed {
            self.post(&ident, &label, None, MsgKind::System, format!("{label} a quitte le salon"));
        }
    }

    /// Resout un token -> agent (clone), en mettant a jour `last_seen`.
    pub fn lookup(&self, token: &str) -> Option<AgentInfo> {
        let mut agents = self.inner.agents.lock().ok()?;
        let info = agents.get_mut(token)?;
        info.last_seen = now_ts();
        Some(info.clone())
    }

    /// Consomme un jeton du token-bucket d'envoi de l'agent (rate-limit).
    /// Renvoie `false` si le quota est epuise. L'etat vit dans l'entree
    /// canonique (pas dans les clones renvoyes par `lookup`).
    fn try_consume_send(&self, token: &str) -> bool {
        let Ok(mut agents) = self.inner.agents.lock() else {
            return true;
        };
        let Some(info) = agents.get_mut(token) else {
            return false;
        };
        let now = now_ts();
        let elapsed = (now - info.bucket_refilled_at).max(0) as f64;
        info.send_tokens =
            (info.send_tokens + elapsed * SEND_BUCKET_REFILL_PER_SEC).min(SEND_BUCKET_CAPACITY);
        info.bucket_refilled_at = now;
        if info.send_tokens >= 1.0 {
            info.send_tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Vrai si un ident public correspond a un agent connu (pour valider un `to`).
    pub fn ident_exists(&self, ident: &str) -> bool {
        if ident == OPERATOR_IDENT {
            return true;
        }
        self.inner
            .agents
            .lock()
            .map(|agents| agents.values().any(|a| a.ident == ident))
            .unwrap_or(false)
    }

    pub fn present_agents(&self) -> Vec<AgentInfo> {
        self.inner
            .agents
            .lock()
            .map(|agents| {
                let mut list: Vec<AgentInfo> =
                    agents.values().filter(|a| a.present).cloned().collect();
                list.sort_by(|a, b| a.joined_at.cmp(&b.joined_at));
                list
            })
            .unwrap_or_default()
    }

    /// Poste un message et notifie les liseurs. Renvoie le message (avec son id).
    ///
    /// Garde anti-boucle : un message `Room`/`Dm` strictement identique au
    /// dernier message du meme emetteur vers la meme cible est ignore (on
    /// renvoie le message existant sans reecrire ni notifier). Les messages
    /// systeme ne sont jamais dedupliques.
    pub fn post(
        &self,
        from: &str,
        from_label: &str,
        to: Option<String>,
        kind: MsgKind,
        text: impl Into<String>,
    ) -> RoomMessage {
        let text = frame_text(text.into());

        if kind != MsgKind::System {
            if let Ok(log) = self.inner.log.lock() {
                if let Some(last) = log.last() {
                    if last.from == from && last.to == to && last.text == text {
                        return last.clone();
                    }
                }
            }
        }

        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let message = RoomMessage {
            id,
            ts: now_ts(),
            from: from.to_string(),
            from_label: from_label.to_string(),
            to,
            kind,
            text,
        };
        if let Ok(mut log) = self.inner.log.lock() {
            log.push(message.clone());
        }
        self.persist(&message);
        let _ = self.inner.notify.send(id);
        message
    }

    /// Long-poll : attend l'arrivee d'un message visible par `ident` posterieur
    /// a `since`, borne par `timeout`. Renvoie immediatement si des messages
    /// sont deja disponibles, sinon `[]` a l'expiration.
    pub async fn wait_for(&self, ident: &str, since: u64, timeout: Duration) -> Vec<RoomMessage> {
        let existing = self.messages_for(ident, since);
        if !existing.is_empty() {
            return existing;
        }
        let mut rx = self.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Vec::new();
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(_id)) => {
                    let msgs = self.messages_for(ident, since);
                    if !msgs.is_empty() {
                        return msgs;
                    }
                    // Message non visible par cet ident (DM pour un autre) : on
                    // continue d'attendre jusqu'au deadline.
                }
                // Lagged : on recheck immediatement.
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                    let msgs = self.messages_for(ident, since);
                    if !msgs.is_empty() {
                        return msgs;
                    }
                }
                // Canal ferme ou timeout : on rend la main.
                _ => return self.messages_for(ident, since),
            }
        }
    }

    /// Poste au nom de l'operateur humain (UI).
    pub fn operator_post(&self, to: Option<String>, text: String) -> RoomMessage {
        let kind = if to.is_some() { MsgKind::Dm } else { MsgKind::Room };
        self.post(OPERATOR_IDENT, "Operateur", to, kind, text)
    }

    /// Messages visibles pour `ident` avec `id > since` :
    /// - toutes les diffusions salon + messages systeme,
    /// - les DM dont il est l'emetteur ou le destinataire.
    pub fn messages_for(&self, ident: &str, since: u64) -> Vec<RoomMessage> {
        self.inner
            .log
            .lock()
            .map(|log| {
                log.iter()
                    .filter(|m| m.id > since)
                    .filter(|m| match &m.to {
                        None => true,
                        Some(target) => target == ident || m.from == ident,
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn cursor(&self) -> u64 {
        self.inner.next_id.load(Ordering::SeqCst).saturating_sub(1)
    }

    pub fn snapshot(&self) -> RoomSnapshot {
        let agents = self
            .inner
            .agents
            .lock()
            .map(|a| {
                let mut list: Vec<AgentInfo> = a.values().cloned().collect();
                list.sort_by(|x, y| x.joined_at.cmp(&y.joined_at));
                list
            })
            .unwrap_or_default();
        let present = agents.iter().filter(|a| a.present).count();
        let total_messages = self.inner.log.lock().map(|l| l.len()).unwrap_or(0);
        RoomSnapshot {
            present,
            total_messages,
            cursor: self.cursor(),
            agents,
        }
    }

    /// Souscrit au flux de notifications (id du dernier message). Sert au
    /// long-poll `wait_for_messages`.
    pub fn subscribe(&self) -> broadcast::Receiver<u64> {
        self.inner.notify.subscribe()
    }

    fn next_ident(&self, label: &str) -> String {
        let seq = self.inner.ident_seq.fetch_add(1, Ordering::SeqCst);
        let slug = slugify(label);
        if slug.is_empty() {
            format!("agent-{seq}")
        } else {
            format!("{slug}-{seq}")
        }
    }
}

impl Default for RoomState {
    fn default() -> Self {
        Self::new()
    }
}

fn slugify(label: &str) -> String {
    let mut out = String::new();
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if (ch == ' ' || ch == '-' || ch == '_') && !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.chars().count() >= 16 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

/// Borne la longueur et retire les caracteres de controle (hors `\n`/`\t`).
fn frame_text(text: String) -> String {
    let cleaned: String = text
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect();
    cleaned.chars().take(MESSAGE_MAX_CHARS).collect()
}

// ---------------------------------------------------------------------------
// Serveur MCP (JSON-RPC sur POST /mcp)
// ---------------------------------------------------------------------------

pub fn router(state: RoomState) -> Router {
    Router::new()
        .route(
            "/mcp",
            post(mcp_post).get(|| async { StatusCode::METHOD_NOT_ALLOWED }),
        )
        .with_state(state)
}

fn bearer_token(headers: &HeaderMap) -> String {
    let raw = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    raw.strip_prefix("Bearer ").unwrap_or(raw).trim().to_string()
}

async fn mcp_post(State(state): State<RoomState>, headers: HeaderMap, body: Bytes) -> Response {
    let token = bearer_token(&headers);
    let Some(agent) = state.lookup(&token) else {
        // Token absent / inconnu : l'agent n'a pas ete enregistre par l'app.
        return unauthorized();
    };

    let accept = headers
        .get("accept")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => return rpc_http(&accept, parse_error(&error.to_string())),
    };

    // Un lot (array) ou un message unique.
    match parsed {
        Value::Array(items) => {
            let mut responses = Vec::new();
            for item in &items {
                if let Some(response) = handle_one(&state, &agent, &token, item) {
                    responses.push(response);
                }
            }
            if responses.is_empty() {
                accepted()
            } else {
                rpc_http(&accept, Value::Array(responses))
            }
        }
        single => {
            // `wait_for_messages` est le seul outil bloquant : traite en async,
            // hors du chemin synchrone `handle_one`.
            if let Some((id, args)) = wait_call(&single) {
                let result = run_wait_for_messages(&state, &agent, &args).await;
                return rpc_http(&accept, rpc_ok(id, result));
            }
            match handle_one(&state, &agent, &token, &single) {
                Some(response) => rpc_http(&accept, response),
                // Notification (pas d'id) : rien a renvoyer.
                None => accepted(),
            }
        }
    }
}

/// Detecte un appel unique a `wait_for_messages` et renvoie (id, arguments).
fn wait_call(msg: &Value) -> Option<(Value, Value)> {
    if msg.get("method").and_then(Value::as_str) != Some("tools/call") {
        return None;
    }
    if msg.pointer("/params/name").and_then(Value::as_str) != Some("wait_for_messages") {
        return None;
    }
    let id = msg.get("id").cloned()?;
    let args = msg.pointer("/params/arguments").cloned().unwrap_or(json!({}));
    Some((id, args))
}

async fn run_wait_for_messages(state: &RoomState, agent: &AgentInfo, args: &Value) -> Value {
    let since = args.get("since").and_then(Value::as_u64).unwrap_or(0);
    let timeout_ms = args
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(WAIT_DEFAULT_MS)
        .clamp(0, WAIT_MAX_MS);
    let messages = state
        .wait_for(&agent.ident, since, Duration::from_millis(timeout_ms))
        .await;
    let cursor = messages.iter().map(|m| m.id).max().unwrap_or(since);
    tool_ok(json!({ "messages": messages, "cursor": cursor }))
}

/// Traite un message JSON-RPC. Renvoie `Some(reponse)` pour une requete,
/// `None` pour une notification.
fn handle_one(state: &RoomState, agent: &AgentInfo, token: &str, msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let id = msg.get("id").cloned();

    // Notifications (pas d'`id`) : on ne repond pas.
    if id.is_none() {
        return None;
    }
    let id = id.unwrap();

    match method {
        "initialize" => {
            state
                .inner
                .initialize_count
                .fetch_add(1, Ordering::Relaxed);
            let protocol = msg
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_PROTOCOL_VERSION)
                .to_string();
            Some(rpc_ok(
                id,
                json!({
                    "protocolVersion": protocol,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "codex-switch-agent-room", "version": env!("CARGO_PKG_VERSION") }
                }),
            ))
        }
        "ping" => Some(rpc_ok(id, json!({}))),
        "tools/list" => {
            state.inner.tools_list_count.fetch_add(1, Ordering::Relaxed);
            Some(rpc_ok(id, json!({ "tools": tools_schema() })))
        }
        "tools/call" => {
            let name = msg
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let empty = json!({});
            let args = msg.pointer("/params/arguments").unwrap_or(&empty);
            Some(rpc_ok(id, call_tool(state, agent, token, name, args)))
        }
        // Requetes non supportees : erreur "method not found".
        _ => Some(rpc_err(id, -32601, &format!("methode inconnue: {method}"))),
    }
}

// ---------------------------------------------------------------------------
// Outils MCP
// ---------------------------------------------------------------------------

fn tools_schema() -> Value {
    json!([
        {
            "name": "whoami",
            "description": "Renvoie ta propre identite dans le salon (ton ident public, ton label, ton compte) et le nombre d'agents presents.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "list_agents",
            "description": "Liste les autres agents actuellement presents dans le salon (ident public a utiliser pour un message prive, label, dossier de travail).",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "send_message",
            "description": "Envoie un message. Sans 'to', il est diffuse a tout le salon. Avec 'to' (un ident public renvoye par list_agents), c'est un message prive a cet agent.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Le contenu du message." },
                    "to": { "type": "string", "description": "Ident public du destinataire pour un message prive. Omets pour diffuser au salon." }
                },
                "required": ["text"],
                "additionalProperties": false
            }
        },
        {
            "name": "read_messages",
            "description": "Lit les messages qui te concernent (diffusions du salon + messages prives pour toi) posterieurs au curseur 'since'. Renvoie aussi un nouveau curseur a reutiliser.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "since": { "type": "integer", "description": "Ne renvoyer que les messages dont l'id est superieur a cette valeur (0 pour tout depuis le debut)." }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "wait_for_messages",
            "description": "Comme read_messages mais BLOQUE jusqu'a l'arrivee d'un nouveau message te concernant (ou expiration du delai). Utile pour attendre la reponse d'un autre agent sans interroger en boucle.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "since": { "type": "integer", "description": "Ne renvoyer que les messages dont l'id est superieur a cette valeur." },
                    "timeoutMs": { "type": "integer", "description": "Delai d'attente max en millisecondes (defaut 25000, max 55000)." }
                },
                "additionalProperties": false
            }
        }
    ])
}

fn call_tool(state: &RoomState, agent: &AgentInfo, token: &str, name: &str, args: &Value) -> Value {
    match name {
        "whoami" => tool_ok(json!({
            "ident": agent.ident,
            "label": agent.label,
            "accountId": agent.account_id,
            "agentId": agent.agent_id,
            "cwd": agent.cwd,
            "presentAgents": state.present_agents().len(),
        })),
        "list_agents" => {
            let others: Vec<Value> = state
                .present_agents()
                .into_iter()
                .filter(|a| a.ident != agent.ident)
                .map(|a| {
                    json!({
                        "ident": a.ident,
                        "label": a.label,
                        "agentId": a.agent_id,
                        "cwd": a.cwd,
                    })
                })
                .collect();
            tool_ok(json!({ "agents": others }))
        }
        "send_message" => {
            let text = args.get("text").and_then(Value::as_str).unwrap_or("").trim();
            if text.is_empty() {
                return tool_err("le champ 'text' est requis et non vide");
            }
            if !state.try_consume_send(token) {
                return tool_err(
                    "quota d'envoi temporairement epuise (rate-limit), reessaie dans un instant",
                );
            }
            let to = args
                .get("to")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            if let Some(target) = &to {
                if target == &agent.ident {
                    return tool_err("impossible de s'envoyer un message a soi-meme");
                }
                if !state.ident_exists(target) {
                    return tool_err(&format!(
                        "destinataire inconnu: '{target}' (utilise list_agents pour les idents valides)"
                    ));
                }
            }
            let kind = if to.is_some() { MsgKind::Dm } else { MsgKind::Room };
            let message = state.post(&agent.ident, &agent.label, to.clone(), kind, text.to_string());
            tool_ok(json!({
                "id": message.id,
                "deliveredTo": to.unwrap_or_else(|| "room".to_string()),
            }))
        }
        "read_messages" => {
            let since = args.get("since").and_then(Value::as_u64).unwrap_or(0);
            let messages = state.messages_for(&agent.ident, since);
            let cursor = messages.iter().map(|m| m.id).max().unwrap_or(since);
            tool_ok(json!({ "messages": messages, "cursor": cursor }))
        }
        // Le vrai long-poll passe par `run_wait_for_messages` (async) dans
        // `mcp_post` ; ici c'est le fallback non-bloquant (appel en lot).
        "wait_for_messages" => {
            let since = args.get("since").and_then(Value::as_u64).unwrap_or(0);
            let messages = state.messages_for(&agent.ident, since);
            let cursor = messages.iter().map(|m| m.id).max().unwrap_or(since);
            tool_ok(json!({ "messages": messages, "cursor": cursor }))
        }
        _ => tool_err(&format!("outil inconnu: {name}")),
    }
}

/// Enveloppe MCP d'un resultat d'outil : le contenu texte est le JSON serialise.
fn tool_ok(value: Value) -> Value {
    json!({
        "content": [ { "type": "text", "text": value.to_string() } ],
        "isError": false
    })
}

fn tool_err(message: &str) -> Value {
    json!({
        "content": [ { "type": "text", "text": message } ],
        "isError": true
    })
}

// ---------------------------------------------------------------------------
// Helpers JSON-RPC / HTTP
// ---------------------------------------------------------------------------

fn rpc_ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_err(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn parse_error(detail: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("JSON invalide: {detail}") } })
}

/// Encadre une reponse JSON-RPC selon l'en-tete `Accept` du client : en
/// `text/event-stream` (un seul evenement) si demande, sinon `application/json`.
fn rpc_http(accept: &str, value: Value) -> Response {
    if accept.contains("text/event-stream") {
        let body = format!("event: message\ndata: {}\n\n", value);
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(Body::from(body))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    } else {
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(value.to_string()))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    }
}

/// Reponse a une notification / lot vide : 202 sans corps.
fn accepted() -> Response {
    StatusCode::ACCEPTED.into_response()
}

// ---------------------------------------------------------------------------
// Provisioning de config.toml (via le CLI codex, merge-safe)
// ---------------------------------------------------------------------------

/// Idempotent : verifie via `codex mcp get agent_room` ; si absent (ou URL
/// differente), (re)ajoute via `codex mcp add ... --url <url>
/// --bearer-token-env-var CST_ROOM_TOKEN`. `codex` fusionne dans le config.toml
/// existant sans ecraser les autres entrees.
pub fn provision(codex_bin: &str, codex_home: &Path, url: &str) -> Result<(), String> {
    let get = Command::new(codex_bin)
        .args(["mcp", "get", "agent_room"])
        .env("CODEX_HOME", codex_home)
        .output();

    if let Ok(output) = &get {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            if text.contains(url) {
                // Deja provisionne avec la bonne URL : rien a faire.
                return Ok(());
            }
            // Present mais URL differente (ex. port change) : on retire avant de
            // reajouter proprement.
            deprovision(codex_bin, codex_home);
        }
    }

    let add = Command::new(codex_bin)
        .args([
            "mcp",
            "add",
            "agent_room",
            "--url",
            url,
            "--bearer-token-env-var",
            "CST_ROOM_TOKEN",
        ])
        .env("CODEX_HOME", codex_home)
        .output()
        .map_err(|e| format!("lancement de `{codex_bin} mcp add` impossible: {e}"))?;

    if add.status.success() {
        Ok(())
    } else {
        Err(format!(
            "`codex mcp add` a echoue: {}",
            String::from_utf8_lossy(&add.stderr).trim()
        ))
    }
}

/// Retire l'entree du salon (best-effort : un retrait d'une entree absente
/// n'est pas une erreur bloquante).
pub fn deprovision(codex_bin: &str, codex_home: &Path) {
    let _ = Command::new(codex_bin)
        .args(["mcp", "remove", "agent_room"])
        .env("CODEX_HOME", codex_home)
        .output();
}

fn unauthorized() -> Response {
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "error": "token de salon inconnu (agent non enregistre)" }).to_string(),
        ))
        .unwrap_or_else(|_| StatusCode::UNAUTHORIZED.into_response())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(label: &str) -> AgentMeta {
        AgentMeta {
            agent_id: "codex".to_string(),
            account_id: "acc".to_string(),
            label: label.to_string(),
            cwd: Some("C:/proj".to_string()),
        }
    }

    fn call(state: &RoomState, token: &str, name: &str, args: Value) -> Value {
        let agent = state.lookup(token).expect("agent enregistre");
        let msg = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": name, "arguments": args }
        });
        let response = handle_one(state, &agent, token, &msg).expect("reponse");
        response["result"].clone()
    }

    /// Decode l'unique bloc texte d'un resultat d'outil MCP en JSON.
    fn tool_json(result: &Value) -> Value {
        let text = result["content"][0]["text"].as_str().unwrap();
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn initialize_echoes_protocol_and_declares_tools() {
        let state = RoomState::new();
        let token = state.register(meta("A"));
        let agent = state.lookup(&token).unwrap();

        let init = json!({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": { "protocolVersion": "2025-03-26", "capabilities": {} }
        });
        let resp = handle_one(&state, &agent, &token, &init).unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2025-03-26");
        assert!(resp["result"]["capabilities"]["tools"].is_object());

        let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
        let resp = handle_one(&state, &agent, &token, &list).unwrap();
        let names: Vec<&str> = resp["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"whoami"));
        assert!(names.contains(&"send_message"));
        assert!(names.contains(&"read_messages"));
        assert!(names.contains(&"list_agents"));
    }

    #[test]
    fn notification_yields_no_response() {
        let state = RoomState::new();
        let token = state.register(meta("A"));
        let agent = state.lookup(&token).unwrap();
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(handle_one(&state, &agent, &token, &note).is_none());
    }

    #[test]
    fn unknown_method_is_rpc_error() {
        let state = RoomState::new();
        let token = state.register(meta("A"));
        let agent = state.lookup(&token).unwrap();
        let msg = json!({ "jsonrpc": "2.0", "id": 9, "method": "resources/list" });
        let resp = handle_one(&state, &agent, &token, &msg).unwrap();
        assert_eq!(resp["error"]["code"], -32601);
    }

    #[test]
    fn whoami_returns_own_identity() {
        let state = RoomState::new();
        let token = state.register(meta("Alice"));
        let result = call(&state, &token, "whoami", json!({}));
        let body = tool_json(&result);
        assert_eq!(body["label"], "Alice");
        assert!(body["ident"].as_str().unwrap().starts_with("alice-"));
    }

    #[test]
    fn broadcast_is_visible_to_all_but_dm_is_private() {
        let state = RoomState::new();
        let a = state.register(meta("A"));
        let b = state.register(meta("B"));
        let c = state.register(meta("C"));
        let ident_b = state.lookup(&b).unwrap().ident;

        // A diffuse au salon.
        call(&state, &a, "send_message", json!({ "text": "coucou salon" }));
        // A envoie un DM a B.
        call(&state, &a, "send_message", json!({ "text": "prive B", "to": ident_b }));

        let read = |token: &str| -> Vec<String> {
            let result = call(&state, token, "read_messages", json!({ "since": 0 }));
            tool_json(&result)["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["text"].as_str().unwrap().to_string())
                .collect()
        };

        let b_texts = read(&b);
        assert!(b_texts.iter().any(|t| t == "coucou salon"));
        assert!(b_texts.iter().any(|t| t == "prive B"));

        let c_texts = read(&c);
        assert!(c_texts.iter().any(|t| t == "coucou salon"));
        assert!(
            !c_texts.iter().any(|t| t == "prive B"),
            "C ne doit pas voir le DM A->B"
        );
    }

    #[test]
    fn dm_to_unknown_recipient_errors() {
        let state = RoomState::new();
        let a = state.register(meta("A"));
        let result = call(
            &state,
            &a,
            "send_message",
            json!({ "text": "hey", "to": "fantome-99" }),
        );
        assert_eq!(result["isError"], true);
    }

    #[test]
    fn read_messages_cursor_advances() {
        let state = RoomState::new();
        let a = state.register(meta("A"));
        let b = state.register(meta("B"));
        // Purge l'historique (messages systeme d'arrivee) via un premier read.
        let first = call(&state, &b, "read_messages", json!({ "since": 0 }));
        let cursor = tool_json(&first)["cursor"].as_u64().unwrap();

        call(&state, &a, "send_message", json!({ "text": "nouveau" }));
        let second = call(&state, &b, "read_messages", json!({ "since": cursor }));
        let texts: Vec<String> = tool_json(&second)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["text"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(texts, vec!["nouveau".to_string()]);
    }

    #[test]
    fn duplicate_message_is_deduped() {
        let state = RoomState::new();
        let a = state.register(meta("A"));
        let first = call(&state, &a, "send_message", json!({ "text": "identique" }));
        let second = call(&state, &a, "send_message", json!({ "text": "identique" }));
        // Meme id renvoye : le doublon consecutif n'a pas ete rejournalise.
        assert_eq!(tool_json(&first)["id"], tool_json(&second)["id"]);
    }

    #[test]
    fn rate_limit_eventually_blocks() {
        let state = RoomState::new();
        let a = state.register(meta("A"));
        let mut blocked = false;
        // Au-dela de la capacite du bucket, au moins un envoi (avec textes
        // distincts pour eviter la dedup) doit etre refuse.
        for i in 0..(SEND_BUCKET_CAPACITY as usize + 5) {
            let result = call(&state, &a, "send_message", json!({ "text": format!("m{i}") }));
            if result["isError"] == true {
                blocked = true;
                break;
            }
        }
        assert!(blocked, "le rate-limit aurait du finir par bloquer");
    }

    #[test]
    fn persistence_round_trips() {
        let dir = std::env::temp_dir().join(format!("cst-room-{}", uid_for_test()));
        {
            let state = RoomState::with_data_dir(dir.clone());
            let a = state.register(meta("A"));
            call(&state, &a, "send_message", json!({ "text": "persiste-moi" }));
        }
        // Nouveau salon sur le meme repertoire : l'historique est recharge.
        let reloaded = RoomState::with_data_dir(dir.clone());
        let all = reloaded.messages_for("operator", 0);
        assert!(all.iter().any(|m| m.text == "persiste-moi"));
        // next_id reprend apres le max charge : le prochain post a un id superieur.
        let b = reloaded.register(meta("B"));
        let posted = call(&reloaded, &b, "send_message", json!({ "text": "apres-reload" }));
        let new_id = tool_json(&posted)["id"].as_u64().unwrap();
        assert!(new_id > all.iter().map(|m| m.id).max().unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn wait_for_unblocks_on_new_message() {
        let state = RoomState::new();
        let a = state.register(meta("A"));
        let b = state.register(meta("B"));
        let ident_b = state.lookup(&b).unwrap().ident;
        let cursor = state.cursor();

        let waiter = {
            let state = state.clone();
            let ident_b = ident_b.clone();
            tokio::spawn(async move {
                state
                    .wait_for(&ident_b, cursor, Duration::from_secs(5))
                    .await
            })
        };

        // Laisse le waiter s'installer, puis A envoie un DM a B.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let ident_a = state.lookup(&a).unwrap().ident;
        state.post(&ident_a, "A", Some(ident_b), MsgKind::Dm, "reveille-toi");

        let received = waiter.await.unwrap();
        assert!(received.iter().any(|m| m.text == "reveille-toi"));
    }

    fn uid_for_test() -> String {
        uuid::Uuid::new_v4().simple().to_string()
    }

    #[test]
    fn deregister_marks_absent_and_hides_from_list() {
        let state = RoomState::new();
        let a = state.register(meta("A"));
        let b = state.register(meta("B"));
        state.deregister(&b);
        let result = call(&state, &a, "list_agents", json!({}));
        let agents = tool_json(&result);
        let idents: Vec<String> = agents["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["ident"].as_str().unwrap().to_string())
            .collect();
        assert!(idents.is_empty(), "B est parti, la liste pour A doit etre vide");
    }
}
