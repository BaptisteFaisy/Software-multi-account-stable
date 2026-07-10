use crate::{
    account_usage,
    agent_room::{self, AgentMeta, RoomState},
    discussions,
    kombai::{KombaiManager, KombaiStatus},
    metrics,
    pool::{self, AccountStatus, PoolManager},
    settings::{self, AppSettings},
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxumPath, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime},
};
use tokio::sync::broadcast;
use tower_http::{cors::CorsLayer, services::ServeDir};
use uuid::Uuid;

const WORKSPACE_RETENTION_SECS: u64 = 7 * 24 * 60 * 60;

/// Version du binaire, exposee par `/healthz`, `/api/health` et `--version`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Commit git embarque au build (voir `build.rs`). "unknown" si indisponible.
pub const COMMIT: &str = match option_env!("CST_GIT_COMMIT") {
    Some(value) => value,
    None => "unknown",
};

#[derive(Debug, Clone)]
pub struct ServerConfig {
    bind: String,
    data_dir: PathBuf,
    static_dir: PathBuf,
    admin_token: String,
    git_pat: String,
    public_base_url: String,
    node_id: String,
    node_label: String,
    node_capacity: usize,
}

#[derive(Clone)]
struct ServerState {
    config: ServerConfig,
    terminals: RemoteTerminalManager,
    kombai: Arc<KombaiManager>,
    /// Salon d'agents partage (serveur MCP monte a `/mcp`).
    room: RoomState,
    started_at: i64,
    /// Quand true, le noeud refuse les NOUVEAUX terminaux (503) et se signale
    /// `draining`/non `ready` ; les sessions deja ouvertes continuent. En
    /// memoire uniquement : un redemarrage repart non draine (voulu par
    /// l'updater qui redemarre apres la bascule).
    draining: Arc<AtomicBool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartTerminalRequest {
    id: Option<u64>,
    account_id: String,
    repo_url: String,
    branch: Option<String>,
    cols: u16,
    rows: u16,
    command: Option<String>,
    agent_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartTerminalResponse {
    id: u64,
    workspace_id: String,
    workspace_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    node_id: String,
    node_label: String,
    public_base_url: String,
    version: &'static str,
    commit: &'static str,
    ready: bool,
    draining: bool,
    active_terminals: usize,
    capacity: usize,
    started_at: i64,
}

/// Liveness minimale NON authentifiee (`GET /healthz`), pour l'updater,
/// l'orchestrateur rolling et le routage client. Aucun secret : ni token, ni
/// compte, ni usage.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LivenessResponse {
    ok: bool,
    node_id: String,
    version: &'static str,
    commit: &'static str,
    ready: bool,
    draining: bool,
    active_terminals: usize,
    capacity: usize,
}

#[derive(Debug, Deserialize)]
struct DrainRequest {
    draining: bool,
}

#[derive(Debug, Deserialize)]
struct ImportAccountRequest {
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnsureAccountHomeRequest {
    codex_home: String,
}

#[derive(Debug, Deserialize)]
struct WriteTerminalRequest {
    data: String,
}

#[derive(Debug, Deserialize)]
struct ResizeTerminalRequest {
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KombaiStartRequest {
    project_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyDiscussionRequest {
    session_id: String,
    source_account_id: String,
    target_account_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimSessionRequest {
    account_id: String,
    after_unix: i64,
    #[serde(default)]
    exclude_session_ids: Vec<String>,
    #[serde(default)]
    match_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteDiscussionRequest {
    account_id: String,
    session_id: String,
    #[serde(default)]
    archive: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceView {
    id: String,
    path: String,
    modified_at: Option<i64>,
    retained_until: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerWsMessage {
    Data {
        id: u64,
        data: String,
    },
    Exit {
        id: u64,
    },
    Error {
        id: u64,
        message: String,
    },
    Status {
        id: u64,
        status: String,
        workspace_id: String,
        workspace_path: String,
    },
    Pong {
        id: u64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientWsMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Stop,
    Ping,
}

#[derive(Clone, Default)]
struct RemoteTerminalManager {
    sessions: Arc<Mutex<HashMap<u64, Arc<RemoteTerminalSession>>>>,
    next_id: Arc<AtomicU64>,
}

struct RemoteTerminalSession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send>>,
    events: broadcast::Sender<ServerWsMessage>,
    started_at: i64,
    account_id: String,
    account_label: String,
    workspace_id: String,
    workspace_path: PathBuf,
    recorded_end: AtomicBool,
}

impl RemoteTerminalManager {
    fn active_agent_runs(&self) -> Vec<metrics::ActiveAgentRun> {
        let Ok(guard) = self.sessions.lock() else {
            return Vec::new();
        };

        guard
            .values()
            .filter(|session| !session.recorded_end.load(Ordering::Relaxed))
            .map(|session| metrics::ActiveAgentRun {
                started_at: session.started_at,
            })
            .collect()
    }

    fn active_count(&self) -> usize {
        self.sessions
            .lock()
            .map(|guard| guard.len())
            .unwrap_or_default()
    }

    fn start(
        &self,
        config: &ServerConfig,
        room: &RoomState,
        request: StartTerminalRequest,
    ) -> Result<StartTerminalResponse, String> {
        let settings = settings::load_settings_for_terminal()?;
        let account = settings
            .accounts
            .iter()
            .find(|candidate| candidate.id == request.account_id)
            .cloned()
            .ok_or_else(|| "Compte Codex introuvable".to_string())?;
        let proxy = if settings.proxy_controls_enabled {
            account.proxy_id.as_ref().and_then(|id| {
                settings
                    .proxies
                    .iter()
                    .find(|candidate| candidate.id == *id)
            })
        } else {
            None
        };

        let id = request
            .id
            .unwrap_or_else(|| self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let workspace_id = format!("{id}-{}", Uuid::new_v4().simple());
        let workspace_root = config.data_dir.join("workspaces").join(&workspace_id);
        let repo_dir = workspace_root.join("repo");
        let repo_label = prepare_workspace(
            &request.repo_url,
            request.branch.as_deref(),
            &repo_dir,
            &config.git_pat,
        )
        .map_err(|error| redact_secrets(&error, config))?;

        let codex_home = settings::expand_home(&account.codex_home)?;
        fs::create_dir_all(&codex_home).map_err(|error| error.to_string())?;

        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: request.rows.max(8),
                cols: request.cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;

        let mut builder = shell_command(&settings);
        builder.cwd(repo_dir.as_os_str());
        builder.env("CODEX_HOME", codex_home.to_string_lossy().to_string());
        builder.env("TERM", "xterm-256color");
        builder.env("COLORTERM", "truecolor");
        builder.env("PWD", repo_dir.to_string_lossy().to_string());
        builder.env("CST_WORKSPACE_ID", workspace_id.clone());
        builder.env("CST_AGENT_ID", request.agent_id.unwrap_or_default());

        if let Some(proxy) = proxy {
            for key in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            ] {
                builder.env(key, proxy.proxy_url.clone());
            }
        }

        // Salon d'agents (SaaS) : le serveur MCP tourne dans CE process, les
        // agents server-spawned l'atteignent en loopback. On provisionne le
        // CODEX_HOME et on injecte un token unique par terminal.
        let mut room_token: Option<String> = None;
        if settings.agent_room.enabled {
            let port = config
                .bind
                .parse::<SocketAddr>()
                .map(|addr| addr.port())
                .unwrap_or(settings.agent_room.port);
            let url = format!("http://127.0.0.1:{port}/mcp");
            match room.provision_home(&settings.codex_command, &codex_home, &url) {
                Ok(()) => {
                    let token = room.register(AgentMeta {
                        agent_id: "codex".to_string(),
                        account_id: account.id.clone(),
                        label: account.label.clone(),
                        cwd: Some(repo_dir.to_string_lossy().to_string()),
                    });
                    builder.env("CST_ROOM_TOKEN", token.clone());
                    room_token = Some(token);
                }
                Err(error) => {
                    eprintln!("[agent_room] provisioning ignore (SaaS): {error}");
                }
            }
        }

        let child = pair
            .slave
            .spawn_command(builder)
            .map_err(|error| error.to_string())?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let (events, _) = broadcast::channel(512);

        let session = Arc::new(RemoteTerminalSession {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            events: events.clone(),
            started_at: metrics::now_ts(),
            account_id: account.id.clone(),
            account_label: account.label.clone(),
            workspace_id: workspace_id.clone(),
            workspace_path: repo_dir.clone(),
            recorded_end: AtomicBool::new(false),
        });

        self.sessions
            .lock()
            .map_err(|_| "Etat terminal verrouille".to_string())?
            .insert(id, session.clone());

        let sessions = self.sessions.clone();
        let reader_events = events.clone();
        let room_clone = room.clone();
        let room_token_thread = room_token.clone();
        thread::spawn(move || {
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                        let _ = reader_events.send(ServerWsMessage::Data { id, data });
                    }
                    Err(error) => {
                        let _ = reader_events.send(ServerWsMessage::Error {
                            id,
                            message: error.to_string(),
                        });
                        break;
                    }
                }
            }

            if let Ok(mut guard) = sessions.lock() {
                if let Some(session) = guard.remove(&id) {
                    finish_session(&session);
                    let _ = session.events.send(ServerWsMessage::Exit { id });
                }
            }
            if let Some(token) = &room_token_thread {
                room_clone.deregister(token);
            }
        });

        let banner = format!(
            "\r\n[Codex Switch Terminal SaaS] session #{id} | compte: {} | repo: {} | workspace: {}\r\n\r\n",
            account.label,
            repo_label,
            repo_dir.to_string_lossy()
        );
        let _ = events.send(ServerWsMessage::Status {
            id,
            status: "active".to_string(),
            workspace_id: workspace_id.clone(),
            workspace_path: repo_dir.to_string_lossy().to_string(),
        });
        let _ = events.send(ServerWsMessage::Data { id, data: banner });

        if let Some(command) = request.command.or_else(|| account.startup_command.clone()) {
            let line = format!("{}\r", command.trim());
            session
                .writer
                .lock()
                .map_err(|_| "Writer terminal verrouille".to_string())?
                .write_all(line.as_bytes())
                .map_err(|error| error.to_string())?;
        }

        Ok(StartTerminalResponse {
            id,
            workspace_id,
            workspace_path: repo_dir.to_string_lossy().to_string(),
        })
    }

    fn write(&self, id: u64, data: String) -> Result<(), String> {
        let session = self.get(id)?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "Writer terminal verrouille".to_string())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| error.to_string())
    }

    fn resize(&self, id: u64, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.get(id)?;
        let master = session
            .master
            .lock()
            .map_err(|_| "PTY verrouille".to_string())?;
        master
            .resize(PtySize {
                rows: rows.max(8),
                cols: cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())
    }

    fn stop(&self, id: u64) -> Result<(), String> {
        let Some(session) = self
            .sessions
            .lock()
            .map_err(|_| "Etat terminal verrouille".to_string())?
            .remove(&id)
        else {
            return Ok(());
        };

        finish_session(&session);
        let result = session
            .child
            .lock()
            .map_err(|_| "Process terminal verrouille".to_string())?
            .kill();
        let _ = session.events.send(ServerWsMessage::Exit { id });
        result.map_err(|error| error.to_string())
    }

    fn get(&self, id: u64) -> Result<Arc<RemoteTerminalSession>, String> {
        self.sessions
            .lock()
            .map_err(|_| "Etat terminal verrouille".to_string())?
            .get(&id)
            .cloned()
            .ok_or_else(|| "Session terminal introuvable".to_string())
    }
}

fn finish_session(session: &Arc<RemoteTerminalSession>) {
    if session.recorded_end.swap(true, Ordering::Relaxed) {
        return;
    }

    let _ = metrics::record_agent_run(
        &session.account_id,
        &session.account_label,
        session.started_at,
        metrics::now_ts(),
    );
}

pub async fn run_from_env() -> Result<(), String> {
    let config = ServerConfig::from_env()?;
    fs::create_dir_all(config.data_dir.join("workspaces")).map_err(|error| error.to_string())?;
    fs::create_dir_all(config.data_dir.join("codex-homes")).map_err(|error| error.to_string())?;
    fs::create_dir_all(config.data_dir.join("logs")).map_err(|error| error.to_string())?;

    let settings = settings::load_settings_for_terminal()?;
    let pool_manager = Arc::new(PoolManager::build(&settings)?);
    let room = RoomState::with_data_dir(config.data_dir.join("agent-room"));
    let state = Arc::new(ServerState {
        config: config.clone(),
        terminals: RemoteTerminalManager::default(),
        kombai: Arc::new(KombaiManager::default()),
        room: room.clone(),
        started_at: metrics::now_ts(),
        draining: Arc::new(AtomicBool::new(false)),
    });

    spawn_workspace_cleanup(config.data_dir.clone());

    let api = Router::new()
        .route("/health", get(api_health))
        .route("/admin/drain", post(api_admin_drain))
        .route("/settings", get(api_get_settings).put(api_put_settings))
        .route("/accounts", get(api_get_accounts))
        .route("/accounts/import", post(api_import_account))
        .route("/accounts/home", post(api_ensure_account_home))
        .route("/accounts/:id", delete(api_remove_account))
        .route("/limits", get(api_limits))
        .route("/usage", get(api_usage))
        .route("/account-usage", get(api_account_usage))
        .route("/discussions", get(api_list_discussions))
        .route("/discussions/copy", post(api_copy_discussion))
        .route("/discussions/claim", post(api_claim_session))
        .route("/discussions/delete", post(api_delete_discussion))
        .route("/pool/status", get(api_pool_status))
        .route("/pool/start", post(api_pool_status))
        .route("/pool/stop", post(api_pool_stop))
        .route("/terminals", post(api_start_terminal))
        .route("/terminals/:id/write", post(api_write_terminal))
        .route("/terminals/:id/resize", post(api_resize_terminal))
        .route("/terminals/:id", delete(api_stop_terminal))
        .route("/kombai/status", get(api_kombai_status))
        .route("/kombai/start", post(api_kombai_start))
        .route("/kombai/stop", post(api_kombai_stop))
        .route(
            "/kombai/install-extension",
            post(api_kombai_install_extension),
        )
        .route("/workspaces", get(api_workspaces))
        .route("/workspaces/:id", delete(api_delete_workspace))
        .route("/room/status", get(api_room_status))
        .route("/room/messages", get(api_room_messages))
        .route("/room/send", post(api_room_send))
        .with_state(state.clone());

    let ws = Router::new()
        .route("/terminals/:id", get(ws_terminal))
        .with_state(state.clone());

    // Liveness NON authentifiee, a la racine (`/healthz`) : l'auth de ce projet
    // est appliquee par handler, pas par couche de routeur, donc ce handler est
    // simplement lisible sans token.
    let health = Router::new()
        .route("/healthz", get(api_healthz))
        .with_state(state.clone());

    let static_service = ServeDir::new(config.static_dir.clone())
        .not_found_service(ServeDir::new(config.static_dir.clone()));

    let app = Router::new()
        .merge(health)
        .nest("/api", api)
        .nest("/ws", ws)
        .merge(pool::router(pool_manager))
        .merge(agent_room::router(room))
        .fallback_service(static_service)
        .layer(CorsLayer::very_permissive());

    let addr: SocketAddr = config
        .bind
        .parse()
        .map_err(|error| format!("CST_BIND invalide: {error}"))?;
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|error| format!("bind {addr} impossible: {error}"))?;

    println!(
        "Codex Switch Terminal SaaS listening on http://{} (node: {}, capacity: {}, data: {}, static: {})",
        addr,
        config.node_label,
        config.node_capacity,
        config.data_dir.display(),
        config.static_dir.display()
    );

    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| error.to_string())
}

/// Arret propre sur Ctrl-C (SIGINT) ET SIGTERM (envoye par `systemctl restart`
/// / `Stop-ScheduledTask`). Sans la branche SIGTERM, un redemarrage coupait
/// l'HTTP en vol au lieu de laisser Axum terminer les requetes en cours.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

impl ServerConfig {
    fn from_env() -> Result<Self, String> {
        let data_dir = std::env::var_os("CST_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/srv/cst"));
        let bind = std::env::var("CST_BIND").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
        let admin_token = std::env::var("CST_ADMIN_TOKEN")
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        if admin_token.is_empty() {
            return Err("CST_ADMIN_TOKEN est requis pour lancer le serveur SaaS".to_string());
        }

        let static_dir = std::env::var_os("CST_STATIC_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(default_static_dir);
        let public_base_url =
            std::env::var("CST_PUBLIC_BASE_URL").unwrap_or_else(|_| format!("http://{bind}"));
        let node_id =
            std::env::var("CST_NODE_ID").unwrap_or_else(|_| default_node_name(&public_base_url));
        let node_label = std::env::var("CST_NODE_LABEL").unwrap_or_else(|_| node_id.clone());
        let node_capacity = std::env::var("CST_NODE_CAPACITY")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or_else(default_node_capacity);
        Ok(ServerConfig {
            bind,
            data_dir,
            static_dir,
            admin_token,
            git_pat: std::env::var("CST_GIT_PAT").unwrap_or_default(),
            public_base_url,
            node_id,
            node_label,
            node_capacity,
        })
    }
}

fn default_node_name(public_base_url: &str) -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .map(|value| value.trim().to_string())
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| public_base_url.replace([':', '/', '.'], "-"))
}

fn default_node_capacity() -> usize {
    std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .max(1)
}

fn default_static_dir() -> PathBuf {
    std::env::current_dir()
        .ok()
        .and_then(|cwd| cwd.parent().map(|parent| parent.join("dist")))
        .unwrap_or_else(|| PathBuf::from("dist"))
}

async fn api_healthz(State(state): State<Arc<ServerState>>) -> Response {
    let draining = state.draining.load(Ordering::Relaxed);
    json_response(LivenessResponse {
        ok: true,
        node_id: state.config.node_id.clone(),
        version: VERSION,
        commit: COMMIT,
        // `ready` = pret a accepter de NOUVEAUX terminaux. Un noeud en drain se
        // declare non pret (semantique readiness type k8s) tout en restant
        // vivant pour ses sessions en cours.
        ready: !draining,
        draining,
        active_terminals: state.terminals.active_count(),
        capacity: state.config.node_capacity,
    })
}

async fn api_health(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    auth_or(&state, &headers, || {
        let draining = state.draining.load(Ordering::Relaxed);
        Ok(json_response(HealthResponse {
            ok: true,
            node_id: state.config.node_id.clone(),
            node_label: state.config.node_label.clone(),
            public_base_url: state.config.public_base_url.clone(),
            version: VERSION,
            commit: COMMIT,
            ready: !draining,
            draining,
            active_terminals: state.terminals.active_count(),
            capacity: state.config.node_capacity,
            started_at: state.started_at,
        }))
    })
}

async fn api_admin_drain(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(request): Json<DrainRequest>,
) -> Response {
    auth_or(&state, &headers, || {
        state.draining.store(request.draining, Ordering::Relaxed);
        Ok(json_response(json!({
            "draining": request.draining,
            "activeTerminals": state.terminals.active_count(),
        })))
    })
}

async fn api_get_settings(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    auth_or(&state, &headers, || {
        settings::load_settings().map(json_response)
    })
}

async fn api_put_settings(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(settings): Json<AppSettings>,
) -> Response {
    auth_or(&state, &headers, || {
        settings::save_settings(settings).map(json_response)
    })
}

async fn api_get_accounts(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    auth_or(&state, &headers, || {
        settings::load_settings().map(|settings| json_response(settings.accounts))
    })
}

async fn api_import_account(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(request): Json<ImportAccountRequest>,
) -> Response {
    auth_or(&state, &headers, || {
        settings::import_account_json(request.content).map(json_response)
    })
}

async fn api_ensure_account_home(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(request): Json<EnsureAccountHomeRequest>,
) -> Response {
    auth_or(&state, &headers, || {
        settings::ensure_account_home(request.codex_home)
            .map(|_| json_response(json!({ "ok": true })))
    })
}

async fn api_remove_account(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    auth_or(&state, &headers, || {
        settings::remove_account(id).map(json_response)
    })
}

async fn api_limits(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    if let Err(response) = check_admin_header(&state, &headers) {
        return response;
    }

    match settings::account_limit_status().await {
        Ok(value) => json_response(value),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error, &state.config),
    }
}

async fn api_usage(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    auth_or(&state, &headers, || {
        metrics::usage_dashboard_for_server(state.terminals.active_agent_runs()).map(json_response)
    })
}

async fn api_account_usage(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    auth_or(&state, &headers, || {
        account_usage::account_token_usage_dashboard().map(json_response)
    })
}

async fn api_list_discussions(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    auth_or(&state, &headers, || {
        discussions::list_discussions_dashboard().map(json_response)
    })
}

async fn api_copy_discussion(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(request): Json<CopyDiscussionRequest>,
) -> Response {
    auth_or(&state, &headers, || {
        discussions::copy_discussion_between(
            request.session_id,
            request.source_account_id,
            request.target_account_id,
        )
        .map(json_response)
    })
}

async fn api_claim_session(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(request): Json<ClaimSessionRequest>,
) -> Response {
    auth_or(&state, &headers, || {
        discussions::claim_session_for_account(
            request.account_id,
            request.after_unix,
            request.exclude_session_ids,
            request.match_session_id,
        )
        .map(json_response)
    })
}

async fn api_delete_discussion(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(request): Json<DeleteDiscussionRequest>,
) -> Response {
    auth_or(&state, &headers, || {
        discussions::delete_discussion_for_account(
            request.account_id,
            request.session_id,
            request.archive,
        )
        .map(json_response)
    })
}

async fn api_pool_status(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    auth_or(&state, &headers, || {
        let settings = settings::load_settings_for_terminal()?;
        let manager = PoolManager::build(&settings)?;
        Ok(pool_status_response(
            &state.config,
            &settings,
            &manager,
            true,
        ))
    })
}

async fn api_pool_stop(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    auth_or(&state, &headers, || {
        Ok(json_response(json!({ "running": false })))
    })
}

async fn api_start_terminal(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(request): Json<StartTerminalRequest>,
) -> Response {
    // Auth d'abord (401 pour un appelant sans token), puis refus explicite en
    // 503 si le noeud est en drain. On NE passe PAS par auth_or ici : auth_or
    // mappe toute Err en 500, or on veut un 503 distinguable que le client
    // interprete comme "essaie un autre noeud".
    if let Err(response) = check_admin_header(&state, &headers) {
        return response;
    }
    if state.draining.load(Ordering::Relaxed) {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "noeud en drain: nouveaux terminaux refuses",
            &state.config,
        );
    }
    match state
        .terminals
        .start(&state.config, &state.room, request)
    {
        Ok(value) => json_response(value),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error, &state.config),
    }
}

#[derive(Debug, Deserialize)]
struct RoomMessagesQuery {
    since: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoomSendRequest {
    text: String,
    to: Option<String>,
}

async fn api_room_status(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    auth_or(&state, &headers, || {
        Ok(json_response(json!({
            "running": true,
            "snapshot": state.room.snapshot(),
        })))
    })
}

async fn api_room_messages(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Query(query): Query<RoomMessagesQuery>,
) -> Response {
    auth_or(&state, &headers, || {
        let since = query.since.unwrap_or(0);
        let messages = state.room.messages_for(agent_room::OPERATOR_IDENT, since);
        let cursor = messages.iter().map(|m| m.id).max().unwrap_or(since);
        Ok(json_response(json!({ "messages": messages, "cursor": cursor })))
    })
}

async fn api_room_send(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(request): Json<RoomSendRequest>,
) -> Response {
    auth_or(&state, &headers, || {
        let text = request.text.trim().to_string();
        if text.is_empty() {
            return Err("message vide".to_string());
        }
        Ok(json_response(state.room.operator_post(request.to, text)))
    })
}

async fn api_write_terminal(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<u64>,
    Json(request): Json<WriteTerminalRequest>,
) -> Response {
    auth_or(&state, &headers, || {
        state.terminals.write(id, request.data)?;
        Ok(json_response(json!({ "ok": true })))
    })
}

async fn api_resize_terminal(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<u64>,
    Json(request): Json<ResizeTerminalRequest>,
) -> Response {
    auth_or(&state, &headers, || {
        state.terminals.resize(id, request.cols, request.rows)?;
        Ok(json_response(json!({ "ok": true })))
    })
}

async fn api_stop_terminal(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<u64>,
) -> Response {
    auth_or(&state, &headers, || {
        state.terminals.stop(id)?;
        Ok(json_response(json!({ "ok": true })))
    })
}

async fn api_kombai_status(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    auth_or(&state, &headers, || {
        state
            .kombai
            .status()
            .map(|status| json_response(server_kombai_status(&state.config, status)))
    })
}

async fn api_kombai_start(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(request): Json<KombaiStartRequest>,
) -> Response {
    if let Err(response) = check_admin_header(&state, &headers) {
        return response;
    }

    match state.kombai.start(request.project_dir).await {
        Ok(status) => json_response(server_kombai_status(&state.config, status)),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error, &state.config),
    }
}

async fn api_kombai_stop(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    auth_or(&state, &headers, || {
        state
            .kombai
            .stop()
            .map(|status| json_response(server_kombai_status(&state.config, status)))
    })
}

async fn api_kombai_install_extension(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = check_admin_header(&state, &headers) {
        return response;
    }

    match state.kombai.install_extension().await {
        Ok(status) => json_response(server_kombai_status(&state.config, status)),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error, &state.config),
    }
}

async fn api_workspaces(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    auth_or(&state, &headers, || {
        list_workspaces(&state.config.data_dir).map(json_response)
    })
}

async fn api_delete_workspace(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    auth_or(&state, &headers, || {
        delete_workspace(&state.config.data_dir, &id)?;
        Ok(json_response(json!({ "ok": true })))
    })
}

async fn ws_terminal(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<u64>,
    Query(params): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let token = params.get("token").map(String::as_str).unwrap_or("");
    if token != state.config.admin_token {
        if let Err(response) = check_admin_header(&state, &headers) {
            return response;
        }
    }

    let session = match state.terminals.get(id) {
        Ok(session) => session,
        Err(error) => return api_error(StatusCode::NOT_FOUND, &error, &state.config),
    };

    ws.on_upgrade(move |socket| handle_terminal_socket(socket, state, id, session))
}

async fn handle_terminal_socket(
    socket: WebSocket,
    state: Arc<ServerState>,
    id: u64,
    session: Arc<RemoteTerminalSession>,
) {
    let (mut sender, mut receiver) = socket.split();
    let mut events = session.events.subscribe();
    let hello = ServerWsMessage::Status {
        id,
        status: "active".to_string(),
        workspace_id: session.workspace_id.clone(),
        workspace_path: session.workspace_path.to_string_lossy().to_string(),
    };
    let _ = send_ws(&mut sender, &hello).await;

    loop {
        tokio::select! {
            event = events.recv() => {
                match event {
                    Ok(event) => {
                        if send_ws(&mut sender, &event).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = receiver.next() => {
                let Some(Ok(message)) = incoming else {
                    break;
                };
                if let Message::Text(text) = message {
                    match serde_json::from_str::<ClientWsMessage>(&text) {
                        Ok(ClientWsMessage::Input { data }) => {
                            let _ = state.terminals.write(id, data);
                        }
                        Ok(ClientWsMessage::Resize { cols, rows }) => {
                            let _ = state.terminals.resize(id, cols, rows);
                        }
                        Ok(ClientWsMessage::Stop) => {
                            let _ = state.terminals.stop(id);
                            break;
                        }
                        Ok(ClientWsMessage::Ping) => {
                            let _ = send_ws(&mut sender, &ServerWsMessage::Pong { id }).await;
                        }
                        Err(error) => {
                            let event = ServerWsMessage::Error {
                                id,
                                message: format!("message websocket invalide: {error}"),
                            };
                            let _ = send_ws(&mut sender, &event).await;
                        }
                    }
                }
            }
        }
    }
}

async fn send_ws(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event: &ServerWsMessage,
) -> Result<(), axum::Error> {
    let text = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string());
    sender.send(Message::Text(text)).await
}

fn auth_or(
    state: &Arc<ServerState>,
    headers: &HeaderMap,
    f: impl FnOnce() -> Result<Response, String>,
) -> Response {
    if let Err(response) = check_admin_header(state, headers) {
        return response;
    }

    match f() {
        Ok(response) => response,
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error, &state.config),
    }
}

fn check_admin_header(state: &Arc<ServerState>, headers: &HeaderMap) -> Result<(), Response> {
    let bearer = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let provided = bearer.strip_prefix("Bearer ").unwrap_or(bearer).trim();
    if provided == state.config.admin_token {
        Ok(())
    } else {
        Err(api_error(
            StatusCode::UNAUTHORIZED,
            "token admin invalide",
            &state.config,
        ))
    }
}

fn json_response(value: impl Serialize) -> Response {
    Json(value).into_response()
}

fn server_kombai_status(_config: &ServerConfig, status: KombaiStatus) -> KombaiStatus {
    status
}

fn api_error(status: StatusCode, message: &str, config: &ServerConfig) -> Response {
    let message = redact_secrets(message, config);
    (
        status,
        Json(json!({
            "error": {
                "message": message,
                "code": status.as_u16()
            }
        })),
    )
        .into_response()
}

fn pool_status_response(
    config: &ServerConfig,
    settings: &AppSettings,
    manager: &PoolManager,
    running: bool,
) -> Response {
    let views = manager.status_view();
    let total = views.len();
    let idle = views
        .iter()
        .filter(|account| account.status == AccountStatus::Idle)
        .count();
    json_response(json!({
        "running": running,
        "startedAt": manager.started_at(),
        "baseUrl": config.public_base_url,
        "model": settings.pool.default_model,
        "upstream": settings.pool.upstream,
        "total": total,
        "idle": idle,
        "accounts": views,
    }))
}

fn shell_command(settings: &AppSettings) -> CommandBuilder {
    let raw = settings.shell.trim();
    let shell = if raw.is_empty() || (cfg!(unix) && raw.to_ascii_lowercase().contains("powershell"))
    {
        "/bin/bash"
    } else {
        raw
    };
    let mut builder = CommandBuilder::new(shell);
    let lower = shell.to_ascii_lowercase();
    if lower.ends_with("powershell.exe")
        || lower.ends_with("pwsh.exe")
        || lower == "powershell"
        || lower == "pwsh"
    {
        builder.arg("-NoLogo");
    }
    builder
}

fn prepare_workspace(
    repo_url: &str,
    branch: Option<&str>,
    target: &Path,
    git_pat: &str,
) -> Result<String, String> {
    let repo_url = repo_url.trim();
    if repo_url.is_empty() {
        fs::create_dir_all(target).map_err(|error| error.to_string())?;
        return Ok("workspace vide".to_string());
    }

    clone_repo(repo_url, branch, target, git_pat)?;
    Ok(repo_url.to_string())
}

fn clone_repo(
    repo_url: &str,
    branch: Option<&str>,
    target: &Path,
    git_pat: &str,
) -> Result<(), String> {
    let repo_url = validate_repo_url(repo_url)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let authed_url = authenticated_repo_url(&repo_url, git_pat);
    let mut command = Command::new("git");
    command.arg("clone");
    if let Some(branch) = branch.map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--branch").arg(branch);
    }
    command
        .arg(&authed_url)
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = command
        .output()
        .map_err(|error| format!("git clone impossible: {error}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(format!(
        "git clone a echoue ({}): {}{}",
        output.status, stdout, stderr
    ))
}

fn validate_repo_url(repo_url: &str) -> Result<String, String> {
    let value = repo_url.trim();
    if value.is_empty() {
        return Err("repoUrl requis en mode SaaS".to_string());
    }
    if value.contains([' ', '\n', '\r', '\t']) {
        return Err("repoUrl contient un caractere invalide".to_string());
    }
    let allowed = [
        "https://github.com/",
        "https://gitlab.com/",
        "https://bitbucket.org/",
    ];
    if allowed.iter().any(|prefix| value.starts_with(prefix)) {
        Ok(value.to_string())
    } else {
        Err("repoUrl doit commencer par https://github.com/, https://gitlab.com/ ou https://bitbucket.org/".to_string())
    }
}

fn authenticated_repo_url(repo_url: &str, git_pat: &str) -> String {
    let token = git_pat.trim();
    if token.is_empty() || repo_url.contains('@') {
        return repo_url.to_string();
    }
    if let Some(path) = repo_url.strip_prefix("https://github.com/") {
        return format!("https://x-access-token:{token}@github.com/{path}");
    }
    if let Some(path) = repo_url.strip_prefix("https://gitlab.com/") {
        return format!("https://oauth2:{token}@gitlab.com/{path}");
    }
    if let Some(path) = repo_url.strip_prefix("https://bitbucket.org/") {
        return format!("https://x-token-auth:{token}@bitbucket.org/{path}");
    }
    repo_url.to_string()
}

fn redact_secrets(value: &str, config: &ServerConfig) -> String {
    let mut redacted = value.to_string();
    for secret in [&config.git_pat, &config.admin_token] {
        let secret = secret.trim();
        if !secret.is_empty() {
            redacted = redacted.replace(secret, "***");
        }
    }
    redacted
}

fn spawn_workspace_cleanup(data_dir: PathBuf) {
    tokio::spawn(async move {
        loop {
            let _ = cleanup_old_workspaces(&data_dir);
            tokio::time::sleep(Duration::from_secs(60 * 60)).await;
        }
    });
}

fn cleanup_old_workspaces(data_dir: &Path) -> Result<(), String> {
    let now = SystemTime::now();
    let root = data_dir.join("workspaces");
    if !root.is_dir() {
        return Ok(());
    }

    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            continue;
        }
        let modified = metadata.modified().unwrap_or(now);
        let age = now
            .duration_since(modified)
            .unwrap_or_else(|_| Duration::from_secs(0));
        if age.as_secs() >= WORKSPACE_RETENTION_SECS {
            fs::remove_dir_all(entry.path()).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn list_workspaces(data_dir: &Path) -> Result<Vec<WorkspaceView>, String> {
    let root = data_dir.join("workspaces");
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut views = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            continue;
        }
        let modified_at = metadata.modified().ok().and_then(system_time_to_unix);
        views.push(WorkspaceView {
            id: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            modified_at,
            retained_until: modified_at.map(|ts| ts + WORKSPACE_RETENTION_SECS as i64),
        });
    }
    views.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(views)
}

fn delete_workspace(data_dir: &Path, id: &str) -> Result<(), String> {
    if id.contains(['/', '\\']) || id == "." || id == ".." {
        return Err("workspace id invalide".to_string());
    }
    let target = data_dir.join("workspaces").join(id);
    if target.is_dir() {
        fs::remove_dir_all(target).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn system_time_to_unix(value: SystemTime) -> Option<i64> {
    value
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs() as i64)
}
