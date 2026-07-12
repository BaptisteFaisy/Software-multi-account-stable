//! Abstraction multi-fournisseur (Codex / Claude Code).
//!
//! Centralise tout ce qui differe entre les CLI geres par l'app : variable
//! d'environnement du "home" isole, presence de credentials, ecriture de la
//! config par compte, emplacement des sessions, commande de reprise et flag
//! "bypass". Le comportement **Codex est preserve a l'identique** : les branches
//! Codex delegent aux fonctions historiques de `settings.rs`.
//!
//! Ajouter un fournisseur = ajouter une variante a `settings::Provider` puis un
//! bras a chaque `match` de ce module (le compilateur reclame l'exhaustivite).

use crate::settings::{self, Provider};
use serde_json::{Map, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

impl Provider {
    /// Variable d'environnement qui redirige le "home" isole du CLI (le
    /// mecanisme d'isolation multi-comptes). Codex=`CODEX_HOME`,
    /// Claude=`CLAUDE_CONFIG_DIR` (relocalise sessions + credentials + config).
    pub fn home_env_var(self) -> &'static str {
        match self {
            Provider::Codex => "CODEX_HOME",
            Provider::Claude => "CLAUDE_CONFIG_DIR",
        }
    }

    /// Flag CLI qui neutralise approbations/sandbox pour la session lancee.
    pub fn bypass_flag(self) -> &'static str {
        match self {
            Provider::Codex => "--dangerously-bypass-approvals-and-sandbox",
            Provider::Claude => "--dangerously-skip-permissions",
        }
    }

    /// Modele par defaut applique aux nouveaux comptes de ce provider.
    pub fn default_model(self) -> &'static str {
        match self {
            Provider::Codex => "gpt-5.6-sol",
            Provider::Claude => "sonnet",
        }
    }

    /// Dossier racine ou le CLI stocke ses sessions/discussions, sous le home.
    /// Codex: `<home>/sessions/AAAA/MM/JJ/rollout-*.jsonl`.
    /// Claude: `<home>/projects/<cwd-echappe>/<uuid>.jsonl`.
    pub fn sessions_root(self, home: &Path) -> PathBuf {
        match self {
            Provider::Codex => home.join("sessions"),
            Provider::Claude => home.join("projects"),
        }
    }

    /// Construit la commande de reprise d'une session (envoyee au terminal).
    pub fn resume_command(self, cli: &str, session_id: &str) -> String {
        let cli = cli.trim();
        match self {
            Provider::Codex => format!("{cli} resume {session_id}"),
            Provider::Claude => format!("{cli} --resume {session_id}"),
        }
    }

    /// Vrai si `name` (nom d'un dossier directement sous $HOME) ressemble au
    /// home d'un compte de ce provider (decouverte automatique).
    pub fn is_home_like_dir(self, name: &str) -> bool {
        match self {
            Provider::Codex => {
                name == ".codex" || name.starts_with(".codex-") || name.starts_with(".codex_")
            }
            Provider::Claude => {
                name == ".claude" || name.starts_with(".claude-") || name.starts_with(".claude_")
            }
        }
    }

    /// Vrai si le compte possede des credentials exploitables dans `home`.
    pub fn has_auth(self, home: &Path) -> bool {
        match self {
            Provider::Codex => codex_has_auth(home),
            Provider::Claude => claude_has_auth(home),
        }
    }

    /// (Re)ecrit, de facon idempotente, la config propre au compte dans `home`.
    /// `reasoning_effort` est ignore pour les providers qui n'en ont pas.
    pub fn write_account_config(
        self,
        home: &Path,
        bypass: bool,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
    ) -> io::Result<()> {
        match self {
            Provider::Codex => {
                settings::ensure_codex_account_config(home, bypass, model, reasoning_effort)
            }
            Provider::Claude => ensure_claude_account_config(home, bypass, model),
        }
    }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// Codex : `home/auth.json` -> `tokens.access_token` non vide.
fn codex_has_auth(home: &Path) -> bool {
    read_json(&home.join("auth.json"))
        .and_then(|value| {
            value
                .get("tokens")
                .and_then(|tokens| tokens.get("access_token"))
                .and_then(Value::as_str)
                .map(|token| !token.is_empty())
        })
        .unwrap_or(false)
}

/// Claude Code : `home/.credentials.json` -> `claudeAiOauth.accessToken` non
/// vide (format ecrit par `claude` apres `/login` dans le CLAUDE_CONFIG_DIR).
fn claude_has_auth(home: &Path) -> bool {
    read_json(&home.join(".credentials.json"))
        .and_then(|value| {
            value
                .get("claudeAiOauth")
                .and_then(|oauth| oauth.get("accessToken"))
                .and_then(Value::as_str)
                .map(|token| !token.is_empty())
        })
        .unwrap_or(false)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

// ---------------------------------------------------------------------------
// Claude : chemins de sessions + config settings.json
// ---------------------------------------------------------------------------

/// Nom de dossier Claude pour un cwd : chaque caractere non alphanumerique
/// ASCII devient un tiret (aucune fusion de tirets, casse preservee), exactement
/// comme Claude Code encode `projects/<cwd>/` (verifie sur disque : `C:\Users`
/// -> `C--Users`). C'est la cle pour poser un fichier de session la ou
/// `claude --resume <id>` (qui ne cherche que dans le dossier projet courant)
/// saura le retrouver.
///
/// Utilise notamment quand le drag-and-drop rattache une session Claude a un
/// autre workspace : le fichier doit suivre cette cle pour rester reprenable.
pub fn claude_escaped_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Ecrit `home/settings.json` (JSON) pour un compte Claude en **preservant** les
/// cles non gerees (mcpServers, hooks, env, permissions.allow/deny...). Le choix
/// bypass est toujours materialise explicitement : `permissions.defaultMode`
/// passe a `bypassPermissions` (bypass actif) ou `default` (sinon), ce qui
/// neutralise un ancien bypass persiste. Ecriture atomique (tmp + rename).
pub fn ensure_claude_account_config(
    home: &Path,
    bypass: bool,
    model: Option<&str>,
) -> io::Result<()> {
    let model = model.map(str::trim).filter(|value| !value.is_empty());

    fs::create_dir_all(home)?;
    let path = home.join("settings.json");
    let existing = fs::read_to_string(&path).unwrap_or_default();

    let mut root: Value = if existing.trim().is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str(&existing).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("settings.json Claude illisible: {error}"),
            )
        })?
    };
    if !root.is_object() {
        // Un settings.json corrompu (non-objet) est remplace par un objet propre
        // plutot que de faire echouer tout lancement de terminal.
        root = Value::Object(Map::new());
    }

    {
        let obj = root.as_object_mut().expect("root is object");

        if let Some(model) = model {
            obj.insert("model".to_string(), Value::String(model.to_string()));
        }

        let mode = if bypass {
            "bypassPermissions"
        } else {
            "default"
        };
        let permissions = obj
            .entry("permissions".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !permissions.is_object() {
            *permissions = Value::Object(Map::new());
        }
        permissions
            .as_object_mut()
            .expect("permissions is object")
            .insert("defaultMode".to_string(), Value::String(mode.to_string()));
    }

    let mut serialized = serde_json::to_string_pretty(&root)
        .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
    serialized.push('\n');

    // Idempotent : converge des la 2e ecriture (existing == notre sortie pretty).
    if serialized == existing {
        return Ok(());
    }

    crate::fs_util::atomic_write(&path, serialized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cst-provider-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn home_env_and_flags_are_provider_specific() {
        assert_eq!(Provider::Codex.home_env_var(), "CODEX_HOME");
        assert_eq!(Provider::Claude.home_env_var(), "CLAUDE_CONFIG_DIR");
        assert_eq!(
            Provider::Codex.bypass_flag(),
            "--dangerously-bypass-approvals-and-sandbox"
        );
        assert_eq!(
            Provider::Claude.bypass_flag(),
            "--dangerously-skip-permissions"
        );
    }

    #[test]
    fn resume_command_matches_each_cli_syntax() {
        assert_eq!(
            Provider::Codex.resume_command("codex", "abc"),
            "codex resume abc"
        );
        assert_eq!(
            Provider::Claude.resume_command("claude", "abc"),
            "claude --resume abc"
        );
    }

    #[test]
    fn sessions_root_points_at_each_store() {
        let home = Path::new("/home/x");
        assert!(Provider::Codex.sessions_root(home).ends_with("sessions"));
        assert!(Provider::Claude.sessions_root(home).ends_with("projects"));
    }

    #[test]
    fn claude_escaped_cwd_replaces_non_alnum_without_collapsing() {
        // Le `:` et le `\` deviennent CHACUN un tiret -> `C--Users`.
        assert_eq!(
            claude_escaped_cwd("C:\\Users\\jeanp\\proj"),
            "C--Users-jeanp-proj"
        );
        // Un point devient un tiret ; la casse est preservee.
        assert_eq!(claude_escaped_cwd("liquid.App"), "liquid-App");
    }

    #[test]
    fn has_auth_reads_provider_specific_credential_files() {
        let home = scratch("auth");

        assert!(!Provider::Codex.has_auth(&home));
        assert!(!Provider::Claude.has_auth(&home));

        fs::write(
            home.join("auth.json"),
            "{\"tokens\":{\"access_token\":\"xyz\"}}",
        )
        .unwrap();
        assert!(Provider::Codex.has_auth(&home));
        // Un auth.json Codex ne vaut PAS une auth Claude.
        assert!(!Provider::Claude.has_auth(&home));

        fs::write(
            home.join(".credentials.json"),
            "{\"claudeAiOauth\":{\"accessToken\":\"tok\"}}",
        )
        .unwrap();
        assert!(Provider::Claude.has_auth(&home));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn claude_config_writes_model_and_bypass_mode_idempotently() {
        let home = scratch("claude-cfg");

        ensure_claude_account_config(&home, true, Some("opus")).unwrap();
        let once = fs::read_to_string(home.join("settings.json")).unwrap();
        let value: Value = serde_json::from_str(&once).unwrap();
        assert_eq!(
            value.pointer("/model").and_then(Value::as_str),
            Some("opus")
        );
        assert_eq!(
            value
                .pointer("/permissions/defaultMode")
                .and_then(Value::as_str),
            Some("bypassPermissions")
        );

        // Idempotent au 2e passage.
        ensure_claude_account_config(&home, true, Some("opus")).unwrap();
        let twice = fs::read_to_string(home.join("settings.json")).unwrap();
        assert_eq!(once, twice);

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn claude_config_disables_bypass_and_preserves_unrelated_keys() {
        let home = scratch("claude-preserve");
        fs::create_dir_all(&home).unwrap();
        // Un settings.json existant avec des cles NON gerees (mcpServers, hooks)
        // et une permission allow-list qui doivent survivre.
        fs::write(
            home.join("settings.json"),
            "{\"mcpServers\":{\"foo\":{\"url\":\"http://x\"}},\"permissions\":{\"allow\":[\"Bash\"]}}",
        )
        .unwrap();

        ensure_claude_account_config(&home, false, None).unwrap();
        let value: Value =
            serde_json::from_str(&fs::read_to_string(home.join("settings.json")).unwrap()).unwrap();

        // defaultMode passe a "default" (bypass off), le reste est preserve.
        assert_eq!(
            value
                .pointer("/permissions/defaultMode")
                .and_then(Value::as_str),
            Some("default")
        );
        assert_eq!(
            value
                .pointer("/permissions/allow/0")
                .and_then(Value::as_str),
            Some("Bash")
        );
        assert_eq!(
            value.pointer("/mcpServers/foo/url").and_then(Value::as_str),
            Some("http://x")
        );

        let _ = fs::remove_dir_all(&home);
    }
}
