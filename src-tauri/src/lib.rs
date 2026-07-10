mod account_usage;
pub mod agent_room;
mod client_startup;
mod discussions;
mod kombai;
mod metrics;
mod pool;
pub mod server;
mod settings;
mod terminal;

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
    shutdown: tokio::sync::oneshot::Sender<()>,
    port: u16,
}

/// Handle d'arret du serveur HTTP du salon. Le `RoomState` (etat partage) est
/// manage separement pour que `terminal.rs` puisse y enregistrer les agents.
#[derive(Default)]
struct RoomServer {
    runtime: Mutex<Option<RoomRuntime>>,
}

const DEFAULT_ROOM_PORT: u16 = 8123;

fn stop_room(server: &RoomServer) {
    if let Ok(mut guard) = server.runtime.lock() {
        if let Some(rt) = guard.take() {
            let _ = rt.shutdown.send(());
        }
    }
}

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
    tauri::Builder::default()
        .manage(terminal::TerminalManager::default())
        .manage(PoolState::default())
        .manage(build_room_state())
        .manage(RoomServer::default())
        .manage(kombai::KombaiManager::default())
        .setup(|app| {
            // Auto-demarrage du salon au boot s'il est active dans les settings.
            if let Ok(settings) = settings::load_settings_for_terminal() {
                if settings.agent_room.enabled {
                    let room = app.state::<RoomState>().inner().clone();
                    let server = app.state::<RoomServer>();
                    let port = settings.agent_room.port;
                    if let Ok(tx) = tauri::async_runtime::block_on(serve_room(room, port)) {
                        if let Ok(mut guard) = server.runtime.lock() {
                            *guard = Some(RoomRuntime { shutdown: tx, port });
                        }
                    }
                }
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
            settings::pick_project_dir,
            metrics::usage_dashboard,
            account_usage::account_token_usage,
            discussions::list_discussions,
            discussions::list_prompt_history,
            discussions::claim_session_for_terminal,
            discussions::copy_discussion_to_account,
            discussions::delete_discussion,
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
            room_enable,
            room_disable,
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

#[tauri::command]
async fn pool_start(state: tauri::State<'_, PoolState>) -> Result<Value, String> {
    stop_runtime(&state);

    let settings = settings::load_settings_for_terminal()?;
    let port = settings.pool.port;
    let addr = format!("0.0.0.0:{port}");

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("port {port} indisponible: {e}"))?;

    let manager = Arc::new(PoolManager::build(&settings)?);
    let router = pool::router(manager.clone());
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
    let accounts = settings
        .accounts
        .into_iter()
        .filter(settings::account_has_auth_tokens)
        .collect::<Vec<_>>();

    if accounts.is_empty() {
        return Err(
            "Aucun compte avec auth.json dans le pool. Importe d'abord des JSON.".to_string(),
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
// Salon d'agents (Agent Room)
// ---------------------------------------------------------------------------

fn room_running_port(server: &RoomServer) -> Option<u16> {
    server
        .runtime
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|rt| rt.port))
}

/// Active le salon : persiste `enabled=true` + le port, et demarre le serveur
/// MCP loopback. Le provisioning des `CODEX_HOME` se fait paresseusement au
/// lancement de chaque terminal (cf. `terminal::start_terminal`).
#[tauri::command]
async fn room_enable(
    room: tauri::State<'_, RoomState>,
    server: tauri::State<'_, RoomServer>,
    port: Option<u16>,
) -> Result<Value, String> {
    let mut settings = settings::load_settings_for_terminal()?;
    if let Some(p) = port {
        settings.agent_room.port = p;
    }
    settings.agent_room.enabled = true;
    let port = settings.agent_room.port;
    settings::save_settings(settings)?;

    stop_room(&server);
    let tx = serve_room(room.inner().clone(), port).await?;
    if let Ok(mut guard) = server.runtime.lock() {
        *guard = Some(RoomRuntime { shutdown: tx, port });
    }
    Ok(json!({ "running": true, "port": port, "url": format!("http://127.0.0.1:{port}/mcp") }))
}

/// Desactive le salon : arrete le serveur, persiste `enabled=false`, et retire
/// l'entree `[mcp_servers.agent_room]` de chaque `CODEX_HOME` (reversible).
#[tauri::command]
fn room_disable(
    room: tauri::State<'_, RoomState>,
    server: tauri::State<'_, RoomServer>,
) -> Result<Value, String> {
    stop_room(&server);
    let mut settings = settings::load_settings_for_terminal()?;
    settings.agent_room.enabled = false;
    let codex_bin = settings.codex_command.clone();
    // Deprovision de chaque compte (best-effort).
    for account in &settings.accounts {
        if let Ok(home) = settings::expand_home(&account.codex_home) {
            room.deprovision_home(&codex_bin, &home);
        }
    }
    settings::save_settings(settings)?;
    Ok(json!({ "running": false }))
}

#[tauri::command]
fn room_status(
    room: tauri::State<'_, RoomState>,
    server: tauri::State<'_, RoomServer>,
) -> Result<Value, String> {
    let running_port = room_running_port(&server);
    let port = running_port.unwrap_or(DEFAULT_ROOM_PORT);
    let snapshot = room.snapshot();
    Ok(json!({
        "running": running_port.is_some(),
        "port": port,
        "url": format!("http://127.0.0.1:{port}/mcp"),
        "snapshot": snapshot,
    }))
}

#[tauri::command]
fn room_messages(room: tauri::State<'_, RoomState>, since: Option<u64>) -> Result<Value, String> {
    let messages = room.messages_for(agent_room::OPERATOR_IDENT, since.unwrap_or(0));
    let cursor = messages.iter().map(|m| m.id).max().unwrap_or_else(|| since.unwrap_or(0));
    Ok(json!({ "messages": messages, "cursor": cursor }))
}

/// Poste un message au nom de l'operateur humain (UI). `to` = ident public pour
/// un DM, sinon diffusion salon.
#[tauri::command]
fn room_send(
    room: tauri::State<'_, RoomState>,
    text: String,
    to: Option<String>,
) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("message vide".to_string());
    }
    let message = room.operator_post(to, text);
    serde_json::to_value(message).map_err(|e| e.to_string())
}
