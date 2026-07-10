use serde::Serialize;
use std::{env, fs, path::PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStartupConfig {
    pub remote_mode: bool,
    pub base_url: Option<String>,
    pub token: Option<String>,
}

#[tauri::command]
pub fn client_startup_config() -> ClientStartupConfig {
    let args = env::args().collect::<Vec<_>>();
    let exe_name = env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_stem()
                .map(|value| value.to_string_lossy().to_string())
        })
        .unwrap_or_default()
        .to_ascii_lowercase();

    let remote_mode = env_flag("CST_CLIENT_REMOTE")
        || args.iter().any(|arg| arg == "--remote")
        || exe_name.contains("cloud");

    let base_url = env::var("CST_CLIENT_BASE_URL")
        .ok()
        .or_else(|| arg_value(&args, "--remote-url"))
        .or_else(|| remote_mode.then(|| "http://127.0.0.1:8080".to_string()));

    let token = env::var("CST_CLIENT_TOKEN")
        .ok()
        .or_else(|| arg_value(&args, "--remote-token"))
        .or_else(read_local_server_token);

    ClientStartupConfig {
        remote_mode,
        base_url,
        token,
    }
}

fn env_flag(name: &str) -> bool {
    env::var(name)
        .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    args.iter()
        .find_map(|arg| arg.strip_prefix(&prefix).map(str::to_string))
}

fn read_local_server_token() -> Option<String> {
    let appdata = env::var_os("APPDATA").map(PathBuf::from)?;
    let file = appdata
        .join("codex-switch-terminal-server")
        .join("server.local.env.ps1");
    let content = fs::read_to_string(file).ok()?;
    for line in content.lines() {
        if !line.contains("CST_ADMIN_TOKEN") {
            continue;
        }
        if let Some(start) = line.find('"') {
            let rest = &line[start + 1..];
            if let Some(end) = rest.find('"') {
                let token = rest[..end].trim();
                if !token.is_empty() {
                    return Some(token.to_string());
                }
            }
        }
    }
    None
}
