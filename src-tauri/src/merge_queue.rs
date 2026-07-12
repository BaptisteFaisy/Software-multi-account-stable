//! File d'integration serie, durable et independante du journal de chat.

use crate::worktree::{GitControl, MergeContext};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, Weak,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

const JOURNAL_FILE: &str = "merge-queue.jsonl";
const TASK_JOURNAL_FILE: &str = "tasks.jsonl";
const JOURNAL_COMPACT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CAS_ATTEMPTS: u32 = 4;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MergeStatus {
    Queued,
    Running,
    Landed,
    Conflict,
    VerifyFailed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeStatusView {
    pub id: u64,
    pub room_id: String,
    pub status: MergeStatus,
    pub agent_ident: String,
    pub workspace_id: String,
    pub commit_sha: String,
    pub base_sha: String,
    pub target_ref: String,
    pub landed_sha: Option<String>,
    pub conflicts: Vec<String>,
    pub error: Option<String>,
    pub verify: bool,
    pub submitted_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeJob {
    id: u64,
    #[serde(default = "default_room_id")]
    room_id: String,
    status: MergeStatus,
    agent_ident: String,
    workspace_id: String,
    context: MergeContext,
    commit_sha: String,
    landed_sha: Option<String>,
    #[serde(default)]
    conflicts: Vec<String>,
    error: Option<String>,
    verify: bool,
    submitted_at: i64,
    updated_at: i64,
}

impl MergeJob {
    fn view(&self) -> MergeStatusView {
        MergeStatusView {
            id: self.id,
            room_id: self.room_id.clone(),
            status: self.status,
            agent_ident: self.agent_ident.clone(),
            workspace_id: self.workspace_id.clone(),
            commit_sha: self.commit_sha.clone(),
            base_sha: self.context.base_sha.clone(),
            target_ref: self.context.target_ref.clone(),
            landed_sha: self.landed_sha.clone(),
            conflicts: self.conflicts.clone(),
            error: self.error.clone(),
            verify: self.verify,
            submitted_at: self.submitted_at,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Claimed,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    #[serde(default = "default_room_id")]
    pub room_id: String,
    pub id: String,
    pub description: String,
    pub status: TaskStatus,
    pub claimed_by: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeQueueSnapshot {
    pub queued: usize,
    pub running: usize,
    pub landed: usize,
    pub attention: usize,
    pub recent_landed: Vec<MergeStatusView>,
    pub tasks: Vec<TaskView>,
}

type Notifier = Arc<dyn Fn(MergeStatusView) + Send + Sync>;

#[derive(Clone)]
pub struct MergeQueue {
    inner: Arc<QueueInner>,
}

struct QueueInner {
    data_dir: PathBuf,
    jobs: Mutex<BTreeMap<u64, MergeJob>>,
    submit_lock: Mutex<()>,
    tasks: Mutex<HashMap<String, TaskView>>,
    next_id: AtomicU64,
    sender: mpsc::Sender<u64>,
    io_lock: Mutex<()>,
    task_io_lock: Mutex<()>,
    notifier: Mutex<Option<Notifier>>,
    owner_lock: Option<crate::fs_util::ProcessFileLock>,
    verify_command: Option<String>,
    ephemeral: bool,
}

impl MergeQueue {
    pub fn new() -> Self {
        Self::build_with_mode(
            std::env::temp_dir().join(format!(
                "cst-merge-memory-{}",
                uuid::Uuid::new_v4().simple()
            )),
            None,
            true,
        )
    }

    pub fn with_data_dir(data_dir: PathBuf) -> Self {
        let verify_command = std::env::var("CST_MERGE_VERIFY_COMMAND")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Self::build(data_dir, verify_command)
    }

    fn build(data_dir: PathBuf, verify_command: Option<String>) -> Self {
        Self::build_with_mode(data_dir, verify_command, false)
    }

    fn build_with_mode(data_dir: PathBuf, verify_command: Option<String>, ephemeral: bool) -> Self {
        let _ = fs::create_dir_all(data_dir.join("integration"));
        let _ = fs::create_dir_all(data_dir.join("hooks-empty"));
        let owner_lock = crate::fs_util::try_process_lock(&data_dir.join(".owner.lock")).ok();
        let is_owner = owner_lock.is_some();
        let (sender, receiver) = mpsc::channel();
        let (jobs, next_id) = load_jobs(&data_dir);
        let tasks = load_tasks(&data_dir);
        let pending = jobs
            .values()
            .filter(|job| matches!(job.status, MergeStatus::Queued | MergeStatus::Running))
            .map(|job| job.id)
            .collect::<Vec<_>>();
        let inner = Arc::new(QueueInner {
            data_dir,
            jobs: Mutex::new(jobs),
            submit_lock: Mutex::new(()),
            tasks: Mutex::new(tasks),
            next_id: AtomicU64::new(next_id),
            sender,
            io_lock: Mutex::new(()),
            task_io_lock: Mutex::new(()),
            notifier: Mutex::new(None),
            owner_lock,
            verify_command,
            ephemeral,
        });
        if is_owner {
            spawn_worker(Arc::downgrade(&inner), receiver);
        } else {
            drop(receiver);
            eprintln!(
                "[merge_queue] store {} possede par un autre processus; worker passif",
                inner.data_dir.display()
            );
        }
        let queue = Self { inner };
        for id in pending {
            let _ = queue.inner.sender.send(id);
        }
        queue
    }

    pub fn set_notifier(&self, notifier: Notifier) {
        if let Ok(mut slot) = self.inner.notifier.lock() {
            *slot = Some(notifier);
        }
    }

    pub fn submit(
        &self,
        room_id: &str,
        agent_ident: &str,
        workspace_id: &str,
        mut context: MergeContext,
        commit_sha: Option<&str>,
        verify: bool,
    ) -> Result<MergeStatusView, String> {
        if self.inner.owner_lock.is_none() {
            return Err(
                "ce processus n'est pas proprietaire de la merge queue; utilise son endpoint MCP/REST"
                    .to_string(),
            );
        }
        let commit_sha = match commit_sha.map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) => resolve_commit(&context.worktree, value)?,
            None => resolve_commit(&context.worktree, "HEAD")?,
        };
        let dirty = git_output(
            Command::new("git")
                .arg("-C")
                .arg(&context.worktree)
                .args(["status", "--porcelain"]),
            "lecture du statut de soumission",
        )?;
        if !dirty.is_empty() {
            return Err(
                "le worktree contient des changements non committes; commit puis resoumets"
                    .to_string(),
            );
        }
        if commit_sha == context.base_sha {
            return Err("aucun commit nouveau a integrer".to_string());
        }
        if !git_success(Command::new("git").arg("-C").arg(&context.worktree).args([
            "merge-base",
            "--is-ancestor",
            &context.base_sha,
            &commit_sha,
        ])) {
            return Err("le commit soumis ne descend pas de CST_BASE_SHA".to_string());
        }

        // Apres un conflit, l'agent peut avoir rebase sur la base annoncee dans
        // le salon. Si la tete cible courante est bien son ancetre, elle devient
        // la nouvelle base effective : on ne rejoue pas les commits deja landed.
        if let Ok(current_target) = resolve_control_ref(&context.control, &context.target_ref) {
            if current_target != context.base_sha
                && git_success(Command::new("git").arg("-C").arg(&context.worktree).args([
                    "merge-base",
                    "--is-ancestor",
                    &current_target,
                    &commit_sha,
                ]))
            {
                context.base_sha = current_target;
            }
        }

        let _submit = self
            .inner
            .submit_lock
            .lock()
            .map_err(|_| "soumissions de merge verrouillees".to_string())?;
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let queue_ref = queue_ref(id);
        let mut control = control_command(&context.control);
        git_run(
            control.args(["update-ref", &queue_ref, &commit_sha]),
            "ancrage du commit dans la queue",
        )?;
        let now = now_ts();
        let job = MergeJob {
            id,
            room_id: normalized_room_id(room_id),
            status: MergeStatus::Queued,
            agent_ident: agent_ident.to_string(),
            workspace_id: workspace_id.to_string(),
            context,
            commit_sha,
            landed_sha: None,
            conflicts: Vec::new(),
            error: None,
            verify,
            submitted_at: now,
            updated_at: now,
        };
        let view = job.view();
        self.inner
            .jobs
            .lock()
            .map_err(|_| "merge queue verrouillee".to_string())?
            .insert(id, job.clone());
        persist_job(&self.inner, &job);
        self.inner
            .sender
            .send(id)
            .map_err(|_| "worker de merge indisponible".to_string())?;
        Ok(view)
    }

    pub fn status(&self, room_id: &str, id: u64) -> Result<MergeStatusView, String> {
        let room_id = normalized_room_id(room_id);
        self.inner
            .jobs
            .lock()
            .map_err(|_| "merge queue verrouillee".to_string())?
            .get(&id)
            .filter(|job| job.room_id == room_id)
            .map(MergeJob::view)
            .ok_or_else(|| format!("soumission de merge introuvable: {id}"))
    }

    pub fn list_landed(&self, room_id: &str, limit: usize) -> Vec<MergeStatusView> {
        let room_id = normalized_room_id(room_id);
        self.inner
            .jobs
            .lock()
            .map(|jobs| {
                jobs.values()
                    .rev()
                    .filter(|job| job.room_id == room_id && job.status == MergeStatus::Landed)
                    .take(limit.clamp(1, 200))
                    .map(MergeJob::view)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn snapshot(&self, room_id: &str) -> MergeQueueSnapshot {
        let room_id = normalized_room_id(room_id);
        let (queued, running, landed, attention, recent_landed) = self
            .inner
            .jobs
            .lock()
            .map(|jobs| {
                let queued = jobs
                    .values()
                    .filter(|job| job.room_id == room_id && job.status == MergeStatus::Queued)
                    .count();
                let running = jobs
                    .values()
                    .filter(|job| job.room_id == room_id && job.status == MergeStatus::Running)
                    .count();
                let landed = jobs
                    .values()
                    .filter(|job| job.room_id == room_id && job.status == MergeStatus::Landed)
                    .count();
                let attention = jobs
                    .values()
                    .filter(|job| {
                        job.room_id == room_id
                            && matches!(
                                job.status,
                                MergeStatus::Conflict
                                    | MergeStatus::VerifyFailed
                                    | MergeStatus::Failed
                            )
                    })
                    .count();
                let recent_landed = jobs
                    .values()
                    .rev()
                    .filter(|job| job.room_id == room_id && job.status == MergeStatus::Landed)
                    .take(8)
                    .map(MergeJob::view)
                    .collect();
                (queued, running, landed, attention, recent_landed)
            })
            .unwrap_or_default();
        MergeQueueSnapshot {
            queued,
            running,
            landed,
            attention,
            recent_landed,
            tasks: self.list_tasks(&room_id),
        }
    }

    pub fn claim_task(
        &self,
        room_id: &str,
        task_id: &str,
        description: Option<&str>,
        agent_ident: &str,
    ) -> Result<TaskView, String> {
        self.ensure_owner()?;
        let room_id = normalized_room_id(room_id);
        let id = validate_task_id(task_id)?;
        let key = scoped_task_key(&room_id, &id);
        let mut tasks = self
            .inner
            .tasks
            .lock()
            .map_err(|_| "task board verrouille".to_string())?;
        if let Some(task) = tasks.get(&key) {
            if task.status == TaskStatus::Completed {
                return Err(format!("tache deja terminee: {id}"));
            }
            if task.claimed_by != agent_ident {
                return Err(format!("tache deja prise par {}", task.claimed_by));
            }
            return Ok(task.clone());
        }
        let task = TaskView {
            room_id,
            id: id.clone(),
            description: description
                .unwrap_or("")
                .trim()
                .chars()
                .take(2000)
                .collect(),
            status: TaskStatus::Claimed,
            claimed_by: agent_ident.to_string(),
            updated_at: now_ts(),
        };
        tasks.insert(key, task.clone());
        drop(tasks);
        persist_task(&self.inner, &task);
        Ok(task)
    }

    pub fn complete_task(
        &self,
        room_id: &str,
        task_id: &str,
        agent_ident: &str,
    ) -> Result<TaskView, String> {
        self.ensure_owner()?;
        let room_id = normalized_room_id(room_id);
        let id = validate_task_id(task_id)?;
        let key = scoped_task_key(&room_id, &id);
        let task = {
            let mut tasks = self
                .inner
                .tasks
                .lock()
                .map_err(|_| "task board verrouille".to_string())?;
            let task = tasks
                .get_mut(&key)
                .ok_or_else(|| format!("tache introuvable: {id}"))?;
            if task.claimed_by != agent_ident {
                return Err(format!("tache prise par {}", task.claimed_by));
            }
            task.status = TaskStatus::Completed;
            task.updated_at = now_ts();
            task.clone()
        };
        persist_task(&self.inner, &task);
        Ok(task)
    }

    pub fn list_tasks(&self, room_id: &str) -> Vec<TaskView> {
        let room_id = normalized_room_id(room_id);
        let mut tasks = self
            .inner
            .tasks
            .lock()
            .map(|tasks| {
                tasks
                    .values()
                    .filter(|task| task.room_id == room_id)
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        tasks.sort_by(|a, b| {
            a.updated_at
                .cmp(&b.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        tasks
    }

    fn ensure_owner(&self) -> Result<(), String> {
        if self.inner.owner_lock.is_some() {
            Ok(())
        } else {
            Err(
                "ce processus n'est pas proprietaire du store; utilise son endpoint MCP/REST"
                    .to_string(),
            )
        }
    }
}

impl Drop for QueueInner {
    fn drop(&mut self) {
        if self.ephemeral
            && self.data_dir.starts_with(std::env::temp_dir())
            && self
                .data_dir
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("cst-merge-memory-"))
        {
            drop(self.owner_lock.take());
            let _ = fs::remove_dir_all(&self.data_dir);
        }
    }
}

impl Default for MergeQueue {
    fn default() -> Self {
        Self::new()
    }
}

fn spawn_worker(inner: Weak<QueueInner>, receiver: mpsc::Receiver<u64>) {
    thread::Builder::new()
        .name("cst-merge-queue".to_string())
        .spawn(move || {
            while let Ok(id) = receiver.recv() {
                let Some(inner) = inner.upgrade() else {
                    break;
                };
                process_job(&inner, id);
            }
        })
        .expect("demarrage du worker de merge impossible");
}

fn process_job(inner: &Arc<QueueInner>, id: u64) {
    let Some(mut job) = update_job(inner, id, |job| {
        job.status = MergeStatus::Running;
        job.error = None;
        job.conflicts.clear();
    }) else {
        return;
    };

    let result = land_job(inner, &job);
    job = match result {
        Ok(landed_sha) => update_job(inner, id, |current| {
            current.status = MergeStatus::Landed;
            current.landed_sha = Some(landed_sha.clone());
            current.error = None;
            current.conflicts.clear();
        }),
        Err(LandError::Conflict(files)) => update_job(inner, id, |current| {
            current.status = MergeStatus::Conflict;
            current.conflicts = files.clone();
            current.error = Some("rebase non-clean; rebase le worktree puis resoumets".to_string());
        }),
        Err(LandError::Verify(error)) => update_job(inner, id, |current| {
            current.status = MergeStatus::VerifyFailed;
            current.error = Some(error.clone());
        }),
        Err(LandError::Failed(error)) => update_job(inner, id, |current| {
            current.status = MergeStatus::Failed;
            current.error = Some(error.clone());
        }),
    }
    .unwrap_or(job);

    if job.status == MergeStatus::Landed {
        let mut control = control_command(&job.context.control);
        let _ = git_run(
            control.args(["update-ref", "-d", &queue_ref(job.id), &job.commit_sha]),
            "retrait de la ref queue",
        );
    }
    if let Ok(notifier) = inner.notifier.lock() {
        if let Some(notifier) = notifier.as_ref() {
            notifier(job.view());
        }
    }
}

fn update_job(
    inner: &Arc<QueueInner>,
    id: u64,
    update: impl FnOnce(&mut MergeJob),
) -> Option<MergeJob> {
    let job = {
        let mut jobs = inner.jobs.lock().ok()?;
        let job = jobs.get_mut(&id)?;
        update(job);
        job.updated_at = now_ts();
        job.clone()
    };
    persist_job(inner, &job);
    Some(job)
}

enum LandError {
    Conflict(Vec<String>),
    Verify(String),
    Failed(String),
}

fn land_job(inner: &QueueInner, job: &MergeJob) -> Result<String, LandError> {
    let integration = integration_path(&inner.data_dir, &job.context.control);
    for _attempt in 0..MAX_CAS_ATTEMPTS {
        let expected_old = resolve_control_ref(&job.context.control, &job.context.target_ref)
            .map_err(LandError::Failed)?;
        ensure_integration(inner, &job.context.control, &integration, &expected_old)
            .map_err(LandError::Failed)?;
        reset_integration(&integration, &expected_old).map_err(LandError::Failed)?;

        let commits = git_output(
            Command::new("git").arg("-C").arg(&integration).args([
                "rev-list",
                "--reverse",
                &format!("{}..{}", job.context.base_sha, job.commit_sha),
            ]),
            "calcul des commits a rebaser",
        )
        .map_err(LandError::Failed)?;
        let commits = commits
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>();
        if commits.is_empty() {
            return Err(LandError::Failed("aucun commit a integrer".to_string()));
        }
        for commit in commits {
            let mut cherry_pick = Command::new("git");
            cherry_pick
                .arg("-c")
                .arg(format!(
                    "core.hooksPath={}",
                    inner.data_dir.join("hooks-empty").to_string_lossy()
                ))
                .arg("-C")
                .arg(&integration)
                .args(["cherry-pick", commit]);
            if let Err(error) = git_run(&mut cherry_pick, "rebase/cherry-pick") {
                let files = git_output(
                    Command::new("git").arg("-C").arg(&integration).args([
                        "diff",
                        "--name-only",
                        "--diff-filter=U",
                    ]),
                    "lecture des conflits",
                )
                .unwrap_or_default()
                .lines()
                .map(ToString::to_string)
                .collect::<Vec<_>>();
                let _ = git_run(
                    Command::new("git")
                        .arg("-C")
                        .arg(&integration)
                        .args(["cherry-pick", "--abort"]),
                    "abort du cherry-pick",
                );
                if files.is_empty() {
                    return Err(LandError::Failed(error));
                }
                return Err(LandError::Conflict(files));
            }
        }

        if job.verify {
            if let Err(error) = run_verify(&integration, inner.verify_command.as_deref()) {
                let _ = reset_integration(&integration, &expected_old);
                return Err(LandError::Verify(error));
            }
        }
        let new_sha = resolve_commit(&integration, "HEAD").map_err(LandError::Failed)?;
        match cas_land(
            &job.context.control,
            &job.context.target_ref,
            &new_sha,
            &expected_old,
        ) {
            Ok(true) => return Ok(new_sha),
            Ok(false) => {}
            Err(error) => return Err(LandError::Failed(error)),
        }
        // Une ecriture externe a gagne entre la lecture et le CAS : on repart
        // de la nouvelle tete, sans jamais perdre sa mise a jour.
    }
    Err(LandError::Failed(
        "la branche cible change trop vite; resoumets plus tard".to_string(),
    ))
}

/// Bare/mirror : CAS `update-ref` exact. Repo local dont la branche cible est
/// checkout : `git merge --ff-only` met a jour ref + index + fichiers sous les
/// locks Git natifs, uniquement si le checkout est propre et encore sur
/// `expected_old`. Cela evite de laisser le checkout original incoherent apres
/// un update-ref direct.
fn cas_land(
    control: &GitControl,
    target_ref: &str,
    new_sha: &str,
    expected_old: &str,
) -> Result<bool, String> {
    if let GitControl::WorkTree { repo_root } = control {
        let checked_out = git_output(
            Command::new("git")
                .arg("-C")
                .arg(repo_root)
                .args(["symbolic-ref", "-q", "HEAD"]),
            "lecture de la branche checkout",
        )
        .ok();
        if checked_out.as_deref() == Some(target_ref) {
            let status = git_output(
                Command::new("git")
                    .arg("-C")
                    .arg(repo_root)
                    .args(["status", "--porcelain"]),
                "verification du checkout principal",
            )?;
            if !status.is_empty() {
                return Err(
                    "checkout principal modifie; nettoie/commit avant de lander la queue"
                        .to_string(),
                );
            }
            let current = resolve_control_ref(control, target_ref)?;
            if current != expected_old {
                return Ok(false);
            }
            let mut merge = Command::new("git");
            merge
                .arg("-c")
                .arg("core.hooksPath=.git/cst-hooks-disabled")
                .arg("-C")
                .arg(repo_root)
                .args(["merge", "--ff-only", new_sha]);
            git_run(&mut merge, "fast-forward du checkout principal")?;
            return Ok(resolve_control_ref(control, target_ref)? == new_sha);
        }
    }

    let mut command = control_command(control);
    Ok(git_run(
        command.args(["update-ref", target_ref, new_sha, expected_old]),
        "CAS update-ref",
    )
    .is_ok())
}

fn ensure_integration(
    inner: &QueueInner,
    control: &GitControl,
    integration: &Path,
    expected: &str,
) -> Result<(), String> {
    if integration.join(".git").exists() {
        return Ok(());
    }
    if integration.exists() {
        safe_remove_integration(&inner.data_dir, integration);
    }
    if let Some(parent) = integration.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut prune = control_command(control);
    let _ = git_run(prune.args(["worktree", "prune"]), "prune integration");
    let mut add = control_command(control);
    git_run(
        add.args(["worktree", "add", "--detach"])
            .arg(integration)
            .arg(expected),
        "creation du worktree d'integration",
    )
}

fn reset_integration(integration: &Path, expected: &str) -> Result<(), String> {
    git_run(
        Command::new("git")
            .arg("-C")
            .arg(integration)
            .args(["reset", "--hard", expected]),
        "reset integration",
    )?;
    git_run(
        Command::new("git")
            .arg("-C")
            .arg(integration)
            .args(["clean", "-fd"]),
        "clean integration",
    )
}

fn run_verify(integration: &Path, script: Option<&str>) -> Result<(), String> {
    let Some(script) = script else {
        return Ok(());
    };
    let mut command = if cfg!(windows) {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", script]);
        command
    } else {
        let mut command = Command::new("sh");
        command.args(["-lc", script]);
        command
    };
    command.current_dir(integration).stdin(Stdio::null());
    let output = command
        .output()
        .map_err(|error| format!("verify impossible: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(format!(
            "verify a echoue ({}): {}{}",
            output.status,
            truncate(&stdout, 4000),
            truncate(&stderr, 4000)
        ))
    }
}

fn load_jobs(data_dir: &Path) -> (BTreeMap<u64, MergeJob>, u64) {
    let mut jobs = BTreeMap::new();
    let mut max_id = 0;
    if let Ok(file) = fs::File::open(data_dir.join(JOURNAL_FILE)) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if let Ok(mut job) = serde_json::from_str::<MergeJob>(&line) {
                if job.status == MergeStatus::Running {
                    job.status = MergeStatus::Queued;
                }
                max_id = max_id.max(job.id);
                jobs.insert(job.id, job);
            }
        }
    }
    (jobs, max_id + 1)
}

fn load_tasks(data_dir: &Path) -> HashMap<String, TaskView> {
    let mut tasks = HashMap::new();
    if let Ok(file) = fs::File::open(data_dir.join(TASK_JOURNAL_FILE)) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if let Ok(task) = serde_json::from_str::<TaskView>(&line) {
                tasks.insert(scoped_task_key(&task.room_id, &task.id), task);
            }
        }
    }
    tasks
}

fn persist_job(inner: &QueueInner, job: &MergeJob) {
    let Ok(line) = serde_json::to_string(job) else {
        return;
    };
    let Ok(_io) = inner.io_lock.lock() else {
        return;
    };
    let path = inner.data_dir.join(JOURNAL_FILE);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{line}");
        let _ = file.flush();
        let _ = file.sync_data();
    }
    if path.metadata().map(|meta| meta.len()).unwrap_or(0) > JOURNAL_COMPACT_BYTES {
        if let Ok(jobs) = inner.jobs.lock() {
            let compact = jobs
                .values()
                .filter_map(|job| serde_json::to_string(job).ok())
                .collect::<Vec<_>>()
                .join("\n");
            let _ = crate::fs_util::atomic_write(&path, format!("{compact}\n"));
        }
    }
}

fn persist_task(inner: &QueueInner, task: &TaskView) {
    let Ok(line) = serde_json::to_string(task) else {
        return;
    };
    let Ok(_io) = inner.task_io_lock.lock() else {
        return;
    };
    let path = inner.data_dir.join(TASK_JOURNAL_FILE);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
        let _ = file.flush();
        let _ = file.sync_data();
    }
}

fn integration_path(data_dir: &Path, control: &GitControl) -> PathBuf {
    let identity = match control {
        GitControl::WorkTree { repo_root } => repo_root,
        GitControl::Bare { git_dir } => git_dir,
    };
    let digest = Sha256::digest(identity.to_string_lossy().as_bytes());
    let key = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    data_dir.join("integration").join(key)
}

fn resolve_control_ref(control: &GitControl, reference: &str) -> Result<String, String> {
    let mut command = control_command(control);
    git_output(
        command.args(["rev-parse", "--verify", reference]),
        "lecture de la branche cible",
    )
}

fn resolve_commit(worktree: &Path, value: &str) -> Result<String, String> {
    git_output(
        Command::new("git").arg("-C").arg(worktree).args([
            "rev-parse",
            "--verify",
            &format!("{value}^{{commit}}"),
        ]),
        "resolution du commit",
    )
}

fn control_command(control: &GitControl) -> Command {
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

fn git_success(command: &mut Command) -> bool {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn queue_ref(id: u64) -> String {
    format!("refs/cst/queue/{id}")
}

fn validate_task_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 160
        || value
            .chars()
            .any(|character| character.is_control() || character == '\0')
    {
        return Err("taskId invalide".to_string());
    }
    Ok(value.to_string())
}

fn default_room_id() -> String {
    crate::agent_room::DEFAULT_ROOM_ID.to_string()
}

fn normalized_room_id(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        default_room_id()
    } else {
        value.chars().take(160).collect()
    }
}

fn scoped_task_key(room_id: &str, task_id: &str) -> String {
    format!("{}\0{}", normalized_room_id(room_id), task_id)
}

fn safe_remove_integration(data_dir: &Path, target: &Path) {
    let root = data_dir
        .canonicalize()
        .unwrap_or_else(|_| data_dir.to_path_buf());
    let target_abs = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());
    if target_abs != root && target_abs.starts_with(&root) {
        let _ = fs::remove_dir_all(target);
    }
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::WorktreeManager;
    use std::time::Duration;

    const ROOM: &str = "test-room";

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("cst-merge-{name}-{}", uuid::Uuid::new_v4()))
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

    fn wait_terminal(queue: &MergeQueue, id: u64) -> MergeStatusView {
        for _ in 0..100 {
            let status = queue.status(ROOM, id).unwrap();
            if !matches!(status.status, MergeStatus::Queued | MergeStatus::Running) {
                return status;
            }
            thread::sleep(Duration::from_millis(30));
        }
        panic!("merge timeout")
    }

    #[test]
    fn fifo_land_uses_cas_and_keeps_both_disjoint_changes() {
        let root = temp("fifo");
        let repo = root.join("repo");
        let home = root.join("home");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&home).unwrap();
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("base.txt"), "base").unwrap();
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
        let a = manager.prepare_local("a", &home, Some(&repo)).unwrap();
        let b = manager.prepare_local("b", &home, Some(&repo)).unwrap();
        for (workspace, file) in [(&a, "a.txt"), (&b, "b.txt")] {
            fs::write(workspace.cwd().join(file), file).unwrap();
            git(workspace.cwd(), &["add", "."]);
            git(
                workspace.cwd(),
                &[
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "commit",
                    "-m",
                    file,
                ],
            );
        }
        let queue = MergeQueue::with_data_dir(root.join("queue"));
        let first = queue
            .submit(
                ROOM,
                "a",
                a.workspace_id(),
                a.merge_context().unwrap(),
                None,
                false,
            )
            .unwrap();
        let second = queue
            .submit(
                ROOM,
                "b",
                b.workspace_id(),
                b.merge_context().unwrap(),
                None,
                false,
            )
            .unwrap();
        assert_eq!(wait_terminal(&queue, first.id).status, MergeStatus::Landed);
        assert!(queue.status("other-room", first.id).is_err());
        assert_eq!(wait_terminal(&queue, second.id).status, MergeStatus::Landed);
        assert_eq!(queue.list_landed(ROOM, 10).len(), 2);
        let target = git_output(
            Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["rev-parse", "refs/heads/main"]),
            "target",
        )
        .unwrap();
        let integration =
            integration_path(&root.join("queue"), &a.merge_context().unwrap().control);
        git(&integration, &["reset", "--hard", &target]);
        assert!(integration.join("a.txt").is_file());
        assert!(integration.join("b.txt").is_file());
        drop(a);
        drop(b);
        drop(queue);
        let reloaded = MergeQueue::with_data_dir(root.join("queue"));
        assert_eq!(
            reloaded.status(ROOM, first.id).unwrap().status,
            MergeStatus::Landed
        );
        assert_eq!(
            reloaded.status(ROOM, second.id).unwrap().status,
            MergeStatus::Landed
        );
        drop(reloaded);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn claim_task_is_atomic() {
        let root = temp("tasks");
        let queue = MergeQueue::with_data_dir(root.clone());
        let task = queue
            .claim_task(ROOM, "M1-1", Some("isoler"), "agent-a")
            .unwrap();
        assert_eq!(task.claimed_by, "agent-a");
        assert!(queue.claim_task(ROOM, "M1-1", None, "agent-b").is_err());
        assert_eq!(
            queue.complete_task(ROOM, "M1-1", "agent-a").unwrap().status,
            TaskStatus::Completed
        );
        let other = queue
            .claim_task("other-room", "M1-1", Some("autre repo"), "agent-b")
            .unwrap();
        assert_eq!(other.claimed_by, "agent-b");
        assert_eq!(queue.list_tasks(ROOM).len(), 1);
        assert_eq!(queue.list_tasks("other-room").len(), 1);
        drop(queue);
        let reloaded = MergeQueue::with_data_dir(root.clone());
        assert_eq!(reloaded.list_tasks(ROOM).len(), 1);
        assert_eq!(reloaded.list_tasks("other-room").len(), 1);
        drop(reloaded);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn second_process_view_is_passive_until_owner_drops() {
        let root = temp("ownership");
        let owner = MergeQueue::with_data_dir(root.clone());
        let passive = MergeQueue::with_data_dir(root.clone());
        assert!(owner.ensure_owner().is_ok());
        assert!(passive.ensure_owner().is_err());
        assert!(passive.claim_task(ROOM, "x", None, "agent").is_err());
        drop(owner);
        let replacement = MergeQueue::with_data_dir(root.clone());
        assert!(replacement.ensure_owner().is_ok());
        drop(passive);
        drop(replacement);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn overlapping_changes_report_conflicting_files_without_moving_main_twice() {
        let root = temp("conflict");
        let repo = root.join("repo");
        let home = root.join("home");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&home).unwrap();
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("hot.txt"), "base\n").unwrap();
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
        let a = manager.prepare_local("a", &home, Some(&repo)).unwrap();
        let b = manager.prepare_local("b", &home, Some(&repo)).unwrap();
        for (workspace, text) in [(&a, "from-a\n"), (&b, "from-b\n")] {
            fs::write(workspace.cwd().join("hot.txt"), text).unwrap();
            git(workspace.cwd(), &["add", "."]);
            git(
                workspace.cwd(),
                &[
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "commit",
                    "-m",
                    text.trim(),
                ],
            );
        }
        let queue = MergeQueue::with_data_dir(root.join("queue"));
        let first = queue
            .submit(
                ROOM,
                "a",
                a.workspace_id(),
                a.merge_context().unwrap(),
                None,
                false,
            )
            .unwrap();
        let second = queue
            .submit(
                ROOM,
                "b",
                b.workspace_id(),
                b.merge_context().unwrap(),
                None,
                false,
            )
            .unwrap();
        assert_eq!(wait_terminal(&queue, first.id).status, MergeStatus::Landed);
        let conflict = wait_terminal(&queue, second.id);
        assert_eq!(conflict.status, MergeStatus::Conflict);
        assert_eq!(conflict.conflicts, vec!["hot.txt"]);
        assert_eq!(
            fs::read_to_string(repo.join("hot.txt")).unwrap().trim(),
            "from-a"
        );
        drop(a);
        drop(b);
        drop(queue);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn verify_failure_rolls_back_integration_and_keeps_target_unchanged() {
        let root = temp("verify");
        let repo = root.join("repo");
        let home = root.join("home");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&home).unwrap();
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("base.txt"), "base").unwrap();
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
        let base = git_output(
            Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["rev-parse", "HEAD"]),
            "base",
        )
        .unwrap();
        let manager = WorktreeManager::new(root.join("runtime"), 1).unwrap();
        let agent = manager.prepare_local("a", &home, Some(&repo)).unwrap();
        fs::write(agent.cwd().join("new.txt"), "new").unwrap();
        git(agent.cwd(), &["add", "."]);
        git(
            agent.cwd(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "change",
            ],
        );
        let fail = if cfg!(windows) { "exit /b 7" } else { "exit 7" };
        let queue = MergeQueue::build(root.join("queue"), Some(fail.to_string()));
        let submitted = queue
            .submit(
                ROOM,
                "a",
                agent.workspace_id(),
                agent.merge_context().unwrap(),
                None,
                true,
            )
            .unwrap();
        assert_eq!(
            wait_terminal(&queue, submitted.id).status,
            MergeStatus::VerifyFailed
        );
        let target = git_output(
            Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["rev-parse", "refs/heads/main"]),
            "target",
        )
        .unwrap();
        assert_eq!(target, base);
        drop(agent);
        drop(queue);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn saas_mirror_reuse_keeps_landed_commits_when_remote_is_behind() {
        let root = temp("saas-mirror");
        let source = root.join("source");
        let home = root.join("home");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&home).unwrap();
        git(&source, &["init", "-b", "main"]);
        fs::write(source.join("base.txt"), "base").unwrap();
        git(&source, &["add", "."]);
        git(
            &source,
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
        let source_url = source.to_string_lossy().to_string();
        let first = manager
            .prepare_remote("saas-a", &home, &source_url, &source_url, Some("main"))
            .unwrap();
        fs::write(first.cwd().join("landed.txt"), "landed").unwrap();
        git(first.cwd(), &["add", "."]);
        git(
            first.cwd(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "landed",
            ],
        );
        let queue = MergeQueue::with_data_dir(root.join("queue"));
        let submitted = queue
            .submit(
                ROOM,
                "saas-a",
                first.workspace_id(),
                first.merge_context().unwrap(),
                None,
                false,
            )
            .unwrap();
        let landed = wait_terminal(&queue, submitted.id);
        assert_eq!(landed.status, MergeStatus::Landed, "{landed:?}");
        let landed_sha = landed.landed_sha.unwrap();
        drop(first);

        let second = manager
            .prepare_remote("saas-b", &home, &source_url, &source_url, Some("main"))
            .unwrap();
        assert_eq!(second.base_sha(), Some(landed_sha.as_str()));
        assert!(second.cwd().join("landed.txt").is_file());
        drop(second);
        drop(queue);
        let _ = fs::remove_dir_all(root);
    }
}
