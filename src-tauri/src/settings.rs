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

/// Fournisseur CLI gere par un compte / un agent.
///
/// `Codex` (ChatGPT/OpenAI) est le defaut historique : les comptes et agents
/// existants (champ `provider` absent du settings.json) ainsi que tout code qui
/// ne precise pas de provider restent Codex, ce qui preserve le comportement
/// actuel bit pour bit. `Claude` designe Claude Code (CLI `claude`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Codex,
    Claude,
}

impl Provider {
    /// Identifiant stable (utilise pour les logs, l'agent-room, l'UI).
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Codex => "codex",
            Provider::Claude => "claude",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub id: String,
    pub label: String,
    /// Fournisseur CLI de ce compte. `#[serde(default)]` => les comptes crees
    /// par une version anterieure (sans ce champ) sont interpretes comme Codex.
    #[serde(default)]
    pub provider: Provider,
    /// Dossier "home" isole du compte. Pour Codex c'est `CODEX_HOME` ; pour
    /// Claude c'est `CLAUDE_CONFIG_DIR` (meme role : sessions + credentials +
    /// config propres au compte). Le nom de champ reste `codexHome` cote JSON
    /// pour la retro-compat des settings.json existants.
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
    /// Modele Codex par defaut de CE compte. `None` preserve le comportement et
    /// le `config.toml` des profils crees par une ancienne version de l'app.
    #[serde(default)]
    pub model: Option<String>,
    /// Intensite de raisonnement Codex (`model_reasoning_effort`) de CE compte.
    /// `None` laisse une eventuelle valeur existante du `config.toml` intacte.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
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

/// Capacites d'intensite exposees par le catalogue du CLI Codex pour un
/// modele precis. Le frontend ne doit pas inventer une liste globale : `max`
/// et `ultra`, par exemple, ne sont proposes que par certains modeles.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelReasoningEffortView {
    pub reasoning_effort: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountModelView {
    pub id: String,
    pub display_name: String,
    pub default_reasoning_effort: Option<String>,
    pub supported_reasoning_efforts: Vec<ModelReasoningEffortView>,
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
    /// Fournisseur CLI pilote par cet agent. `#[serde(default)]` => les agents
    /// existants (sans ce champ) sont Codex. L'agent Claude Code integre porte
    /// `Provider::Claude`.
    #[serde(default)]
    pub provider: Provider,
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

/// Un **workspace** = un dossier projet ouvert par l'utilisateur, qui sert de
/// contexte a un ensemble de chats (comme OpenCode / Codex / Claude Code). Le
/// registre des workspaces est persiste dans `settings.json` afin de suivre
/// l'utilisateur sur ses appareils (desktop/web/Android), a la difference du
/// pointeur de workspace ACTIF qui reste local a l'appareil (localStorage).
///
/// L'appartenance d'un chat a un workspace n'est PAS stockee ici : elle est
/// derivee cote client en comparant le `cwd` de la discussion au `path` du
/// workspace. On ne conserve donc jamais de reference de chat fragile.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProfile {
    /// Identite stable = chemin normalise (cf. `normalize_workspace_path`). Le
    /// backend le recalcule toujours afin de fusionner les anciens doublons.
    pub id: String,
    /// Libelle affiche (par defaut le nom du dossier), personnalisable.
    pub label: String,
    /// Chemin du dossier projet (tel que saisi/choisi par l'utilisateur).
    pub path: String,
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
    /// Registre des workspaces (dossiers projets ouverts). `#[serde(default)]`
    /// => les settings.json anterieurs (sans ce champ) restent lisibles et
    /// demarrent avec une liste vide, ensuite peuplee par migration du
    /// localStorage cote client.
    #[serde(default)]
    pub workspaces: Vec<WorkspaceProfile>,
    /// Identites normalisees des workspaces explicitement fermes. Elles
    /// empechent une ancienne discussion ou le MRU d'un autre appareil de les
    /// recreer automatiquement ; une ouverture explicite retire le tombstone.
    #[serde(default)]
    pub closed_workspace_ids: Vec<String>,
}

/// Reglages historiques du transport MCP. `enabled` est conserve uniquement
/// pour relire les anciens settings ; la collaboration workspace est desormais
/// native et toujours disponible dans les homes isoles.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoomConfig {
    /// Champ de compatibilite, ignore par le runtime natif.
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
const CLAUDE_AGENT_ID: &str = "claude";
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
const MODEL_CATALOG_TIMEOUT_SECS: u64 = 12;

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

const DEFAULT_ACCOUNT_MODEL: &str = "gpt-5.6-sol";
const DEFAULT_ACCOUNT_REASONING_EFFORT: &str = "medium";

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
    if ensure_workspaces(&mut settings) {
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
    ensure_workspaces(&mut settings);
    sync_account_limit_trackers(&mut settings);
    write_settings(&path, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn ensure_account_home(
    codex_home: String,
    provider: Option<Provider>,
    bypass: bool,
    model: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    let home = expand_home(&codex_home)?;
    fs::create_dir_all(&home).map_err(|error| error.to_string())?;
    // `provider` absent (anciens appels front) => Codex : comportement inchange.
    provider
        .unwrap_or_default()
        .write_account_config(&home, bypass, model.as_deref(), reasoning_effort.as_deref())
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Retire un compte du Pool / de la liste. Si `delete_files` est faux, ne touche
/// PAS au dossier CODEX_HOME sur le disque : seul l'enregistrement dans
/// `settings.json` est supprime (avec `auto_discover_accounts = false`, le compte
/// ne reapparait pas au prochain chargement).
///
/// Si `delete_files` est vrai, le dossier CODEX_HOME du compte est aussi efface
/// du disque (auth.json, sessions, config...). Garde-fous stricts :
/// - le dossier n'est efface que s'il ressemble a un CODEX_HOME (nom `.codex*`,
///   dossier sous `codex-homes`, ou presence d'un `auth.json`/`config.toml`) ;
/// - jamais le dossier utilisateur, un de ses ancetres, ni le dossier de
///   configuration de l'app ;
/// - si un AUTRE compte restant pointe vers le meme dossier, il est conserve.
/// En cas de dossier dangereux ou non supprimable, l'operation est annulee AVANT
/// d'ecrire `settings.json` (etat inchange) et l'erreur est remontee : le compte
/// reste alors present et l'utilisateur peut le retirer sans effacer les fichiers.
#[tauri::command]
pub fn remove_account(account_id: String, delete_files: bool) -> Result<AppSettings, String> {
    let path = settings_path()?;
    let mut settings = load_settings()?;

    let Some(target) = settings
        .accounts
        .iter()
        .find(|account| account.id == account_id)
        .cloned()
    else {
        return Err("Compte introuvable".to_string());
    };

    settings.accounts.retain(|account| account.id != account_id);

    if settings.default_account_id.as_deref() == Some(account_id.as_str()) {
        settings.default_account_id = settings.accounts.first().map(|account| account.id.clone());
    }

    ensure_agents(&mut settings);
    sync_account_limit_trackers(&mut settings);

    // Suppression du dossier AVANT l'ecriture de settings.json : si elle echoue
    // (chemin refuse par les garde-fous, verrou fichier...), on renvoie l'erreur
    // sans rien persister -> l'etat reste coherent (le compte est toujours la).
    if delete_files {
        let normalized_target = normalize_string_path(&target.codex_home);
        let still_referenced = settings
            .accounts
            .iter()
            .any(|account| normalize_string_path(&account.codex_home) == normalized_target);
        if !still_referenced {
            delete_codex_home_dir(&target.codex_home)?;
        }
    }

    write_settings(&path, &settings)?;
    Ok(settings)
}

/// Supprime le dossier CODEX_HOME d'un compte apres validation stricte. Un
/// dossier absent est traite comme un succes (rien a effacer).
fn delete_codex_home_dir(codex_home: &str) -> Result<(), String> {
    let path = expand_home(codex_home)?;
    if !path.exists() {
        return Ok(());
    }
    if !path.is_dir() {
        return Err(format!(
            "Le CODEX_HOME du compte n'est pas un dossier : {}",
            path.display()
        ));
    }
    guard_deletable_codex_home(&path)?;
    fs::remove_dir_all(&path)
        .map_err(|error| format!("Suppression de {} impossible : {error}", path.display()))
}

/// Refuse d'effacer un dossier qui n'est pas manifestement le CODEX_HOME d'un
/// compte, ou qui est un chemin critique (racine/drive root, dossier
/// utilisateur et ses ancetres, dossier de configuration de l'app).
fn guard_deletable_codex_home(path: &Path) -> Result<(), String> {
    let path_key = guard_key(path);

    // Chemins trop courts (racine, drive root, chemin relatif ambigu) : refus.
    if path.components().count() < 3 || path.file_name().is_none() {
        return Err(format!(
            "Refus : chemin trop court ou critique ({}).",
            path.display()
        ));
    }

    // Dossier utilisateur lui-meme ou l'un de ses ancetres.
    if let Ok(home) = home_dir() {
        let home_key = guard_key(&home);
        if path_key == home_key || home_key.starts_with(&format!("{path_key}\\")) {
            return Err(format!(
                "Refus : {} est le dossier utilisateur (ou un parent).",
                path.display()
            ));
        }
    }

    // Dossier de configuration de l'app (settings.json, agent-room...).
    if let Ok(settings_file) = settings_path() {
        if let Some(app_dir) = settings_file.parent() {
            let app_key = guard_key(app_dir);
            if path_key == app_key || app_key.starts_with(&format!("{path_key}\\")) {
                return Err(format!(
                    "Refus : {} est le dossier de configuration de l'app.",
                    path.display()
                ));
            }
        }
    }

    // Le dossier doit ressembler au home d'un compte (Codex ou Claude).
    let looks_like_home = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            is_codex_like_dir(name)
                || Provider::Codex.is_home_like_dir(name)
                || Provider::Claude.is_home_like_dir(name)
        })
        .unwrap_or(false);
    let under_homes = path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .map(|name| {
            name.eq_ignore_ascii_case("codex-homes") || name.eq_ignore_ascii_case("claude-homes")
        })
        .unwrap_or(false);
    let has_marker = path.join("auth.json").is_file()      // Codex
        || path.join("config.toml").is_file()              // Codex
        || path.join(".credentials.json").is_file()        // Claude
        || path.join(".claude.json").is_file(); // Claude

    if !(looks_like_home || under_homes || has_marker) {
        return Err(format!(
            "Refus : {} ne ressemble pas a un dossier de compte Codex (nom .codex*, dossier codex-homes, ou auth.json/config.toml requis).",
            path.display()
        ));
    }

    Ok(())
}

/// Cle normalisee pour comparer des chemins de facon robuste : minuscules,
/// separateurs `\`, sans separateur final.
fn guard_key(path: &Path) -> String {
    normalize_string_path(&path.to_string_lossy())
        .trim_end_matches('\\')
        .to_string()
}

#[tauri::command]
pub async fn account_limit_status() -> Result<Vec<AccountLimitView>, String> {
    let settings = load_settings()?;
    tauri::async_runtime::spawn_blocking(move || account_limit_views(&settings))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn account_model_catalog(account_id: String) -> Result<Vec<AccountModelView>, String> {
    tauri::async_runtime::spawn_blocking(move || load_account_model_catalog(&account_id))
        .await
        .map_err(|error| error.to_string())?
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

    fn fresh_account_home(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        env::temp_dir().join(format!("cst-{prefix}-{unique}"))
    }

    #[test]
    fn account_home_is_provisioned_with_all_account_defaults() {
        let home = fresh_account_home("account-config");

        ensure_account_home(
            home.to_string_lossy().to_string(),
            Some(Provider::Codex),
            true,
            Some("gpt-5.6-sol".to_string()),
            Some("medium".to_string()),
        )
        .expect("account home should be created and provisioned");

        let config = fs::read_to_string(home.join("config.toml"))
            .expect("config.toml should exist immediately");
        assert!(config.contains("approval_policy = \"never\""));
        assert!(config.contains("sandbox_mode = \"danger-full-access\""));
        assert!(config.contains("model = \"gpt-5.6-sol\""));
        assert!(config.contains("model_reasoning_effort = \"medium\""));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn non_bypass_account_gets_safe_explicit_permissions() {
        let home = fresh_account_home("safe-account");

        ensure_account_home(
            home.to_string_lossy().to_string(),
            Some(Provider::Codex),
            false,
            None,
            None,
        )
        .expect("non-bypass account should be provisioned");

        let config = fs::read_to_string(home.join("config.toml")).expect("config.toml");
        assert!(config.contains("approval_policy = \"on-request\""));
        assert!(config.contains("sandbox_mode = \"workspace-write\""));
        assert!(!config.contains("danger-full-access"));
        assert!(!config.contains("approval_policy = \"never\""));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn disabling_bypass_replaces_previously_persisted_bypass() {
        let home = fresh_account_home("bypass-transition");
        ensure_codex_account_config(&home, true, Some("gpt-5.6-sol"), Some("high"))
            .expect("bypass config");
        ensure_codex_account_config(&home, false, Some("gpt-5.6-sol"), Some("high"))
            .expect("safe config");

        let config = fs::read_to_string(home.join("config.toml")).expect("config.toml");
        assert!(config.contains("approval_policy = \"on-request\""));
        assert!(config.contains("sandbox_mode = \"workspace-write\""));
        assert!(!config.contains("danger-full-access"));
        assert!(!config.contains("approval_policy = \"never\""));
        assert_eq!(config.matches("approval_policy =").count(), 1);
        assert_eq!(config.matches("sandbox_mode =").count(), 1);

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn account_config_preserves_sections_and_is_idempotent() {
        let home = fresh_account_home("config-idempotent");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join("config.toml"),
            "[mcp_servers.agent_room]\nurl = \"http://127.0.0.1:8123/mcp\"\n",
        )
        .unwrap();

        ensure_codex_account_config(&home, true, Some("gpt-5.6-sol"), Some("xhigh"))
            .expect("first provisioning");
        let once = fs::read_to_string(home.join("config.toml")).unwrap();
        ensure_codex_account_config(&home, true, Some("gpt-5.6-sol"), Some("xhigh"))
            .expect("second provisioning");
        let twice = fs::read_to_string(home.join("config.toml")).unwrap();

        assert_eq!(once, twice);
        assert!(twice.contains("[mcp_servers.agent_room]"));
        assert!(twice.contains("url = \"http://127.0.0.1:8123/mcp\""));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn account_config_rejects_invalid_reasoning_effort() {
        let home = fresh_account_home("invalid-effort");
        let error = ensure_codex_account_config(&home, true, None, Some("ultra mode"))
            .expect_err("malformed effort must be rejected");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(!home.join("config.toml").exists());
    }

    #[test]
    fn account_config_accepts_max_and_ultra_reasoning_efforts() {
        let home = fresh_account_home("max-ultra-effort");
        ensure_codex_account_config(&home, true, Some("gpt-5.6-sol"), Some("max"))
            .expect("max effort");
        ensure_codex_account_config(&home, true, Some("gpt-5.6-sol"), Some("ultra"))
            .expect("ultra effort");

        let config = fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(config.contains("model_reasoning_effort = \"ultra\""));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn account_config_escapes_model_before_writing_toml() {
        let home = fresh_account_home("model-escape");
        let injected = "gpt-5.6-sol\"\nsandbox_mode = \"danger-full-access";
        ensure_codex_account_config(&home, false, Some(injected), Some("low"))
            .expect("escaped model should remain a TOML string");

        let config = fs::read_to_string(home.join("config.toml")).unwrap();
        ensure_codex_account_config(&home, false, Some(injected), Some("low"))
            .expect("escaped model should stay idempotent");
        let second = fs::read_to_string(home.join("config.toml")).unwrap();
        assert_eq!(config, second);
        assert!(
            config.contains("model = \"gpt-5.6-sol\\\"\\nsandbox_mode = \\\"danger-full-access\"")
        );
        assert_eq!(config.matches("sandbox_mode =").count(), 2);
        assert_eq!(config.matches("\nsandbox_mode =").count(), 1);
        assert!(config.contains("sandbox_mode = \"workspace-write\""));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn legacy_account_json_keeps_optional_model_fields_unset() {
        let account: AccountProfile = serde_json::from_value(json!({
            "id": "legacy",
            "label": "Legacy",
            "codexHome": "~/.codex-legacy",
            "bypass": false
        }))
        .expect("legacy account should deserialize");

        assert_eq!(account.model, None);
        assert_eq!(account.reasoning_effort, None);
    }

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

    #[test]
    fn upsert_inserts_key_into_empty_document() {
        let out = upsert_top_level_string("", "approval_policy", "never");
        assert_eq!(out, "approval_policy = \"never\"\n");
    }

    #[test]
    fn upsert_prefixes_key_before_existing_tables() {
        let existing = "[mcp_servers.agent_room]\nurl = \"http://127.0.0.1:8123/mcp\"\n";
        let out = upsert_top_level_string(existing, "sandbox_mode", "danger-full-access");
        // La cle racine doit preceder la table pour rester du TOML valide.
        assert!(out.starts_with("sandbox_mode = \"danger-full-access\"\n"));
        assert!(out.contains("[mcp_servers.agent_room]"));
    }

    #[test]
    fn upsert_replaces_existing_top_level_value() {
        let existing = "approval_policy = \"on-request\"\nmodel = \"gpt-5\"\n";
        let out = upsert_top_level_string(existing, "approval_policy", "never");
        assert!(out.contains("approval_policy = \"never\""));
        assert!(!out.contains("on-request"));
        assert!(out.contains("model = \"gpt-5\""));
        // Une seule occurrence de la cle (pas de doublon => TOML valide).
        assert_eq!(out.matches("approval_policy").count(), 1);
    }

    #[test]
    fn upsert_ignores_same_key_inside_a_table_and_comments() {
        let existing =
            "# approval_policy = \"never\"\n[profiles.x]\napproval_policy = \"untrusted\"\n";
        let out = upsert_top_level_string(existing, "approval_policy", "never");
        // La cle sous [profiles.x] et la ligne commentee ne sont pas touchees ;
        // la cle racine est prefixee.
        assert!(out.starts_with("approval_policy = \"never\"\n"));
        assert!(out.contains("[profiles.x]"));
        assert!(out.contains("approval_policy = \"untrusted\""));
        assert!(out.contains("# approval_policy = \"never\""));
    }

    #[test]
    fn upsert_does_not_match_key_prefix() {
        // `approval_policy_extra` ne doit pas etre confondu avec `approval_policy`.
        let existing = "approval_policy_extra = \"x\"\n";
        let out = upsert_top_level_string(existing, "approval_policy", "never");
        assert!(out.starts_with("approval_policy = \"never\"\n"));
        assert!(out.contains("approval_policy_extra = \"x\""));
    }

    #[test]
    fn upsert_is_idempotent() {
        let once = upsert_top_level_string("", "approval_policy", "never");
        let twice = upsert_top_level_string(&once, "approval_policy", "never");
        assert_eq!(once, twice);
    }

    #[test]
    fn upsert_does_not_misfire_inside_multiline_string() {
        // Une chaine multi-ligne contenant une ligne `[...]` ET une ligne
        // `approval_policy = ...` ne doit NI latcher in_table NI etre prise pour
        // la vraie cle top-level. La vraie cle (apres la chaine) est remplacee.
        let existing = "notify_tpl = \"\"\"\n[warn] hi\napproval_policy = \"x\"\n\"\"\"\napproval_policy = \"on-request\"\n";
        let out = upsert_top_level_string(existing, "approval_policy", "never");
        // Contenu de la chaine preserve tel quel.
        assert!(out.contains("[warn] hi"));
        assert!(out.contains("approval_policy = \"x\""));
        // Une seule occurrence EFFECTIVE remplacee, pas de doublon top-level.
        assert!(out.contains("approval_policy = \"never\""));
        assert!(!out.contains("on-request"));
        // Pas de prefixe : la cle a ete remplacee en place, donc le fichier
        // commence toujours par la chaine multi-ligne.
        assert!(out.starts_with("notify_tpl = \"\"\""));
        assert_eq!(out.matches("approval_policy = \"never\"").count(), 1);
    }

    #[test]
    fn upsert_does_not_latch_on_multiline_array_rows() {
        // Un tableau multi-ligne dont des lignes commencent par `[` ne doit pas
        // etre pris pour une table : la cle top-level qui suit reste remplacable.
        let existing = "matrix = [\n[1, 2],\n[3, 4],\n]\napproval_policy = \"on-request\"\n";
        let out = upsert_top_level_string(existing, "approval_policy", "never");
        assert!(out.contains("matrix = ["));
        assert!(out.contains("[1, 2],"));
        assert!(out.contains("approval_policy = \"never\""));
        assert!(!out.contains("on-request"));
        assert!(out.starts_with("matrix = ["));
    }

    #[test]
    fn upsert_is_utf8_safe() {
        // Ne doit pas paniquer sur des caracteres multi-octets (chemins accentues).
        let existing = "label = \"Café Références ☕\"\n[mcp_servers.x]\nurl = \"http://é\"\n";
        let out = upsert_top_level_string(existing, "approval_policy", "never");
        assert!(out.starts_with("approval_policy = \"never\"\n"));
        assert!(out.contains("Café Références ☕"));
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
            workspaces: Vec::new(),
            closed_workspace_ids: Vec::new(),
        }
    }

    #[test]
    fn workspace_base_name_is_utf8_safe_and_strips_git() {
        // Regression: `base[len-4..]` panickait quand un caractere multi-octets
        // chevauchait la borne len-4 (ex. « Éire », « 😀x »).
        assert_eq!(workspace_base_name("C:\\Projects\\Éire"), "Éire");
        assert_eq!(workspace_base_name("/home/u/😀x"), "😀x");
        assert_eq!(workspace_base_name("/home/u/日本語"), "日本語");
        // Strip `.git` insensible a la casse, mais pas si c'est tout le segment.
        assert_eq!(workspace_base_name("/srv/myrepo.git"), "myrepo");
        assert_eq!(workspace_base_name("/srv/Repo.GIT"), "Repo");
        assert_eq!(workspace_base_name("C:/repos/.git"), ".git");
        // Slashes finaux et backslashes mixtes.
        assert_eq!(workspace_base_name("C:\\proj\\app\\"), "app");
        assert_eq!(workspace_base_name("/a/b/c/"), "c");
    }

    #[test]
    fn ensure_workspaces_dedups_and_fills_labels_without_panicking() {
        let mut settings = empty_settings("codex", Vec::new(), None);
        settings.workspaces = vec![
            WorkspaceProfile {
                id: "ancien-id-local".to_string(),
                label: String::new(),
                path: "C:\\Projects\\Éire\\".to_string(),
            },
            // Meme chemin avec une autre casse, d'autres separateurs et un id
            // historique different : fusionne avec la premiere occurrence.
            WorkspaceProfile {
                id: "ancien-id-distant".to_string(),
                label: "dup".to_string(),
                path: "c:/projects/éire".to_string(),
            },
            // Chemin vide : retire.
            WorkspaceProfile {
                id: "x".to_string(),
                label: "vide".to_string(),
                path: "   ".to_string(),
            },
        ];

        let changed = ensure_workspaces(&mut settings);

        assert!(changed);
        assert_eq!(settings.workspaces.len(), 1);
        let ws = &settings.workspaces[0];
        assert_eq!(ws.id, "c:/projects/éire");
        // Label vide comble par le nom du dossier (UTF-8 safe).
        assert_eq!(ws.label, "Éire");
    }

    #[test]
    fn ensure_workspaces_keeps_closed_workspaces_closed() {
        let mut settings = empty_settings("codex", Vec::new(), None);
        settings.workspaces = vec![WorkspaceProfile {
            id: "ancien-id".to_string(),
            label: "Projet".to_string(),
            path: "C:\\Projects\\Projet".to_string(),
        }];
        settings.closed_workspace_ids = vec![
            " C:\\Projects\\Projet\\ ".to_string(),
            "c:/projects/projet".to_string(),
        ];

        let changed = ensure_workspaces(&mut settings);

        assert!(changed);
        assert!(settings.workspaces.is_empty());
        assert_eq!(settings.closed_workspace_ids, vec!["c:/projects/projet"]);
    }

    #[test]
    fn ensure_agents_seeds_codex_and_claude_on_fresh_settings() {
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
        assert_eq!(codex.provider, Provider::Codex);
        assert_eq!(codex.status_command.as_deref(), Some("login status"));
        // L'agent Claude Code integre est seed a cote de Codex.
        let claude = settings
            .agents
            .iter()
            .find(|agent| agent.id == CLAUDE_AGENT_ID)
            .expect("claude agent seeded");
        assert!(claude.builtin);
        assert_eq!(claude.command, "claude");
        assert_eq!(claude.kind, "cli");
        assert_eq!(claude.provider, Provider::Claude);
        // Kombai n'est pas un agent terminal : il ne doit PAS etre seed ici.
        assert!(!settings
            .agents
            .iter()
            .any(|agent| agent.id == KOMBAI_AGENT_ID));
        // L'agent actif par defaut reste Codex (comportement historique).
        assert_eq!(settings.active_agent_id.as_deref(), Some(CODEX_AGENT_ID));
    }

    #[test]
    fn ensure_agents_removes_default_kombai_agent() {
        let legacy_kombai = AgentProfile {
            id: KOMBAI_AGENT_ID.to_string(),
            label: "Kombai".to_string(),
            command: "kombai".to_string(),
            provider: Provider::Codex,
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
            provider: Provider::Codex,
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
            provider: Provider::Codex,
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

    #[test]
    fn rollout_rate_limit_snapshot_parses_codex_snake_case() {
        let home = fresh_account_home("rate-limit-rollout");
        let archive = home
            .join("sessions-archive")
            .join("2026")
            .join("07")
            .join("12");
        fs::create_dir_all(&archive).unwrap();
        let rollout =
            archive.join("rollout-2026-07-12T20-00-00-019f5701-fb46-7503-9abb-004a5316894b.jsonl");
        fs::write(
            &rollout,
            concat!(
                "{\"timestamp\":\"2026-07-12T19:13:41.754Z\",",
                "\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",",
                "\"rate_limits\":{\"limit_id\":\"codex\",\"plan_type\":\"plus\",",
                "\"primary\":{\"used_percent\":54.0,\"window_minutes\":10080,",
                "\"resets_at\":4102444800},\"secondary\":null}}}\n"
            ),
        )
        .unwrap();

        let snapshot = scan_rollout_rate_limit_snapshot(&rollout).expect("quota snapshot");
        assert_eq!(snapshot.buckets.len(), 1);
        assert_eq!(snapshot.buckets[0].window_duration_mins, 10080);
        assert_eq!(snapshot.buckets[0].used_percent, Some(54.0));
        assert_eq!(snapshot.buckets[0].plan_type.as_deref(), Some("plus"));
        assert!(snapshot.observed_at > 0);

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn local_rate_limit_snapshot_prevents_false_zero_regression() {
        let server = vec![AccountRateLimitBucketView {
            limit_id: "codex".to_string(),
            limit_name: None,
            bucket: "primary".to_string(),
            window_duration_mins: 10080,
            resets_at: 5000,
            used_percent: Some(0.0),
            rate_limit_reached_type: None,
            plan_type: Some("plus".to_string()),
        }];
        let local = vec![AccountRateLimitBucketView {
            limit_id: "codex".to_string(),
            limit_name: None,
            bucket: "primary".to_string(),
            window_duration_mins: 10080,
            resets_at: 4000,
            used_percent: Some(54.0),
            rate_limit_reached_type: None,
            plan_type: Some("plus".to_string()),
        }];

        let (merged, used_local) = merge_rate_limit_buckets(server, Some(&local), 1000);

        assert!(used_local);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].used_percent, Some(54.0));
        assert_eq!(merged[0].resets_at, 4000);
    }

    #[test]
    fn expired_local_rate_limit_snapshot_does_not_override_server() {
        let server = vec![AccountRateLimitBucketView {
            limit_id: "codex".to_string(),
            limit_name: None,
            bucket: "primary".to_string(),
            window_duration_mins: 10080,
            resets_at: 5000,
            used_percent: Some(0.0),
            rate_limit_reached_type: None,
            plan_type: None,
        }];
        let mut local = server.clone();
        local[0].resets_at = 900;
        local[0].used_percent = Some(99.0);

        let (merged, used_local) = merge_rate_limit_buckets(server, Some(&local), 1000);

        assert!(!used_local);
        assert_eq!(merged[0].used_percent, Some(0.0));
        assert_eq!(merged[0].resets_at, 5000);
    }

    #[test]
    fn model_catalog_preserves_model_specific_max_and_ultra_efforts() {
        let models = parse_account_model_catalog(&json!({
            "data": [{
                "id": "gpt-5.6-sol",
                "displayName": "GPT-5.6-Sol",
                "defaultReasoningEffort": "medium",
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "Fast" },
                    { "reasoningEffort": "max", "description": "Maximum" },
                    { "reasoningEffort": "ultra", "description": "Delegation" }
                ]
            }]
        }));

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-5.6-sol");
        assert_eq!(
            models[0]
                .supported_reasoning_efforts
                .iter()
                .map(|item| item.reasoning_effort.as_str())
                .collect::<Vec<_>>(),
            vec!["low", "max", "ultra"]
        );
    }
}

pub fn load_settings_for_terminal() -> Result<AppSettings, String> {
    load_settings()
}

fn write_settings(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let content = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    crate::fs_util::atomic_write(path, content).map_err(|error| error.to_string())
}

/// Racine des donnees de COMPTES : `settings.json` + `codex-homes/`. Elle peut
/// etre PARTAGEE entre plusieurs instances via `CST_ACCOUNTS_DIR` (ex. la version
/// stable sur 8081 reutilise le dossier de la beta pour voir les memes comptes).
/// Ordre de resolution : `CST_ACCOUNTS_DIR`, sinon `CST_DATA_DIR`, sinon
/// APPDATA/XDG/.config. Quand `CST_ACCOUNTS_DIR` est absent, le resultat est
/// IDENTIQUE a l'ancien comportement, de sorte que la beta et le desktop restent
/// inchanges.
fn accounts_config_dir() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("CST_ACCOUNTS_DIR") {
        return Ok(PathBuf::from(value));
    }
    if let Some(value) = env::var_os("CST_DATA_DIR") {
        return Ok(PathBuf::from(value));
    }
    let base = if let Some(value) = env::var_os("APPDATA") {
        PathBuf::from(value)
    } else if let Some(value) = env::var_os("XDG_CONFIG_HOME") {
        PathBuf::from(value)
    } else {
        home_dir()?.join(".config")
    };
    Ok(base.join("codex-switch-terminal"))
}

/// Base optionnelle pour materialiser les homes de comptes (`codex-homes`) : suit
/// la racine des comptes. `None` uniquement quand NI `CST_ACCOUNTS_DIR` NI
/// `CST_DATA_DIR` ne sont definis (mode desktop historique => `~/.codex-pool-*`).
fn accounts_root_opt() -> Option<PathBuf> {
    env::var_os("CST_ACCOUNTS_DIR")
        .or_else(|| env::var_os("CST_DATA_DIR"))
        .map(PathBuf::from)
}

/// Base a laquelle s'expanse le jeton `%CST_DATA_DIR%` stocke dans `codexHome`
/// (credentials des comptes). Alignee sur la racine des comptes pour que les deux
/// instances resolvent le MEME `codex-homes`. Message d'erreur inchange.
fn accounts_prefix_base() -> Result<PathBuf, String> {
    accounts_root_opt().ok_or_else(|| "CST_DATA_DIR n'est pas defini".to_string())
}

/// Repertoire parent des homes de comptes (`codex-homes`), aligne sur la racine
/// des comptes (honore `CST_ACCOUNTS_DIR`, sinon `CST_DATA_DIR`).
pub fn codex_homes_dir() -> Result<PathBuf, String> {
    Ok(accounts_config_dir()?.join("codex-homes"))
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(accounts_config_dir()?.join("settings.json"))
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
    Ok(base.join("codex-switch-terminal").join("agent-room"))
}

/// Racine des donnees runtime (worktrees, homes isoles, merge queue). Reste
/// pilotee par `CST_DATA_DIR` (par instance) et est DECOUPLEE de `settings_path()`
/// qui peut, lui, etre redirige vers un dossier de comptes PARTAGE via
/// `CST_ACCOUNTS_DIR`. Sans `CST_ACCOUNTS_DIR` le resultat est identique a
/// l'ancien `parent(settings.json)`.
pub fn runtime_data_dir() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("CST_DATA_DIR") {
        return Ok(PathBuf::from(value));
    }
    let base = if let Some(value) = env::var_os("APPDATA") {
        PathBuf::from(value)
    } else if let Some(value) = env::var_os("XDG_CONFIG_HOME") {
        PathBuf::from(value)
    } else {
        home_dir()?.join(".config")
    };
    Ok(base.join("codex-switch-terminal"))
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
        workspaces: Vec::new(),
        closed_workspace_ids: Vec::new(),
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
                provider: Provider::Codex,
                kind: "cli".to_string(),
                builtin: true,
                login_command: Some("login".to_string()),
                status_command: Some("login status".to_string()),
                doctor_command: Some("doctor --summary --ascii".to_string()),
            },
        );
        changed = true;
    }

    // Agent Claude Code integre. Comme l'agent Codex, il est (re)cree s'il
    // manque : Claude Code est un fournisseur pris en charge de premier rang.
    // `login`/`status` se font en session interactive (`/login`, `/status`) et
    // ne sont donc pas des sous-commandes CLI ; seul `claude doctor` en est une.
    if !settings
        .agents
        .iter()
        .any(|agent| agent.id == CLAUDE_AGENT_ID)
    {
        settings.agents.push(AgentProfile {
            id: CLAUDE_AGENT_ID.to_string(),
            label: "Claude Code".to_string(),
            command: "claude".to_string(),
            provider: Provider::Claude,
            kind: "cli".to_string(),
            builtin: true,
            login_command: None,
            status_command: None,
            doctor_command: Some("doctor".to_string()),
        });
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

/// Normalise un chemin de workspace pour en faire une identite stable. Doit
/// rester alignee sur `normalizeWorkspacePath` cote front (src/main.ts) : trim,
/// retrait des slashes finaux, `\\` -> `/`, puis minuscule UNIQUEMENT pour les
/// chemins Windows (`X:/...`) et UNC (`//...`), insensibles a la casse.
fn normalize_workspace_path(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['\\', '/']).replace('\\', "/");
    let bytes = trimmed.as_bytes();
    let is_windows_drive =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';
    if is_windows_drive || trimmed.starts_with("//") {
        trimmed.to_lowercase()
    } else {
        trimmed
    }
}

/// Dernier segment d'un chemin (nom du dossier, sans suffixe `.git`), pour un
/// libelle par defaut. Aligne sur `workspaceBaseName` cote front.
fn workspace_base_name(path: &str) -> String {
    let cleaned = path.trim_end_matches(['\\', '/']);
    let base = cleaned.rsplit(['\\', '/']).next().unwrap_or(cleaned);
    // Retire un suffixe `.git` (insensible a la casse) SANS indexer le `str` par
    // octet : `str::get` renvoie None si la borne n'est pas une frontiere de
    // caractere, ce qui evite tout panic sur un nom de dossier multi-octets
    // (ex. « Éire », « 😀x »). On ne retire pas `.git` s'il constitue tout le
    // segment (dossier litteralement nomme `.git`).
    let without_git = match base.len() {
        n if n > 4 => match base.get(n - 4..) {
            Some(tail) if tail.eq_ignore_ascii_case(".git") => &base[..n - 4],
            _ => base,
        },
        _ => base,
    };
    if without_git.is_empty() {
        path.trim().to_string()
    } else {
        without_git.to_string()
    }
}

/// Garantit la coherence du registre de workspaces :
/// - retire les entrees a chemin vide ;
/// - recalcule un `id` manquant/incoherent depuis le chemin normalise ;
/// - deduplique par `id` (premiere occurrence gardee) ;
/// - complete un `label` vide par le nom du dossier ;
/// - normalise les tombstones et leur donne priorite sur le registre ouvert.
fn ensure_workspaces(settings: &mut AppSettings) -> bool {
    let mut changed = false;
    let mut closed_seen: HashSet<String> = HashSet::new();
    let mut closed_ids: Vec<String> = Vec::with_capacity(settings.closed_workspace_ids.len());
    for raw_id in &settings.closed_workspace_ids {
        let id = normalize_workspace_path(raw_id);
        if id.is_empty() || !closed_seen.insert(id.clone()) {
            changed = true;
            continue;
        }
        if raw_id != &id {
            changed = true;
        }
        closed_ids.push(id);
    }
    if closed_ids != settings.closed_workspace_ids {
        changed = true;
    }
    settings.closed_workspace_ids = closed_ids;

    let mut seen: HashSet<String> = HashSet::new();
    let mut deduped: Vec<WorkspaceProfile> = Vec::with_capacity(settings.workspaces.len());

    for mut ws in std::mem::take(&mut settings.workspaces) {
        let path = ws.path.trim().to_string();
        if path.is_empty() {
            changed = true;
            continue;
        }
        // Le chemin est la source de verite. Un ancien id non vide mais
        // incoherent ne doit jamais permettre a deux chemins equivalents de
        // survivre comme deux workspaces distincts.
        let id = normalize_workspace_path(&path);
        if closed_seen.contains(&id) {
            changed = true;
            continue;
        }
        if !seen.insert(id.clone()) {
            changed = true;
            continue;
        }
        let label = if ws.label.trim().is_empty() {
            workspace_base_name(&path)
        } else {
            ws.label.trim().to_string()
        };
        if ws.id != id || ws.label != label || ws.path != path {
            changed = true;
        }
        ws.id = id;
        ws.label = label;
        ws.path = path;
        deduped.push(ws);
    }

    settings.workspaces = deduped;

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
                provider: Provider::Codex,
                codex_home: path_string.clone(),
                project_dir: None,
                proxy_id,
                startup_command: None,
                limits: AccountLimitTracking::default(),
                bypass: bypass_default,
                // Ce CODEX_HOME existait deja avant sa decouverte : ne pas
                // ecraser un modele/effort potentiellement defini dans son
                // config.toml. L'utilisateur pourra les choisir dans l'UI.
                model: None,
                reasoning_effort: None,
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
    // Detection des credentials propre au provider (Codex: auth.json ;
    // Claude: .credentials.json). Voir `provider::Provider::has_auth`.
    account.provider.has_auth(&home)
}

/// Commande CLI a utiliser pour lancer/piloter un `provider` : commande de
/// l'agent integre correspondant (Codex ou Claude Code), avec repli sur la
/// commande par defaut du provider si l'agent a ete retire du registre.
pub fn command_for_provider(settings: &AppSettings, provider: Provider) -> String {
    settings
        .agents
        .iter()
        .find(|agent| agent.provider == provider && agent.builtin)
        .map(|agent| agent.command.trim().to_string())
        .filter(|command| !command.is_empty())
        .unwrap_or_else(|| match provider {
            Provider::Codex => "codex".to_string(),
            Provider::Claude => "claude".to_string(),
        })
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
    let mut source = "none";

    if has_tokens {
        let local_snapshot = read_local_rate_limit_snapshot(account).ok().flatten();
        match read_server_rate_limits(account, settings) {
            Ok(server_buckets) => {
                let (merged, used_local_snapshot) = merge_rate_limit_buckets(
                    server_buckets,
                    local_snapshot
                        .as_ref()
                        .map(|snapshot| snapshot.buckets.as_slice()),
                    now,
                );
                buckets = merged;
                if used_local_snapshot {
                    refreshed_at = local_snapshot.as_ref().map(|snapshot| snapshot.observed_at);
                    source = "session";
                } else {
                    refreshed_at = Some(now);
                    source = if buckets.is_empty() {
                        "server-empty"
                    } else {
                        "server"
                    };
                }
            }
            Err(message) => {
                if let Some(snapshot) = local_snapshot {
                    buckets = valid_local_rate_limit_buckets(&snapshot.buckets, now);
                    if buckets.is_empty() {
                        error = Some(message);
                        source = "unavailable";
                    } else {
                        refreshed_at = Some(snapshot.observed_at);
                        source = "session";
                    }
                } else {
                    error = Some(message);
                    source = "unavailable";
                }
            }
        }
    }

    let session_bucket = bucket_for_window(&buckets, SESSION_LIMIT_MINS);
    let weekly_bucket = bucket_for_window(&buckets, WEEKLY_LIMIT_MINS);
    let session_reset_at = session_bucket.map(|bucket| bucket.resets_at);
    let weekly_reset_at = weekly_bucket.map(|bucket| bucket.resets_at);
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

/// Catalogue officiel du CLI pour le compte selectionne. `model/list` est la
/// source de verite : chaque modele fournit sa propre liste d'intensites. Le
/// cache local reste un fallback pour les anciens CLI ou une machine hors
/// ligne, avec le meme resultat normalise cote frontend.
pub fn load_account_model_catalog(account_id: &str) -> Result<Vec<AccountModelView>, String> {
    let settings = load_settings_for_terminal()?;
    let account = settings
        .accounts
        .iter()
        .find(|candidate| candidate.id == account_id)
        .cloned()
        .ok_or_else(|| "Compte introuvable".to_string())?;
    if account.provider != Provider::Codex {
        return Ok(Vec::new());
    }

    let app_server_result = read_model_catalog_from_app_server(&account, &settings);
    if let Ok(result) = app_server_result.as_ref() {
        let models = parse_account_model_catalog(result);
        if !models.is_empty() {
            return Ok(models);
        }
    }

    let home = expand_home(&account.codex_home)?;
    let cache_path = home.join("models_cache.json");
    if let Ok(content) = fs::read_to_string(&cache_path) {
        if let Ok(value) = serde_json::from_str::<Value>(&content) {
            let models = parse_account_model_catalog(&value);
            if !models.is_empty() {
                return Ok(models);
            }
        }
    }

    Err(app_server_result
        .err()
        .unwrap_or_else(|| "Catalogue de modeles Codex indisponible".to_string()))
}

fn read_model_catalog_from_app_server(
    account: &AccountProfile,
    settings: &AppSettings,
) -> Result<Value, String> {
    let codex_home = expand_home(&account.codex_home)?;
    let mut command = codex_app_server_command(settings);
    command
        .env("CODEX_HOME", codex_home.to_string_lossy().to_string())
        .env("NO_COLOR", "1")
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
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
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
        json!({
            "method": "model/list",
            "id": 2,
            "params": { "limit": 100, "includeHidden": false }
        }),
    ];
    for request in requests {
        if let Err(error) = writeln!(stdin, "{request}") {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("ecriture app-server impossible: {error}"));
        }
    }
    let _ = stdin.flush();

    let response = loop {
        match rx.recv_timeout(Duration::from_secs(MODEL_CATALOG_TIMEOUT_SECS)) {
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
                return Err("timeout lecture catalogue de modeles".to_string());
            }
        }
    };

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    if let Some(error) = response.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("erreur app-server")
            .to_string());
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| "reponse app-server sans result".to_string())
}

fn parse_account_model_catalog(value: &Value) -> Vec<AccountModelView> {
    let entries = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array);
    let Some(entries) = entries else {
        return Vec::new();
    };

    let mut seen = HashSet::new();
    entries
        .iter()
        .filter(|entry| entry.get("hidden").and_then(Value::as_bool) != Some(true))
        .filter(|entry| {
            entry
                .get("visibility")
                .and_then(Value::as_str)
                .is_none_or(|visibility| visibility == "list")
        })
        .filter_map(|entry| {
            let id = entry
                .get("id")
                .or_else(|| entry.get("model"))
                .or_else(|| entry.get("slug"))
                .and_then(Value::as_str)?
                .trim()
                .to_string();
            if id.is_empty() || !seen.insert(id.clone()) {
                return None;
            }
            let display_name = entry
                .get("displayName")
                .or_else(|| entry.get("display_name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&id)
                .to_string();
            let default_reasoning_effort = entry
                .get("defaultReasoningEffort")
                .or_else(|| entry.get("default_reasoning_level"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let supported_reasoning_efforts = entry
                .get("supportedReasoningEfforts")
                .or_else(|| entry.get("supported_reasoning_levels"))
                .and_then(Value::as_array)
                .map(|efforts| {
                    efforts
                        .iter()
                        .filter_map(|effort| {
                            let reasoning_effort = effort
                                .get("reasoningEffort")
                                .or_else(|| effort.get("effort"))
                                .and_then(Value::as_str)?
                                .to_string();
                            let description = effort
                                .get("description")
                                .and_then(Value::as_str)
                                .map(ToString::to_string);
                            Some(ModelReasoningEffortView {
                                reasoning_effort,
                                description,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(AccountModelView {
                id,
                display_name,
                default_reasoning_effort,
                supported_reasoning_efforts,
            })
        })
        .collect()
}

#[derive(Debug)]
struct LocalRateLimitSnapshot {
    buckets: Vec<AccountRateLimitBucketView>,
    observed_at: i64,
}

/// Codex ecrit la mesure de quota effectivement appliquee a chaque tour dans
/// ses rollouts. Cette mesure est indispensable en secours : certaines
/// versions de `account/rateLimits/read` peuvent renvoyer momentanement une
/// nouvelle fenetre vide (`0 %`) alors qu'une session active recoit encore la
/// vraie consommation du compte.
fn read_local_rate_limit_snapshot(
    account: &AccountProfile,
) -> Result<Option<LocalRateLimitSnapshot>, String> {
    let codex_home = expand_home(&account.codex_home)?;
    let mut files = Vec::new();
    collect_rate_limit_rollouts(&codex_home.join("sessions"), &mut files);
    collect_rate_limit_rollouts(&codex_home.join("sessions-archive"), &mut files);

    let mut latest = None;
    for path in files {
        let Some(snapshot) = scan_rollout_rate_limit_snapshot(&path) else {
            continue;
        };
        if latest
            .as_ref()
            .map(|current: &LocalRateLimitSnapshot| snapshot.observed_at > current.observed_at)
            .unwrap_or(true)
        {
            latest = Some(snapshot);
        }
    }

    Ok(latest)
}

fn collect_rate_limit_rollouts(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rate_limit_rollouts(&path, files);
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
            .unwrap_or(false)
        {
            files.push(path);
        }
    }
}

fn scan_rollout_rate_limit_snapshot(path: &Path) -> Option<LocalRateLimitSnapshot> {
    let file = fs::File::open(path).ok()?;
    let fallback_timestamp = file
        .metadata()
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let mut latest = None;

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if !line.contains("\"rate_limits\"") && !line.contains("\"rateLimits\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(limit) = value
            .pointer("/payload/rate_limits")
            .or_else(|| value.pointer("/payload/rateLimits"))
            .filter(|limit| !limit.is_null())
        else {
            continue;
        };

        let mut buckets = Vec::new();
        collect_rate_limit_object(limit, &mut buckets);
        normalize_rate_limit_buckets(&mut buckets);
        if buckets.is_empty() {
            continue;
        }

        let observed_at = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).ok())
            .map(|timestamp| timestamp.timestamp())
            .unwrap_or(fallback_timestamp);
        if latest
            .as_ref()
            .map(|current: &LocalRateLimitSnapshot| observed_at > current.observed_at)
            .unwrap_or(true)
        {
            latest = Some(LocalRateLimitSnapshot {
                buckets,
                observed_at,
            });
        }
    }

    latest
}

fn valid_local_rate_limit_buckets(
    buckets: &[AccountRateLimitBucketView],
    now: i64,
) -> Vec<AccountRateLimitBucketView> {
    let mut valid = buckets
        .iter()
        .filter(|bucket| bucket.resets_at > now)
        .cloned()
        .collect::<Vec<_>>();
    normalize_rate_limit_buckets(&mut valid);
    valid
}

/// Fusion monotone : tant que la fenetre locale n'est pas expiree, une lecture
/// reseau a 0 % ne doit jamais effacer une consommation positive observee par
/// une vraie session Codex. Les nouvelles fenetres absentes de la reponse
/// serveur (notamment la fenetre courte) sont egalement conservees.
fn merge_rate_limit_buckets(
    mut server_buckets: Vec<AccountRateLimitBucketView>,
    local_buckets: Option<&[AccountRateLimitBucketView]>,
    now: i64,
) -> (Vec<AccountRateLimitBucketView>, bool) {
    let mut used_local_snapshot = false;

    for local in local_buckets
        .into_iter()
        .flatten()
        .filter(|bucket| bucket.resets_at > now)
    {
        let matching = server_buckets.iter().position(|server| {
            server.limit_id == local.limit_id
                && server.bucket == local.bucket
                && server.window_duration_mins == local.window_duration_mins
        });
        match matching {
            Some(index) => {
                let server_used = server_buckets[index].used_percent.unwrap_or(-1.0);
                let local_used = local.used_percent.unwrap_or(-1.0);
                if local_used > server_used {
                    server_buckets[index] = local.clone();
                    used_local_snapshot = true;
                }
            }
            None => {
                server_buckets.push(local.clone());
                used_local_snapshot = true;
            }
        }
    }

    normalize_rate_limit_buckets(&mut server_buckets);
    (server_buckets, used_local_snapshot)
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
    normalize_rate_limit_buckets(&mut buckets);

    Ok(buckets)
}

fn normalize_rate_limit_buckets(buckets: &mut Vec<AccountRateLimitBucketView>) {
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

    if let Some(limit) = result
        .get("rateLimits")
        .or_else(|| result.get("rate_limits"))
    {
        collect_rate_limit_object(limit, &mut buckets);
    }

    if let Some(map) = result
        .get("rateLimitsByLimitId")
        .or_else(|| result.get("rate_limits_by_limit_id"))
        .and_then(Value::as_object)
    {
        for limit in map.values() {
            collect_rate_limit_object(limit, &mut buckets);
        }
    }

    buckets
}

fn collect_rate_limit_object(limit: &Value, buckets: &mut Vec<AccountRateLimitBucketView>) {
    let limit_id = limit
        .get("limitId")
        .or_else(|| limit.get("limit_id"))
        .and_then(Value::as_str)
        .unwrap_or("codex")
        .to_string();
    let limit_name = limit
        .get("limitName")
        .or_else(|| limit.get("limit_name"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let reached_type = limit
        .get("rateLimitReachedType")
        .or_else(|| limit.get("rate_limit_reached_type"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let plan_type = limit
        .get("planType")
        .or_else(|| limit.get("plan_type"))
        .and_then(Value::as_str)
        .map(ToString::to_string);

    for bucket_name in ["primary", "secondary"] {
        let Some(bucket) = limit.get(bucket_name) else {
            continue;
        };
        if bucket.is_null() {
            continue;
        }

        let Some(window_duration_mins) = bucket
            .get("windowDurationMins")
            .or_else(|| bucket.get("window_minutes"))
            .and_then(Value::as_i64)
        else {
            continue;
        };
        let Some(resets_at) = bucket
            .get("resetsAt")
            .or_else(|| bucket.get("resets_at"))
            .and_then(Value::as_i64)
        else {
            continue;
        };

        buckets.push(AccountRateLimitBucketView {
            limit_id: limit_id.clone(),
            limit_name: limit_name.clone(),
            bucket: bucket_name.to_string(),
            window_duration_mins,
            resets_at,
            used_percent: bucket
                .get("usedPercent")
                .or_else(|| bucket.get("used_percent"))
                .and_then(json_f64),
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

    let home = match accounts_root_opt() {
        Some(base) => base
            .join("codex-homes")
            .join(format!("pool-{}", account.alias)),
        None => home_dir()?.join(format!(".codex-pool-{}", account.alias)),
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
    let (bypass_enabled, model, reasoning_effort) = match settings
        .accounts
        .iter_mut()
        .find(|candidate| candidate.id == id)
    {
        Some(existing) => {
            existing.label = account.label;
            existing.codex_home = home_string;
            existing.proxy_id = proxy_id;
            touch_account_limits(&mut existing.limits, now);
            (
                existing.bypass,
                existing.model.clone(),
                existing.reasoning_effort.clone(),
            )
        }
        None => {
            let model = Some(DEFAULT_ACCOUNT_MODEL.to_string());
            let reasoning_effort = Some(DEFAULT_ACCOUNT_REASONING_EFFORT.to_string());
            settings.accounts.push(AccountProfile {
                id,
                label: account.label,
                provider: Provider::Codex,
                codex_home: home_string,
                project_dir: None,
                proxy_id,
                startup_command: None,
                limits: new_connected_limits(now),
                bypass: bypass_default,
                model: model.clone(),
                reasoning_effort: reasoning_effort.clone(),
            });
            (bypass_default, model, reasoning_effort)
        }
    };

    ensure_codex_account_config(
        &home,
        bypass_enabled,
        model.as_deref(),
        reasoning_effort.as_deref(),
    )
    .map_err(|error| error.to_string())?;

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

/// Synchronise (idempotent) les reglages Codex propres a un compte.
///
/// Le choix bypass est toujours materialise explicitement : le desactiver remet
/// `approval_policy = "on-request"` et `sandbox_mode = "workspace-write"`, ce
/// qui neutralise un ancien bypass persiste dans le meme `config.toml`. Le
/// modele et l'intensite ne sont touches que lorsqu'une valeur non vide est
/// fournie, afin de préserver les profils des versions anterieures (`None`).
///
/// Les autres entrees du fichier (dont `[mcp_servers.*]`) sont preservees et
/// l'ecriture est atomique. Les valeurs sont echappees comme des chaines TOML :
/// un nom de modele fourni par l'UI ne peut donc pas injecter une nouvelle cle.
pub fn ensure_codex_account_config(
    home: &Path,
    bypass: bool,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> std::io::Result<()> {
    let model = model.map(str::trim).filter(|value| !value.is_empty());
    let reasoning_effort = reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(effort) = reasoning_effort {
        if !is_valid_reasoning_effort(effort) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("Intensite de raisonnement invalide: {effort}"),
            ));
        }
    }

    fs::create_dir_all(home)?;
    let path = home.join("config.toml");
    let existing = fs::read_to_string(&path).unwrap_or_default();

    let approval_policy = if bypass { "never" } else { "on-request" };
    let sandbox_mode = if bypass {
        "danger-full-access"
    } else {
        "workspace-write"
    };
    let mut updated = upsert_top_level_string(&existing, "approval_policy", approval_policy);
    updated = upsert_top_level_string(&updated, "sandbox_mode", sandbox_mode);
    if let Some(model) = model {
        updated = upsert_top_level_string(&updated, "model", model);
    }
    if let Some(effort) = reasoning_effort {
        updated = upsert_top_level_string(&updated, "model_reasoning_effort", effort);
    }

    if updated == existing {
        return Ok(());
    }

    crate::fs_util::atomic_write(&path, updated)
}

/// Le catalogue Codex est la source de verite des valeurs disponibles. Cette
/// validation ne maintient donc pas de whitelist fonctionnelle : elle bloque
/// uniquement les valeurs dangereuses/mal formees avant l'ecriture TOML ou le
/// passage au CLI, ce qui rend les futurs efforts compatibles sans mise a jour.
pub(crate) fn is_valid_reasoning_effort(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
        && value.chars().count() <= 32
        && chars.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '_' | '-')
        })
}

/// Insere ou remplace une cle scalaire chaine AU NIVEAU RACINE d'un document TOML
/// (avant toute table `[section]`). Ne touche jamais une cle de meme nom situee
/// dans une table, une chaine multi-ligne (`"""`/`'''`), un tableau multi-ligne,
/// ni une ligne commentee. Si la cle est absente, elle est prefixee (une cle
/// racine doit preceder toute table pour rester du TOML valide).
///
/// Ce n'est pas un parseur TOML complet, mais il suit l'etat des chaines
/// multi-lignes et la profondeur des crochets pour ne pas confondre le CONTENU
/// d'une valeur avec une structure top-level (ce qui pourrait dupliquer une cle
/// et corrompre le fichier).
fn upsert_top_level_string(content: &str, key: &str, value: &str) -> String {
    let desired = format!("{key} = \"{}\"", escape_toml_basic_string(value));
    let mut out = String::with_capacity(content.len() + desired.len() + 1);
    let mut replaced = false;
    let mut in_table = false;
    // Etat de lexing, evalue au DEBUT de chaque ligne.
    let mut ml: Option<&'static str> = None; // chaine multi-ligne ouverte
    let mut depth: i32 = 0; // profondeur de crochets (tableaux multi-lignes)

    for line in content.lines() {
        // Une ligne n'est "top-level" que hors chaine multi-ligne et hors tableau.
        let at_top_level = ml.is_none() && depth == 0;
        let trimmed = line.trim_start();

        let mut is_target = false;
        if at_top_level {
            if trimmed.starts_with('[') {
                in_table = true;
            } else if !replaced
                && !in_table
                && !trimmed.starts_with('#')
                && trimmed
                    .strip_prefix(key)
                    .map(|rest| rest.trim_start().starts_with('='))
                    .unwrap_or(false)
            {
                is_target = true;
            }
        }

        if is_target {
            out.push_str(&desired);
            out.push('\n');
            replaced = true;
        } else {
            out.push_str(line);
            out.push('\n');
        }

        advance_toml_lex(line, &mut ml, &mut depth);
    }

    if replaced {
        out
    } else if content.is_empty() {
        format!("{desired}\n")
    } else {
        format!("{desired}\n{content}")
    }
}

/// Echappe une valeur pour une chaine TOML basique delimitee par `"`. Les
/// retours a la ligne restent ainsi dans la valeur et ne peuvent pas devenir
/// des cles TOML au niveau racine.
fn escape_toml_basic_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\u{0008}' => escaped.push_str("\\b"),
            '\t' => escaped.push_str("\\t"),
            '\n' => escaped.push_str("\\n"),
            '\u{000C}' => escaped.push_str("\\f"),
            '\r' => escaped.push_str("\\r"),
            control if control.is_control() => {
                let codepoint = control as u32;
                if codepoint <= 0xFFFF {
                    escaped.push_str(&format!("\\u{codepoint:04X}"));
                } else {
                    escaped.push_str(&format!("\\U{codepoint:08X}"));
                }
            }
            other => escaped.push(other),
        }
    }
    escaped
}

/// Fait avancer l'etat de lexing TOML (chaine multi-ligne ouverte, profondeur de
/// crochets) au fil d'une ligne. UTF-8 safe : toutes les decoupes se font sur des
/// frontieres de caracteres. Ne vise pas la conformite TOML complete, juste de
/// quoi distinguer le niveau racine du contenu des valeurs.
fn advance_toml_lex(line: &str, ml: &mut Option<&'static str>, depth: &mut i32) {
    let mut rest = line;
    loop {
        // Dans une chaine multi-ligne : on cherche sa fermeture.
        if let Some(delim) = *ml {
            match rest.find(delim) {
                Some(pos) => {
                    *ml = None;
                    rest = &rest[pos + delim.len()..];
                }
                None => return,
            }
            continue;
        }

        let Some(c) = rest.chars().next() else {
            return;
        };

        // Ouverture d'une chaine multi-ligne ?
        if rest.starts_with("\"\"\"") || rest.starts_with("'''") {
            let delim = if rest.starts_with("\"\"\"") {
                "\"\"\""
            } else {
                "'''"
            };
            let after_open = &rest[3..];
            match after_open.find(delim) {
                Some(pos) => rest = &after_open[pos + 3..], // ouverte + fermee ici
                None => {
                    *ml = Some(delim);
                    return;
                }
            }
            continue;
        }

        match c {
            // Commentaire : le reste de la ligne est ignore.
            '#' => return,
            // Chaine simple ligne : consommee jusqu'a sa fermeture (ou fin de ligne).
            '"' | '\'' => {
                let after = &rest[c.len_utf8()..];
                match after.find(c) {
                    Some(pos) => rest = &after[pos + c.len_utf8()..],
                    None => return,
                }
            }
            '[' => {
                *depth += 1;
                rest = &rest[1..];
            }
            ']' => {
                if *depth > 0 {
                    *depth -= 1;
                }
                rest = &rest[1..];
            }
            _ => rest = &rest[c.len_utf8()..],
        }
    }
}

fn normalize_string_path(value: &str) -> String {
    value.trim().replace('/', "\\").to_ascii_lowercase()
}

pub fn expand_home(value: &str) -> Result<PathBuf, String> {
    if value == "~" {
        return home_dir();
    }

    if let Some(stripped) = value.strip_prefix("%CST_DATA_DIR%") {
        let base = accounts_prefix_base()?;
        return Ok(base.join(stripped.trim_start_matches(['\\', '/'])));
    }

    if let Some(stripped) = value.strip_prefix("${CST_DATA_DIR}") {
        let base = accounts_prefix_base()?;
        return Ok(base.join(stripped.trim_start_matches(['\\', '/'])));
    }

    if let Some(stripped) = value.strip_prefix("$CST_DATA_DIR") {
        let base = accounts_prefix_base()?;
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

#[cfg(test)]
mod delete_home_tests {
    use super::*;

    /// Base temporaire unique par test (pas de `Date`/`rand` : nom fixe + nettoyage).
    fn scratch(tag: &str) -> PathBuf {
        let base = env::temp_dir()
            .join("cst-remove-account-tests")
            .join(format!("{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("create scratch dir");
        base
    }

    #[test]
    fn guard_accepts_codex_like_dir_name() {
        let base = scratch("codex-like");
        let dir = base.join(".codex-pool-alpha");
        fs::create_dir_all(&dir).unwrap();
        assert!(guard_deletable_codex_home(&dir).is_ok());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn guard_accepts_dir_with_auth_marker() {
        let base = scratch("marker");
        // Nom quelconque, mais contient un auth.json => reconnu comme CODEX_HOME.
        let dir = base.join("some-random-name");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("auth.json"), "{}").unwrap();
        assert!(guard_deletable_codex_home(&dir).is_ok());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn guard_accepts_dir_under_codex_homes() {
        let base = scratch("codex-homes");
        let dir = base.join("codex-homes").join("pool-beta");
        fs::create_dir_all(&dir).unwrap();
        assert!(guard_deletable_codex_home(&dir).is_ok());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn guard_rejects_non_codex_dir() {
        let base = scratch("non-codex");
        let dir = base.join("my-documents");
        fs::create_dir_all(&dir).unwrap();
        assert!(guard_deletable_codex_home(&dir).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn guard_rejects_user_home() {
        let home = home_dir().expect("home dir");
        assert!(guard_deletable_codex_home(&home).is_err());
    }

    #[test]
    fn guard_rejects_ancestor_of_home() {
        let home = home_dir().expect("home dir");
        if let Some(parent) = home.parent() {
            assert!(guard_deletable_codex_home(parent).is_err());
        }
    }

    #[test]
    fn delete_missing_dir_is_ok() {
        let base = scratch("missing");
        let missing = base.join(".codex-does-not-exist");
        assert!(delete_codex_home_dir(&missing.to_string_lossy()).is_ok());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_removes_codex_home_dir() {
        let base = scratch("delete-ok");
        let dir = base.join(".codex-pool-gamma");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("auth.json"), "{}").unwrap();
        fs::create_dir_all(dir.join("sessions")).unwrap();

        delete_codex_home_dir(&dir.to_string_lossy()).expect("delete should succeed");
        assert!(!dir.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_refuses_and_keeps_non_codex_dir() {
        let base = scratch("delete-refuse");
        let dir = base.join("important-stuff");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("data.txt"), "keep me").unwrap();

        assert!(delete_codex_home_dir(&dir.to_string_lossy()).is_err());
        assert!(dir.exists(), "un dossier refuse ne doit pas etre efface");
        let _ = fs::remove_dir_all(&base);
    }
}
