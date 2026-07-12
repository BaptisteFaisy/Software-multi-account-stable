//! Explorateur des **discussions** (sessions Codex) par compte.
//!
//! Codex CLI ecrit chaque conversation dans
//! `CODEX_HOME/sessions/AAAA/MM/JJ/rollout-<tsLocal>-<uuid>.jsonl`. La ligne 1
//! est un evenement `session_meta` (volumineux : elle embarque les
//! `base_instructions`), les lignes suivantes contiennent les messages
//! utilisateur (`user_message`), les reponses de l'agent (`agent_message`) et
//! l'usage cumulatif (`token_count`).
//!
//! Ce module fournit :
//! - `list_discussions` : le tableau de bord lecture seule (une carte par
//!   compte, une entree par discussion) ;
//! - `claim_session_for_terminal` : associe la session qu'un terminal vient de
//!   creer a son compte, en se basant UNIQUEMENT sur le nom de fichier
//!   (aucune ouverture de fichier — chemin chaud) ;
//! - `copy_discussion_to_account` : duplique une discussion vers un autre
//!   compte en reecrivant l'uuid (fichier + payload) ; la SOURCE reste
//!   octet-pour-octet identique ;
//! - `move_discussion` : rattache une discussion a un autre workspace en
//!   reecrivant son cwd ; pour Claude, le fichier est aussi deplace dans le
//!   dossier projet ou `claude --resume` saura le retrouver ;
//! - `delete_discussion` : archive (deplacement, par defaut) ou suppression
//!   explicite d'une discussion.
//!
//! INVARIANTS (revus de facon adverse) :
//! - Les rollouts de **sous-agents** multi-agent v2 (`thread_source ==
//!   "subagent"`) sont exclus du tableau de bord et de l'historique : ils ne
//!   sont pas reprenables (`turn/start` rejete par l'app-server) et usurpent le
//!   `session_id` du parent (cf. `is_subagent_rollout`). La cible de reprise est
//!   donc toujours un thread utilisateur.
//! - `move_discussion` ne touche qu'au cwd des metadonnees. Pour Claude, il
//!   deplace la session entre dossiers projet sans en modifier l'identite.
//! - Seul `delete_discussion` supprime/archive definitivement un rollout.
//! - `copy_discussion_to_account` n'ouvre JAMAIS la source en ecriture : la
//!   source reste identique, seule la destination est transformee.
//! - La copie reecrit a la fois l'uuid du nom de fichier ET
//!   `payload.session_id`/`payload.id` pour que `codex resume <new_id>`
//!   retrouve la copie quel que soit le mode de localisation de Codex.

use crate::account_usage::collect_rollouts;
use crate::metrics;
use crate::settings::{self, expand_home, AccountProfile, AppSettings};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    thread,
    time::UNIX_EPOCH,
};

const TITLE_MAX_CHARS: usize = 80;
const PREVIEW_MAX_CHARS: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionsDashboard {
    pub generated_at: i64,
    pub total_discussions: u64,
    pub accounts: Vec<DiscussionAccountGroup>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionAccountGroup {
    pub account_id: String,
    pub label: String,
    pub provider: settings::Provider,
    pub codex_home: String,
    pub has_tokens: bool,
    pub discussion_count: u64,
    pub discussions: Vec<DiscussionSummary>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionSummary {
    /// Identite LOGIQUE de la conversation. Codex conserve le meme
    /// `payload.session_id` a travers toutes les reprises/forks : c'est la cle
    /// de regroupement (et de suppression) d'une discussion.
    pub session_id: String,
    /// Identite du fichier rollout HEAD (le plus recent de la chaine) =
    /// `payload.id` (== uuid du nom de fichier). C'est la cible deterministe de
    /// `codex resume <rollout_id>` et de la copie vers un autre compte.
    pub rollout_id: String,
    /// Nombre de fichiers rollout regroupes sous ce `session_id` (1 = jamais
    /// repris ; N = N-1 reprises/forks). Sert d'indicateur dans l'UI.
    pub fork_count: u64,
    /// Fournisseur d'origine de la discussion (Codex ou Claude Code). Permet a
    /// l'UI d'afficher un badge et de router la reprise/continuation.
    pub provider: settings::Provider,
    pub account_id: String,
    pub account_label: String,
    pub codex_home: String,
    pub file_path: String,
    pub cwd: Option<String>,
    pub started_at: i64,
    pub last_activity: i64,
    pub title: Option<String>,
    pub preview: Option<String>,
    pub message_count: u64,
    pub total_tokens: Option<u64>,
    pub cli_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDiscussionResult {
    pub archived: bool,
    /// Nombre de fichiers rollout traites (une conversation reprise = plusieurs
    /// fichiers partageant le meme `session_id`, tous archives ensemble).
    pub count: u64,
    /// Chemin du premier fichier traite (retro-compatibilite d'affichage).
    pub path: String,
}

// ---------------------------------------------------------------------------
// (a) list_discussions
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_discussions() -> Result<DiscussionsDashboard, String> {
    tauri::async_runtime::spawn_blocking(list_discussions_dashboard)
        .await
        .map_err(|error| error.to_string())?
}

/// Variante synchrone reutilisable hors du runtime Tauri (serveur SaaS).
/// Charge les settings du contexte courant (desktop local ou `CST_DATA_DIR`
/// cote serveur) puis construit le tableau de bord des discussions.
pub fn list_discussions_dashboard() -> Result<DiscussionsDashboard, String> {
    let settings = settings::load_settings_for_terminal()?;
    Ok(build(&settings))
}

/// Empreinte legere de l'index des discussions.
///
/// Le flux temps reel appelle cette fonction plusieurs fois par seconde. Il ne
/// relit donc pas les JSONL : seuls les chemins et metadonnees des fichiers de
/// session sont haches. Une creation, suppression ou ecriture fait changer
/// l'empreinte et declenche alors seulement un nouveau scan complet.
pub fn discussions_revision() -> Result<u64, String> {
    let settings = settings::load_settings_for_terminal()?;
    let mut hasher = DefaultHasher::new();

    for account in &settings.accounts {
        account.id.hash(&mut hasher);
        account.label.hash(&mut hasher);
        account.provider.as_str().hash(&mut hasher);
        account.codex_home.hash(&mut hasher);
        settings::account_has_auth_tokens(account).hash(&mut hasher);

        let home = match expand_home(&account.codex_home) {
            Ok(home) => home,
            Err(error) => {
                error.hash(&mut hasher);
                continue;
            }
        };
        let mut files = discussion_files(&home, account.provider);
        files.sort();
        files.len().hash(&mut hasher);
        for file in files {
            hash_file_revision(&file, &mut hasher);
        }
    }

    Ok(hasher.finish())
}

/// Empreinte du fichier qui porte un transcript precis. Elle permet au flux
/// WebSocket de ne reparcourir le JSONL que lorsqu'il a reellement grandi.
pub fn transcript_revision_for_account(account_id: &str, session_id: &str) -> Result<u64, String> {
    let (_, file) = discussion_source_for_account(account_id, session_id)?;
    let mut hasher = DefaultHasher::new();
    hash_file_revision(&file, &mut hasher);
    Ok(hasher.finish())
}

fn discussion_files(home: &Path, provider: settings::Provider) -> Vec<PathBuf> {
    match provider {
        settings::Provider::Codex => {
            let mut files = Vec::new();
            collect_rollouts(&home.join("sessions"), &mut files);
            files
        }
        settings::Provider::Claude => {
            let mut files = Vec::new();
            let Ok(projects) = fs::read_dir(home.join("projects")) else {
                return files;
            };
            for project in projects.flatten() {
                let project_dir = project.path();
                if !project_dir.is_dir() {
                    continue;
                }
                let Ok(entries) = fs::read_dir(project_dir) else {
                    continue;
                };
                files.extend(entries.flatten().map(|entry| entry.path()).filter(|path| {
                    path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
                }));
            }
            files
        }
    }
}

fn hash_file_revision(path: &Path, hasher: &mut DefaultHasher) {
    path.to_string_lossy().hash(hasher);
    match fs::metadata(path) {
        Ok(metadata) => {
            true.hash(hasher);
            metadata.len().hash(hasher);
            metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos())
                .hash(hasher);
        }
        Err(_) => false.hash(hasher),
    }
}

fn build(settings: &AppSettings) -> DiscussionsDashboard {
    // Un thread par compte (scan disque independant), comme
    // `account_usage::build_dashboard`. On JOINT dans l'ordre des handles, ce
    // qui preserve l'ordre des comptes tel que declare dans les settings.
    let handles = settings
        .accounts
        .iter()
        .cloned()
        .map(|account| thread::spawn(move || scan_account(&account)))
        .collect::<Vec<_>>();

    let accounts = handles
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .collect::<Vec<_>>();

    let total_discussions = accounts.iter().map(|group| group.discussion_count).sum();

    DiscussionsDashboard {
        generated_at: metrics::now_ts(),
        total_discussions,
        accounts,
    }
}

fn scan_account(account: &AccountProfile) -> DiscussionAccountGroup {
    let has_tokens = settings::account_has_auth_tokens(account);

    let home = match expand_home(&account.codex_home) {
        Ok(home) => home,
        Err(error) => {
            return DiscussionAccountGroup {
                account_id: account.id.clone(),
                label: account.label.clone(),
                provider: account.provider,
                codex_home: account.codex_home.clone(),
                has_tokens,
                discussion_count: 0,
                discussions: Vec::new(),
                error: Some(error),
            };
        }
    };

    let mut discussions = match account.provider {
        settings::Provider::Codex => scan_codex_discussions(&home, account),
        settings::Provider::Claude => scan_claude_discussions(&home, account),
    };

    // Les plus recemment actives d'abord (le HEAD porte le dernier `mtime`).
    discussions.sort_by(|a, b| {
        b.last_activity
            .cmp(&a.last_activity)
            .then_with(|| b.started_at.cmp(&a.started_at))
    });
    let discussion_count = discussions.len() as u64;

    DiscussionAccountGroup {
        account_id: account.id.clone(),
        label: account.label.clone(),
        provider: account.provider,
        codex_home: account.codex_home.clone(),
        has_tokens,
        discussion_count,
        discussions,
        error: None,
    }
}

/// Scan **Codex** : `<home>/sessions/AAAA/MM/JJ/rollout-*.jsonl`, puis
/// regroupement des reprises/forks par `payload.session_id` (Codex ecrit un
/// nouveau fichier a chaque `resume`, meme session_id ; sans regroupement une
/// conversation apparaitrait autant de fois qu'elle a ete reprise).
fn scan_codex_discussions(home: &Path, account: &AccountProfile) -> Vec<DiscussionSummary> {
    let dir = home.join("sessions");
    let mut discussions = Vec::new();
    if dir.is_dir() {
        let mut files = Vec::new();
        collect_rollouts(&dir, &mut files);
        for file in &files {
            if let Some(summary) = scan_discussion_file(file, account) {
                discussions.push(summary);
            }
        }
    }
    collapse_forks(discussions)
}

/// Scan **Claude Code** : `<home>/projects/<cwd-echappe>/<uuid>.jsonl`. Une
/// session = un fichier (pas de forks facon Codex). On ne prend que les `.jsonl`
/// DIRECTEMENT sous chaque dossier projet : les sous-dossiers `<uuid>/`
/// contiennent des sidechains/sous-agents, pas la conversation principale.
fn scan_claude_discussions(home: &Path, account: &AccountProfile) -> Vec<DiscussionSummary> {
    let projects = home.join("projects");
    let mut discussions = Vec::new();
    let Ok(entries) = fs::read_dir(&projects) else {
        return discussions;
    };
    for entry in entries.flatten() {
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&project_dir) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let is_jsonl = path.extension().and_then(|ext| ext.to_str()) == Some("jsonl");
            if is_jsonl && path.is_file() {
                if let Some(summary) = scan_claude_session_file(&path, account) {
                    discussions.push(summary);
                }
            }
        }
    }
    discussions
}

/// Parse un fichier de session Claude Code en `DiscussionSummary`. Schema (verifie
/// sur disque) : chaque ligne est un objet portant `type` (user/assistant/...),
/// `sessionId`, `cwd`, `timestamp`, `version` ; les lignes `assistant` portent
/// `message.model` + `message.usage` (usage INCREMENTAL par message => on somme).
fn scan_claude_session_file(path: &Path, account: &AccountProfile) -> Option<DiscussionSummary> {
    let mtime = fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64);

    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let session_id_from_name = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(ToString::to_string);

    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut started_at: Option<i64> = None;
    let mut cli_version: Option<String> = None;
    let mut title: Option<String> = None;
    let mut preview: Option<String> = None;
    let mut message_count: u64 = 0;
    let mut total_tokens: u64 = 0;
    let mut saw_tokens = false;

    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let line_type = value.get("type").and_then(Value::as_str).unwrap_or("");

        if session_id.is_none() {
            session_id = value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(ToString::to_string);
        }
        if cwd.is_none() {
            cwd = value
                .get("cwd")
                .and_then(Value::as_str)
                .map(ToString::to_string);
        }
        if started_at.is_none() {
            started_at = value
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(parse_rfc3339_secs);
        }
        if cli_version.is_none() {
            cli_version = value
                .get("version")
                .and_then(Value::as_str)
                .map(ToString::to_string);
        }

        match line_type {
            "user" => {
                if let Some(text) = claude_message_text(&value) {
                    let msg = text.trim();
                    if !msg.is_empty() {
                        message_count += 1;
                        if title.is_none() && !is_synthetic_prompt(msg) {
                            let first_line = msg.lines().next().unwrap_or(msg).trim();
                            title = Some(truncate_chars(first_line, TITLE_MAX_CHARS));
                            preview = Some(truncate_chars(msg, PREVIEW_MAX_CHARS));
                        }
                    }
                }
            }
            "assistant" => {
                message_count += 1;
                if let Some(usage) = value.pointer("/message/usage") {
                    saw_tokens = true;
                    total_tokens += claude_usage_total(usage);
                }
            }
            _ => {}
        }
    }

    // Session vide / avortee (aucun message reel) : on la filtre.
    if message_count == 0 {
        return None;
    }

    let session_id = session_id
        .or(session_id_from_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let started_at = started_at.or(mtime).unwrap_or(0);
    let last_activity = mtime.unwrap_or(started_at);

    Some(DiscussionSummary {
        session_id: session_id.clone(),
        // Claude reprend par identifiant de session (pas de fichier HEAD distinct
        // comme Codex) : rollout_id == session_id.
        rollout_id: session_id,
        fork_count: 1,
        provider: settings::Provider::Claude,
        account_id: account.id.clone(),
        account_label: account.label.clone(),
        codex_home: account.codex_home.clone(),
        file_path: path.to_string_lossy().to_string(),
        cwd,
        started_at,
        last_activity,
        title,
        preview,
        message_count,
        total_tokens: if saw_tokens { Some(total_tokens) } else { None },
        cli_version,
    })
}

/// Texte d'un message Claude : `message.content` est soit une chaine (prompt
/// tape), soit un tableau de blocs. On ne concatene que les blocs `text` (on
/// ignore `tool_use`/`tool_result`/`thinking`). None si aucun texte utile.
fn claude_message_text(line: &Value) -> Option<String> {
    match line.pointer("/message/content")? {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            let mut out = String::new();
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(text);
                    }
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        _ => None,
    }
}

/// Total de tokens d'un bloc `message.usage` Claude. Contrairement a OpenAI,
/// l'input EXCLUT les tokens caches (reportes separement) : on additionne donc
/// input + output + cache_read + cache_creation.
fn claude_usage_total(usage: &Value) -> u64 {
    [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ]
    .iter()
    .filter_map(|key| usage.get(*key).and_then(json_u64))
    .sum()
}

/// Un rollout de **sous-agent** multi-agent v2 : sa ligne `session_meta` porte
/// `thread_source == "subagent"` (et un `parent_thread_id` non vide). Ces threads
/// ne sont PAS des conversations reprenables : `codex resume <id>` charge bien le
/// thread, mais l'app-server rejette ensuite `turn/start` avec
/// « direct app-server input is not allowed for multi-agent v2 sub-agents » —
/// c'est exactement l'erreur « turn/start failed » remontee par le TUI.
///
/// Piege : ces fichiers portent le `session_id` de leur thread PARENT. Sans ce
/// filtre, `collapse_forks` les regroupe avec la conversation parente et, comme
/// ils demarrent APRES le parent, `merge_fork_group` les elit HEAD — donc cible
/// de reprise. On les exclut donc du tableau de bord ET de l'historique des
/// prompts : la cible de reprise redevient toujours le thread utilisateur (dont
/// `codex resume` accepte le `turn/start`).
///
/// Un `fork` utilisateur (`codex fork`) reste `thread_source == "user"` et porte
/// son propre `session_id` : il n'est donc jamais capte par ce filtre.
fn is_subagent_rollout(meta: &Value) -> bool {
    meta.pointer("/payload/thread_source")
        .and_then(Value::as_str)
        == Some("subagent")
        || matches!(
            meta.pointer("/payload/parent_thread_id").and_then(Value::as_str),
            Some(parent) if !parent.is_empty()
        )
}

/// Scan d'un rollout. La ligne 1 (`session_meta`) est volumineuse mais parsee
/// une seule fois ; les lignes suivantes ne sont parsees que si un filtre
/// `contains` (peu couteux) matche. Renvoie `None` si la session est vide/
/// avortee (aucun message) ou s'il s'agit d'un rollout de sous-agent
/// (non reprenable, cf. `is_subagent_rollout`).
fn scan_discussion_file(path: &Path, account: &AccountProfile) -> Option<DiscussionSummary> {
    // mtime = derniere activite (secondes unix). Facultatif : on retombera sur
    // started_at si indisponible.
    let mtime = fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64);

    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);

    // Ligne 1 : doit etre un `session_meta`, sinon on ignore le fichier.
    let mut first_line = String::new();
    reader.read_line(&mut first_line).ok()?;
    let meta: Value = serde_json::from_str(first_line.trim_end()).ok()?;
    if meta.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }

    // Les rollouts de sous-agents (multi-agent v2) ne sont pas reprenables et
    // usurpent le `session_id` du parent : on les ecarte entierement du tableau
    // de bord (cf. `is_subagent_rollout`).
    if is_subagent_rollout(&meta) {
        return None;
    }

    let session_id = meta
        .pointer("/payload/session_id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| parse_rollout_filename(path).map(|(uuid, _)| uuid))
        .unwrap_or_default();

    // `payload.id` = identite du FICHIER rollout (== uuid du nom de fichier).
    // A la difference de `session_id`, il change a chaque reprise/fork ; c'est
    // la cible non ambigue de `codex resume`.
    let rollout_id = meta
        .pointer("/payload/id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| parse_rollout_filename(path).map(|(uuid, _)| uuid))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| session_id.clone());

    let cwd = meta
        .pointer("/payload/cwd")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let started_at = meta
        .pointer("/payload/timestamp")
        .and_then(Value::as_str)
        .and_then(parse_rfc3339_secs)
        .or_else(|| started_secs_from_filename(path))
        .or(mtime)
        .unwrap_or(0);

    let cli_version = meta
        .pointer("/payload/cli_version")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let last_activity = mtime.unwrap_or(started_at);

    let mut message_count: u64 = 0;
    let mut title: Option<String> = None;
    let mut preview: Option<String> = None;
    let mut total_tokens: Option<u64> = None;

    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }

        if line.contains("\"type\":\"user_message\"") {
            message_count += 1;
            if title.is_none() {
                if let Ok(value) = serde_json::from_str::<Value>(line.trim_end()) {
                    if let Some(message) = value.pointer("/payload/message").and_then(Value::as_str)
                    {
                        let msg = message.trim();
                        // Le premier contenu utilisateur synthetique
                        // (`<environment_context>...`) ne doit pas servir de titre.
                        if !msg.is_empty() && !msg.starts_with('<') {
                            let first_line = msg.lines().next().unwrap_or(msg).trim();
                            title = Some(truncate_chars(first_line, TITLE_MAX_CHARS));
                            preview = Some(truncate_chars(msg, PREVIEW_MAX_CHARS));
                        }
                    }
                }
            }
        } else if line.contains("\"type\":\"agent_message\"") {
            message_count += 1;
        }

        if line.contains("\"type\":\"token_count\"") {
            if let Ok(value) = serde_json::from_str::<Value>(line.trim_end()) {
                if let Some(tokens) = value
                    .pointer("/payload/info/total_token_usage/total_tokens")
                    .and_then(json_u64)
                {
                    total_tokens = Some(tokens);
                }
            }
        }
    }

    // Session vide / avortee : on la filtre.
    if message_count == 0 {
        return None;
    }

    Some(DiscussionSummary {
        session_id,
        rollout_id,
        fork_count: 1,
        provider: settings::Provider::Codex,
        account_id: account.id.clone(),
        account_label: account.label.clone(),
        codex_home: account.codex_home.clone(),
        file_path: path.to_string_lossy().to_string(),
        cwd,
        started_at,
        last_activity,
        title,
        preview,
        message_count,
        total_tokens,
        cli_version,
    })
}

/// Regroupe les fichiers rollout d'une meme conversation (meme
/// `payload.session_id`) en une seule entree. Codex cree un nouveau fichier a
/// chaque reprise ; on n'en garde qu'une carte :
/// - HEAD = le fork le plus recent (par `started_at`, puis `last_activity`) : il
///   fournit `rollout_id` (cible de reprise), `file_path`, titre/apercu/cwd et
///   version CLI ;
/// - agregats : `started_at` = min (debut original), `last_activity` = max,
///   `message_count`/`total_tokens` = max (le dernier fork a l'historique le
///   plus complet), `fork_count` = nombre de fichiers regroupes.
///
/// L'ordre de premiere apparition des `session_id` est preserve (deterministe).
fn collapse_forks(summaries: Vec<DiscussionSummary>) -> Vec<DiscussionSummary> {
    use std::collections::HashMap;

    // Phase 1 : regroupe par cle (session_id, ou chemin si session_id vide pour
    // ne pas fusionner des rollouts corrompus), en preservant l'ordre de
    // premiere apparition.
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<DiscussionSummary>> = HashMap::new();

    for summary in summaries {
        let key = if summary.session_id.is_empty() {
            format!("file:{}", summary.file_path)
        } else {
            summary.session_id.clone()
        };
        if !groups.contains_key(&key) {
            order.push(key.clone());
            groups.insert(key.clone(), Vec::new());
        }
        groups.get_mut(&key).expect("group present").push(summary);
    }

    // Phase 2 : reduit chaque groupe a une entree (HEAD + agregats).
    order
        .into_iter()
        .filter_map(|key| groups.remove(&key))
        .filter_map(merge_fork_group)
        .collect()
}

/// Reduit une chaine de forks (memes `session_id`) a une seule entree. Les
/// agregats sont calcules sur le groupe ENTIER (pas sur un accumulateur muable),
/// ce qui evite tout biais du choix du HEAD.
fn merge_fork_group(group: Vec<DiscussionSummary>) -> Option<DiscussionSummary> {
    if group.is_empty() {
        return None;
    }

    let fork_count = group.len() as u64;
    // HEAD = le fork le plus recent (started_at, puis last_activity).
    let mut head_idx = 0usize;
    for (index, candidate) in group.iter().enumerate() {
        let head = &group[head_idx];
        let newer = candidate.started_at > head.started_at
            || (candidate.started_at == head.started_at
                && candidate.last_activity > head.last_activity);
        if newer {
            head_idx = index;
        }
    }

    let started_at = group.iter().map(|s| s.started_at).min().unwrap_or(0);
    let last_activity = group.iter().map(|s| s.last_activity).max().unwrap_or(0);
    let message_count = group.iter().map(|s| s.message_count).max().unwrap_or(0);
    let total_tokens = group.iter().filter_map(|s| s.total_tokens).max();

    let mut head = group.into_iter().nth(head_idx)?;
    head.fork_count = fork_count;
    head.started_at = started_at;
    head.last_activity = last_activity;
    head.message_count = message_count;
    head.total_tokens = total_tokens;
    Some(head)
}

// ---------------------------------------------------------------------------
// (b) claim_session_for_terminal
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn claim_session_for_terminal(
    account_id: String,
    after_unix: i64,
    exclude_session_ids: Vec<String>,
    match_session_id: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        claim_session_for_account(
            account_id,
            after_unix,
            exclude_session_ids,
            match_session_id,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Variante synchrone reutilisable hors du runtime Tauri (serveur SaaS).
pub fn claim_session_for_account(
    account_id: String,
    after_unix: i64,
    exclude_session_ids: Vec<String>,
    match_session_id: Option<String>,
) -> Result<Option<String>, String> {
    let settings = settings::load_settings_for_terminal()?;
    let account = settings
        .accounts
        .iter()
        .find(|account| account.id == account_id)
        .cloned()
        .ok_or_else(|| "Compte introuvable".to_string())?;
    let dir = expand_home(&account.codex_home)?.join("sessions");
    Ok(claim_session(
        &dir,
        after_unix,
        &exclude_session_ids,
        match_session_id,
    ))
}

/// Selection basee UNIQUEMENT sur le nom de fichier (aucune ouverture) :
/// candidat = `start_secs >= after_unix - 5` et uuid non exclu ; on renvoie le
/// plus ANCIEN candidat (le premier rollout cree apres le demarrage). A defaut,
/// si `match_session_id` designe un fichier existant, on renvoie cet id.
fn claim_session(
    dir: &Path,
    after_unix: i64,
    exclude_session_ids: &[String],
    match_session_id: Option<String>,
) -> Option<String> {
    if !dir.is_dir() {
        return None;
    }

    let mut files = Vec::new();
    collect_rollouts(dir, &mut files);

    let mut best: Option<(i64, String)> = None;
    for file in &files {
        let Some((uuid, start_secs)) = parse_rollout_filename(file) else {
            continue;
        };
        if start_secs >= after_unix - 5 && !exclude_session_ids.iter().any(|id| id == &uuid) {
            let replace = match &best {
                None => true,
                Some((best_secs, _)) => start_secs < *best_secs,
            };
            if replace {
                best = Some((start_secs, uuid));
            }
        }
    }

    if let Some((_, uuid)) = best {
        return Some(uuid);
    }

    if let Some(id) = match_session_id {
        let suffix = format!("-{id}.jsonl");
        let exists = files.iter().any(|file| {
            file.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.ends_with(&suffix))
                .unwrap_or(false)
        });
        if exists {
            return Some(id);
        }
    }

    None
}

// ---------------------------------------------------------------------------
// (c) copy_discussion_to_account
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn copy_discussion_to_account(
    session_id: String,
    source_account_id: String,
    target_account_id: String,
) -> Result<DiscussionSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        copy_discussion_between(session_id, source_account_id, target_account_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Variante synchrone reutilisable hors du runtime Tauri (serveur SaaS) :
/// duplique la discussion `session_id` du compte source vers le compte cible.
pub fn copy_discussion_between(
    session_id: String,
    source_account_id: String,
    target_account_id: String,
) -> Result<DiscussionSummary, String> {
    if !is_uuid_shaped(&session_id) {
        return Err("Identifiant de session invalide".to_string());
    }

    let settings = settings::load_settings_for_terminal()?;
    let source = settings
        .accounts
        .iter()
        .find(|account| account.id == source_account_id)
        .cloned()
        .ok_or_else(|| "Compte source introuvable".to_string())?;
    let target = settings
        .accounts
        .iter()
        .find(|account| account.id == target_account_id)
        .cloned()
        .ok_or_else(|| "Compte cible introuvable".to_string())?;

    // `copy_discussion` duplique FIDELEMENT le fichier de rollout Codex (reecrit
    // l'uuid) : ce chemin n'a de sens que Codex -> Codex. Toute reprise
    // inter-provider (ou impliquant Claude) passe par l'export de transcript +
    // amorce (`export_discussion_transcript`), pas par une copie de fichier.
    if source.provider != settings::Provider::Codex || target.provider != settings::Provider::Codex
    {
        return Err(
            "Copie fidele reservee a Codex -> Codex. Pour continuer entre providers, utilisez la continuation par transcript (export_discussion_transcript)."
                .to_string(),
        );
    }

    copy_discussion(session_id, source, target)
}

fn copy_discussion(
    session_id: String,
    source: AccountProfile,
    target: AccountProfile,
) -> Result<DiscussionSummary, String> {
    let source_home = expand_home(&source.codex_home)?;
    let target_home = expand_home(&target.codex_home)?;

    let src = find_rollout_by_id(&source_home.join("sessions"), &session_id)
        .ok_or_else(|| "Discussion introuvable".to_string())?;

    // La source est ouverte en LECTURE SEULE et doit rester octet-pour-octet
    // identique.
    let content = fs::read_to_string(&src).map_err(|error| error.to_string())?;
    let new_id = uuid::Uuid::new_v4().to_string();

    // Decoupe a la PREMIERE '\n'. Tout ce qui suit est recopie verbatim.
    let (line0_raw, rest) = match content.find('\n') {
        Some(index) => (&content[..index], Some(&content[index + 1..])),
        None => (content.as_str(), None),
    };

    // Parse la ligne 0 (retire un eventuel '\r' de fin), verifie le type et
    // reecrit l'uuid.
    let line0_trimmed = line0_raw.trim_end_matches('\r');
    let mut meta: Value = serde_json::from_str(line0_trimmed)
        .map_err(|error| format!("ligne meta illisible: {error}"))?;
    if meta.get("type").and_then(Value::as_str) != Some("session_meta") {
        return Err("Ligne meta inattendue (type != session_meta)".to_string());
    }
    if let Some(payload) = meta.get_mut("payload").and_then(Value::as_object_mut) {
        payload.insert("session_id".to_string(), Value::String(new_id.clone()));
        payload.insert("id".to_string(), Value::String(new_id.clone()));
    }
    let new_line0 = serde_json::to_string(&meta).map_err(|error| error.to_string())?;

    let output = match rest {
        Some(rest) => format!("{new_line0}\n{rest}"),
        None => new_line0,
    };

    // Nom + emplacement de la destination : date issue du nom SOURCE.
    let src_name = src
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "nom de fichier source invalide".to_string())?;
    let name_rest = src_name
        .strip_prefix("rollout-")
        .ok_or_else(|| "nom de rollout inattendu".to_string())?;
    let date = name_rest
        .get(0..10)
        .ok_or_else(|| "date de rollout illisible".to_string())?;
    let year = &date[0..4];
    let month = &date[5..7];
    let day = &date[8..10];

    let dest_dir = target_home
        .join("sessions")
        .join(year)
        .join(month)
        .join(day);
    fs::create_dir_all(&dest_dir).map_err(|error| error.to_string())?;

    let dest_name = src_name.replace(&session_id, &new_id);
    let dest = dest_dir.join(&dest_name);
    fs::write(&dest, output).map_err(|error| error.to_string())?;

    // Resume coherent : on re-scanne la copie (meme logique que la liste).
    if let Some(summary) = scan_discussion_file(&dest, &target) {
        return Ok(summary);
    }

    // Filet de securite si le re-scan ne renvoie rien (session sans message).
    let cwd = meta
        .pointer("/payload/cwd")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let started_at = meta
        .pointer("/payload/timestamp")
        .and_then(Value::as_str)
        .and_then(parse_rfc3339_secs)
        .or_else(|| started_secs_from_filename(&dest))
        .unwrap_or_else(metrics::now_ts);
    let cli_version = meta
        .pointer("/payload/cli_version")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    Ok(DiscussionSummary {
        // La copie repart sur une session neuve (nouvel uuid pour le nom, le
        // `session_id` ET le `payload.id`) : session_id == rollout_id.
        session_id: new_id.clone(),
        rollout_id: new_id,
        fork_count: 1,
        provider: settings::Provider::Codex,
        account_id: target.id.clone(),
        account_label: target.label.clone(),
        codex_home: target.codex_home.clone(),
        file_path: dest.to_string_lossy().to_string(),
        cwd,
        started_at,
        last_activity: metrics::now_ts(),
        title: None,
        preview: None,
        message_count: 0,
        total_tokens: None,
        cli_version,
    })
}

// ---------------------------------------------------------------------------
// (d) move_discussion
// ---------------------------------------------------------------------------

/// Rattache une conversation existante a un autre workspace. Le `cwd` du
/// resume est modifie de facon persistante ; l'identite et le transcript de la
/// discussion restent inchanges.
#[tauri::command]
pub async fn move_discussion(
    account_id: String,
    session_id: String,
    workspace_path: String,
) -> Result<DiscussionSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        move_discussion_for_account(account_id, session_id, workspace_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Variante synchrone reutilisable par le serveur HTTP.
pub fn move_discussion_for_account(
    account_id: String,
    session_id: String,
    workspace_path: String,
) -> Result<DiscussionSummary, String> {
    if !is_uuid_shaped(&session_id) {
        return Err("Identifiant de session invalide".to_string());
    }

    let workspace_path = workspace_path.trim();
    if workspace_path.is_empty() {
        return Err("Le dossier cible est vide".to_string());
    }
    if workspace_path.len() > 4096 {
        return Err("Le chemin du dossier est trop long".to_string());
    }
    let workspace = Path::new(workspace_path);
    if !workspace.is_absolute() {
        return Err("Le dossier cible doit etre un chemin absolu".to_string());
    }
    if !workspace.is_dir() {
        return Err(format!("Dossier introuvable: {workspace_path}"));
    }

    let settings = settings::load_settings_for_terminal()?;
    let account = settings
        .accounts
        .iter()
        .find(|candidate| candidate.id == account_id)
        .cloned()
        .ok_or_else(|| "Compte introuvable".to_string())?;

    match account.provider {
        settings::Provider::Codex => {
            move_codex_discussion_impl(&account, &session_id, workspace_path)
        }
        settings::Provider::Claude => {
            move_claude_discussion_impl(&account, &session_id, workspace_path)
        }
    }
}

/// Codex conserve ses rollouts dans CODEX_HOME independamment du projet. On
/// reecrit donc uniquement `payload.cwd` dans tous les forks utilisateur de la
/// conversation. Les sous-agents historiques sont laisses intacts.
fn move_codex_discussion_impl(
    account: &AccountProfile,
    session_id: &str,
    workspace_path: &str,
) -> Result<DiscussionSummary, String> {
    let home = expand_home(&account.codex_home)?;
    let sessions = home.join("sessions");
    let targets = find_all_rollouts_for(&sessions, session_id);
    if targets.is_empty() {
        return Err("Discussion introuvable".to_string());
    }

    // Prepare toutes les nouvelles versions avant la premiere ecriture. En cas
    // d'echec intermediaire, les fichiers deja remplaces sont restaures.
    let mut rewrites: Vec<(PathBuf, String, String)> = Vec::new();
    for path in targets {
        let original = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        if let Some(updated) = rewrite_codex_rollout_cwd(&original, workspace_path)? {
            rewrites.push((path, original, updated));
        }
    }
    if rewrites.is_empty() {
        return scan_codex_discussions(&home, account)
            .into_iter()
            .find(|summary| summary.session_id == session_id || summary.rollout_id == session_id)
            .ok_or_else(|| "Aucun rollout utilisateur deplacable".to_string());
    }

    for index in 0..rewrites.len() {
        let (path, _, updated) = &rewrites[index];
        if let Err(error) = crate::fs_util::atomic_write(path, updated) {
            for (rollback_path, original, _) in rewrites.iter().take(index) {
                let _ = crate::fs_util::atomic_write(rollback_path, original);
            }
            return Err(format!(
                "Impossible de deplacer une conversation en cours d'utilisation: {error}"
            ));
        }
    }

    scan_codex_discussions(&home, account)
        .into_iter()
        .find(|summary| summary.session_id == session_id || summary.rollout_id == session_id)
        .ok_or_else(|| "Discussion deplacee mais impossible a relire".to_string())
}

/// Renvoie `None` pour un rollout de sous-agent ; sinon une version dont seul
/// le cwd de la ligne `session_meta` a change. Le reste du JSONL reste verbatim.
fn rewrite_codex_rollout_cwd(
    content: &str,
    workspace_path: &str,
) -> Result<Option<String>, String> {
    let (line0_raw, rest) = match content.find('\n') {
        Some(index) => (&content[..index], Some(&content[index + 1..])),
        None => (content, None),
    };
    let had_cr = line0_raw.ends_with('\r');
    let mut meta: Value = serde_json::from_str(line0_raw.trim_end_matches('\r'))
        .map_err(|error| format!("ligne meta illisible: {error}"))?;
    if meta.get("type").and_then(Value::as_str) != Some("session_meta") {
        return Err("Ligne meta inattendue (type != session_meta)".to_string());
    }
    if is_subagent_rollout(&meta) {
        return Ok(None);
    }
    let payload = meta
        .get_mut("payload")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Payload session_meta invalide".to_string())?;
    if payload.get("cwd").and_then(Value::as_str) == Some(workspace_path) {
        return Ok(None);
    }
    payload.insert("cwd".to_string(), Value::String(workspace_path.to_string()));
    let line0 = serde_json::to_string(&meta).map_err(|error| error.to_string())?;
    Ok(Some(match rest {
        Some(rest) if had_cr => format!("{line0}\r\n{rest}"),
        Some(rest) => format!("{line0}\n{rest}"),
        None => line0,
    }))
}

/// Claude localise une session dans `projects/<cwd-echappe>`. Il faut donc
/// reecrire les champs cwd ET deplacer le fichier principal (plus son dossier
/// de sidechains eventuel) pour que `claude --resume` fonctionne depuis la
/// nouvelle cible.
fn move_claude_discussion_impl(
    account: &AccountProfile,
    session_id: &str,
    workspace_path: &str,
) -> Result<DiscussionSummary, String> {
    let home = expand_home(&account.codex_home)?;
    let projects = home.join("projects");
    let source = find_claude_session_file(&projects, session_id)
        .ok_or_else(|| "Discussion introuvable".to_string())?;
    let original = fs::read_to_string(&source).map_err(|error| error.to_string())?;
    let updated = rewrite_claude_session_cwd(&original, workspace_path)?;

    let destination_dir = projects.join(crate::provider::claude_escaped_cwd(workspace_path));
    let destination = destination_dir.join(format!("{session_id}.jsonl"));
    let final_path = if source == destination {
        crate::fs_util::atomic_write(&source, updated).map_err(|error| {
            format!("Impossible de deplacer une conversation en cours d'utilisation: {error}")
        })?;
        source
    } else {
        fs::create_dir_all(&destination_dir).map_err(|error| error.to_string())?;
        if destination.exists() {
            return Err(
                "Une conversation de meme identite existe deja dans ce dossier".to_string(),
            );
        }

        let source_sidechains = source.with_extension("");
        let destination_sidechains = destination.with_extension("");
        if source_sidechains.is_dir() && destination_sidechains.exists() {
            return Err(
                "Les donnees annexes de cette conversation existent deja dans la cible".to_string(),
            );
        }

        crate::fs_util::atomic_write(&destination, updated).map_err(|error| error.to_string())?;

        let sidechains_moved = if source_sidechains.is_dir() {
            if let Err(error) = fs::rename(&source_sidechains, &destination_sidechains) {
                let _ = fs::remove_file(&destination);
                return Err(format!(
                    "Impossible de deplacer les donnees annexes Claude: {error}"
                ));
            }
            true
        } else {
            false
        };

        if let Err(error) = fs::remove_file(&source) {
            if sidechains_moved {
                let _ = fs::rename(&destination_sidechains, &source_sidechains);
            }
            let _ = fs::remove_file(&destination);
            return Err(format!(
                "Impossible de deplacer une conversation en cours d'utilisation: {error}"
            ));
        }
        if let Some(parent) = source.parent() {
            let _ = fs::remove_dir(parent);
        }
        destination
    };

    scan_claude_session_file(&final_path, account)
        .ok_or_else(|| "Discussion deplacee mais impossible a relire".to_string())
}

fn rewrite_claude_session_cwd(content: &str, workspace_path: &str) -> Result<String, String> {
    let mut output = String::with_capacity(content.len() + workspace_path.len());
    let mut updated_lines = 0usize;

    for segment in content.split_inclusive('\n') {
        let has_newline = segment.ends_with('\n');
        let without_newline = if has_newline {
            &segment[..segment.len() - 1]
        } else {
            segment
        };
        let has_cr = without_newline.ends_with('\r');
        let raw = without_newline.trim_end_matches('\r');

        let mut value = match serde_json::from_str::<Value>(raw) {
            Ok(value) => value,
            Err(_) => {
                output.push_str(segment);
                continue;
            }
        };
        if let Some(object) = value.as_object_mut() {
            if object.contains_key("cwd") || object.contains_key("sessionId") {
                object.insert("cwd".to_string(), Value::String(workspace_path.to_string()));
                updated_lines += 1;
            }
        }
        output.push_str(&serde_json::to_string(&value).map_err(|error| error.to_string())?);
        if has_cr {
            output.push('\r');
        }
        if has_newline {
            output.push('\n');
        }
    }

    if updated_lines == 0 {
        return Err("Aucun cwd Claude modifiable dans cette discussion".to_string());
    }
    Ok(output)
}

// ---------------------------------------------------------------------------
// (e) delete_discussion
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn delete_discussion(
    account_id: String,
    session_id: String,
    archive: bool,
) -> Result<DeleteDiscussionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        delete_discussion_for_account(account_id, session_id, archive)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Variante synchrone reutilisable hors du runtime Tauri (serveur SaaS).
pub fn delete_discussion_for_account(
    account_id: String,
    session_id: String,
    archive: bool,
) -> Result<DeleteDiscussionResult, String> {
    if !is_uuid_shaped(&session_id) {
        return Err("Identifiant de session invalide".to_string());
    }

    let settings = settings::load_settings_for_terminal()?;
    let account = settings
        .accounts
        .iter()
        .find(|account| account.id == account_id)
        .cloned()
        .ok_or_else(|| "Compte introuvable".to_string())?;

    match account.provider {
        settings::Provider::Codex => {
            delete_discussion_impl(account.codex_home, session_id, archive)
        }
        settings::Provider::Claude => {
            delete_claude_discussion_impl(account.codex_home, session_id, archive)
        }
    }
}

/// Suppression/archivage d'une session Claude : un fichier unique
/// `<home>/projects/<projet>/<session_id>.jsonl` (le nom == sessionId). L'archive
/// va sous `<home>/projects-archive/<projet>/...`.
fn delete_claude_discussion_impl(
    codex_home: String,
    session_id: String,
    archive: bool,
) -> Result<DeleteDiscussionResult, String> {
    let home = expand_home(&codex_home)?;
    let projects = home.join("projects");
    let target = find_claude_session_file(&projects, &session_id)
        .ok_or_else(|| "Discussion introuvable".to_string())?;

    let final_path = if archive {
        let rel = target
            .strip_prefix(&projects)
            .map_err(|error| error.to_string())?;
        let mut dest = home.join("projects-archive").join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        if dest.exists() {
            dest = append_suffix_before_ext(&dest, metrics::now_ts());
        }
        if fs::rename(&target, &dest).is_err() {
            fs::copy(&target, &dest).map_err(|error| error.to_string())?;
            fs::remove_file(&target).map_err(|error| error.to_string())?;
        }
        dest
    } else {
        fs::remove_file(&target).map_err(|error| error.to_string())?;
        target.clone()
    };

    Ok(DeleteDiscussionResult {
        archived: archive,
        count: 1,
        path: final_path.to_string_lossy().to_string(),
    })
}

/// Localise le fichier de session Claude `<session_id>.jsonl` sous l'un des
/// dossiers projet (`projects/<projet>/`).
fn find_claude_session_file(projects: &Path, session_id: &str) -> Option<PathBuf> {
    let file_name = format!("{session_id}.jsonl");
    for entry in fs::read_dir(projects).ok()?.flatten() {
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let candidate = project_dir.join(&file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn delete_discussion_impl(
    codex_home: String,
    session_id: String,
    archive: bool,
) -> Result<DeleteDiscussionResult, String> {
    let home = expand_home(&codex_home)?;
    let sessions_dir = home.join("sessions");

    // Une conversation reprise = plusieurs fichiers partageant le meme
    // `session_id`. On les traite TOUS, sinon la carte reapparaitrait a la
    // prochaine actualisation (regroupee sur un fork restant).
    let targets = find_all_rollouts_for(&sessions_dir, &session_id);
    if targets.is_empty() {
        return Err("Discussion introuvable".to_string());
    }

    let mut first_path = String::new();
    let mut count: u64 = 0;

    for src in &targets {
        let final_path = if archive {
            let rel = src
                .strip_prefix(&sessions_dir)
                .map_err(|error| error.to_string())?;
            let mut dest = home.join("sessions-archive").join(rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            if dest.exists() {
                dest = append_suffix_before_ext(&dest, metrics::now_ts() + count as i64);
            }

            // Deplacement (rename) rapide ; a defaut (ex. traversee de volume),
            // copie puis suppression de la source.
            if let Err(_rename_error) = fs::rename(src, &dest) {
                fs::copy(src, &dest).map_err(|error| error.to_string())?;
                fs::remove_file(src).map_err(|error| error.to_string())?;
            }
            dest
        } else {
            fs::remove_file(src).map_err(|error| error.to_string())?;
            src.clone()
        };

        if first_path.is_empty() {
            first_path = final_path.to_string_lossy().to_string();
        }
        count += 1;
    }

    Ok(DeleteDiscussionResult {
        archived: archive,
        count,
        path: first_path,
    })
}

/// Tous les rollouts d'une conversation dans `sessions_dir` : ceux dont le NOM
/// se termine par `-<id>.jsonl` (id de fichier) OU dont la ligne 0 porte
/// `payload.session_id == id` (identite logique partagee par tous les forks).
fn find_all_rollouts_for(sessions_dir: &Path, id: &str) -> Vec<PathBuf> {
    if !sessions_dir.is_dir() {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_rollouts(sessions_dir, &mut files);

    let suffix = format!("-{id}.jsonl");
    // `id` peut etre l'identite logique partagee OU l'id de n'importe quel
    // rollout de la chaine (notamment celui conserve par un terminal repris).
    // Dans ce second cas, remonte d'abord au session_id logique pour inclure
    // tous les forks de la discussion.
    let logical_id = files
        .iter()
        .find(|file| {
            file.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.ends_with(&suffix))
                .unwrap_or(false)
        })
        .and_then(|file| line0_session_id(file))
        .filter(|session_id| is_uuid_shaped(session_id))
        .unwrap_or_else(|| id.to_string());

    files
        .into_iter()
        .filter(|file| {
            let by_name = file
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.ends_with(&suffix))
                .unwrap_or(false);
            by_name || line0_session_id(file).as_deref() == Some(logical_id.as_str())
        })
        .collect()
}

// ---------------------------------------------------------------------------
// (e-bis) export_discussion_transcript — reprise INTER-PROVIDER (seed-as-prompt)
// ---------------------------------------------------------------------------
//
// Extrait le transcript SEMANTIQUE (tours utilisateur/assistant, sans tool-calls
// ni raisonnement -- non portables entre providers) d'une discussion Codex OU
// Claude, et le formate en une amorce injectable telle quelle dans une session
// NEUVE du provider cible. C'est l'approche retenue pour la reprise
// inter-provider : robuste (aucun fichier de session natif a synthetiser, donc
// aucun piege parentUuid / appariement tool_use / cwd-echappe / signature) et
// sans perte de ce qui etait reellement transferable.

const TRANSCRIPT_MAX_CHARS: usize = 100_000;

/// Role d'un tour de conversation extrait d'un fichier de session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptRole {
    User,
    Assistant,
}

/// Tour de conversation pret a afficher (vue conversation, export inter-provider).
/// `timestamp` en secondes unix ; 0 si la ligne n'en portait pas.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMessage {
    pub role: TranscriptRole,
    pub text: String,
    pub timestamp: i64,
}

#[tauri::command]
pub async fn export_discussion_transcript(
    account_id: String,
    session_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_transcript_for_account(account_id, session_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Variante synchrone reutilisable hors du runtime Tauri (serveur SaaS).
pub fn export_transcript_for_account(
    account_id: String,
    session_id: String,
) -> Result<String, String> {
    let turns = collect_transcript_turns(&account_id, &session_id)?;
    if turns.is_empty() {
        return Err("Aucun message a exporter dans cette discussion".to_string());
    }
    Ok(format_transcript(&turns))
}

/// Resout le compte + le fichier de session (Codex ou Claude) et en extrait
/// les tours utilisateur/assistant, dans l'ordre du fichier.
fn collect_transcript_turns(
    account_id: &str,
    session_id: &str,
) -> Result<Vec<TranscriptMessage>, String> {
    let (provider, file) = discussion_source_for_account(account_id, session_id)?;

    Ok(match provider {
        settings::Provider::Codex => extract_codex_transcript(&file),
        settings::Provider::Claude => extract_claude_transcript(&file),
    })
}

/// Resout le fichier physique qui porte une discussion. Centraliser cette
/// resolution garantit que le transcript HTTP et son flux temps reel observent
/// exactement le meme rollout.
fn discussion_source_for_account(
    account_id: &str,
    session_id: &str,
) -> Result<(settings::Provider, PathBuf), String> {
    if !is_uuid_shaped(session_id) {
        return Err("Identifiant de session invalide".to_string());
    }
    let settings = settings::load_settings_for_terminal()?;
    let account = settings
        .accounts
        .iter()
        .find(|account| account.id == account_id)
        .cloned()
        .ok_or_else(|| "Compte introuvable".to_string())?;
    let home = expand_home(&account.codex_home)?;

    let file = match account.provider {
        settings::Provider::Codex => find_rollout_by_id(&home.join("sessions"), session_id)
            .ok_or_else(|| "Discussion introuvable".to_string())?,
        settings::Provider::Claude => find_claude_session_file(&home.join("projects"), session_id)
            .ok_or_else(|| "Discussion introuvable".to_string())?,
    };
    Ok((account.provider, file))
}

/// Codex : `event_msg.user_message.message` (hors messages synthetiques) et
/// `event_msg.agent_message.message`, dans l'ordre du fichier.
fn extract_codex_transcript(path: &Path) -> Vec<TranscriptMessage> {
    let mut turns = Vec::new();
    let Ok(file) = fs::File::open(path) else {
        return turns;
    };
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        let is_user = line.contains("\"type\":\"user_message\"");
        let is_agent = line.contains("\"type\":\"agent_message\"");
        if !is_user && !is_agent {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(message) = value.pointer("/payload/message").and_then(Value::as_str) else {
            continue;
        };
        let msg = message.trim();
        if msg.is_empty() {
            continue;
        }
        if is_user {
            if is_synthetic_prompt(msg) {
                continue;
            }
            turns.push(transcript_message(TranscriptRole::User, msg, &value));
        } else {
            turns.push(transcript_message(TranscriptRole::Assistant, msg, &value));
        }
    }
    turns
}

/// Construit un tour en recuperant l'horodatage de la ligne, commun aux deux
/// formats (champ racine `timestamp` en RFC3339).
fn transcript_message(role: TranscriptRole, text: &str, line: &Value) -> TranscriptMessage {
    TranscriptMessage {
        role,
        text: text.to_string(),
        timestamp: line
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_secs)
            .unwrap_or(0),
    }
}

/// Claude : lignes `user`/`assistant`, texte extrait de `message.content`
/// (blocs `text` uniquement ; tool_use/tool_result/thinking ignores).
fn extract_claude_transcript(path: &Path) -> Vec<TranscriptMessage> {
    let mut turns = Vec::new();
    let Ok(file) = fs::File::open(path) else {
        return turns;
    };
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let role = match value.get("type").and_then(Value::as_str) {
            Some("user") => TranscriptRole::User,
            Some("assistant") => TranscriptRole::Assistant,
            _ => continue,
        };
        let Some(text) = claude_message_text(&value) else {
            continue;
        };
        let msg = text.trim();
        if msg.is_empty() {
            continue;
        }
        if role == TranscriptRole::User && is_synthetic_prompt(msg) {
            continue;
        }
        turns.push(transcript_message(role, msg, &value));
    }
    turns
}

/// Formate les tours en une amorce injectable, tronquee a `TRANSCRIPT_MAX_CHARS`
/// en conservant la FIN de la conversation (la plus pertinente pour continuer).
fn format_transcript(turns: &[TranscriptMessage]) -> String {
    let mut body = String::new();
    for turn in turns {
        let speaker = match turn.role {
            TranscriptRole::User => "UTILISATEUR",
            TranscriptRole::Assistant => "ASSISTANT",
        };
        body.push_str(speaker);
        body.push_str(": ");
        body.push_str(&turn.text);
        body.push_str("\n\n");
    }

    let body = if body.chars().count() > TRANSCRIPT_MAX_CHARS {
        let skip = body.chars().count() - TRANSCRIPT_MAX_CHARS;
        let kept: String = body.chars().skip(skip).collect();
        format!("[... debut de la conversation tronque ...]\n\n{kept}")
    } else {
        body
    };

    format!(
        "[Reprise d'une conversation menee avec un autre assistant. Voici l'historique ; poursuis a partir du dernier echange en tenant compte de ce contexte.]\n\n{body}[Fin de l'historique. Continue.]"
    )
}

// ---------------------------------------------------------------------------
// (e-ter) get_discussion_transcript — transcript STRUCTURE pour la vue
// conversation (bulles user/assistant), tous providers.
// ---------------------------------------------------------------------------

/// Nombre maximal de messages renvoyes a la vue conversation. Au-dela on garde
/// la FIN de la discussion (la plus pertinente) et on signale la troncature.
const TRANSCRIPT_MAX_MESSAGES: usize = 2000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionTranscript {
    pub session_id: String,
    pub messages: Vec<TranscriptMessage>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn get_discussion_transcript(
    account_id: String,
    session_id: String,
) -> Result<DiscussionTranscript, String> {
    tauri::async_runtime::spawn_blocking(move || transcript_for_account(account_id, session_id))
        .await
        .map_err(|error| error.to_string())?
}

/// Variante synchrone reutilisable hors du runtime Tauri (serveur SaaS).
pub fn transcript_for_account(
    account_id: String,
    session_id: String,
) -> Result<DiscussionTranscript, String> {
    let mut messages = collect_transcript_turns(&account_id, &session_id)?;
    let truncated = messages.len() > TRANSCRIPT_MAX_MESSAGES;
    if truncated {
        let skip = messages.len() - TRANSCRIPT_MAX_MESSAGES;
        messages.drain(..skip);
    }
    Ok(DiscussionTranscript {
        session_id,
        messages,
        truncated,
    })
}

// ---------------------------------------------------------------------------
// (e) list_prompt_history — recherche globale des demandes utilisateur
// ---------------------------------------------------------------------------
//
// Index plat de TOUS les messages `user_message` "reels" (on saute la ligne
// meta et les messages synthetiques `<environment_context>...`), tous comptes
// et toutes sessions confondus, tries du plus recent au plus ancien. Le
// frontend filtre/recherche cote client (comme la liste des discussions).

const PROMPT_TEXT_MAX_CHARS: usize = 600;
const DEFAULT_PROMPT_LIMIT: usize = 4000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEntry {
    pub session_id: String,
    pub account_id: String,
    pub account_label: String,
    pub codex_home: String,
    pub file_path: String,
    pub cwd: Option<String>,
    pub timestamp: i64,
    pub session_title: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptHistory {
    pub generated_at: i64,
    pub total_prompts: u64,
    pub returned: u64,
    pub truncated: bool,
    pub prompts: Vec<PromptEntry>,
}

#[tauri::command]
pub async fn list_prompt_history(limit: Option<usize>) -> Result<PromptHistory, String> {
    let settings = settings::load_settings_for_terminal()?;
    tauri::async_runtime::spawn_blocking(move || build_prompt_history(&settings, limit))
        .await
        .map_err(|error| error.to_string())
}

fn build_prompt_history(settings: &AppSettings, limit: Option<usize>) -> PromptHistory {
    let limit = limit.unwrap_or(DEFAULT_PROMPT_LIMIT).max(1);

    // Dedupe les comptes qui resolvent vers le meme CODEX_HOME : sinon chaque
    // rollout serait lu ET indexe une fois par compte (doublons dans la
    // recherche + I/O redondante). On garde le premier compte pour l'etiquette.
    let mut seen_homes = HashSet::new();
    let accounts = settings
        .accounts
        .iter()
        .filter(|account| {
            let key = expand_home(&account.codex_home)
                .map(|path| path.to_string_lossy().to_lowercase())
                .unwrap_or_else(|_| account.codex_home.to_lowercase());
            seen_homes.insert(key)
        })
        .cloned()
        .collect::<Vec<_>>();

    // Un thread par compte (scan disque independant), comme `build`.
    let handles = accounts
        .into_iter()
        .map(|account| thread::spawn(move || scan_account_prompts(&account)))
        .collect::<Vec<_>>();

    let mut prompts = handles
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .flatten()
        .collect::<Vec<_>>();

    // Les plus recentes d'abord ; le tri est stable donc a horodatage egal on
    // preserve l'ordre de lecture du fichier (demandes dans l'ordre chronologique
    // au sein d'une session).
    prompts.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    let total_prompts = prompts.len() as u64;
    let truncated = prompts.len() > limit;
    if truncated {
        prompts.truncate(limit);
    }

    PromptHistory {
        generated_at: metrics::now_ts(),
        total_prompts,
        returned: prompts.len() as u64,
        truncated,
        prompts,
    }
}

fn scan_account_prompts(account: &AccountProfile) -> Vec<PromptEntry> {
    let Ok(home) = expand_home(&account.codex_home) else {
        return Vec::new();
    };
    let dir = home.join("sessions");
    if !dir.is_dir() {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_rollouts(&dir, &mut files);

    let mut entries = Vec::new();
    for file in &files {
        scan_prompt_file(file, account, &mut entries);
    }
    entries
}

/// Vrai pour les messages `user_message` synthetiques injectes par Codex au
/// debut d'une session (contexte d'environnement / instructions) : ce ne sont
/// jamais des demandes tapees par l'utilisateur. On NE filtre PAS sur un simple
/// prefixe '<' car de vraies demandes commencent par '<' (HTML/JSX colle,
/// generiques TS `<T>`, comparaisons `<= 5`, ...).
fn is_synthetic_prompt(msg: &str) -> bool {
    msg.starts_with("<environment_context>") || msg.starts_with("<user_instructions>")
}

/// Extrait toutes les demandes utilisateur d'un rollout et les pousse dans
/// `out`. Seules les lignes contenant `"type":"user_message"` sont parsees en
/// JSON (filtre `contains` peu couteux) : les grosses reponses de l'agent ne
/// sont jamais deserialisees.
fn scan_prompt_file(path: &Path, account: &AccountProfile, out: &mut Vec<PromptEntry>) {
    let Ok(file) = fs::File::open(path) else {
        return;
    };
    let mut reader = BufReader::new(file);

    // Ligne 1 : session_meta (session_id, cwd, timestamp de depart).
    let mut first_line = String::new();
    if reader.read_line(&mut first_line).is_err() {
        return;
    }
    let Ok(meta) = serde_json::from_str::<Value>(first_line.trim_end()) else {
        return;
    };
    if meta.get("type").and_then(Value::as_str) != Some("session_meta") {
        return;
    }

    // Un rollout de sous-agent ne contient que les instructions synthetiques
    // envoyees au sous-agent, pas de vraies demandes utilisateur : on l'ignore
    // (cf. `is_subagent_rollout`), comme pour le tableau de bord.
    if is_subagent_rollout(&meta) {
        return;
    }

    let session_id = meta
        .pointer("/payload/session_id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| parse_rollout_filename(path).map(|(uuid, _)| uuid))
        .unwrap_or_default();
    let cwd = meta
        .pointer("/payload/cwd")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let started_at = meta
        .pointer("/payload/timestamp")
        .and_then(Value::as_str)
        .and_then(parse_rfc3339_secs)
        .or_else(|| started_secs_from_filename(path))
        .unwrap_or(0);

    let file_path = path.to_string_lossy().to_string();
    let start_index = out.len();
    let mut session_title: Option<String> = None;

    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }

        if !line.contains("\"type\":\"user_message\"") {
            continue;
        }

        let Ok(value) = serde_json::from_str::<Value>(line.trim_end()) else {
            continue;
        };
        let Some(message) = value.pointer("/payload/message").and_then(Value::as_str) else {
            continue;
        };
        let msg = message.trim();
        if msg.is_empty() || is_synthetic_prompt(msg) {
            continue;
        }

        let timestamp = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_secs)
            .unwrap_or(started_at);

        if session_title.is_none() {
            let first_msg_line = msg.lines().next().unwrap_or(msg).trim();
            session_title = Some(truncate_chars(first_msg_line, TITLE_MAX_CHARS));
        }

        out.push(PromptEntry {
            session_id: session_id.clone(),
            account_id: account.id.clone(),
            account_label: account.label.clone(),
            codex_home: account.codex_home.clone(),
            file_path: file_path.clone(),
            cwd: cwd.clone(),
            timestamp,
            // Renseigne apres la boucle (titre = 1re demande de la session).
            session_title: None,
            text: truncate_chars(msg, PROMPT_TEXT_MAX_CHARS),
        });
    }

    if let Some(title) = session_title {
        for entry in &mut out[start_index..] {
            entry.session_title = Some(title.clone());
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers prives
// ---------------------------------------------------------------------------

fn parse_rfc3339_secs(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|datetime| datetime.timestamp())
}

/// `rollout-2026-07-07T16-11-28-<uuid>.jsonl` -> (`uuid`, secondes unix locales).
/// Les 19 premiers caracteres apres `rollout-` encodent l'heure de debut
/// LOCALE ; l'uuid (qui contient des tirets) est tout le reste jusqu'a `.jsonl`.
fn parse_rollout_filename(path: &Path) -> Option<(String, i64)> {
    let name = path.file_name()?.to_str()?;
    let rest = name.strip_prefix("rollout-")?;
    let ts_part = rest.get(0..19)?;
    let start_secs = chrono::NaiveDateTime::parse_from_str(ts_part, "%Y-%m-%dT%H-%M-%S")
        .ok()?
        .and_local_timezone(chrono::Local)
        .single()?
        .timestamp();
    let uuid = rest.get(20..)?.trim_end_matches(".jsonl").to_string();
    Some((uuid, start_secs))
}

fn started_secs_from_filename(path: &Path) -> Option<i64> {
    parse_rollout_filename(path).map(|(_, secs)| secs)
}

/// Localise un rollout par uuid : d'abord par nom de fichier
/// (`...-<id>.jsonl`), puis, a defaut, par `payload.session_id` de la ligne 0.
fn find_rollout_by_id(sessions_dir: &Path, id: &str) -> Option<PathBuf> {
    if !sessions_dir.is_dir() {
        return None;
    }

    let mut files = Vec::new();
    collect_rollouts(sessions_dir, &mut files);

    let suffix = format!("-{id}.jsonl");
    if let Some(found) = files.iter().find(|file| {
        file.file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.ends_with(&suffix))
            .unwrap_or(false)
    }) {
        return Some(found.clone());
    }

    for file in &files {
        if line0_session_id(file).as_deref() == Some(id) {
            return Some(file.clone());
        }
    }

    None
}

fn line0_session_id(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut first_line = String::new();
    reader.read_line(&mut first_line).ok()?;
    let value: Value = serde_json::from_str(first_line.trim_end()).ok()?;
    value
        .pointer("/payload/session_id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

/// Verifie une forme d'uuid 8-4-4-4-12 (hex + tirets), sans dependance regex.
fn is_uuid_shaped(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    for (index, byte) in value.as_bytes().iter().enumerate() {
        match index {
            8 | 13 | 18 | 23 => {
                if *byte != b'-' {
                    return false;
                }
            }
            _ => {
                if !byte.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

fn append_suffix_before_ext(path: &Path, suffix: i64) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("rollout");
    let new_name = match path.extension().and_then(|value| value.to_str()) {
        Some(ext) => format!("{stem}-{suffix}.{ext}"),
        None => format!("{stem}-{suffix}"),
    };
    match path.parent() {
        Some(parent) => parent.join(new_name),
        None => PathBuf::from(new_name),
    }
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn json_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
        .or_else(|| value.as_f64().map(|number| number.max(0.0) as u64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn fresh_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("cst-disc-{}-{}", std::process::id(), n));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn local_secs(ts: &str) -> i64 {
        chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H-%M-%S")
            .unwrap()
            .and_local_timezone(chrono::Local)
            .single()
            .unwrap()
            .timestamp()
    }

    fn test_account(id: &str, home: &Path) -> AccountProfile {
        AccountProfile {
            id: id.to_string(),
            label: format!("Compte {id}"),
            provider: settings::Provider::Codex,
            codex_home: home.to_string_lossy().to_string(),
            project_dir: None,
            proxy_id: None,
            startup_command: None,
            limits: Default::default(),
            bypass: true,
            model: None,
            reasoning_effort: None,
        }
    }

    fn write_rollout(dir: &Path, ts: &str, uuid: &str) -> PathBuf {
        let name = format!("rollout-{ts}-{uuid}.jsonl");
        let path = dir.join(name);
        let content = format!(
            "{{\"timestamp\":\"2026-07-07T00:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{uuid}\",\"id\":\"{uuid}\"}}}}\n"
        );
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn parse_rollout_filename_extracts_uuid_and_start_secs() {
        let path =
            Path::new("x/rollout-2026-07-07T16-11-28-019f3ceb-69d3-7862-b69f-f6e1136622df.jsonl");
        let (uuid, start_secs) = parse_rollout_filename(path).expect("parsed");
        assert_eq!(uuid, "019f3ceb-69d3-7862-b69f-f6e1136622df");
        assert!(start_secs > 0);
    }

    #[test]
    fn claim_selects_oldest_after_start_and_respects_exclude() {
        let dir = fresh_dir();
        let sessions = dir.join("sessions").join("2026").join("07").join("07");
        fs::create_dir_all(&sessions).unwrap();

        let uuid_a = "019f0000-0000-7000-8000-000000000001";
        let uuid_b = "019f0000-0000-7000-8000-000000000002";
        let uuid_c = "019f0000-0000-7000-8000-000000000003";
        write_rollout(&sessions, "2026-07-07T10-00-00", uuid_a);
        write_rollout(&sessions, "2026-07-07T11-00-00", uuid_b);
        write_rollout(&sessions, "2026-07-07T12-00-00", uuid_c);

        let after = local_secs("2026-07-07T11-00-00");
        let sessions_root = dir.join("sessions");

        // Le plus ancien candidat >= after : 11h (10h est avant, exclu).
        let claimed = claim_session(&sessions_root, after, &[], None);
        assert_eq!(claimed.as_deref(), Some(uuid_b));

        // En excluant 11h, on remonte a 12h.
        let claimed2 = claim_session(&sessions_root, after, &[uuid_b.to_string()], None);
        assert_eq!(claimed2.as_deref(), Some(uuid_c));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claim_falls_back_to_match_session_id() {
        let dir = fresh_dir();
        let sessions = dir.join("sessions").join("2026").join("07").join("07");
        fs::create_dir_all(&sessions).unwrap();

        let uuid_old = "019f0000-0000-7000-8000-000000000010";
        write_rollout(&sessions, "2026-07-07T09-00-00", uuid_old);

        // Aucun candidat (after tres posterieur au seul fichier).
        let after = local_secs("2026-07-07T23-00-00");
        let sessions_root = dir.join("sessions");

        let claimed = claim_session(&sessions_root, after, &[], Some(uuid_old.to_string()));
        assert_eq!(claimed.as_deref(), Some(uuid_old));

        let missing = claim_session(
            &sessions_root,
            after,
            &[],
            Some("019f0000-0000-7000-8000-000000000099".to_string()),
        );
        assert_eq!(missing, None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_preserves_source_and_rewrites_dest_uuid() {
        let base = fresh_dir();
        let source_home = base.join("src-home");
        let target_home = base.join("dst-home");
        let src_sessions = source_home
            .join("sessions")
            .join("2026")
            .join("07")
            .join("07");
        fs::create_dir_all(&src_sessions).unwrap();
        fs::create_dir_all(&target_home).unwrap();

        let old_uuid = "019f3ceb-69d3-7862-b69f-f6e1136622df";
        let src_name = format!("rollout-2026-07-07T16-11-28-{old_uuid}.jsonl");
        let src_path = src_sessions.join(&src_name);
        let line1 = format!(
            "{{\"timestamp\":\"2026-07-07T16:11:28.851Z\",\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{old_uuid}\",\"id\":\"{old_uuid}\",\"timestamp\":\"2026-07-07T14:11:28.851Z\",\"cwd\":\"C:\\\\Users\\\\jeanp\",\"cli_version\":\"0.142.5\"}}}}"
        );
        let line2 = "{\"timestamp\":\"2026-07-07T16:11:30.000Z\",\"type\":\"user_message\",\"payload\":{\"message\":\"Bonjour ceci est un test\"}}";
        let line3 = "{\"timestamp\":\"2026-07-07T16:11:40.000Z\",\"type\":\"token_count\",\"payload\":{\"info\":{\"total_token_usage\":{\"total_tokens\":1234}}}}";
        let source_content = format!("{line1}\n{line2}\n{line3}");
        fs::write(&src_path, &source_content).unwrap();

        let source = test_account("src", &source_home);
        let target = test_account("dst", &target_home);

        let summary =
            copy_discussion(old_uuid.to_string(), source, target).expect("copy should succeed");

        // (a) SOURCE octet-pour-octet identique.
        let after = fs::read_to_string(&src_path).unwrap();
        assert_eq!(after, source_content);

        // (b) destination avec le NOUVEL uuid dans le nom ET dans payload.
        let new_id = summary.session_id.clone();
        assert_ne!(new_id, old_uuid);
        assert!(is_uuid_shaped(&new_id));

        let dest_path = PathBuf::from(&summary.file_path);
        assert!(dest_path.exists());
        let dest_name = dest_path.file_name().unwrap().to_str().unwrap();
        assert!(dest_name.contains(&new_id));
        assert!(!dest_name.contains(old_uuid));

        let dest_content = fs::read_to_string(&dest_path).unwrap();
        let dest_line0 = dest_content.split('\n').next().unwrap();
        let meta: Value = serde_json::from_str(dest_line0).unwrap();
        assert_eq!(
            meta.pointer("/payload/session_id").and_then(Value::as_str),
            Some(new_id.as_str())
        );
        assert_eq!(
            meta.pointer("/payload/id").and_then(Value::as_str),
            Some(new_id.as_str())
        );

        // (c) lignes 2..n identiques a la source.
        let src_rest: Vec<&str> = source_content.split('\n').skip(1).collect();
        let dest_rest: Vec<&str> = dest_content.split('\n').skip(1).collect();
        assert_eq!(src_rest, dest_rest);

        // Destination sous target_home/sessions/2026/07/07 (date de la source).
        let normalized = summary.file_path.replace('\\', "/");
        assert!(normalized.contains("dst-home/sessions/2026/07/07"));

        // Le re-scan a bien reconstitue le resume.
        assert_eq!(summary.message_count, 1);
        assert_eq!(summary.total_tokens, Some(1234));
        assert_eq!(summary.title.as_deref(), Some("Bonjour ceci est un test"));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn move_codex_rewrites_cwd_and_preserves_transcript() {
        let base = fresh_dir();
        let home = base.join("home");
        let sessions = home.join("sessions").join("2026").join("07").join("07");
        fs::create_dir_all(&sessions).unwrap();

        let uuid = "019f0000-0000-7000-8000-0000000000e1";
        let path = sessions.join(format!("rollout-2026-07-07T10-00-00-{uuid}.jsonl"));
        let transcript =
            "{\"type\":\"user_message\",\"payload\":{\"message\":\"conversation a deplacer\"}}";
        let meta = format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{uuid}\",\"id\":\"{uuid}\",\"cwd\":\"C:\\\\ancien\",\"thread_source\":\"user\"}}}}"
        );
        fs::write(&path, format!("{meta}\n{transcript}\n")).unwrap();

        let account = test_account("acc", &home);
        let summary = move_codex_discussion_impl(&account, uuid, "C:\\nouveau")
            .expect("move Codex should succeed");

        assert_eq!(summary.cwd.as_deref(), Some("C:\\nouveau"));
        assert_eq!(summary.session_id, uuid);
        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content.lines().nth(1), Some(transcript));
        let meta: Value = serde_json::from_str(content.lines().next().unwrap()).unwrap();
        assert_eq!(
            meta.pointer("/payload/cwd").and_then(Value::as_str),
            Some("C:\\nouveau")
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn move_claude_relocates_session_to_target_project() {
        let base = fresh_dir();
        let home = base.join("claude-home");
        let old_cwd = "C:\\ancien";
        let new_cwd = "C:\\nouveau";
        let uuid = "019f0000-0000-7000-8000-0000000000e2";
        let source_dir = home
            .join("projects")
            .join(crate::provider::claude_escaped_cwd(old_cwd));
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join(format!("{uuid}.jsonl"));
        let content = format!(
            "{{\"type\":\"user\",\"sessionId\":\"{uuid}\",\"cwd\":\"C:\\\\ancien\",\"timestamp\":\"2026-07-07T10:00:00Z\",\"message\":{{\"content\":\"bonjour\"}}}}\n"
        );
        fs::write(&source, content).unwrap();

        let mut account = test_account("claude", &home);
        account.provider = settings::Provider::Claude;
        let summary = move_claude_discussion_impl(&account, uuid, new_cwd)
            .expect("move Claude should succeed");

        assert_eq!(summary.cwd.as_deref(), Some(new_cwd));
        assert_eq!(summary.session_id, uuid);
        assert!(!source.exists());
        let destination = home
            .join("projects")
            .join(crate::provider::claude_escaped_cwd(new_cwd))
            .join(format!("{uuid}.jsonl"));
        assert!(destination.exists());

        let moved: Value = serde_json::from_str(
            fs::read_to_string(destination)
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(moved.get("cwd").and_then(Value::as_str), Some(new_cwd));

        let _ = fs::remove_dir_all(&base);
    }

    /// Ecrit un rollout complet (session_meta + 1 user_message) en controlant les
    /// champs `session_id`/`id`/`thread_source`/`parent_thread_id` du meta.
    fn write_rollout_meta(
        dir: &Path,
        ts: &str,
        file_uuid: &str,
        session_id: &str,
        rollout_id: &str,
        thread_source: &str,
        parent_thread_id: Option<&str>,
    ) -> PathBuf {
        let path = dir.join(format!("rollout-{ts}-{file_uuid}.jsonl"));
        let parent = match parent_thread_id {
            Some(id) => format!(",\"parent_thread_id\":\"{id}\""),
            None => String::new(),
        };
        let line0 = format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{session_id}\",\"id\":\"{rollout_id}\",\"cwd\":\"C:\\\\proj\",\"thread_source\":\"{thread_source}\"{parent}}}}}"
        );
        let line1 = "{\"type\":\"user_message\",\"payload\":{\"message\":\"demande reelle\"}}";
        fs::write(&path, format!("{line0}\n{line1}")).unwrap();
        path
    }

    #[test]
    fn scan_discussion_file_skips_subagent_rollouts() {
        let dir = fresh_dir();
        let account = test_account("acc", &dir);

        let user_uuid = "019f0000-0000-7000-8000-0000000000a1";
        let user = write_rollout_meta(
            &dir,
            "2026-07-07T10-00-00",
            user_uuid,
            user_uuid,
            user_uuid,
            "user",
            None,
        );
        assert!(
            scan_discussion_file(&user, &account).is_some(),
            "un thread utilisateur doit apparaitre"
        );

        // Sous-agent : thread_source=subagent, session_id usurpe = parent.
        let child_uuid = "019f0000-0000-7000-8000-0000000000b2";
        let sub = write_rollout_meta(
            &dir,
            "2026-07-07T11-00-00",
            child_uuid,
            user_uuid, // usurpe le session_id du parent
            child_uuid,
            "subagent",
            Some(user_uuid),
        );
        assert!(
            scan_discussion_file(&sub, &account).is_none(),
            "un sous-agent ne doit jamais apparaitre comme discussion"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resume_target_is_user_thread_not_newer_subagent() {
        // Reproduit le bug « turn/start failed » : un parent utilisateur + ses
        // sous-agents (plus recents) partagent le meme session_id. La cible de
        // reprise doit rester le thread utilisateur, pas le sous-agent HEAD.
        let base = fresh_dir();
        let home = base.join("home");
        let sessions = home.join("sessions").join("2026").join("07").join("07");
        fs::create_dir_all(&sessions).unwrap();

        let parent_uuid = "019f0000-0000-7000-8000-0000000000c1";
        let child_uuid = "019f0000-0000-7000-8000-0000000000c2";
        // Parent (10h) puis sous-agent plus recent (12h), meme session_id.
        write_rollout_meta(
            &sessions,
            "2026-07-07T10-00-00",
            parent_uuid,
            parent_uuid,
            parent_uuid,
            "user",
            None,
        );
        write_rollout_meta(
            &sessions,
            "2026-07-07T12-00-00",
            child_uuid,
            parent_uuid,
            child_uuid,
            "subagent",
            Some(parent_uuid),
        );

        let account = test_account("acc", &home);
        let group = scan_account(&account);

        assert_eq!(group.discussion_count, 1, "une seule conversation attendue");
        let head = &group.discussions[0];
        assert_eq!(head.session_id, parent_uuid);
        assert_eq!(
            head.rollout_id, parent_uuid,
            "la cible de reprise doit etre le thread utilisateur, pas le sous-agent"
        );
        assert_eq!(
            head.fork_count, 1,
            "le sous-agent ne doit pas gonfler le compte"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn prompt_history_skips_subagent_rollouts() {
        let dir = fresh_dir();
        let account = test_account("acc", &dir);

        let child_uuid = "019f0000-0000-7000-8000-0000000000d3";
        let sub = write_rollout_meta(
            &dir,
            "2026-07-07T11-00-00",
            child_uuid,
            "019f0000-0000-7000-8000-0000000000d0",
            child_uuid,
            "subagent",
            Some("019f0000-0000-7000-8000-0000000000d0"),
        );

        let mut out = Vec::new();
        scan_prompt_file(&sub, &account, &mut out);
        assert!(
            out.is_empty(),
            "les prompts d'un sous-agent doivent etre ignores"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_archive_moves_file_into_archive() {
        let base = fresh_dir();
        let home = base.join("home");
        let sessions = home.join("sessions").join("2026").join("07").join("07");
        fs::create_dir_all(&sessions).unwrap();

        let uuid = "019f3ceb-69d3-7862-b69f-f6e1136622df";
        let name = format!("rollout-2026-07-07T16-11-28-{uuid}.jsonl");
        let src = sessions.join(&name);
        fs::write(&src, "{\"type\":\"session_meta\",\"payload\":{}}\n").unwrap();

        let result =
            delete_discussion_impl(home.to_string_lossy().to_string(), uuid.to_string(), true)
                .expect("archive should succeed");

        assert!(result.archived);
        assert!(!src.exists());

        let archived = PathBuf::from(&result.path);
        assert!(archived.exists());
        let normalized = result.path.replace('\\', "/");
        assert!(normalized.contains("sessions-archive/2026/07/07"));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn prompt_history_extracts_real_user_messages_only() {
        let base = fresh_dir();
        let home = base.join("home");
        let sessions = home.join("sessions").join("2026").join("07").join("07");
        fs::create_dir_all(&sessions).unwrap();

        let uuid = "019f3ceb-69d3-7862-b69f-f6e1136622df";
        let name = format!("rollout-2026-07-07T16-11-28-{uuid}.jsonl");
        let path = sessions.join(&name);
        let content = [
            format!(
                "{{\"timestamp\":\"2026-07-07T16:11:28.851Z\",\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{uuid}\",\"id\":\"{uuid}\",\"timestamp\":\"2026-07-07T14:11:28.851Z\",\"cwd\":\"C:\\\\proj\"}}}}"
            ),
            // Message synthetique : doit etre ignore (commence par '<').
            "{\"timestamp\":\"2026-07-07T16:11:29.000Z\",\"type\":\"user_message\",\"payload\":{\"message\":\"<environment_context>ignore</environment_context>\"}}".to_string(),
            "{\"timestamp\":\"2026-07-07T16:11:30.000Z\",\"type\":\"user_message\",\"payload\":{\"message\":\"premiere demande\"}}".to_string(),
            // Reponse de l'agent : ne doit jamais etre comptee comme une demande.
            "{\"timestamp\":\"2026-07-07T16:11:31.000Z\",\"type\":\"agent_message\",\"payload\":{\"message\":\"une longue reponse\"}}".to_string(),
            "{\"timestamp\":\"2026-07-07T16:11:32.000Z\",\"type\":\"user_message\",\"payload\":{\"message\":\"seconde demande\"}}".to_string(),
        ]
        .join("\n");
        fs::write(&path, content).unwrap();

        let account = test_account("acc", &home);
        let mut out = Vec::new();
        scan_prompt_file(&path, &account, &mut out);

        // Seuls les 2 messages utilisateur reels sont retenus, dans l'ordre.
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].text, "premiere demande");
        assert_eq!(out[1].text, "seconde demande");

        // Le titre de session (1re demande reelle) est propage a chaque entree.
        assert_eq!(out[0].session_title.as_deref(), Some("premiere demande"));
        assert_eq!(out[1].session_title.as_deref(), Some("premiere demande"));

        assert_eq!(out[0].session_id, uuid);
        assert_eq!(out[0].account_id, "acc");
        assert_eq!(out[0].cwd.as_deref(), Some("C:\\proj"));
        assert!(out[0].timestamp > 0);
        // Horodatage par message : la 2e demande est posterieure a la 1re.
        assert!(out[1].timestamp >= out[0].timestamp);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn prompt_history_truncates_long_messages() {
        let base = fresh_dir();
        let home = base.join("home");
        let sessions = home.join("sessions").join("2026").join("07").join("07");
        fs::create_dir_all(&sessions).unwrap();

        let uuid = "019f3ceb-69d3-7862-b69f-f6e1136622df";
        let long = "a".repeat(PROMPT_TEXT_MAX_CHARS + 500);
        let path = sessions.join(format!("rollout-2026-07-07T16-11-28-{uuid}.jsonl"));
        let content = format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{uuid}\"}}}}\n{{\"timestamp\":\"2026-07-07T16:11:30.000Z\",\"type\":\"user_message\",\"payload\":{{\"message\":\"{long}\"}}}}"
        );
        fs::write(&path, content).unwrap();

        let account = test_account("acc", &home);
        let mut out = Vec::new();
        scan_prompt_file(&path, &account, &mut out);

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text.chars().count(), PROMPT_TEXT_MAX_CHARS);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn prompt_history_keeps_angle_bracket_prompts_but_skips_synthetic() {
        let base = fresh_dir();
        let home = base.join("home");
        let sessions = home.join("sessions").join("2026").join("07").join("07");
        fs::create_dir_all(&sessions).unwrap();

        let uuid = "019f3ceb-69d3-7862-b69f-f6e1136622df";
        let path = sessions.join(format!("rollout-2026-07-07T16-11-28-{uuid}.jsonl"));
        let content = [
            format!("{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{uuid}\"}}}}"),
            // Enveloppes synthetiques Codex : ignorees.
            "{\"timestamp\":\"2026-07-07T16:11:29.000Z\",\"type\":\"user_message\",\"payload\":{\"message\":\"<environment_context>ctx</environment_context>\"}}".to_string(),
            "{\"timestamp\":\"2026-07-07T16:11:29.500Z\",\"type\":\"user_message\",\"payload\":{\"message\":\"<user_instructions>do x</user_instructions>\"}}".to_string(),
            // Vraie demande commencant par '<' : conservee.
            "{\"timestamp\":\"2026-07-07T16:11:30.000Z\",\"type\":\"user_message\",\"payload\":{\"message\":\"<div className=x> what renders?\"}}".to_string(),
        ]
        .join("\n");
        fs::write(&path, content).unwrap();

        let account = test_account("acc", &home);
        let mut out = Vec::new();
        scan_prompt_file(&path, &account, &mut out);

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "<div className=x> what renders?");

        let _ = fs::remove_dir_all(&base);
    }

    fn sample_summary(
        session_id: &str,
        rollout_id: &str,
        started_at: i64,
        last_activity: i64,
        msgs: u64,
        tokens: Option<u64>,
    ) -> DiscussionSummary {
        DiscussionSummary {
            session_id: session_id.to_string(),
            rollout_id: rollout_id.to_string(),
            fork_count: 1,
            provider: settings::Provider::Codex,
            account_id: "acc".to_string(),
            account_label: "Acc".to_string(),
            codex_home: "home".to_string(),
            file_path: format!("/x/rollout-{rollout_id}.jsonl"),
            cwd: Some("/proj".to_string()),
            started_at,
            last_activity,
            title: Some(format!("t-{rollout_id}")),
            preview: Some("p".to_string()),
            message_count: msgs,
            total_tokens: tokens,
            cli_version: Some("0.1".to_string()),
        }
    }

    #[test]
    fn collapse_forks_groups_by_session_id() {
        let sid = "019f0000-0000-7000-8000-000000000001";
        let other = "019f0000-0000-7000-8000-000000000099";
        // Forks volontairement en desordre pour verifier la selection du HEAD.
        let input = vec![
            sample_summary(sid, "r1", 100, 110, 2, Some(50)), // original
            sample_summary(sid, "r3", 300, 330, 9, Some(400)), // HEAD (plus recent)
            sample_summary(sid, "r2", 200, 220, 5, Some(200)),
            sample_summary(other, "r9", 150, 150, 1, None), // conversation distincte
        ];

        let out = collapse_forks(input);
        assert_eq!(out.len(), 2, "une entree par session_id");

        let g = out.iter().find(|d| d.session_id == sid).unwrap();
        assert_eq!(g.fork_count, 3);
        assert_eq!(g.rollout_id, "r3", "HEAD = fork le plus recent");
        assert_eq!(g.title.as_deref(), Some("t-r3"));
        assert_eq!(g.started_at, 100, "debut = min");
        assert_eq!(g.last_activity, 330, "derniere activite = max");
        assert_eq!(g.message_count, 9, "messages = max");
        assert_eq!(g.total_tokens, Some(400), "tokens = max");

        let o = out.iter().find(|d| d.session_id == other).unwrap();
        assert_eq!(o.fork_count, 1);
    }

    #[test]
    fn collapse_forks_keeps_empty_session_ids_distinct() {
        // Deux rollouts corrompus (session_id vide) ne doivent pas fusionner.
        let mut a = sample_summary("", "ra", 100, 100, 1, None);
        a.file_path = "/x/a.jsonl".to_string();
        let mut b = sample_summary("", "rb", 200, 200, 1, None);
        b.file_path = "/x/b.jsonl".to_string();

        let out = collapse_forks(vec![a, b]);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn delete_archives_all_forks_of_a_session() {
        let base = fresh_dir();
        let home = base.join("home");
        let sessions = home.join("sessions").join("2026").join("07").join("07");
        fs::create_dir_all(&sessions).unwrap();

        let sid = "019f4bb2-0000-7000-8000-000000000001";
        // 1er fichier : nom == session_id. 2 forks : nom different, meme
        // payload.session_id.
        let file_uuids = [
            sid,
            "019f4bbc-0000-7000-8000-0000000000aa",
            "019f4bbc-0000-7000-8000-0000000000bb",
        ];
        for (i, file_uuid) in file_uuids.iter().enumerate() {
            let name = format!("rollout-2026-07-07T16-11-2{i}-{file_uuid}.jsonl");
            let content = format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{sid}\",\"id\":\"{file_uuid}\"}}}}\n"
            );
            fs::write(sessions.join(name), content).unwrap();
        }

        let result =
            delete_discussion_impl(home.to_string_lossy().to_string(), sid.to_string(), true)
                .expect("archive should succeed");
        assert!(result.archived);
        assert_eq!(result.count, 3, "les 3 forks sont archives");

        let mut remaining = Vec::new();
        collect_rollouts(&home.join("sessions"), &mut remaining);
        assert_eq!(remaining.len(), 0, "plus aucun rollout actif");

        let mut archived = Vec::new();
        collect_rollouts(&home.join("sessions-archive"), &mut archived);
        assert_eq!(archived.len(), 3, "3 rollouts archives");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_from_an_old_rollout_archives_the_whole_discussion() {
        let base = fresh_dir();
        let home = base.join("home");
        let sessions = home.join("sessions").join("2026").join("07").join("07");
        fs::create_dir_all(&sessions).unwrap();

        let sid = "019f4bb2-0000-7000-8000-000000000011";
        let old_rollout = "019f4bbc-0000-7000-8000-0000000000cc";
        let current_rollout = "019f4bbc-0000-7000-8000-0000000000dd";
        for (i, file_uuid) in [sid, old_rollout, current_rollout].iter().enumerate() {
            let name = format!("rollout-2026-07-07T17-11-2{i}-{file_uuid}.jsonl");
            let content = format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{sid}\",\"id\":\"{file_uuid}\"}}}}\n"
            );
            fs::write(sessions.join(name), content).unwrap();
        }

        let result = delete_discussion_impl(
            home.to_string_lossy().to_string(),
            old_rollout.to_string(),
            true,
        )
        .expect("archive from an old rollout should succeed");
        assert_eq!(result.count, 3, "toute la chaine doit etre archivee");

        let mut remaining = Vec::new();
        collect_rollouts(&home.join("sessions"), &mut remaining);
        assert!(remaining.is_empty(), "aucun fork ne doit rester actif");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn codex_transcript_extracts_roles_timestamps_and_skips_synthetic() {
        let dir = fresh_dir();
        let uuid = "019f4bb2-0000-7000-8000-00000000cafe";
        let path = dir.join(format!("rollout-2026-07-07T16-11-28-{uuid}.jsonl"));
        let lines = [
            format!("{{\"timestamp\":\"2026-07-07T16:11:28.000Z\",\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{uuid}\",\"id\":\"{uuid}\"}}}}"),
            "{\"timestamp\":\"2026-07-07T16:11:29.000Z\",\"type\":\"user_message\",\"payload\":{\"message\":\"<environment_context>ignore</environment_context>\"}}".to_string(),
            "{\"timestamp\":\"2026-07-07T16:11:30.000Z\",\"type\":\"user_message\",\"payload\":{\"message\":\"premiere demande\"}}".to_string(),
            "{\"timestamp\":\"2026-07-07T16:11:31.000Z\",\"type\":\"agent_message\",\"payload\":{\"message\":\"une reponse **markdown**\"}}".to_string(),
            // Ligne sans horodatage : le tour doit sortir avec timestamp 0.
            "{\"type\":\"agent_message\",\"payload\":{\"message\":\"suite\"}}".to_string(),
        ];
        fs::write(&path, lines.join("\n")).unwrap();

        let turns = extract_codex_transcript(&path);
        assert_eq!(turns.len(), 3, "le message synthetique est filtre");
        assert_eq!(turns[0].role, TranscriptRole::User);
        assert_eq!(turns[0].text, "premiere demande");
        assert!(turns[0].timestamp > 0);
        assert_eq!(turns[1].role, TranscriptRole::Assistant);
        assert!(turns[1].timestamp > turns[0].timestamp);
        assert_eq!(turns[2].timestamp, 0, "ligne sans champ timestamp");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_transcript_extracts_text_blocks_only() {
        let dir = fresh_dir();
        let path = dir.join("session.jsonl");
        let lines = [
            "{\"timestamp\":\"2026-07-07T10:00:00.000Z\",\"type\":\"user\",\"message\":{\"content\":\"bonjour\"}}",
            "{\"timestamp\":\"2026-07-07T10:00:05.000Z\",\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"thinking\",\"thinking\":\"prive\"},{\"type\":\"text\",\"text\":\"salut !\"}]}}",
            "{\"timestamp\":\"2026-07-07T10:00:06.000Z\",\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\"}]}}",
        ];
        fs::write(&path, lines.join("\n")).unwrap();

        let turns = extract_claude_transcript(&path);
        assert_eq!(turns.len(), 2, "la ligne tool_use sans texte est ignoree");
        assert_eq!(turns[0].role, TranscriptRole::User);
        assert_eq!(turns[0].text, "bonjour");
        assert_eq!(turns[1].role, TranscriptRole::Assistant);
        assert_eq!(turns[1].text, "salut !");
        assert!(turns[1].timestamp > turns[0].timestamp);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_revision_changes_when_live_transcript_grows() {
        let dir = fresh_dir();
        let path = dir.join("live.jsonl");
        fs::write(&path, "premiere ligne\n").unwrap();

        let revision = || {
            let mut hasher = DefaultHasher::new();
            hash_file_revision(&path, &mut hasher);
            hasher.finish()
        };
        let before = revision();
        assert_eq!(
            before,
            revision(),
            "une source inchangee garde la meme empreinte"
        );

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        std::io::Write::write_all(&mut file, b"nouveau message\n").unwrap();
        std::io::Write::flush(&mut file).unwrap();
        assert_ne!(
            before,
            revision(),
            "un append doit reveiller le flux temps reel"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
