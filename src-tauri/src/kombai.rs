//! Gestion d'un VS Code embarque (code-server) hebergeant l'extension Kombai,
//! affiche dans l'onglet "Kombai" de l'application. Kombai n'ayant ni CLI ni
//! API, c'est la seule facon de l'utiliser DANS l'app sans ouvrir un editeur
//! externe : on lance un code-server local et on l'affiche dans une iframe.

use crate::settings::{load_settings_for_terminal, KombaiConfig};
use serde::Serialize;
use std::{
    env,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::State;

#[derive(Default)]
pub struct KombaiManager {
    inner: Mutex<Option<Running>>,
    /// Serialise les demarrages : evite qu'un double-clic (ou un redemarrage
    /// pendant que code-server n'ecoute pas encore) spawn deux code-server.
    starting: AtomicBool,
}

impl KombaiManager {
    /// Arrete le code-server suivi. Appele a la fermeture de la fenetre pour ne
    /// pas laisser de process orphelin qui garderait le port occupe.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(mut running) = guard.take() {
                kill_process(&mut running.child);
            }
        }
    }

    pub fn status(&self) -> Result<KombaiStatus, String> {
        let config = load_settings_for_terminal()?.kombai;
        let guard = self
            .inner
            .lock()
            .map_err(|_| "etat kombai verrouille".to_string())?;
        Ok(status_snapshot(&config, &guard, None))
    }

    pub async fn start(&self, project_dir: Option<String>) -> Result<KombaiStatus, String> {
        let config = load_settings_for_terminal()?.kombai;

        {
            let guard = self
                .inner
                .lock()
                .map_err(|_| "etat kombai verrouille".to_string())?;
            if let Some(running) = guard.as_ref() {
                if port_open(running.port) {
                    return Ok(status_snapshot(&config, &guard, None));
                }
            }
        }

        // Un seul demarrage a la fois (les commandes Tauri/API async ne sont pas
        // serialisees, et le Mutex est relache pendant l'await).
        if self.starting.swap(true, Ordering::SeqCst) {
            return Err("Demarrage de Kombai deja en cours".to_string());
        }
        let _start_guard = StartGuard(&self.starting);

        let cfg = config.clone();
        let (child, message) = tauri::async_runtime::spawn_blocking(
            move || -> Result<(Child, Option<String>), String> {
                if find_binary(&cfg.code_server_command).is_none() {
                    return Err(format!(
                        "code-server introuvable ({}). Installe-le (npm i -g code-server) puis reessaie, ou renseigne le chemin dans les reglages.",
                        cfg.code_server_command
                    ));
                }

                let mut message = None;
                if cfg.auto_install_extension && !extension_installed(&cfg) {
                    if let Err(error) = install_extension(&cfg) {
                        message = Some(format!(
                            "code-server demarre mais l'extension Kombai n'a pas pu etre installee ({error}). Installe-la manuellement."
                        ));
                    }
                }

                let child = spawn_code_server(&cfg)?;
                Ok((child, message))
            },
        )
        .await
        .map_err(|error| error.to_string())??;

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "etat kombai verrouille".to_string())?;
        if let Some(mut previous) = guard.take() {
            kill_process(&mut previous.child);
        }
        *guard = Some(Running {
            child,
            port: config.port,
            project_dir,
        });

        Ok(status_snapshot(&config, &guard, message))
    }

    pub fn stop(&self) -> Result<KombaiStatus, String> {
        let config = load_settings_for_terminal()?.kombai;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "etat kombai verrouille".to_string())?;
        if let Some(mut running) = guard.take() {
            kill_process(&mut running.child);
        }
        Ok(status_snapshot(&config, &guard, None))
    }

    pub async fn install_extension(&self) -> Result<KombaiStatus, String> {
        let config = load_settings_for_terminal()?.kombai;
        let cfg = config.clone();
        let message = tauri::async_runtime::spawn_blocking(move || -> Option<String> {
            if find_binary(&cfg.code_server_command).is_none() {
                return Some(format!(
                    "code-server introuvable ({}).",
                    cfg.code_server_command
                ));
            }
            match install_extension(&cfg) {
                Ok(()) => Some(format!("Extension {} installee.", cfg.extension_id)),
                Err(error) => Some(error),
            }
        })
        .await
        .map_err(|error| error.to_string())?;

        let guard = self
            .inner
            .lock()
            .map_err(|_| "etat kombai verrouille".to_string())?;
        Ok(status_snapshot(&config, &guard, message))
    }
}

/// Remet `starting` a false quoi qu'il arrive (retours anticipes via `?`).
struct StartGuard<'a>(&'a AtomicBool);

impl Drop for StartGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct Running {
    child: Child,
    port: u16,
    project_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KombaiStatus {
    /// true uniquement quand code-server ecoute reellement sur le port.
    pub running: bool,
    /// true des qu'un process a ete lance (peut etre en cours de demarrage).
    pub started: bool,
    pub url: Option<String>,
    pub port: u16,
    pub project_dir: Option<String>,
    pub command: String,
    pub binary_available: bool,
    pub extension_id: String,
    pub message: Option<String>,
}

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn url_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Localise le binaire code-server (pour signaler s'il est installe). Sur
/// Windows on cherche aussi les shims .cmd/.exe/.bat.
fn find_binary(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }

    let direct = PathBuf::from(command);
    if direct.is_absolute() || command.contains(['/', '\\']) {
        if direct.is_file() {
            return Some(direct);
        }
        if cfg!(windows) {
            for ext in ["cmd", "exe", "bat"] {
                let candidate = PathBuf::from(format!("{command}.{ext}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        return None;
    }

    let paths = env::var_os("PATH")?;
    let exts: &[&str] = if cfg!(windows) {
        &["", "cmd", "exe", "bat"]
    } else {
        &[""]
    };
    for dir in env::split_paths(&paths) {
        for ext in exts {
            let candidate = if ext.is_empty() {
                dir.join(command)
            } else {
                dir.join(format!("{command}.{ext}"))
            };
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Construit une commande code-server. Sur Windows on passe par cmd.exe pour
/// resoudre les shims .cmd. Tous les arguments sont des flags fixes sans espace
/// (le dossier projet est ouvert via `?folder=` cote iframe, pas en argument),
/// ce qui evite tout probleme de quoting.
fn code_server(binary: &str, args: &[&str]) -> Command {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("cmd.exe");
        command.arg("/C").arg(binary).args(args);
        command
    } else {
        let mut command = Command::new(binary);
        command.args(args);
        command
    };

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    command
}

fn extension_installed(config: &KombaiConfig) -> bool {
    let output = code_server(&config.code_server_command, &["--list-extensions"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();

    match output {
        Ok(output) => {
            let listed = String::from_utf8_lossy(&output.stdout).to_lowercase();
            listed.contains(&config.extension_id.to_lowercase())
        }
        Err(_) => false,
    }
}

fn install_extension(config: &KombaiConfig) -> Result<(), String> {
    let status = code_server(
        &config.code_server_command,
        &["--install-extension", config.extension_id.as_str()],
    )
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .map_err(|error| format!("installation extension impossible: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("code-server a refuse l'installation de l'extension".to_string())
    }
}

fn spawn_code_server(config: &KombaiConfig) -> Result<Child, String> {
    let bind = format!("127.0.0.1:{}", config.port);
    let args = [
        "--bind-addr",
        bind.as_str(),
        "--auth",
        "none",
        "--disable-telemetry",
        "--disable-update-check",
    ];

    code_server(&config.code_server_command, &args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            format!(
                "code-server non lancable ({}): {error}",
                config.code_server_command
            )
        })
}

fn kill_process(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn status_snapshot(
    config: &KombaiConfig,
    running: &Option<Running>,
    message: Option<String>,
) -> KombaiStatus {
    let started = running.is_some();
    let port = running.as_ref().map(|r| r.port).unwrap_or(config.port);
    let listening = started && port_open(port);
    let project_dir = running.as_ref().and_then(|r| r.project_dir.clone());

    KombaiStatus {
        running: listening,
        started,
        url: Some(url_for(port)),
        port,
        project_dir,
        command: config.code_server_command.clone(),
        binary_available: find_binary(&config.code_server_command).is_some(),
        extension_id: config.extension_id.clone(),
        message,
    }
}

#[tauri::command]
pub async fn kombai_status(state: State<'_, KombaiManager>) -> Result<KombaiStatus, String> {
    state.status()
}

#[tauri::command]
pub async fn kombai_start(
    state: State<'_, KombaiManager>,
    project_dir: Option<String>,
) -> Result<KombaiStatus, String> {
    state.start(project_dir).await
}

#[tauri::command]
pub async fn kombai_stop(state: State<'_, KombaiManager>) -> Result<KombaiStatus, String> {
    state.stop()
}

#[tauri::command]
pub async fn kombai_install_extension(
    state: State<'_, KombaiManager>,
) -> Result<KombaiStatus, String> {
    state.install_extension().await
}
