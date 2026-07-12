mod account_usage;
pub mod agent_room;
mod chat;
mod client_startup;
pub mod devices;
mod discussions;
mod fs_util;
mod kombai;
mod merge_queue;
mod metrics;
mod pool;
mod provider;
mod security;
pub mod server;
mod settings;
mod terminal;
mod worktree;

// `Provider` fait partie de l'API publique (champ de `agent_room::AgentMeta`,
// DTOs serveur) : on le re-exporte pour qu'il soit nommable hors du crate.
pub use settings::Provider;

use agent_room::RoomState;
use pool::PoolManager;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::Manager;

struct PoolRuntime {
    shutdown: tokio::sync::oneshot::Sender<()>,
    manager: Arc<PoolManager>,
}

#[derive(Default)]
struct PoolState {
    runtime: Mutex<Option<PoolRuntime>>,
    terminal_cursor: Mutex<usize>,
}

struct RoomRuntime {
    _shutdown: tokio::sync::oneshot::Sender<()>,
    port: u16,
}

/// Handle d'arret du serveur HTTP du salon. Le `RoomState` (etat partage) est
/// manage separement pour que `terminal.rs` puisse y enregistrer les agents.
#[derive(Default)]
struct RoomServer {
    runtime: Mutex<Option<RoomRuntime>>,
}

const DEFAULT_ROOM_PORT: u16 = 8123;

/// Construit le RoomState persiste (repertoire aligne sur CST_DATA_DIR), avec
/// repli en memoire seule si le repertoire n'est pas resolvable.
fn build_room_state() -> RoomState {
    settings::agent_room_data_dir()
        .map(RoomState::with_data_dir)
        .unwrap_or_else(|_| RoomState::new())
}

/// Bind loopback + serve le routeur MCP du salon ; renvoie le handle d'arret.
async fn serve_room(
    room: RoomState,
    port: u16,
) -> Result<tokio::sync::oneshot::Sender<()>, String> {
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .map_err(|e| format!("port {port} indisponible: {e}"))?;
    let router = agent_room::router(room);
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router.into_make_service())
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Ok(tx)
}

pub fn run() {
    let worktrees = settings::runtime_data_dir()
        .and_then(|root| worktree::WorktreeManager::from_env(root.join("agents")))
        .expect("initialisation du gestionnaire de worktrees impossible");
    let _ = worktrees.sweep_stale(7 * 24 * 60 * 60);
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(terminal::TerminalManager::default())
        .manage(chat::ChatTurnManager::default())
        .manage(worktrees)
        .manage(PoolState::default())
        .manage(build_room_state())
        .manage(RoomServer::default())
        .manage(kombai::KombaiManager::default())
        .setup(|app| {
            // Collaboration workspace native : toujours disponible, sans
            // activation utilisateur. Le port historique reste configurable.
            let port = settings::load_settings_for_terminal()
                .map(|settings| settings.agent_room.port)
                .unwrap_or(DEFAULT_ROOM_PORT);
            let room = app.state::<RoomState>().inner().clone();
            let server = app.state::<RoomServer>();
            match tauri::async_runtime::block_on(serve_room(room, port)) {
                Ok(tx) => {
                    if let Ok(mut guard) = server.runtime.lock() {
                        *guard = Some(RoomRuntime {
                            _shutdown: tx,
                            port,
                        });
                    }
                }
                Err(error) => eprintln!("[workspace_collab] demarrage impossible: {error}"),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Arrete le code-server embarque quand la fenetre se ferme, pour ne
            // pas laisser de process orphelin qui occuperait le port 8899.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                window.state::<kombai::KombaiManager>().shutdown();
            }
        })
        .invoke_handler(tauri::generate_handler![
            settings::load_settings,
            client_startup::client_startup_config,
            settings::save_settings,
            settings::ensure_account_home,
            settings::import_account_docs,
            settings::import_account_json,
            settings::remove_account,
            settings::account_limit_status,
            settings::account_model_catalog,
            settings::pick_project_dir,
            metrics::usage_dashboard,
            account_usage::account_token_usage,
            discussions::list_discussions,
            discussions::list_prompt_history,
            discussions::claim_session_for_terminal,
            discussions::copy_discussion_to_account,
            discussions::move_discussion,
            discussions::export_discussion_transcript,
            discussions::get_discussion_transcript,
            discussions::delete_discussion,
            chat::start_chat_turn,
            chat::chat_turn_status,
            chat::stop_chat_turn,
            terminal::start_terminal,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::stop_terminal,
            terminal::launch_ide,
            kombai::kombai_status,
            kombai::kombai_start,
            kombai::kombai_stop,
            kombai::kombai_install_extension,
            pool_start,
            pool_stop,
            pool_status,
            pool_pick_terminal_account,
            room_status,
            room_messages,
            room_send
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Codex Switch Terminal");
}

fn stop_runtime(state: &PoolState) {
    if let Ok(mut guard) = state.runtime.lock() {
        if let Some(rt) = guard.take() {
            let _ = rt.shutdown.send(());
        }
    }
}

/// Adresse d'ecoute du proxy de pool. Le pool est un proxy PUREMENT LOCAL,
/// consomme via `http://localhost:{port}` : on bind donc sur loopback par
/// defaut. Cela evite la fenetre "Pare-feu Windows Defender / Autoriser l'acces"
/// (declenchee uniquement par un bind sur `0.0.0.0`), qui exige l'admin a chaque
/// lancement tant qu'aucune regle n'est acceptee. Un override explicite reste
/// possible via `CST_POOL_BIND=0.0.0.0:<port>` pour exposer le pool sur le LAN.
fn pool_bind_addr(port: u16) -> String {
    std::env::var("CST_POOL_BIND")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("127.0.0.1:{port}"))
}

#[tauri::command]
async fn pool_start(state: tauri::State<'_, PoolState>) -> Result<Value, String> {
    stop_runtime(&state);

    let settings = settings::load_settings_for_terminal()?;
    let port = settings.pool.port;
    let addr = pool_bind_addr(port);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("port {port} indisponible: {e}"))?;

    let manager = Arc::new(PoolManager::build(&settings)?);
    // Pool local desktop : proxy purement loopback, pas d'admin_token dans ce
    // process -> pas de jeton break-glass (l'auth reste facultative via la cle
    // API du pool si l'utilisateur en configure une).
    let router = pool::router(manager.clone(), None);
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();

    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router.into_make_service())
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });

    if let Ok(mut guard) = state.runtime.lock() {
        *guard = Some(PoolRuntime {
            shutdown: tx,
            manager: manager.clone(),
        });
    }

    pool_snapshot(&manager, true, port)
}

#[tauri::command]
fn pool_stop(state: tauri::State<'_, PoolState>) -> Result<Value, String> {
    stop_runtime(&state);
    Ok(json!({ "running": false }))
}

#[tauri::command]
fn pool_status(state: tauri::State<'_, PoolState>) -> Result<Value, String> {
    let guard = state
        .runtime
        .lock()
        .map_err(|_| "etat pool verrouille".to_string())?;
    match guard.as_ref() {
        Some(rt) => pool_snapshot(&rt.manager, true, rt.manager.config().port),
        None => {
            // Pool a l'arret : on construit quand meme un snapshot depuis les
            // settings pour que l'UI affiche tous les comptes (avec leur statut
            // de tokens) sans avoir a demarrer le serveur.
            let settings = settings::load_settings_for_terminal()?;
            let port = settings.pool.port;
            let manager = Arc::new(PoolManager::build(&settings)?);
            pool_snapshot(&manager, false, port)
        }
    }
}

#[tauri::command]
fn pool_pick_terminal_account(
    state: tauri::State<'_, PoolState>,
) -> Result<settings::AccountProfile, String> {
    let settings = settings::load_settings_for_terminal()?;
    // Le pool ChatGPT ne rotationne que des comptes Codex authentifies (auth.json).
    let accounts = settings
        .accounts
        .into_iter()
        .filter(|account| account.provider == settings::Provider::Codex)
        .filter(settings::account_has_auth_tokens)
        .collect::<Vec<_>>();

    if accounts.is_empty() {
        return Err(
            "Aucun compte Codex avec auth.json dans le pool. Importe d'abord des JSON.".to_string(),
        );
    }

    let mut cursor = state
        .terminal_cursor
        .lock()
        .map_err(|_| "curseur pool verrouille".to_string())?;
    let index = *cursor % accounts.len();
    *cursor = (*cursor + 1) % accounts.len();

    Ok(accounts[index].clone())
}

fn pool_snapshot(manager: &Arc<PoolManager>, running: bool, port: u16) -> Result<Value, String> {
    let views = manager.status_view();
    let total = views.len();
    let idle = views
        .iter()
        .filter(|a| a.status == pool::AccountStatus::Idle)
        .count();
    Ok(json!({
        "running": running,
        "started_at": manager.started_at(),
        "base_url": format!("http://localhost:{port}"),
        "model": manager.config().default_model,
        "upstream": manager.config().upstream,
        "total": total,
        "idle": idle,
        "accounts": views,
    }))
}

// ---------------------------------------------------------------------------
// Collaboration native du workspace
// ---------------------------------------------------------------------------

fn room_running_port(server: &RoomServer) -> Option<u16> {
    server
        .runtime
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|rt| rt.port))
}

#[tauri::command]
fn room_status(
    room: tauri::State<'_, RoomState>,
    server: tauri::State<'_, RoomServer>,
    workspace_path: Option<String>,
) -> Result<Value, String> {
    let running_port = room_running_port(&server);
    let port = running_port.unwrap_or(DEFAULT_ROOM_PORT);
    let room_id = desktop_room_id(workspace_path.as_deref())?;
    let snapshot = room.snapshot_for_room(&room_id);
    Ok(json!({
        "running": running_port.is_some(),
        "port": port,
        "url": format!("http://127.0.0.1:{port}/mcp"),
        "snapshot": snapshot,
    }))
}

#[tauri::command]
fn room_messages(
    room: tauri::State<'_, RoomState>,
    since: Option<u64>,
    workspace_path: Option<String>,
) -> Result<Value, String> {
    let room_id = desktop_room_id(workspace_path.as_deref())?;
    let messages = room.messages_for_room(&room_id, agent_room::OPERATOR_IDENT, since.unwrap_or(0));
    let cursor = messages
        .iter()
        .map(|m| m.id)
        .max()
        .unwrap_or_else(|| since.unwrap_or(0));
    Ok(json!({ "messages": messages, "cursor": cursor }))
}

/// Poste un message au nom de l'operateur humain (UI). `to` = ident public pour
/// un DM, sinon diffusion salon.
#[tauri::command]
fn room_send(
    room: tauri::State<'_, RoomState>,
    text: String,
    to: Option<String>,
    workspace_path: Option<String>,
) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("message vide".to_string());
    }
    let room_id = desktop_room_id(workspace_path.as_deref())?;
    if let Some(target) = to.as_deref() {
        if !room.ident_exists_in_room(&room_id, target) {
            return Err("destinataire absent du dossier actif".to_string());
        }
    }
    let message = room.operator_post_in_room(&room_id, to, text);
    serde_json::to_value(message).map_err(|e| e.to_string())
}

fn desktop_room_id(workspace_path: Option<&str>) -> Result<String, String> {
    let Some(raw) = workspace_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(agent_room::DEFAULT_ROOM_ID.to_string());
    };
    let path = settings::expand_home(raw)?;
    if !path.is_dir() {
        return Err(format!("dossier introuvable: {raw}"));
    }
    Ok(worktree::room_id_for_local_path(&path))
}
