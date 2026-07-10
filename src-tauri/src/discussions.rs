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
//! - `delete_discussion` : archive (deplacement, par defaut) ou suppression
//!   explicite d'une discussion.
//!
//! INVARIANTS (revus de facon adverse) :
//! - Seul `delete_discussion` retire/deplace un rollout ; aucun autre chemin ne
//!   supprime ni ne tronque de fichier.
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
    collections::HashSet,
    fs,
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

    let dir = match expand_home(&account.codex_home) {
        Ok(home) => home.join("sessions"),
        Err(error) => {
            return DiscussionAccountGroup {
                account_id: account.id.clone(),
                label: account.label.clone(),
                codex_home: account.codex_home.clone(),
                has_tokens,
                discussion_count: 0,
                discussions: Vec::new(),
                error: Some(error),
            };
        }
    };

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

    // Regroupe les reprises/forks : Codex ecrit un NOUVEAU fichier rollout a
    // chaque `resume` (nouveau nom + nouveau `payload.id`) mais conserve le meme
    // `payload.session_id`. Sans regroupement, une meme conversation apparait
    // autant de fois qu'elle a ete reprise (les "doublons" observes). On garde
    // une entree par `session_id`.
    let mut discussions = collapse_forks(discussions);

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
        codex_home: account.codex_home.clone(),
        has_tokens,
        discussion_count,
        discussions,
        error: None,
    }
}

/// Scan d'un rollout. La ligne 1 (`session_meta`) est volumineuse mais parsee
/// une seule fois ; les lignes suivantes ne sont parsees que si un filtre
/// `contains` (peu couteux) matche. Renvoie `None` si la session est vide/
/// avortee (aucun message).
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
        claim_session_for_account(account_id, after_unix, exclude_session_ids, match_session_id)
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
// (d) delete_discussion
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

    delete_discussion_impl(account.codex_home, session_id, archive)
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
    files
        .into_iter()
        .filter(|file| {
            let by_name = file
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.ends_with(&suffix))
                .unwrap_or(false);
            by_name || line0_session_id(file).as_deref() == Some(id)
        })
        .collect()
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
            codex_home: home.to_string_lossy().to_string(),
            project_dir: None,
            proxy_id: None,
            startup_command: None,
            limits: Default::default(),
            bypass: true,
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
}
