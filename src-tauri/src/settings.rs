use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub id: String,
    pub label: String,
    pub codex_home: String,
    #[serde(default)]
    pub project_dir: Option<String>,
    pub proxy_id: Option<String>,
    pub startup_command: Option<String>,
    #[serde(default)]
    pub limits: AccountLimitTracking,
    /// Lance Codex en mode bypass (`--dangerously-bypass-approvals-and-sandbox`)
    /// pour CE compte. Actif par defaut ; les comptes existants (champ absent du
    /// settings.json) sont migres a `true` au chargement via ce default serde.
    #[serde(default = "default_true")]
    pub bypass: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLimitTracking {
    pub connected_at: Option<i64>,
    pub session_anchor_at: Option<i64>,
    pub weekly_anchor_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLimitView {
    pub id: String,
    pub label: String,
    pub codex_home: String,
    pub has_tokens: bool,
    pub connected_at: Option<i64>,
    pub session_reset_at: Option<i64>,
    pub weekly_reset_at: Option<i64>,
    pub session_remaining_secs: Option<i64>,
    pub weekly_remaining_secs: Option<i64>,
    pub session_used_percent: Option<f64>,
    pub weekly_used_percent: Option<f64>,
    pub buckets: Vec<AccountRateLimitBucketView>,
    pub refreshed_at: Option<i64>,
    pub source: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRateLimitBucketView {
    pub limit_id: String,
    pub limit_name: Option<String>,
    pub bucket: String,
    pub window_duration_mins: i64,
    pub resets_at: i64,
    pub used_percent: Option<f64>,
    pub rate_limit_reached_type: Option<String>,
    pub plan_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyProfile {
    pub id: String,
    pub label: String,
    pub proxy_url: String,
    pub note: Option<String>,
}

/// Un agent CLI lancable dans un terminal (Codex, Kombai, ou tout autre outil).
/// `command` est la commande de base envoyee dans le shell ; les sous-commandes
/// optionnelles (`login`, `status`, `doctor`) ne sont proposees dans l'UI que
/// lorsqu'elles sont definies (Codex les fournit, un agent generique non).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub label: String,
    pub command: String,
    /// "cli" : la commande est envoyee dans le terminal (Codex).
    /// "ide" : la commande est un lanceur d'editeur (code, cursor, windsurf,
    /// trae, antigravity, kiro) ouvert sur le dossier projet — c'est ainsi que
    /// Kombai (extension d'IDE) est utilise.
    #[serde(default = "default_agent_kind")]
    pub kind: String,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub login_command: Option<String>,
    #[serde(default)]
    pub status_command: Option<String>,
    #[serde(default)]
    pub doctor_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub accounts: Vec<AccountProfile>,
    pub proxies: Vec<ProxyProfile>,
    pub default_account_id: Option<String>,
    pub shell: String,
    pub codex_command: String,
    pub auto_run_codex: bool,
    #[serde(default = "default_proxy_controls_enabled")]
    pub proxy_controls_enabled: bool,
    #[serde(default)]
    pub pool: PoolConfig,
    #[serde(default)]
    pub agents: Vec<AgentProfile>,
    #[serde(default)]
    pub active_agent_id: Option<String>,
    #[serde(default)]
    pub kombai: KombaiConfig,
    /// Salon de communication inter-agents (serveur MCP + provisioning).
    #[serde(default)]
    pub agent_room: AgentRoomConfig,
    /// Ajoute `--dangerously-bypass-approvals-and-sandbox` quand l'app lance
    /// Codex (bouton Run + auto-run). Actif par defaut.
    #[serde(default = "default_true")]
    pub codex_bypass: bool,
    /// Re-scan automatique de `~/.codex*` a chaque chargement pour ajouter les
    /// comptes trouves. Desactive par defaut : les comptes se gerent via le Pool
    /// (import + suppression).
    #[serde(default)]
    pub auto_discover_accounts: bool,
}

/// Reglages du salon d'agents (« Agent Room »). Desactive par defaut : tant que
/// `enabled` est faux, l'app n'ecrit RIEN dans les `CODEX_HOME` et ne demarre
/// aucun serveur.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoomConfig {
    /// Active le salon : demarrage du serveur MCP + provisioning des agents
    /// (ecriture d'une entree `[mcp_servers.agent_room]` mergee dans config.toml).
    #[serde(default)]
    pub enabled: bool,
    /// Port loopback du serveur MCP du salon (desktop).
    #[serde(default = "default_room_port")]
    pub port: u16,
    /// Secret partage optionnel (second facteur en plus du token par agent).
    #[serde(default)]
    pub secret: String,
}

impl Default for AgentRoomConfig {
    fn default() -> Self {
        AgentRoomConfig {
            enabled: false,
            port: default_room_port(),
            secret: String::new(),
        }
    }
}

fn default_room_port() -> u16 {
    8123
}

/// Reglages du VS Code embarque (code-server) qui heberge l'extension Kombai
/// dans l'onglet "Kombai". Kombai n'ayant pas de CLI/API, c'est la seule facon
/// de l'utiliser dans l'app.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KombaiConfig {
    #[serde(default = "default_code_server_command")]
    pub code_server_command: String,
    #[serde(default = "default_kombai_port")]
    pub port: u16,
    #[serde(default = "default_kombai_extension")]
    pub extension_id: String,
    #[serde(default = "default_auto_install_extension")]
    pub auto_install_extension: bool,
}

impl Default for KombaiConfig {
    fn default() -> Self {
        KombaiConfig {
            code_server_command: default_code_server_command(),
            port: default_kombai_port(),
            extension_id: default_kombai_extension(),
            auto_install_extension: default_auto_install_extension(),
        }
    }
}

fn default_code_server_command() -> String {
    "code-server".to_string()
}
fn default_kombai_port() -> u16 {
    8899
}
fn default_kombai_extension() -> String {
    "kombai.kombai".to_string()
}
fn default_auto_install_extension() -> bool {
    true
}

const CODEX_AGENT_ID: &str = "codex";
const KOMBAI_AGENT_ID: &str = "kombai";

fn default_agent_kind() -> String {
    "cli".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolConfig {
    #[serde(default = "default_pool_port")]
    pub port: u16,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_pool_model")]
    pub default_model: String,
    #[serde(default = "default_pool_effort")]
    pub reasoning_effort: String,
    #[serde(default = "default_pool_upstream")]
    pub upstream: String,
    #[serde(default = "default_request_timeout")]
    pub request_timeout_secs: u64,
    #[serde(default = "default_cooldown_429")]
    pub cooldown_secs_429: u64,
    #[serde(default = "default_pool_concurrency")]
    pub concurrency: usize,
    #[serde(default)]
    pub client_id_override: String,
}

const SESSION_LIMIT_MINS: i64 = 5 * 60;
const WEEKLY_LIMIT_MINS: i64 = 7 * 24 * 60;
const RATE_LIMIT_READ_TIMEOUT_SECS: u64 = 18;

impl Default for PoolConfig {
    fn default() -> Self {
        PoolConfig {
            port: default_pool_port(),
            api_key: String::new(),
            default_model: default_pool_model(),
            reasoning_effort: default_pool_effort(),
            upstream: default_pool_upstream(),
            request_timeout_secs: default_request_timeout(),
            cooldown_secs_429: default_cooldown_429(),
            concurrency: default_pool_concurrency(),
            client_id_override: String::new(),
        }
    }
}

fn default_pool_port() -> u16 {
    8787
}
fn default_pool_model() -> String {
    "gpt-5-codex".to_string()
}
fn default_pool_effort() -> String {
    "medium".to_string()
}
fn default_pool_upstream() -> String {
    "https://chatgpt.com".to_string()
}
fn default_request_timeout() -> u64 {
    300
}
fn default_cooldown_429() -> u64 {
    60
}
fn default_pool_concurrency() -> usize {
    1
}
fn default_proxy_controls_enabled() -> bool {
    true
}
fn default_true() -> bool {
    true
}

#[tauri::command]
pub fn load_settings() -> Result<AppSettings, String> {
    let path = settings_path()?;
    let mut settings = if path.exists() {
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        serde_json::from_str::<AppSettings>(&content).map_err(|error| error.to_string())?
    } else {
        let settings = discover_initial_settings()?;
        write_settings(&path, &settings)?;
        settings
    };

    let mut changed = if settings.auto_discover_accounts {
        merge_discovered_profiles(&mut settings)?
    } else {
        false
    };
    ensure_default_account(&mut settings);
    if ensure_agents(&mut settings) {
        changed = true;
    }
    if sync_account_limit_trackers(&mut settings) {
        changed = true;
    }
    if changed {
        write_settings(&path, &settings)?;
    }
    Ok(settings)
}

#[tauri::command]
pub fn save_settings(mut settings: AppSettings) -> Result<AppSettings, String> {
    let path = settings_path()?;
    ensure_agents(&mut settings);
    sync_account_limit_trackers(&mut settings);
    write_settings(&path, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn ensure_account_home(codex_home: String) -> Result<(), String> {
    let home = expand_home(&codex_home)?;
    fs::create_dir_all(&home).map_err(|error| error.to_string())
}

/// Retire un compte du Pool / de la liste. Ne touche PAS au dossier CODEX_HOME
/// sur le disque : seul l'enregistrement dans `settings.json` est supprime.
/// Avec l'auto-detection desactivee (`auto_discover_accounts = false`), le
/// compte ne reapparait pas au prochain chargement.
#[tauri::command]
pub fn remove_account(account_id: String) -> Result<AppSettings, String> {
    let path = settings_path()?;
    let mut settings = load_settings()?;

    let before = settings.accounts.len();
    settings.accounts.retain(|account| account.id != account_id);
    if settings.accounts.len() == before {
        return Err("Compte introuvable".to_string());
    }

    if settings.default_account_id.as_deref() == Some(account_id.as_str()) {
        settings.default_account_id = settings.accounts.first().map(|account| account.id.clone());
    }

    ensure_agents(&mut settings);
    sync_account_limit_trackers(&mut settings);
    write_settings(&path, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub async fn account_limit_status() -> Result<Vec<AccountLimitView>, String> {
    let settings = load_settings()?;
    tauri::async_runtime::spawn_blocking(move || account_limit_views(&settings))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn import_account_docs(paths: Vec<String>) -> Result<AppSettings, String> {
    let settings_file = settings_path()?;
    let mut settings = load_settings()?;
    let files = expand_import_files(&paths)?;

    if files.is_empty() {
        return Err("Aucun fichier JSON a importer".to_string());
    }

    let mut imported = 0_usize;

    for file in files {
        let content =
            fs::read_to_string(&file).map_err(|error| format!("{}: {error}", file.display()))?;
        let value: Value = serde_json::from_str(&content)
            .map_err(|error| format!("JSON invalide {}: {error}", file.display()))?;
        let accounts = extract_import_accounts(&value);

        for account in accounts {
            import_single_account(&mut settings, account)?;
            imported += 1;
        }
    }

    if imported == 0 {
        return Err("Aucun token de compte trouve dans ces fichiers".to_string());
    }

    ensure_default_account(&mut settings);
    write_settings(&settings_file, &settings)?;
    Ok(settings)
}

/// Importe un ou plusieurs comptes a partir d'un contenu JSON colle
/// (blob de session ChatGPT, export `accounts[].credentials`, objet plat,
/// ou tableau de l'un de ces formats). Contrairement a `import_account_docs`,
/// aucune lecture fichier : le JSON est fourni directement par l'UI.
#[tauri::command]
pub fn import_account_json(content: String) -> Result<AppSettings, String> {
    let settings_file = settings_path()?;
    let mut settings = load_settings()?;

    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("Contenu JSON vide".to_string());
    }

    let value = parse_import_json_content(trimmed)?;
    let accounts = extract_import_accounts(&value);

    if accounts.is_empty() {
        return Err("Aucun token de compte trouve dans ce JSON".to_string());
    }

    let mut imported = 0_usize;
    for account in accounts {
        import_single_account(&mut settings, account)?;
        imported += 1;
    }

    if imported == 0 {
        return Err("Aucun token de compte trouve dans ce JSON".to_string());
    }

    ensure_default_account(&mut settings);
    write_settings(&settings_file, &settings)?;
    Ok(settings)
}

fn parse_import_json_content(content: &str) -> Result<Value, String> {
    match serde_json::from_str::<Value>(content) {
        Ok(Value::String(inner)) => {
            let inner = inner.trim();
            if inner.starts_with('{') || inner.starts_with('[') {
                return parse_import_json_content(inner);
            }

            Err("JSON invalide: le contenu colle est une chaine, pas un objet".to_string())
        }
        Ok(value) => Ok(value),
        Err(error) => {
            if content.starts_with("{\\\"") || content.starts_with("[\\\"") {
                let unescaped = content.replace("\\\"", "\"");
                if let Ok(value) = serde_json::from_str::<Value>(&unescaped) {
                    return Ok(value);
                }
            }

            Err(format!("JSON invalide: {error}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_session_blob_import(content: &str) {
        let value = parse_import_json_content(content).expect("session blob should parse");
        let accounts = extract_import_accounts(&value);

        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].access_token, "header.payload.signature");
        assert_eq!(accounts[0].refresh_token, "");
        assert_eq!(accounts[0].account_id, "account-1");
        assert_eq!(accounts[0].label, "Pool ava@example.com");
    }

    #[test]
    fn parses_pasted_chatgpt_session_blob_variants() {
        let raw = r#"{"accessToken":"header.payload.signature","user":{"id":"user-1","name":"","email":"ava@example.com"},"account":{"id":"account-1","planType":"plus"}}"#;
        let escaped_object = raw.replace('"', "\\\"");
        let quoted_json_string = serde_json::to_string(raw).expect("quoted string");

        assert_session_blob_import(raw);
        assert_session_blob_import(&escaped_object);
        assert_session_blob_import(&quoted_json_string);
    }

    fn empty_settings(
        codex_command: &str,
        agents: Vec<AgentProfile>,
        active: Option<&str>,
    ) -> AppSettings {
        AppSettings {
            accounts: Vec::new(),
            proxies: Vec::new(),
            default_account_id: None,
            shell: "sh".to_string(),
            codex_command: codex_command.to_string(),
            auto_run_codex: true,
            proxy_controls_enabled: true,
            pool: PoolConfig::default(),
            agents,
            active_agent_id: active.map(ToString::to_string),
            kombai: KombaiConfig::default(),
            agent_room: AgentRoomConfig::default(),
            codex_bypass: true,
            auto_discover_accounts: false,
        }
    }

    #[test]
    fn ensure_agents_seeds_codex_only_on_fresh_settings() {
        let mut settings = empty_settings("codex", Vec::new(), None);

        let changed = ensure_agents(&mut settings);

        assert!(changed);
        let codex = settings
            .agents
            .iter()
            .find(|agent| agent.id == CODEX_AGENT_ID)
            .expect("codex agent seeded");
        assert!(codex.builtin);
        assert_eq!(codex.command, "codex");
        assert_eq!(codex.kind, "cli");
        assert_eq!(codex.status_command.as_deref(), Some("login status"));
        // Kombai n'est pas un agent terminal : il ne doit PAS etre seed ici.
        assert!(!settings
            .agents
            .iter()
            .any(|agent| agent.id == KOMBAI_AGENT_ID));
        assert_eq!(settings.active_agent_id.as_deref(), Some(CODEX_AGENT_ID));
    }

    #[test]
    fn ensure_agents_removes_default_kombai_agent() {
        let legacy_kombai = AgentProfile {
            id: KOMBAI_AGENT_ID.to_string(),
            label: "Kombai".to_string(),
            command: "kombai".to_string(),
            kind: "cli".to_string(),
            builtin: false,
            login_command: None,
            status_command: None,
            doctor_command: None,
        };
        let mut settings = empty_settings("codex", vec![legacy_kombai], Some(CODEX_AGENT_ID));

        let _ = ensure_agents(&mut settings);

        // L'agent Kombai seed par defaut est retire (Kombai = onglet dedie).
        assert!(!settings
            .agents
            .iter()
            .any(|agent| agent.id == KOMBAI_AGENT_ID));
    }

    #[test]
    fn ensure_agents_keeps_customized_kombai_agent() {
        let custom_kombai = AgentProfile {
            id: KOMBAI_AGENT_ID.to_string(),
            label: "Kombai".to_string(),
            command: "my-kombai-wrapper".to_string(),
            kind: "cli".to_string(),
            builtin: false,
            login_command: None,
            status_command: None,
            doctor_command: None,
        };
        let mut settings = empty_settings("codex", vec![custom_kombai], Some(CODEX_AGENT_ID));

        let _ = ensure_agents(&mut settings);

        // Un agent Kombai personnalise (commande non-default) est conserve.
        assert!(settings
            .agents
            .iter()
            .any(|agent| agent.id == KOMBAI_AGENT_ID));
    }

    #[test]
    fn ensure_agents_syncs_codex_command_and_does_not_reseed_kombai() {
        let codex_agent = AgentProfile {
            id: CODEX_AGENT_ID.to_string(),
            label: "Codex".to_string(),
            command: "codex-custom".to_string(),
            kind: "cli".to_string(),
            builtin: true,
            login_command: Some("login".to_string()),
            status_command: None,
            doctor_command: None,
        };
        let mut settings = empty_settings("codex", vec![codex_agent], Some(CODEX_AGENT_ID));

        let _ = ensure_agents(&mut settings);

        // Le champ historique suit la commande de l'agent Codex.
        assert_eq!(settings.codex_command, "codex-custom");
        // Kombai n'est PAS recree quand le registre etait deja renseigne.
        assert!(!settings
            .agents
            .iter()
            .any(|agent| agent.id == KOMBAI_AGENT_ID));
    }

    #[test]
    fn ensure_agents_repairs_dangling_active_agent_id() {
        let mut settings = empty_settings("codex", Vec::new(), Some("ghost-agent"));

        let _ = ensure_agents(&mut settings);

        assert_eq!(settings.active_agent_id.as_deref(), Some(CODEX_AGENT_ID));
    }
}

pub fn load_settings_for_terminal() -> Result<AppSettings, String> {
    load_settings()
}

fn write_settings(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let content = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn settings_path() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("CST_DATA_DIR") {
        return Ok(PathBuf::from(value).join("settings.json"));
    }

    let base = if let Some(value) = env::var_os("APPDATA") {
        PathBuf::from(value)
    } else if let Some(value) = env::var_os("XDG_CONFIG_HOME") {
        PathBuf::from(value)
    } else {
        home_dir()?.join(".config")
    };

    Ok(base.join("codex-switch-terminal").join("settings.json"))
}

/// Repertoire de persistance du salon d'agents (`.../agent-room`), aligne sur la
/// meme resolution que `settings_path` (honore `CST_DATA_DIR`).
pub fn agent_room_data_dir() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("CST_DATA_DIR") {
        return Ok(PathBuf::from(value).join("agent-room"));
    }
    let base = if let Some(value) = env::var_os("APPDATA") {
        PathBuf::from(value)
    } else if let Some(value) = env::var_os("XDG_CONFIG_HOME") {
        PathBuf::from(value)
    } else {
        home_dir()?.join(".config")
    };
    Ok(base
        .join("codex-switch-terminal")
        .join("agent-room"))
}

fn discover_initial_settings() -> Result<AppSettings, String> {
    let mut settings = AppSettings {
        accounts: Vec::new(),
        proxies: Vec::new(),
        default_account_id: None,
        shell: default_shell(),
        codex_command: "codex".to_string(),
        auto_run_codex: true,
        proxy_controls_enabled: true,
        pool: PoolConfig::default(),
        agents: Vec::new(),
        active_agent_id: None,
        kombai: KombaiConfig::default(),
        agent_room: AgentRoomConfig::default(),
        codex_bypass: true,
        auto_discover_accounts: false,
    };

    if env::var_os("CST_DATA_DIR").is_none() {
        merge_discovered_profiles(&mut settings)?;
    }
    ensure_default_account(&mut settings);
    ensure_agents(&mut settings);
    sync_account_limit_trackers(&mut settings);
    Ok(settings)
}

/// Garantit la coherence du registre d'agents :
/// - l'agent Codex integre existe toujours (pilote la lecture des limites via
///   `codex app-server`) ;
/// - au tout premier passage (aucun agent enregistre) on ajoute aussi un agent
///   Kombai pret a l'emploi ;
/// - le champ historique `codex_command` reste synchronise avec la commande de
///   l'agent Codex ;
/// - `active_agent_id` pointe toujours vers un agent existant.
fn ensure_agents(settings: &mut AppSettings) -> bool {
    let mut changed = false;

    let codex_command = {
        let trimmed = settings.codex_command.trim();
        if trimmed.is_empty() {
            "codex".to_string()
        } else {
            trimmed.to_string()
        }
    };

    if !settings
        .agents
        .iter()
        .any(|agent| agent.id == CODEX_AGENT_ID)
    {
        settings.agents.insert(
            0,
            AgentProfile {
                id: CODEX_AGENT_ID.to_string(),
                label: "Codex".to_string(),
                command: codex_command,
                kind: "cli".to_string(),
                builtin: true,
                login_command: Some("login".to_string()),
                status_command: Some("login status".to_string()),
                doctor_command: Some("doctor --summary --ascii".to_string()),
            },
        );
        changed = true;
    }

    // Kombai n'est PAS un agent terminal : il vit dans l'onglet "Kombai"
    // (VS Code embarque). On retire un agent Kombai seed par defaut lors de
    // versions precedentes, tant que l'utilisateur ne l'a pas personnalise.
    let before = settings.agents.len();
    settings.agents.retain(|agent| {
        !(!agent.builtin
            && agent.id == KOMBAI_AGENT_ID
            && matches!(agent.command.trim(), "" | "kombai" | "code"))
    });
    if settings.agents.len() != before {
        changed = true;
    }

    // Synchronise le champ historique `codex_command` avec l'agent Codex.
    let codex_agent_command = settings
        .agents
        .iter()
        .find(|agent| agent.id == CODEX_AGENT_ID)
        .map(|agent| agent.command.trim().to_string());
    if let Some(command) = codex_agent_command {
        let synced = if command.is_empty() {
            "codex".to_string()
        } else {
            command
        };
        if settings.codex_command != synced {
            settings.codex_command = synced;
            changed = true;
        }
    }

    // `active_agent_id` doit referencer un agent existant.
    let active_valid = match &settings.active_agent_id {
        Some(id) => settings.agents.iter().any(|agent| &agent.id == id),
        None => false,
    };
    if !active_valid {
        let fallback = settings
            .agents
            .iter()
            .find(|agent| agent.id == CODEX_AGENT_ID)
            .or_else(|| settings.agents.first())
            .map(|agent| agent.id.clone());
        if settings.active_agent_id != fallback {
            settings.active_agent_id = fallback;
            changed = true;
        }
    }

    changed
}

fn merge_discovered_profiles(settings: &mut AppSettings) -> Result<bool, String> {
    let home = home_dir()?;
    if !home.exists() {
        return Ok(false);
    }
    let mut changed = false;

    let mut account_paths = settings
        .accounts
        .iter()
        .map(|account| normalize_string_path(&account.codex_home))
        .collect::<HashSet<_>>();
    let mut proxy_urls = settings
        .proxies
        .iter()
        .map(|proxy| proxy.proxy_url.trim().to_string())
        .collect::<HashSet<_>>();

    for entry in fs::read_dir(&home).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };

        if !is_codex_like_dir(name) {
            continue;
        }

        let path_string = path.to_string_lossy().to_string();
        let normalized = normalize_string_path(&path_string);
        let has_auth = path.join("auth.json").is_file();
        let has_config = path.join("config.toml").is_file();
        let proxy_file = path.join("proxy.txt");
        let proxy_id = if proxy_file.is_file() {
            let proxy_url = fs::read_to_string(&proxy_file)
                .map_err(|error| error.to_string())?
                .trim()
                .to_string();
            if proxy_url.is_empty() {
                None
            } else if let Some(existing) = settings
                .proxies
                .iter()
                .find(|proxy| proxy.proxy_url.trim() == proxy_url)
            {
                Some(existing.id.clone())
            } else {
                let id = stable_id("proxy", &path_string);
                if !proxy_urls.contains(&proxy_url) {
                    settings.proxies.push(ProxyProfile {
                        id: id.clone(),
                        label: format!("Proxy {}", name.trim_start_matches('.')),
                        proxy_url: proxy_url.clone(),
                        note: Some(path_string.clone()),
                    });
                    proxy_urls.insert(proxy_url);
                    changed = true;
                }
                Some(id)
            }
        } else {
            None
        };

        if (has_auth || has_config || proxy_id.is_some()) && !account_paths.contains(&normalized) {
            let id = stable_id("account", &path_string);
            // Compte auto-decouvert : herite du defaut global "Bypass defaut"
            // (comme la creation via l'UI), pas un `true` code en dur.
            let bypass_default = settings.codex_bypass;
            settings.accounts.push(AccountProfile {
                id,
                label: label_from_codex_dir(name),
                codex_home: path_string.clone(),
                project_dir: None,
                proxy_id,
                startup_command: None,
                limits: AccountLimitTracking::default(),
                bypass: bypass_default,
            });
            account_paths.insert(normalized);
            changed = true;
        }
    }

    Ok(changed)
}

fn ensure_default_account(settings: &mut AppSettings) {
    if settings.default_account_id.is_none() {
        settings.default_account_id = settings.accounts.first().map(|account| account.id.clone());
    }
}

fn is_codex_like_dir(name: &str) -> bool {
    name == ".codex" || name.starts_with(".codex-") || name.starts_with(".codex_")
}

fn label_from_codex_dir(name: &str) -> String {
    match name {
        ".codex" => "Principal".to_string(),
        other => other
            .trim_start_matches('.')
            .replace(['-', '_'], " ")
            .split_whitespace()
            .map(capitalize)
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn stable_id(prefix: &str, input: &str) -> String {
    let mut value = String::with_capacity(prefix.len() + input.len() + 1);
    value.push_str(prefix);
    value.push('-');

    for character in input.chars() {
        if character.is_ascii_alphanumeric() {
            value.push(character.to_ascii_lowercase());
        } else if !value.ends_with('-') {
            value.push('-');
        }
    }

    value.trim_end_matches('-').chars().take(96).collect()
}

pub fn account_has_auth_tokens(account: &AccountProfile) -> bool {
    let Ok(home) = expand_home(&account.codex_home) else {
        return false;
    };
    let Ok(content) = fs::read_to_string(home.join("auth.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return false;
    };
    value
        .get("tokens")
        .and_then(|tokens| tokens.get("access_token"))
        .and_then(Value::as_str)
        .map(|token| !token.is_empty())
        .unwrap_or(false)
}

fn sync_account_limit_trackers(settings: &mut AppSettings) -> bool {
    let now = now_unix();
    let mut changed = false;

    for account in &mut settings.accounts {
        if account_has_auth_tokens(account) && touch_account_limits(&mut account.limits, now) {
            changed = true;
        }
    }

    changed
}

fn touch_account_limits(limits: &mut AccountLimitTracking, now: i64) -> bool {
    let mut changed = false;

    if limits.connected_at.is_none() {
        limits.connected_at = Some(now);
        changed = true;
    }
    if limits.session_anchor_at.is_none() {
        limits.session_anchor_at = limits.connected_at.or(Some(now));
        changed = true;
    }
    if limits.weekly_anchor_at.is_none() {
        limits.weekly_anchor_at = limits.connected_at.or(Some(now));
        changed = true;
    }

    changed
}

fn new_connected_limits(now: i64) -> AccountLimitTracking {
    AccountLimitTracking {
        connected_at: Some(now),
        session_anchor_at: Some(now),
        weekly_anchor_at: Some(now),
    }
}

fn account_limit_views(settings: &AppSettings) -> Vec<AccountLimitView> {
    let accounts = settings.accounts.clone();
    let handles = accounts
        .into_iter()
        .map(|account| {
            let settings = settings.clone();
            thread::spawn(move || account_limit_view(&account, &settings))
        })
        .collect::<Vec<_>>();

    handles
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .collect()
}

fn account_limit_view(account: &AccountProfile, settings: &AppSettings) -> AccountLimitView {
    let now = now_unix();
    let has_tokens = account_has_auth_tokens(account);
    let mut buckets = Vec::new();
    let mut refreshed_at = None;
    let mut error = None;

    if has_tokens {
        match read_server_rate_limits(account, settings) {
            Ok(server_buckets) => {
                buckets = server_buckets;
                refreshed_at = Some(now);
            }
            Err(message) => {
                error = Some(message);
            }
        }
    }

    let session_bucket = bucket_for_window(&buckets, SESSION_LIMIT_MINS);
    let weekly_bucket = bucket_for_window(&buckets, WEEKLY_LIMIT_MINS);
    let session_reset_at = session_bucket.map(|bucket| bucket.resets_at);
    let weekly_reset_at = weekly_bucket.map(|bucket| bucket.resets_at);
    let source = if !has_tokens {
        "none"
    } else if error.is_some() {
        "unavailable"
    } else if buckets.is_empty() {
        "server-empty"
    } else {
        "server"
    };

    AccountLimitView {
        id: account.id.clone(),
        label: account.label.clone(),
        codex_home: account.codex_home.clone(),
        has_tokens,
        connected_at: account.limits.connected_at,
        session_reset_at,
        weekly_reset_at,
        session_remaining_secs: session_reset_at.map(|value| (value - now).max(0)),
        weekly_remaining_secs: weekly_reset_at.map(|value| (value - now).max(0)),
        session_used_percent: session_bucket.and_then(|bucket| bucket.used_percent),
        weekly_used_percent: weekly_bucket.and_then(|bucket| bucket.used_percent),
        buckets,
        refreshed_at,
        source: source.to_string(),
        error,
    }
}

fn bucket_for_window(
    buckets: &[AccountRateLimitBucketView],
    window_duration_mins: i64,
) -> Option<&AccountRateLimitBucketView> {
    buckets
        .iter()
        .filter(|bucket| bucket.window_duration_mins == window_duration_mins)
        .min_by_key(|bucket| bucket.resets_at)
}

fn read_server_rate_limits(
    account: &AccountProfile,
    settings: &AppSettings,
) -> Result<Vec<AccountRateLimitBucketView>, String> {
    let codex_home = expand_home(&account.codex_home)?;
    let mut command = codex_app_server_command(settings);
    command
        .env("CODEX_HOME", codex_home.to_string_lossy().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    if let Some(proxy_url) = proxy_url_for_account(account, settings) {
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            command.env(key, proxy_url.clone());
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("codex app-server impossible: {error}"))?;

    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        return Err("stdin app-server indisponible".to_string());
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Err("stdout app-server indisponible".to_string());
    };

    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let requests = [
        json!({
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": {
                    "name": "codex_switch_terminal",
                    "title": "Codex Switch Terminal",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
        json!({ "method": "initialized", "params": {} }),
        json!({ "method": "account/rateLimits/read", "id": 2 }),
    ];

    for request in requests {
        writeln!(stdin, "{request}").map_err(|error| {
            let _ = child.kill();
            format!("ecriture app-server impossible: {error}")
        })?;
    }
    let _ = stdin.flush();
    // NE PAS fermer stdin ici. Depuis codex >= 0.144, `codex app-server`
    // interprete la fin de stdin (EOF) comme un signal d'arret et quitte
    // *avant* d'avoir termine la requete asynchrone `account/rateLimits/read`
    // (~1 a 2 s de reseau). Fermer stdin trop tot faisait quitter le serveur
    // sans reponse, ce qui remontait a tort en "timeout lecture limites
    // serveur". On garde donc `stdin` ouvert jusqu'a reception de la reponse.

    let timeout = Duration::from_secs(RATE_LIMIT_READ_TIMEOUT_SECS);
    let response = loop {
        match rx.recv_timeout(timeout) {
            Ok(line) => {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if value.get("id").and_then(Value::as_i64) == Some(2) {
                    break value;
                }
            }
            Err(_) => {
                drop(stdin);
                let _ = child.kill();
                let _ = child.wait();
                return Err("timeout lecture limites serveur".to_string());
            }
        }
    };

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();

    if let Some(error) = response.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("erreur app-server");
        return Err(message.to_string());
    }

    let result = response
        .get("result")
        .ok_or_else(|| "reponse app-server sans result".to_string())?;
    let mut buckets = extract_rate_limit_buckets(result);
    buckets.sort_by(|a, b| {
        (
            a.limit_id.as_str(),
            a.bucket.as_str(),
            a.window_duration_mins,
            a.resets_at,
        )
            .cmp(&(
                b.limit_id.as_str(),
                b.bucket.as_str(),
                b.window_duration_mins,
                b.resets_at,
            ))
    });
    buckets.dedup_by(|a, b| {
        a.limit_id == b.limit_id
            && a.bucket == b.bucket
            && a.window_duration_mins == b.window_duration_mins
            && a.resets_at == b.resets_at
    });

    Ok(buckets)
}

fn codex_app_server_command(settings: &AppSettings) -> Command {
    let codex = settings.codex_command.trim();
    let codex = if codex.is_empty() { "codex" } else { codex };

    if cfg!(windows) {
        let mut command = Command::new("cmd.exe");
        command.arg("/S").arg("/C").arg(format!(
            "{} app-server --stdio",
            quote_windows_command(codex)
        ));
        command
    } else {
        let mut parts = codex.split_whitespace();
        let program = parts.next().unwrap_or("codex");
        let mut command = Command::new(program);
        command.args(parts).arg("app-server").arg("--stdio");
        command
    }
}

fn quote_windows_command(command: &str) -> String {
    if command.contains([' ', '\t']) && !command.starts_with('"') {
        format!("\"{}\"", command.replace('"', "\\\""))
    } else {
        command.to_string()
    }
}

fn proxy_url_for_account(account: &AccountProfile, settings: &AppSettings) -> Option<String> {
    if !settings.proxy_controls_enabled {
        return None;
    }

    account
        .proxy_id
        .as_ref()
        .and_then(|id| settings.proxies.iter().find(|proxy| proxy.id == *id))
        .map(|proxy| proxy.proxy_url.clone())
}

fn extract_rate_limit_buckets(result: &Value) -> Vec<AccountRateLimitBucketView> {
    let mut buckets = Vec::new();

    if let Some(limit) = result.get("rateLimits") {
        collect_rate_limit_object(limit, &mut buckets);
    }

    if let Some(map) = result.get("rateLimitsByLimitId").and_then(Value::as_object) {
        for limit in map.values() {
            collect_rate_limit_object(limit, &mut buckets);
        }
    }

    buckets
}

fn collect_rate_limit_object(limit: &Value, buckets: &mut Vec<AccountRateLimitBucketView>) {
    let limit_id = limit
        .get("limitId")
        .and_then(Value::as_str)
        .unwrap_or("codex")
        .to_string();
    let limit_name = limit
        .get("limitName")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let reached_type = limit
        .get("rateLimitReachedType")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let plan_type = limit
        .get("planType")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    for bucket_name in ["primary", "secondary"] {
        let Some(bucket) = limit.get(bucket_name) else {
            continue;
        };
        if bucket.is_null() {
            continue;
        }

        let Some(window_duration_mins) = bucket.get("windowDurationMins").and_then(Value::as_i64)
        else {
            continue;
        };
        let Some(resets_at) = bucket.get("resetsAt").and_then(Value::as_i64) else {
            continue;
        };

        buckets.push(AccountRateLimitBucketView {
            limit_id: limit_id.clone(),
            limit_name: limit_name.clone(),
            bucket: bucket_name.to_string(),
            window_duration_mins,
            resets_at,
            used_percent: bucket.get("usedPercent").and_then(json_f64),
            rate_limit_reached_type: reached_type.clone(),
            plan_type: plan_type.clone(),
        });
    }
}

fn json_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|number| number as f64))
}

#[derive(Debug, Clone)]
struct ImportedAccount {
    alias: String,
    label: String,
    id_token: String,
    access_token: String,
    refresh_token: String,
    account_id: String,
    last_refresh: Option<String>,
    proxy_url: Option<String>,
}

fn import_single_account(
    settings: &mut AppSettings,
    account: ImportedAccount,
) -> Result<(), String> {
    // On accepte un refresh_token vide (cas du blob de session ChatGPT qui ne
    // contient que l'accessToken). Le compte restera valide jusqu'a
    // l'expiration du JWT, sans renouvellement possible.
    if account.access_token.is_empty() {
        return Ok(());
    }

    let home = if let Some(value) = env::var_os("CST_DATA_DIR") {
        PathBuf::from(value)
            .join("codex-homes")
            .join(format!("pool-{}", account.alias))
    } else {
        home_dir()?.join(format!(".codex-pool-{}", account.alias))
    };
    fs::create_dir_all(&home).map_err(|error| error.to_string())?;

    // Codex CLI valide le format du `id_token` (JWT). Les blobs de session
    // ChatGPT n'en fournissent pas : on reutilise l'accessToken (JWT valide
    // contenant deja les memes claims d'identite) pour satisfaire le parseur.
    let id_token = if account.id_token.is_empty() {
        account.access_token.clone()
    } else {
        account.id_token.clone()
    };

    let auth = json!({
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": Value::Null,
        "tokens": {
            "id_token": id_token,
            "access_token": account.access_token,
            "refresh_token": account.refresh_token,
            "account_id": account.account_id,
        },
        "last_refresh": account.last_refresh.unwrap_or_else(now_iso8601),
    });

    fs::write(
        home.join("auth.json"),
        serde_json::to_string_pretty(&auth).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    let home_string = home.to_string_lossy().to_string();
    let id = stable_id("account", &home_string);
    let now = now_unix();
    let proxy_id = match account
        .proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(proxy_url) => Some(upsert_proxy(settings, proxy_url, &account.label)),
        None => None,
    };

    // Compte importe : herite du defaut global "Bypass defaut" (comme la
    // creation via l'UI / newAccountProfile), pas un `true` code en dur.
    let bypass_default = settings.codex_bypass;
    match settings
        .accounts
        .iter_mut()
        .find(|candidate| candidate.id == id)
    {
        Some(existing) => {
            existing.label = account.label;
            existing.codex_home = home_string;
            existing.proxy_id = proxy_id;
            touch_account_limits(&mut existing.limits, now);
        }
        None => settings.accounts.push(AccountProfile {
            id,
            label: account.label,
            codex_home: home_string,
            project_dir: None,
            proxy_id,
            startup_command: None,
            limits: new_connected_limits(now),
            bypass: bypass_default,
        }),
    }

    Ok(())
}

fn upsert_proxy(settings: &mut AppSettings, proxy_url: &str, label: &str) -> String {
    if let Some(existing) = settings
        .proxies
        .iter()
        .find(|proxy| proxy.proxy_url.trim() == proxy_url)
    {
        return existing.id.clone();
    }

    let id = stable_id("proxy", proxy_url);
    settings.proxies.push(ProxyProfile {
        id: id.clone(),
        label: format!("Proxy {label}"),
        proxy_url: proxy_url.to_string(),
        note: Some("imported account doc".to_string()),
    });
    id
}

fn extract_import_accounts(value: &Value) -> Vec<ImportedAccount> {
    if let Some(array) = value.as_array() {
        return array.iter().flat_map(extract_import_accounts).collect();
    }

    let Some(object) = value.as_object() else {
        return Vec::new();
    };

    if let Some(accounts) = object.get("accounts").and_then(Value::as_array) {
        return accounts
            .iter()
            .filter_map(import_from_nested_account)
            .collect();
    }

    if object
        .get("credentials")
        .and_then(Value::as_object)
        .is_some()
    {
        return import_from_nested_account(value).into_iter().collect();
    }

    // Blob de session web ChatGPT (chatgpt.com/api/auth/session) :
    // champ camelCase `accessToken`, pas de refresh_token. Compte a ~10 jours
    // de duree de vie (expiration du JWT), non renouvelable.
    if object.get("accessToken").and_then(Value::as_str).is_some() {
        return import_from_session_blob(value).into_iter().collect();
    }

    import_from_flat_account(value).into_iter().collect()
}

fn import_from_flat_account(value: &Value) -> Option<ImportedAccount> {
    let access_token = string_at(value, &["access_token"])?;
    let refresh_token = string_at(value, &["refresh_token"])?;
    let id_token = string_at(value, &["id_token"]).unwrap_or_default();
    let account_id = string_at(value, &["account_id"])
        .or_else(|| string_at(value, &["chatgpt_account_id"]))
        .unwrap_or_default();
    let email = string_at(value, &["email"]);
    let name = string_at(value, &["name"]);
    let label = best_label(name.as_deref(), email.as_deref(), account_id.as_str());
    let alias = make_alias(email.as_deref().or(name.as_deref()).unwrap_or(&account_id));

    Some(ImportedAccount {
        alias,
        label,
        id_token,
        access_token,
        refresh_token,
        account_id,
        last_refresh: string_at(value, &["last_refresh"]),
        proxy_url: proxy_url_from_value(value),
    })
}

fn import_from_nested_account(value: &Value) -> Option<ImportedAccount> {
    let credentials = value.get("credentials").unwrap_or(value);
    let extra = value.get("extra");
    let access_token = string_at(credentials, &["access_token"])?;
    let refresh_token = string_at(credentials, &["refresh_token"])?;
    let id_token = string_at(credentials, &["id_token"]).unwrap_or_default();
    let account_id = string_at(credentials, &["account_id"])
        .or_else(|| string_at(credentials, &["chatgpt_account_id"]))
        .unwrap_or_default();
    let email = string_at(credentials, &["email"])
        .or_else(|| extra.and_then(|extra| string_at(extra, &["email"])))
        .or_else(|| extra.and_then(|extra| string_at(extra, &["email_key"])));
    let name =
        string_at(value, &["name"]).or_else(|| extra.and_then(|extra| string_at(extra, &["name"])));
    let label = best_label(name.as_deref(), email.as_deref(), account_id.as_str());
    let alias = make_alias(email.as_deref().or(name.as_deref()).unwrap_or(&account_id));

    Some(ImportedAccount {
        alias,
        label,
        id_token,
        access_token,
        refresh_token,
        account_id,
        last_refresh: extra.and_then(|extra| string_at(extra, &["last_refresh"])),
        proxy_url: proxy_url_from_value(value),
    })
}

/// Parse un blob de session web ChatGPT (chatgpt.com/api/auth/session).
///
/// Format : `{ "accessToken": "<jwt>", "sessionToken": "<jwe>",
/// "user": { "id", "name", "email", "idp" }, "account": { "id", "planType" },
/// "expires": "<iso>" }`.
///
/// Ce blob ne contient PAS de `refresh_token` OAuth : le compte cree ici est
/// utilisable jusqu'a l'expiration du JWT d'acces (~10 jours), sans
/// renouvellement possible cote pool/Codex CLI.
fn import_from_session_blob(value: &Value) -> Option<ImportedAccount> {
    let access_token = string_at(value, &["accessToken"])?;
    let user_value = value.get("user").unwrap_or(value);
    let account_value = value.get("account").unwrap_or(value);

    let account_id = string_at(account_value, &["id"])
        .or_else(|| string_at(value, &["account_id"]))
        .or_else(|| string_at(user_value, &["id"]))
        .unwrap_or_default();
    let email = string_at(user_value, &["email"]);
    let name = string_at(user_value, &["name"]);
    let label = best_label(name.as_deref(), email.as_deref(), &account_id);
    let alias = make_alias(email.as_deref().or(name.as_deref()).unwrap_or(&account_id));

    Some(ImportedAccount {
        alias,
        label,
        id_token: String::new(),
        access_token,
        refresh_token: String::new(),
        account_id,
        last_refresh: None,
        proxy_url: proxy_url_from_value(value),
    })
}

fn proxy_url_from_value(value: &Value) -> Option<String> {
    string_at(value, &["proxy_url"])
        .or_else(|| string_at(value, &["proxyUrl"]))
        .or_else(|| {
            value
                .get("proxy")
                .and_then(|proxy| string_at(proxy, &["url"]))
        })
        .or_else(|| {
            value
                .get("proxy")
                .and_then(|proxy| string_at(proxy, &["proxy_url"]))
        })
        .or_else(|| {
            value
                .get("proxy")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
}

fn best_label(name: Option<&str>, email: Option<&str>, account_id: &str) -> String {
    let base = name
        .filter(|value| !value.trim().is_empty())
        .or(email)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(account_id);
    format!("Pool {base}")
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }

    match current {
        Value::String(text) if !text.is_empty() => Some(text.to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn make_alias(value: &str) -> String {
    let mut alias = String::new();

    for character in value.trim().to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            alias.push(character);
        } else if !alias.ends_with('-') {
            alias.push('-');
        }
    }

    let alias = alias.trim_matches('-').chars().take(60).collect::<String>();
    if alias.is_empty() {
        "account".to_string()
    } else {
        alias
    }
}

fn expand_import_files(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();

    for raw in paths {
        for part in raw.split(['\n', '\r', ';', ',']) {
            let value = part.trim().trim_matches('"').trim_matches('\'');
            if value.is_empty() {
                continue;
            }

            for file in expand_import_entry(value)? {
                let key = normalize_string_path(&file.to_string_lossy());
                if seen.insert(key) {
                    files.push(file);
                }
            }
        }
    }

    Ok(files)
}

fn expand_import_entry(value: &str) -> Result<Vec<PathBuf>, String> {
    let path = expand_known_path(value)?;

    if path.is_dir() {
        let mut files = Vec::new();
        for entry in fs::read_dir(&path).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let candidate = entry.path();
            if candidate
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension.eq_ignore_ascii_case("json"))
                .unwrap_or(false)
            {
                files.push(candidate);
            }
        }
        return Ok(files);
    }

    if value.contains('*') || value.contains('?') {
        return expand_wildcard(value);
    }

    if path.is_file() {
        Ok(vec![path])
    } else {
        Err(format!("Fichier introuvable: {value}"))
    }
}

fn expand_known_path(value: &str) -> Result<PathBuf, String> {
    if value == "~"
        || value.starts_with("~/")
        || value.starts_with("~\\")
        || value.starts_with("%USERPROFILE%")
    {
        return expand_home(value);
    }

    if let Some(stripped) = value.strip_prefix("%APPDATA%") {
        if let Some(appdata) = env::var_os("APPDATA") {
            return Ok(PathBuf::from(appdata).join(stripped.trim_start_matches(['\\', '/'])));
        }
    }

    Ok(PathBuf::from(value))
}

fn expand_wildcard(value: &str) -> Result<Vec<PathBuf>, String> {
    let path = expand_known_path(value)?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let pattern = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Wildcard invalide: {value}"))?;
    let mut files = Vec::new();

    for entry in fs::read_dir(parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let candidate = entry.path();
        let Some(name) = candidate.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if wildcard_match(pattern, name) && candidate.is_file() {
            files.push(candidate);
        }
    }

    Ok(files)
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.as_bytes();
    let text = text.as_bytes();
    let (mut pi, mut ti) = (0_usize, 0_usize);
    let mut star = None;
    let mut match_i = 0_usize;

    while ti < text.len() {
        if pi < pattern.len()
            && (pattern[pi] == b'?' || pattern[pi].eq_ignore_ascii_case(&text[ti]))
        {
            pi += 1;
            ti += 1;
        } else if pi < pattern.len() && pattern[pi] == b'*' {
            star = Some(pi);
            match_i = ti;
            pi += 1;
        } else if let Some(star_i) = star {
            pi = star_i + 1;
            match_i += 1;
            ti = match_i;
        } else {
            return false;
        }
    }

    while pi < pattern.len() && pattern[pi] == b'*' {
        pi += 1;
    }

    pi == pattern.len()
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// Horodatage ISO 8601 / RFC 3339 attendu par Codex CLI pour `last_refresh`
/// dans `auth.json` (ex. `2026-07-07T22:02:21.440539Z`). Un timestamp unix
/// casse le parseur de Codex ("input contains invalid characters").
fn now_iso8601() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true)
}

fn normalize_string_path(value: &str) -> String {
    value.trim().replace('/', "\\").to_ascii_lowercase()
}

pub fn expand_home(value: &str) -> Result<PathBuf, String> {
    if value == "~" {
        return home_dir();
    }

    if let Some(stripped) = value.strip_prefix("%CST_DATA_DIR%") {
        let base = env::var_os("CST_DATA_DIR")
            .map(PathBuf::from)
            .ok_or_else(|| "CST_DATA_DIR n'est pas defini".to_string())?;
        return Ok(base.join(stripped.trim_start_matches(['\\', '/'])));
    }

    if let Some(stripped) = value.strip_prefix("${CST_DATA_DIR}") {
        let base = env::var_os("CST_DATA_DIR")
            .map(PathBuf::from)
            .ok_or_else(|| "CST_DATA_DIR n'est pas defini".to_string())?;
        return Ok(base.join(stripped.trim_start_matches(['\\', '/'])));
    }

    if let Some(stripped) = value.strip_prefix("$CST_DATA_DIR") {
        let base = env::var_os("CST_DATA_DIR")
            .map(PathBuf::from)
            .ok_or_else(|| "CST_DATA_DIR n'est pas defini".to_string())?;
        return Ok(base.join(stripped.trim_start_matches(['\\', '/'])));
    }

    if let Some(stripped) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return Ok(home_dir()?.join(stripped));
    }

    if let Some(stripped) = value.strip_prefix("%USERPROFILE%") {
        return Ok(home_dir()?.join(stripped.trim_start_matches(['\\', '/'])));
    }

    Ok(PathBuf::from(value))
}

#[tauri::command]
pub async fn pick_project_dir(current_dir: Option<String>) -> Result<Option<String>, String> {
    let start_dir = current_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| expand_home(value).ok())
        .filter(|path| path.is_dir());

    let selected = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new();
        if let Some(dir) = start_dir {
            dialog = dialog.set_directory(dir);
        }
        dialog
            .pick_folder()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| error.to_string())?;

    Ok(selected)
}

fn home_dir() -> Result<PathBuf, String> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "Impossible de trouver le dossier utilisateur".to_string())
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}
