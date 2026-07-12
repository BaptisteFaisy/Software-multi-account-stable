//! Isolation physique des agents.
//!
//! Un agent obtient un checkout (git worktree ou copie pour un dossier non-git)
//! et un home provider uniques. Le lease est suivi pour l'observabilite et son
//! `Drop` fusionne uniquement les transcripts, preserve les
//! commits sous `refs/cst/recovery/*`, puis nettoie les repertoires isoles.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex, Weak},
};

const UNLIMITED_MAX_AGENTS: usize = usize::MAX;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitControl {
    WorkTree { repo_root: PathBuf },
    Bare { git_dir: PathBuf },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeContext {
    pub control: GitControl,
    pub worktree: PathBuf,
    pub base_sha: String,
    pub target_ref: String,
}

#[derive(Clone)]
pub struct WorktreeManager {
    inner: Arc<ManagerInner>,
}

struct ManagerInner {
    data_dir: PathBuf,
    max_agents: usize,
    /// Un seul processus peut admettre/nettoyer des agents dans ce runtime.
    /// Cela rend le cap global au `CST_DATA_DIR`, au lieu de le multiplier par
    /// le nombre de processus desktop/serveur concurrents.
    _owner_lock: crate::fs_util::ProcessFileLock,
    active: Mutex<HashSet<String>>,
    /// Git impose deja ses propres locks, mais ce verrou evite les courses entre
    /// creation/prune/retrait de worktrees dans CE processus.
    git_ops: Mutex<()>,
    /// Le store de transcripts canonique n'a qu'un ecrivain dans le processus.
    home_merge: Mutex<()>,
}

#[derive(Clone)]
pub struct AgentWorkspace {
    inner: Arc<WorkspaceInner>,
}

struct WorkspaceInner {
    manager: Weak<ManagerInner>,
    workspace_id: String,
    room_id: String,
    workspace_root: PathBuf,
    cwd: PathBuf,
    isolated_home: PathBuf,
    canonical_home: PathBuf,
    merge_context: Option<MergeContext>,
    transcript_baseline: TranscriptBaseline,
    _admission: AdmissionLease,
}

struct AdmissionLease {
    manager: Weak<ManagerInner>,
    workspace_id: String,
}

type TranscriptBaseline = HashMap<PathBuf, BaselineFile>;

struct BaselineFile {
    fingerprint: FileFingerprint,
    digest: [u8; 32],
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileFingerprint {
    len: u64,
    modified_nanos: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseMarker {
    workspace_id: String,
    agent_id: String,
    pid: u32,
    started_at: i64,
    active: bool,
    #[serde(default)]
    merge_context: Option<MergeContext>,
    #[serde(default)]
    canonical_home: Option<PathBuf>,
}

impl WorktreeManager {
    pub fn new(data_dir: PathBuf, max_agents: usize) -> Result<Self, String> {
        let max_agents = max_agents.max(1);
        for child in ["workspaces", "agent-homes", "mirrors", "recoveries"] {
            fs::create_dir_all(data_dir.join(child)).map_err(|error| {
                format!("creation du runtime agents ({child}) impossible: {error}")
            })?;
        }
        let owner_lock =
            crate::fs_util::try_process_lock(&data_dir.join(".owner.lock")).map_err(|error| {
                format!(
                    "runtime agents deja possede par un autre processus ({}): {error}",
                    data_dir.display()
                )
            })?;
        Ok(Self {
            inner: Arc::new(ManagerInner {
                data_dir,
                max_agents,
                _owner_lock: owner_lock,
                active: Mutex::new(HashSet::new()),
                git_ops: Mutex::new(()),
                home_merge: Mutex::new(()),
            }),
        })
    }

    pub fn from_env(data_dir: PathBuf) -> Result<Self, String> {
        Self::new(data_dir, max_agents_from_env())
    }

    #[cfg(test)]
    pub fn unlimited(data_dir: PathBuf) -> Result<Self, String> {
        Self::new(data_dir, UNLIMITED_MAX_AGENTS)
    }

    pub fn active_count(&self) -> usize {
        self.inner
            .active
            .lock()
            .map(|active| active.len())
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub fn capacity(&self) -> usize {
        self.inner.max_agents
    }

    pub fn active_workspace_ids(&self) -> HashSet<String> {
        self.inner
            .active
            .lock()
            .map(|set| set.clone())
            .unwrap_or_default()
    }

    /// Nettoie uniquement les leases assez anciens dont le processus
    /// proprietaire n'est plus vivant. Un simple mtime ne peut donc plus tuer
    /// un agent long-running.
    pub fn sweep_stale(&self, retention_secs: u64) -> Result<usize, String> {
        let root = self.inner.data_dir.join("workspaces");
        if !root.is_dir() {
            return Ok(0);
        }
        let active = self.active_workspace_ids();
        let mut removed = 0;
        for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if active.contains(&id) {
                continue;
            }
            let workspace_root = entry.path();
            let marker = fs::read(workspace_root.join(".cst-lease.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<LeaseMarker>(&bytes).ok());
            if marker
                .as_ref()
                .is_some_and(|marker| marker.active && process_is_alive(marker.pid))
            {
                continue;
            }
            let started_at = marker
                .as_ref()
                .map(|marker| marker.started_at)
                .unwrap_or_else(|| {
                    entry
                        .metadata()
                        .ok()
                        .and_then(|meta| meta.modified().ok())
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|duration| duration.as_secs() as i64)
                        .unwrap_or_else(crate::metrics::now_ts)
                });
            if crate::metrics::now_ts().saturating_sub(started_at) < retention_secs as i64 {
                continue;
            }

            let isolated_home = self.inner.data_dir.join("agent-homes").join(&id);
            if let Some(context) = marker.and_then(|marker| marker.merge_context) {
                if let Ok(_git) = self.inner.git_ops.lock() {
                    preserve_recovery_ref(&context, &id);
                    let _ = git_worktree_remove(&context.control, &context.worktree);
                }
            }
            safe_remove_dir(&self.inner.data_dir, &workspace_root);
            // Un home de crash peut contenir un transcript non fusionne : on le
            // deplace sous recoveries au lieu de le detruire.
            if isolated_home.is_dir() {
                let recovery = self
                    .inner
                    .data_dir
                    .join("recoveries")
                    .join(format!("{id}-home"));
                if !recovery.exists() {
                    let _ = fs::rename(&isolated_home, recovery);
                }
            }
            removed += 1;
        }
        Ok(removed)
    }

    /// Isole un dossier local. Un repo git partage son object-store via
    /// `git worktree add`; un dossier ordinaire est copie physiquement.
    pub fn prepare_local(
        &self,
        agent_id: &str,
        canonical_home: &Path,
        project_dir: Option<&Path>,
    ) -> Result<AgentWorkspace, String> {
        let prepared = self.begin(agent_id, canonical_home)?;
        let repo_path = prepared.workspace_root.join("repo");
        let room_id = project_dir
            .map(room_id_for_local_path)
            .unwrap_or_else(|| format!("private-{}", prepared.workspace_id));

        let (cwd, merge_context) = match project_dir {
            Some(project) => match discover_local_git(project)? {
                Some(local) => {
                    let _git = self
                        .inner
                        .git_ops
                        .lock()
                        .map_err(|_| "gestionnaire git verrouille".to_string())?;
                    git_worktree_add(&local.control, &repo_path, &local.base_sha)?;
                    (
                        repo_path.join(local.relative_cwd),
                        Some(MergeContext {
                            control: local.control,
                            worktree: repo_path.clone(),
                            base_sha: local.base_sha,
                            target_ref: local.target_ref,
                        }),
                    )
                }
                None => {
                    copy_tree(project, &repo_path, Some(&self.inner.data_dir))?;
                    (repo_path.clone(), None)
                }
            },
            None => {
                fs::create_dir_all(&repo_path).map_err(|error| error.to_string())?;
                (repo_path.clone(), None)
            }
        };

        prepared.finish(cwd, merge_context, room_id)
    }

    /// Prepare un worktree depuis un miroir bare partage. `repo_key` ne contient
    /// pas de secret ; `fetch_url` peut en contenir et n'est jamais persiste.
    pub fn prepare_remote(
        &self,
        agent_id: &str,
        canonical_home: &Path,
        repo_key: &str,
        fetch_url: &str,
        branch: Option<&str>,
    ) -> Result<AgentWorkspace, String> {
        let prepared = self.begin(agent_id, canonical_home)?;
        let repo_path = prepared.workspace_root.join("repo");
        let digest = Sha256::digest(repo_key.as_bytes());
        let mirror_name = digest
            .iter()
            .take(16)
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mirror = self
            .inner
            .data_dir
            .join("mirrors")
            .join(format!("{mirror_name}.git"));

        let _git = self
            .inner
            .git_ops
            .lock()
            .map_err(|_| "gestionnaire git verrouille".to_string())?;
        ensure_mirror(&mirror, repo_key, fetch_url)?;
        let target_ref = resolve_remote_target_ref(&mirror, branch)?;
        let room_id = room_id_for_remote(repo_key, &target_ref);
        sync_remote_target(&mirror, &target_ref)?;
        let base_sha = git_output(
            Command::new("git")
                .arg("--git-dir")
                .arg(&mirror)
                .args(["rev-parse", "--verify"])
                .arg(&target_ref),
            "resolution de la base du miroir",
        )?;
        let control = GitControl::Bare {
            git_dir: mirror.clone(),
        };
        git_worktree_add(&control, &repo_path, &base_sha)?;
        drop(_git);

        prepared.finish(
            repo_path.clone(),
            Some(MergeContext {
                control,
                worktree: repo_path,
                base_sha,
                target_ref,
            }),
            room_id,
        )
    }

    fn begin(&self, agent_id: &str, canonical_home: &Path) -> Result<PreparedWorkspace, String> {
        fs::create_dir_all(canonical_home).map_err(|error| error.to_string())?;
        let safe_agent = safe_component(agent_id)
            .chars()
            .take(32)
            .collect::<String>();
        let workspace_id = format!("{}-{}", safe_agent, uuid::Uuid::new_v4().simple());
        {
            let mut active = self
                .inner
                .active
                .lock()
                .map_err(|_| "semaphore d'admission verrouille".to_string())?;
            if active.len() >= self.inner.max_agents {
                return Err(format!(
                    "capacite agents atteinte ({}/{})",
                    active.len(),
                    self.inner.max_agents
                ));
            }
            active.insert(workspace_id.clone());
        }

        let admission = AdmissionLease {
            manager: Arc::downgrade(&self.inner),
            workspace_id: workspace_id.clone(),
        };
        let workspace_root = self.inner.data_dir.join("workspaces").join(&workspace_id);
        let isolated_home = self.inner.data_dir.join("agent-homes").join(&workspace_id);
        fs::create_dir_all(&workspace_root).map_err(|error| error.to_string())?;
        copy_tree(canonical_home, &isolated_home, Some(&self.inner.data_dir))?;
        inject_agent_conventions(&isolated_home)?;
        let transcript_baseline = collect_transcript_baseline(&isolated_home)?;

        let marker = LeaseMarker {
            workspace_id: workspace_id.clone(),
            agent_id: agent_id.to_string(),
            pid: std::process::id(),
            started_at: crate::metrics::now_ts(),
            active: true,
            merge_context: None,
            canonical_home: Some(canonical_home.to_path_buf()),
        };
        write_marker(&workspace_root, &marker)?;

        Ok(PreparedWorkspace {
            manager: Arc::downgrade(&self.inner),
            workspace_id,
            workspace_root,
            isolated_home,
            canonical_home: canonical_home.to_path_buf(),
            agent_id: agent_id.to_string(),
            started_at: marker.started_at,
            transcript_baseline: Some(transcript_baseline),
            admission: Some(admission),
        })
    }
}

struct PreparedWorkspace {
    manager: Weak<ManagerInner>,
    workspace_id: String,
    workspace_root: PathBuf,
    isolated_home: PathBuf,
    canonical_home: PathBuf,
    agent_id: String,
    started_at: i64,
    transcript_baseline: Option<TranscriptBaseline>,
    admission: Option<AdmissionLease>,
}

impl PreparedWorkspace {
    fn finish(
        mut self,
        cwd: PathBuf,
        merge_context: Option<MergeContext>,
        room_id: String,
    ) -> Result<AgentWorkspace, String> {
        if !cwd.is_dir() {
            return Err(format!("cwd isole introuvable: {}", cwd.display()));
        }
        write_marker(
            &self.workspace_root,
            &LeaseMarker {
                workspace_id: self.workspace_id.clone(),
                agent_id: self.agent_id.clone(),
                pid: std::process::id(),
                started_at: self.started_at,
                active: true,
                merge_context: merge_context.clone(),
                canonical_home: Some(self.canonical_home.clone()),
            },
        )?;
        let admission = self
            .admission
            .take()
            .ok_or_else(|| "lease d'admission absent".to_string())?;
        Ok(AgentWorkspace {
            inner: Arc::new(WorkspaceInner {
                manager: self.manager.clone(),
                workspace_id: self.workspace_id.clone(),
                room_id,
                workspace_root: self.workspace_root.clone(),
                cwd,
                isolated_home: self.isolated_home.clone(),
                canonical_home: self.canonical_home.clone(),
                merge_context,
                transcript_baseline: self.transcript_baseline.take().unwrap_or_default(),
                _admission: admission,
            }),
        })
    }
}

impl Drop for PreparedWorkspace {
    fn drop(&mut self) {
        if self.admission.is_none() {
            return;
        }
        if let Some(manager) = self.manager.upgrade() {
            safe_remove_dir(&manager.data_dir, &self.workspace_root);
            safe_remove_dir(&manager.data_dir, &self.isolated_home);
        }
    }
}

impl AgentWorkspace {
    pub fn workspace_id(&self) -> &str {
        &self.inner.workspace_id
    }

    /// Identifiant stable du salon logique. Plusieurs agents ont des
    /// `workspace_id` physiques differents mais partagent ce `room_id` quand
    /// ils proviennent du meme dossier/depot utilisateur.
    pub fn room_id(&self) -> &str {
        &self.inner.room_id
    }

    pub fn cwd(&self) -> &Path {
        &self.inner.cwd
    }

    pub fn home(&self) -> &Path {
        &self.inner.isolated_home
    }

    pub fn base_sha(&self) -> Option<&str> {
        self.inner
            .merge_context
            .as_ref()
            .map(|context| context.base_sha.as_str())
    }

    pub fn merge_context(&self) -> Option<MergeContext> {
        self.inner.merge_context.clone()
    }
}

impl Drop for WorkspaceInner {
    fn drop(&mut self) {
        let Some(manager) = self.manager.upgrade() else {
            return;
        };

        if let Ok(_merge) = manager.home_merge.lock() {
            if let Err(error) = merge_provider_transcripts(
                &self.isolated_home,
                &self.canonical_home,
                &self.transcript_baseline,
            ) {
                eprintln!("[worktree] fusion transcripts ignoree: {error}");
            }
        }

        if let Some(context) = &self.merge_context {
            if let Ok(_git) = manager.git_ops.lock() {
                preserve_recovery_ref(context, &self.workspace_id);
                let _ = git_worktree_remove(&context.control, &context.worktree);
            }
        }

        safe_remove_dir(&manager.data_dir, &self.workspace_root);
        safe_remove_dir(&manager.data_dir, &self.isolated_home);
    }
}

impl Drop for AdmissionLease {
    fn drop(&mut self) {
        if let Some(manager) = self.manager.upgrade() {
            if let Ok(mut active) = manager.active.lock() {
                active.remove(&self.workspace_id);
            }
        }
    }
}

struct LocalGit {
    control: GitControl,
    base_sha: String,
    target_ref: String,
    relative_cwd: PathBuf,
}

fn discover_local_git(project: &Path) -> Result<Option<LocalGit>, String> {
    let root = match git_output(
        Command::new("git")
            .arg("-C")
            .arg(project)
            .args(["rev-parse", "--show-toplevel"]),
        "detection du depot",
    ) {
        Ok(root) => PathBuf::from(root),
        Err(_) => return Ok(None),
    };
    let base_sha = git_output(
        Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["rev-parse", "HEAD"]),
        "resolution de HEAD",
    )?;
    let target_ref = resolve_local_target_ref(&root, &base_sha)?;
    let relative_cwd = project
        .canonicalize()
        .unwrap_or_else(|_| project.to_path_buf())
        .strip_prefix(root.canonicalize().unwrap_or_else(|_| root.clone()))
        .unwrap_or(Path::new(""))
        .to_path_buf();
    Ok(Some(LocalGit {
        control: GitControl::WorkTree { repo_root: root },
        base_sha,
        target_ref,
        relative_cwd,
    }))
}

fn resolve_local_target_ref(root: &Path, base_sha: &str) -> Result<String, String> {
    if let Ok(value) = git_output(
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["symbolic-ref", "-q", "HEAD"]),
        "resolution de la branche",
    ) {
        return Ok(value);
    }
    for candidate in ["refs/heads/main", "refs/heads/master"] {
        if git_status(
            Command::new("git")
                .arg("-C")
                .arg(root)
                .args(["show-ref", "--verify", "--quiet", candidate]),
        ) {
            return Ok(candidate.to_string());
        }
    }
    let target = "refs/cst/integration".to_string();
    git_run(
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["update-ref", &target, base_sha]),
        "creation de la branche d'integration",
    )?;
    Ok(target)
}

fn resolve_remote_target_ref(mirror: &Path, branch: Option<&str>) -> Result<String, String> {
    if let Some(branch) = branch.map(str::trim).filter(|value| !value.is_empty()) {
        if !git_status(Command::new("git").args(["check-ref-format", "--branch", branch])) {
            return Err(format!("branche git invalide: {branch}"));
        }
        return Ok(format!("refs/heads/{branch}"));
    }
    git_output(
        Command::new("git")
            .arg("--git-dir")
            .arg(mirror)
            .args(["symbolic-ref", "HEAD"]),
        "resolution de la branche par defaut",
    )
}

fn ensure_mirror(mirror: &Path, repo_key: &str, fetch_url: &str) -> Result<(), String> {
    if mirror.is_dir() {
        git_run(
            Command::new("git").arg("--git-dir").arg(mirror).args([
                "fetch",
                "--prune",
                fetch_url,
                "+refs/heads/*:refs/remotes/origin/*",
            ]),
            "mise a jour du miroir",
        )?;
        return Ok(());
    }

    let parent = mirror
        .parent()
        .ok_or_else(|| "racine de miroir invalide".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(".mirror-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        git_run(
            Command::new("git")
                .args(["clone", "--mirror", fetch_url])
                .arg(&temp),
            "creation du miroir",
        )?;
        git_run(
            Command::new("git")
                .arg("--git-dir")
                .arg(&temp)
                .args(["remote", "set-url", "origin", repo_key]),
            "nettoyage de l'URL du miroir",
        )?;
        fs::rename(&temp, mirror).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        safe_remove_dir(parent, &temp);
    }
    result
}

/// Avance la branche locale du miroir si le remote est strictement devant,
/// conserve les commits landed locaux si elle est devant, et refuse une
/// divergence (jamais de reset force qui perdrait un merge de la queue).
fn sync_remote_target(mirror: &Path, target_ref: &str) -> Result<(), String> {
    let Some(branch) = target_ref.strip_prefix("refs/heads/") else {
        return Ok(());
    };
    let remote_ref = format!("refs/remotes/origin/{branch}");
    let remote = match git_output(
        Command::new("git").arg("--git-dir").arg(mirror).args([
            "rev-parse",
            "--verify",
            &remote_ref,
        ]),
        "lecture de la branche distante",
    ) {
        Ok(remote) => remote,
        Err(_) => return Ok(()), // premier clone ou branche uniquement locale
    };
    let local = git_output(
        Command::new("git").arg("--git-dir").arg(mirror).args([
            "rev-parse",
            "--verify",
            target_ref,
        ]),
        "lecture de la branche locale",
    );
    let Ok(local) = local else {
        return git_run(
            Command::new("git").arg("--git-dir").arg(mirror).args([
                "update-ref",
                target_ref,
                &remote,
            ]),
            "creation de la branche locale",
        );
    };
    if local == remote {
        return Ok(());
    }
    if git_status(Command::new("git").arg("--git-dir").arg(mirror).args([
        "merge-base",
        "--is-ancestor",
        &local,
        &remote,
    ])) {
        return git_run(
            Command::new("git").arg("--git-dir").arg(mirror).args([
                "update-ref",
                target_ref,
                &remote,
                &local,
            ]),
            "fast-forward du miroir depuis le remote",
        );
    }
    if git_status(Command::new("git").arg("--git-dir").arg(mirror).args([
        "merge-base",
        "--is-ancestor",
        &remote,
        &local,
    ])) {
        return Ok(());
    }
    Err(format!(
        "divergence entre {target_ref} et {remote_ref}; integration manuelle requise"
    ))
}

fn git_worktree_add(control: &GitControl, target: &Path, base_sha: &str) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut command = git_control_command(control);
    command
        .args(["worktree", "add", "--detach"])
        .arg(target)
        .arg(base_sha);
    git_run(&mut command, "creation du worktree")
}

fn git_worktree_remove(control: &GitControl, target: &Path) -> Result<(), String> {
    let mut command = git_control_command(control);
    command.args(["worktree", "remove", "--force"]).arg(target);
    let result = git_run(&mut command, "retrait du worktree");
    let mut prune = git_control_command(control);
    let _ = git_run(prune.args(["worktree", "prune"]), "prune des worktrees");
    result
}

fn preserve_recovery_ref(context: &MergeContext, workspace_id: &str) {
    let head = git_output(
        Command::new("git")
            .arg("-C")
            .arg(&context.worktree)
            .args(["rev-parse", "HEAD"]),
        "lecture du HEAD agent",
    )
    .ok();
    let dirty = git_output(
        Command::new("git")
            .arg("-C")
            .arg(&context.worktree)
            .args(["status", "--porcelain"]),
        "lecture du statut agent",
    )
    .map(|status| !status.is_empty())
    .unwrap_or(false);

    if dirty {
        let _ = git_run(
            Command::new("git")
                .arg("-C")
                .arg(&context.worktree)
                .args(["add", "-A"]),
            "indexation de la recovery",
        );
        let _ = git_run(
            Command::new("git").arg("-C").arg(&context.worktree).args([
                "-c",
                "user.name=Codex Switch Terminal",
                "-c",
                "user.email=cst-recovery@localhost",
                "commit",
                "--no-verify",
                "-m",
                &format!("CST recovery {workspace_id}"),
            ]),
            "commit de recovery",
        );
    }

    let final_head = git_output(
        Command::new("git")
            .arg("-C")
            .arg(&context.worktree)
            .args(["rev-parse", "HEAD"]),
        "lecture du HEAD final",
    )
    .ok()
    .or(head);
    if let Some(final_head) = final_head.filter(|sha| sha != &context.base_sha) {
        let reference = format!("refs/cst/recovery/{}", safe_component(workspace_id));
        let mut command = git_control_command(&context.control);
        let _ = git_run(
            command.args(["update-ref", &reference, &final_head]),
            "preservation de la recovery",
        );
    }
}

fn git_control_command(control: &GitControl) -> Command {
    let mut command = Command::new("git");
    match control {
        GitControl::WorkTree { repo_root } => {
            command.arg("-C").arg(repo_root);
        }
        GitControl::Bare { git_dir } => {
            command.arg("--git-dir").arg(git_dir);
        }
    }
    command
}

fn git_output(command: &mut Command, operation: &str) -> Result<String, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = command
        .output()
        .map_err(|error| format!("{operation} impossible: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(format!(
            "{operation} a echoue ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn git_run(command: &mut Command, operation: &str) -> Result<(), String> {
    git_output(command, operation).map(|_| ())
}

fn git_status(command: &mut Command) -> bool {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn copy_tree(source: &Path, target: &Path, excluded: Option<&Path>) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let from = entry.path();
        if excluded.is_some_and(|root| paths_equal_or_nested(&from, root)) {
            continue;
        }
        let name = entry.file_name();
        if name.to_string_lossy().contains(".cst-tmp-") {
            continue;
        }
        let to = target.join(name);
        let metadata = fs::symlink_metadata(&from).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            // Ne suit jamais un lien hors du home/workspace source.
            continue;
        }
        if metadata.is_dir() {
            copy_tree(&from, &to, excluded)?;
        } else if metadata.is_file() {
            fs::copy(&from, &to).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn collect_transcript_baseline(home: &Path) -> Result<TranscriptBaseline, String> {
    let mut baseline = HashMap::new();
    for directory in ["sessions", "projects"] {
        let source = home.join(directory);
        if source.is_dir() {
            collect_baseline_tree(&source, Path::new(directory), &mut baseline)?;
        }
    }
    Ok(baseline)
}

fn collect_baseline_tree(
    source: &Path,
    relative: &Path,
    baseline: &mut TranscriptBaseline,
) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let child_relative = relative.join(entry.file_name());
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            collect_baseline_tree(&path, &child_relative, baseline)?;
        } else if metadata.is_file() {
            baseline.insert(
                child_relative,
                BaselineFile {
                    fingerprint: file_fingerprint(&metadata),
                    digest: file_digest(&path)?,
                },
            );
        }
    }
    Ok(())
}

fn merge_provider_transcripts(
    isolated: &Path,
    canonical: &Path,
    baseline: &TranscriptBaseline,
) -> Result<(), String> {
    let batch = uuid::Uuid::new_v4().simple().to_string();
    let mut conflicts = Vec::new();
    for directory in ["sessions", "projects"] {
        let source = isolated.join(directory);
        if source.is_dir() {
            merge_tree(
                &source,
                &canonical.join(directory),
                Path::new(directory),
                canonical,
                &batch,
                baseline,
                &mut conflicts,
            )?;
        }
    }
    if conflicts.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "transcripts modifies concurremment, copies preservees dans .cst-conflicts/{batch}: {}",
            conflicts.join(", ")
        ))
    }
}

fn inject_agent_conventions(home: &Path) -> Result<(), String> {
    const MARKER: &str = "<!-- CST-ISOLATED-AGENT -->";
    const CONTENT: &str = r#"<!-- CST-ISOLATED-AGENT -->
## Codex Switch Terminal: isolated agent

This process has a private worktree and provider home. Stay inside the current
working directory. Use the workspace_collab MCP tools to coordinate real work:

- claim_task before starting shared work;
- commit a clean, focused change before submit_for_merge;
- use merge_status/list_landed and rebase from the announced base when needed;
- never edit another agent's worktree or the original checkout by absolute path.
"#;
    for name in ["AGENTS.md", "CLAUDE.md"] {
        let path = home.join(name);
        let existing = fs::read_to_string(&path).unwrap_or_default();
        if existing.contains(MARKER) {
            continue;
        }
        let separator = if existing.is_empty() || existing.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        crate::fs_util::atomic_write(&path, format!("{existing}{separator}{CONTENT}"))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn merge_tree(
    source: &Path,
    target: &Path,
    relative: &Path,
    canonical: &Path,
    conflict_batch: &str,
    baseline: &TranscriptBaseline,
    conflicts: &mut Vec<String>,
) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let child_relative = relative.join(entry.file_name());
        let metadata = fs::symlink_metadata(&from).map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            merge_tree(
                &from,
                &to,
                &child_relative,
                canonical,
                conflict_batch,
                baseline,
                conflicts,
            )?;
        } else if metadata.is_file() {
            let source_digest = if let Some(original) = baseline.get(&child_relative) {
                if file_fingerprint(&metadata) == original.fingerprint {
                    continue; // copie initiale strictement inchangee
                }
                let digest = file_digest(&from)?;
                if digest == original.digest {
                    continue; // seulement touchee, contenu identique
                }
                if to.is_file() && file_digest(&to)? != original.digest {
                    preserve_transcript_conflict(
                        &from,
                        canonical,
                        conflict_batch,
                        &child_relative,
                    )?;
                    conflicts.push(child_relative.to_string_lossy().to_string());
                    continue;
                }
                digest
            } else {
                let digest = file_digest(&from)?;
                if to.is_file() {
                    if file_digest(&to)? == digest {
                        continue;
                    }
                    preserve_transcript_conflict(
                        &from,
                        canonical,
                        conflict_batch,
                        &child_relative,
                    )?;
                    conflicts.push(child_relative.to_string_lossy().to_string());
                    continue;
                }
                digest
            };
            // Garde la lecture du digest avant le remplacement : elle prouve que
            // le fichier source etait lisible en entier.
            let _ = source_digest;
            crate::fs_util::atomic_copy(&from, &to).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn preserve_transcript_conflict(
    source: &Path,
    canonical: &Path,
    batch: &str,
    relative: &Path,
) -> Result<(), String> {
    let target = canonical.join(".cst-conflicts").join(batch).join(relative);
    crate::fs_util::atomic_copy(source, &target)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn file_fingerprint(metadata: &fs::Metadata) -> FileFingerprint {
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    FileFingerprint {
        len: metadata.len(),
        modified_nanos,
    }
}

fn file_digest(path: &Path) -> Result<[u8; 32], String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    let mut result = [0_u8; 32];
    result.copy_from_slice(&digest);
    Ok(result)
}

fn paths_equal_or_nested(path: &Path, root: &Path) -> bool {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    path == root || path.starts_with(root)
}

fn safe_remove_dir(data_root: &Path, target: &Path) {
    let root = data_root
        .canonicalize()
        .unwrap_or_else(|_| data_root.to_path_buf());
    let target_abs = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());
    if target_abs != root && target_abs.starts_with(&root) {
        let _ = fs::remove_dir_all(target);
    }
}

fn safe_component(value: &str) -> String {
    let result = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let trimmed = result.trim_matches('-');
    if trimmed.is_empty() {
        "agent".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// Scope opaque et stable d'un workspace local. Le chemin canonique n'est
/// jamais expose dans le protocole ou le journal du salon.
pub fn room_id_for_local_path(path: &Path) -> String {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut identity = canonical.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        identity.make_ascii_lowercase();
    }
    hashed_room_id("local", &identity)
}

fn room_id_for_remote(repo_key: &str, target_ref: &str) -> String {
    let repo = repo_key.trim().trim_end_matches('/').to_ascii_lowercase();
    hashed_room_id("remote", &format!("{repo}\0{target_ref}"))
}

fn hashed_room_id(kind: &str, identity: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(kind.as_bytes());
    hasher.update([0]);
    hasher.update(identity.as_bytes());
    let digest = hasher.finalize();
    let short = digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("ws-{short}")
}

fn write_marker(workspace_root: &Path, marker: &LeaseMarker) -> Result<(), String> {
    crate::fs_util::atomic_write(
        &workspace_root.join(".cst-lease.json"),
        serde_json::to_vec_pretty(marker).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    // SAFETY: OpenProcess ne dereference aucun pointeur ; le handle obtenu est
    // ferme exactement une fois.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    unsafe { CloseHandle(handle) };
    true
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    // SAFETY: signal 0 ne modifie pas le processus, il teste son existence.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(any(windows, unix)))]
fn process_is_alive(pid: u32) -> bool {
    pid == std::process::id()
}

pub fn max_agents_from_env() -> usize {
    let Some(value) = std::env::var("CST_MAX_AGENTS")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
    else {
        return UNLIMITED_MAX_AGENTS;
    };
    if matches!(
        value.as_str(),
        "0" | "unlimited" | "unbounded" | "infinite" | "illimite"
    ) {
        return UNLIMITED_MAX_AGENTS;
    }
    value
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .unwrap_or(UNLIMITED_MAX_AGENTS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("cst-{name}-{}", uuid::Uuid::new_v4()))
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    #[test]
    fn local_agents_get_distinct_worktrees_and_homes() {
        let root = temp("worktree");
        let repo = root.join("source");
        let home = root.join("home");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(home.join("sessions")).unwrap();
        fs::write(home.join("auth.json"), "secret").unwrap();
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "base").unwrap();
        git(&repo, &["add", "."]);
        git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "base",
            ],
        );

        let manager = WorktreeManager::new(root.join("runtime"), 2).unwrap();
        let a = manager
            .prepare_local("agent-a", &home, Some(&repo))
            .unwrap();
        let b = manager
            .prepare_local("agent-b", &home, Some(&repo))
            .unwrap();
        assert_ne!(a.cwd(), b.cwd());
        assert_ne!(a.home(), b.home());
        assert_eq!(a.room_id(), b.room_id());
        assert_eq!(a.base_sha(), b.base_sha());
        assert_eq!(manager.active_count(), 2);
        assert!(manager
            .prepare_local("agent-c", &home, Some(&repo))
            .is_err());

        fs::write(a.cwd().join("file.txt"), "agent-a").unwrap();
        assert_eq!(
            fs::read_to_string(b.cwd().join("file.txt")).unwrap(),
            "base"
        );
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "base");
        drop(a);
        assert_eq!(manager.active_count(), 1);
        drop(b);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn transcripts_are_merged_back_but_config_is_not() {
        let root = temp("home-isolation");
        let home = root.join("home");
        fs::create_dir_all(home.join("sessions")).unwrap();
        fs::write(home.join("config.toml"), "canonical").unwrap();
        let manager = WorktreeManager::new(root.join("runtime"), 1).unwrap();
        let agent = manager.prepare_local("agent", &home, None).unwrap();
        fs::write(agent.home().join("config.toml"), "isolated").unwrap();
        fs::write(agent.home().join("sessions").join("turn.jsonl"), "turn").unwrap();
        drop(agent);

        assert_eq!(
            fs::read_to_string(home.join("config.toml")).unwrap(),
            "canonical"
        );
        assert_eq!(
            fs::read_to_string(home.join("sessions").join("turn.jsonl")).unwrap(),
            "turn"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unchanged_home_copy_never_overwrites_a_newer_transcript() {
        let root = temp("transcript-stale-copy");
        let home = root.join("home");
        fs::create_dir_all(home.join("sessions")).unwrap();
        let transcript = home.join("sessions").join("shared.jsonl");
        fs::write(&transcript, "base").unwrap();
        let manager = WorktreeManager::new(root.join("runtime"), 2).unwrap();
        let stale = manager.prepare_local("stale", &home, None).unwrap();
        let writer = manager.prepare_local("writer", &home, None).unwrap();
        fs::write(writer.home().join("sessions").join("shared.jsonl"), "new").unwrap();
        drop(writer);
        assert_eq!(fs::read_to_string(&transcript).unwrap(), "new");
        drop(stale);
        assert_eq!(fs::read_to_string(&transcript).unwrap(), "new");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn concurrent_transcript_edits_are_preserved_as_conflicts() {
        let root = temp("transcript-conflict");
        let home = root.join("home");
        fs::create_dir_all(home.join("sessions")).unwrap();
        let transcript = home.join("sessions").join("shared.jsonl");
        fs::write(&transcript, "base").unwrap();
        let manager = WorktreeManager::new(root.join("runtime"), 2).unwrap();
        let first = manager.prepare_local("first", &home, None).unwrap();
        let second = manager.prepare_local("second", &home, None).unwrap();
        fs::write(first.home().join("sessions").join("shared.jsonl"), "first").unwrap();
        fs::write(
            second.home().join("sessions").join("shared.jsonl"),
            "second",
        )
        .unwrap();
        drop(first);
        drop(second);
        assert_eq!(fs::read_to_string(&transcript).unwrap(), "first");
        let conflict_files = fs::read_dir(home.join(".cst-conflicts"))
            .unwrap()
            .flat_map(|batch| fs::read_dir(batch.unwrap().path()).unwrap())
            .flat_map(|provider_dir| fs::read_dir(provider_dir.unwrap().path()).unwrap())
            .count();
        assert_eq!(conflict_files, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unlimited_admission_handles_more_than_one_hundred_distinct_agents() {
        let root = temp("unlimited-agents");
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let manager = WorktreeManager::unlimited(root.join("runtime")).unwrap();
        let agents = (0..128)
            .map(|index| {
                manager
                    .prepare_local(&format!("agent-{index}"), &home, None)
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(manager.active_count(), 128);
        assert_eq!(manager.capacity(), usize::MAX);
        let unique_worktrees = agents
            .iter()
            .map(|agent| agent.cwd().to_path_buf())
            .collect::<HashSet<_>>();
        let unique_homes = agents
            .iter()
            .map(|agent| agent.home().to_path_buf())
            .collect::<HashSet<_>>();
        assert_eq!(unique_worktrees.len(), 128);
        assert_eq!(unique_homes.len(), 128);
        drop(agents);
        assert_eq!(manager.active_count(), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sweeper_keeps_live_pid_and_recovers_dead_lease() {
        let root = temp("sweeper");
        let runtime = root.join("runtime");
        let manager = WorktreeManager::new(runtime.clone(), 1).unwrap();
        let id = "stale-agent";
        let workspace = runtime.join("workspaces").join(id);
        let home = runtime.join("agent-homes").join(id);
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("transcript.jsonl"), "recovery").unwrap();
        let mut marker = LeaseMarker {
            workspace_id: id.to_string(),
            agent_id: id.to_string(),
            pid: std::process::id(),
            started_at: 0,
            active: true,
            merge_context: None,
            canonical_home: None,
        };
        write_marker(&workspace, &marker).unwrap();
        assert_eq!(manager.sweep_stale(1).unwrap(), 0);
        assert!(workspace.is_dir());

        marker.pid = u32::MAX;
        write_marker(&workspace, &marker).unwrap();
        assert_eq!(manager.sweep_stale(1).unwrap(), 1);
        assert!(!workspace.exists());
        assert!(runtime
            .join("recoveries")
            .join(format!("{id}-home"))
            .is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_has_a_single_cross_process_owner() {
        let root = temp("runtime-owner");
        let runtime = root.join("runtime");
        let first = WorktreeManager::new(runtime.clone(), 100).unwrap();

        let error = match WorktreeManager::new(runtime.clone(), 100) {
            Ok(_) => panic!("un second owner ne doit pas etre admis"),
            Err(error) => error,
        };
        assert!(error.contains("deja possede"));

        drop(first);
        assert!(WorktreeManager::new(runtime, 100).is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn room_id_is_stable_per_logical_workspace_and_private_without_one() {
        let root = temp("room-scope");
        let first = root.join("first");
        let second = root.join("second");
        let home = root.join("home");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::create_dir_all(&home).unwrap();

        assert_eq!(
            room_id_for_local_path(&first),
            room_id_for_local_path(&first)
        );
        assert_ne!(
            room_id_for_local_path(&first),
            room_id_for_local_path(&second)
        );

        let manager = WorktreeManager::unlimited(root.join("runtime")).unwrap();
        let private_a = manager.prepare_local("private-a", &home, None).unwrap();
        let private_b = manager.prepare_local("private-b", &home, None).unwrap();
        assert_ne!(private_a.room_id(), private_b.room_id());
        drop(private_a);
        drop(private_b);
        drop(manager);
        let _ = fs::remove_dir_all(root);
    }
}
