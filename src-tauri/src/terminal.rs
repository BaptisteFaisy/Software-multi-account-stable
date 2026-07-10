use crate::{
    agent_room::{AgentMeta, RoomState},
    metrics,
    settings::{expand_home, load_settings_for_terminal, AccountProfile, AppSettings},
};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter, State};

#[derive(Default, Clone)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<u64, Arc<TerminalSession>>>>,
    next_id: Arc<AtomicU64>,
}

struct TerminalSession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send>>,
    started_at: i64,
    account_id: String,
    account_label: String,
    recorded_end: AtomicBool,
}

impl TerminalManager {
    pub fn active_agent_runs(&self) -> Vec<metrics::ActiveAgentRun> {
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
}

#[derive(Debug, Clone, Serialize)]
struct PtyDataEvent {
    id: u64,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
struct PtyExitEvent {
    id: u64,
}

#[tauri::command]
pub fn start_terminal(
    app: AppHandle,
    state: State<'_, TerminalManager>,
    room: State<'_, RoomState>,
    id: Option<u64>,
    account_id: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
) -> Result<u64, String> {
    let settings = load_settings_for_terminal()?;
    let account = settings
        .accounts
        .iter()
        .find(|candidate| candidate.id == account_id)
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

    let codex_home = expand_home(&account.codex_home)?;
    std::fs::create_dir_all(&codex_home).map_err(|error| error.to_string())?;
    let project_dir = resolve_project_dir(&account)?;

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;

    let mut builder = shell_command(&settings);
    builder.env("CODEX_HOME", codex_home.to_string_lossy().to_string());
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");

    if let Some(project_dir) = &project_dir {
        let project_dir_string = project_dir.to_string_lossy().to_string();
        builder.cwd(project_dir.as_os_str());
        builder.env("PWD", project_dir_string);
    }

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

    // Salon d'agents : si active, on provisionne le CODEX_HOME (entree MCP
    // mergee) puis on injecte un token UNIQUE par terminal pour que le serveur
    // distingue cet agent des autres (meme s'ils partagent un CODEX_HOME).
    let mut room_token: Option<String> = None;
    if settings.agent_room.enabled {
        let url = format!("http://127.0.0.1:{}/mcp", settings.agent_room.port);
        match room.provision_home(&settings.codex_command, &codex_home, &url) {
            Ok(()) => {
                let token = room.register(AgentMeta {
                    agent_id: "codex".to_string(),
                    account_id: account.id.clone(),
                    label: account.label.clone(),
                    cwd: project_dir
                        .as_ref()
                        .map(|path| path.to_string_lossy().to_string()),
                });
                builder.env("CST_ROOM_TOKEN", token.clone());
                room_token = Some(token);
            }
            // Non bloquant : le terminal demarre sans salon si le provisioning
            // echoue (ex. binaire codex introuvable depuis ce process).
            Err(error) => {
                eprintln!(
                    "[agent_room] provisioning ignore pour {}: {error}",
                    account.label
                );
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

    let id = id.unwrap_or_else(|| state.next_id.fetch_add(1, Ordering::Relaxed) + 1);
    let session = Arc::new(TerminalSession {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        started_at: metrics::now_ts(),
        account_id: account.id.clone(),
        account_label: account.label.clone(),
        recorded_end: AtomicBool::new(false),
    });

    state
        .sessions
        .lock()
        .map_err(|_| "Etat terminal verrouille".to_string())?
        .insert(id, session.clone());

    let sessions = state.sessions.clone();
    let reader_app = app.clone();
    let room_state = (*room).clone();
    let room_token_thread = room_token.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                    let _ = reader_app.emit("pty-data", PtyDataEvent { id, data });
                }
                Err(_) => break,
            }
        }

        if let Ok(mut guard) = sessions.lock() {
            if let Some(session) = guard.remove(&id) {
                finish_session(&session);
            }
        }
        // Le PTY s'est ferme (fin naturelle ou kill) : on retire l'agent du salon.
        if let Some(token) = &room_token_thread {
            room_state.deregister(token);
        }
        let _ = reader_app.emit("pty-exit", PtyExitEvent { id });
    });

    emit_banner(
        &app,
        id,
        &account,
        proxy.map(|proxy| proxy.label.as_str()),
        project_dir.as_deref(),
    )?;
    if let Some(command) = command.or_else(|| account.startup_command.clone()) {
        let line = format!("{}\r", command.trim());
        session
            .writer
            .lock()
            .map_err(|_| "Writer terminal verrouille".to_string())?
            .write_all(line.as_bytes())
            .map_err(|error| error.to_string())?;
    }

    Ok(id)
}

#[tauri::command]
pub fn write_terminal(
    state: State<'_, TerminalManager>,
    id: u64,
    data: String,
) -> Result<(), String> {
    let session = get_session(&state, id)?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "Writer terminal verrouille".to_string())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, TerminalManager>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = get_session(&state, id)?;
    let result = {
        let master = session
            .master
            .lock()
            .map_err(|_| "PTY verrouille".to_string())?;
        master.resize(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
    };

    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stop_terminal(state: State<'_, TerminalManager>, id: u64) -> Result<(), String> {
    let Some(session) = state
        .sessions
        .lock()
        .map_err(|_| "Etat terminal verrouille".to_string())?
        .remove(&id)
    else {
        return Ok(());
    };

    let result = {
        let mut child = session
            .child
            .lock()
            .map_err(|_| "Process terminal verrouille".to_string())?;
        finish_session(&session);
        child.kill()
    };

    result.map_err(|error| error.to_string())
}

fn finish_session(session: &Arc<TerminalSession>) {
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

fn get_session(
    state: &State<'_, TerminalManager>,
    id: u64,
) -> Result<Arc<TerminalSession>, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "Etat terminal verrouille".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "Session terminal introuvable".to_string())
}

fn shell_command(settings: &AppSettings) -> CommandBuilder {
    let shell = settings.shell.trim();
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

fn resolve_project_dir(account: &AccountProfile) -> Result<Option<PathBuf>, String> {
    let Some(raw) = account
        .project_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    let project_dir = expand_home(raw)?;
    if !project_dir.is_dir() {
        return Err(format!("Dossier projet introuvable: {raw}"));
    }

    Ok(Some(project_dir))
}

fn emit_banner(
    app: &AppHandle,
    id: u64,
    account: &AccountProfile,
    proxy_label: Option<&str>,
    project_dir: Option<&Path>,
) -> Result<(), String> {
    let proxy = proxy_label.unwrap_or("sans proxy");
    let project = project_dir
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "dossier par defaut".to_string());
    let banner = format!(
        "\r\n[Codex Switch Terminal] session #{id} | compte: {} | CODEX_HOME: {} | projet: {project} | proxy: {proxy}\r\n\r\n",
        account.label, account.codex_home
    );

    app.emit("pty-data", PtyDataEvent { id, data: banner })
        .map_err(|error| error.to_string())
}

/// Lance un editeur (agent "ide", ex. Kombai dans VS Code / Cursor / Windsurf /
/// Trae / Antigravity / Kiro) ouvert sur le dossier projet. Le process editeur
/// est detache : il survit a la fermeture de l'application.
#[tauri::command]
pub fn launch_ide(command: String, project_dir: Option<String>) -> Result<(), String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("Commande IDE vide".to_string());
    }

    let dir = match project_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(raw) => {
            let path = expand_home(raw)?;
            if !path.is_dir() {
                return Err(format!("Dossier projet introuvable: {raw}"));
            }
            Some(path)
        }
        None => None,
    };

    let mut builder = ide_command(&command, dir.as_deref());
    builder
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        builder.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    builder
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Lancement IDE impossible ({command}): {error}"))
}

fn ide_command(command: &str, project_dir: Option<&Path>) -> Command {
    if cfg!(windows) {
        // Les lanceurs d'editeurs (code, cursor, windsurf, ...) sont des scripts
        // .cmd sur le PATH : on passe par cmd.exe. On ne cite pas la commande
        // (pour laisser passer d'eventuels flags) ; seul le chemin est cite.
        let mut line = command.to_string();
        if let Some(path) = project_dir {
            line.push(' ');
            line.push_str(&quote_windows_arg(&path.to_string_lossy()));
        }
        let mut builder = Command::new("cmd.exe");
        builder.arg("/S").arg("/C").arg(line);
        if let Some(path) = project_dir {
            builder.current_dir(path);
        }
        builder
    } else {
        let mut parts = command.split_whitespace();
        let program = parts.next().unwrap_or(command);
        let mut builder = Command::new(program);
        builder.args(parts);
        if let Some(path) = project_dir {
            builder.arg(path);
            builder.current_dir(path);
        }
        builder
    }
}

fn quote_windows_arg(value: &str) -> String {
    if value.contains([' ', '\t']) && !value.starts_with('"') {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
}
