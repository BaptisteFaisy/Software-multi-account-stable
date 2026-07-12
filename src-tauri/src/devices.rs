//! Registre des appareils appairés (téléphones), de leurs sessions révocables,
//! des codes d'appairage QR et des tickets WebSocket à usage unique.
//!
//! Modèle de sécurité (aligné sur le plan « client Android distant ») :
//! - Jetons OPAQUES à forte entropie (jamais des JWT) : la révocation par
//!   appareil est immédiate car tout passe par ce registre côté serveur.
//! - Sur le disque, on ne stocke QUE des empreintes SHA-256 des jetons, jamais
//!   les jetons en clair (rupture avec l'`api_key`/`secret` en clair d'avant).
//! - Access token court (15 min) + refresh token rotatif : chaque refresh
//!   invalide l'ancien couple. Un code d'appairage est à usage unique et expire
//!   en 5 min. Un ticket WS est à usage unique, lié à une cible, et expire en
//!   60 s.
//!
//! Ce module est PUR (état + persistance atomique) et testable sans réseau. Le
//! câblage HTTP (middleware d'auth, routes d'appairage, tickets WS) se fait dans
//! `server.rs` dans une étape suivante.

use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::security::constant_time_eq;

/// Durée de vie d'un access token (court : renouvelé via le refresh).
pub const ACCESS_TOKEN_TTL_SECS: i64 = 15 * 60;
/// Durée de vie d'un refresh token (rotatif à chaque usage).
pub const REFRESH_TOKEN_TTL_SECS: i64 = 30 * 24 * 60 * 60;
/// Durée de validité d'un code d'appairage (QR), à usage unique.
pub const PAIRING_CODE_TTL_SECS: i64 = 5 * 60;
/// Durée de validité d'un ticket WebSocket, à usage unique.
pub const WS_TICKET_TTL_SECS: i64 = 60;

/// Scopes accordables à un appareil mobile (allowlist stricte).
pub const MOBILE_SCOPES: &[&str] = &[
    "threads:read",
    "threads:write",
    "terminal:list",
    "terminal:view",
    "terminal:control",
    "approval:respond",
];

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Jeton opaque URL-safe (~244 bits d'entropie via deux UUID v4 CSPRNG).
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Empreinte stockable d'un jeton (jamais le jeton en clair sur le disque).
fn hash_token(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

/// Ne conserve que les scopes connus (défense en profondeur contre une demande
/// de scope arbitraire à l'appairage).
fn sanitize_scopes(requested: &[String]) -> Vec<String> {
    MOBILE_SCOPES
        .iter()
        .filter(|allowed| requested.iter().any(|s| s == *allowed))
        .map(|s| s.to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// état persisté
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct SessionRecord {
    access_hash: String,
    access_expires_at: i64,
    refresh_hash: String,
    refresh_expires_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
struct DeviceRecord {
    id: String,
    label: String,
    scopes: Vec<String>,
    created_at: i64,
    last_seen: i64,
    #[serde(default)]
    revoked: bool,
    #[serde(default)]
    session: Option<SessionRecord>,
}

#[derive(Clone, Serialize, Deserialize)]
struct PairingRecord {
    code_hash: String,
    label: String,
    scopes: Vec<String>,
    created_at: i64,
    expires_at: i64,
    #[serde(default)]
    used: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct PersistedState {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    devices: Vec<DeviceRecord>,
    #[serde(default)]
    pairings: Vec<PairingRecord>,
}

/// Ticket WebSocket : purement en mémoire (durée de vie 60 s), jamais persisté.
struct TicketRecord {
    ticket_hash: String,
    device_id: String,
    target: String,
    expires_at: i64,
    used: bool,
}

// ---------------------------------------------------------------------------
// valeurs publiques
// ---------------------------------------------------------------------------

/// Identité d'un appelant authentifié (résolue par le middleware d'auth).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallerContext {
    pub device_id: String,
    pub scopes: Vec<String>,
}

impl CallerContext {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }
}

/// Défi d'appairage : le `code` EN CLAIR n'est renvoyé qu'ici (pour le QR),
/// jamais restocké.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingChallenge {
    pub code: String,
    pub expires_at: i64,
}

/// Session émise : jetons EN CLAIR renvoyés une seule fois au client.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedSession {
    pub device_id: String,
    pub access_token: String,
    pub refresh_token: String,
    pub scopes: Vec<String>,
    pub access_expires_at: i64,
    pub refresh_expires_at: i64,
}

/// Vue d'un appareil pour l'écran de gestion desktop (aucun secret).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub label: String,
    pub scopes: Vec<String>,
    pub created_at: i64,
    pub last_seen: i64,
    pub revoked: bool,
    pub has_active_session: bool,
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

pub struct DeviceStore {
    path: PathBuf,
    state: Mutex<PersistedState>,
    tickets: Mutex<Vec<TicketRecord>>,
}

/// Répertoire de persistance des appareils (`.../devices.json`), aligné sur la
/// résolution de `settings.rs` (honore `CST_DATA_DIR`).
pub fn devices_path() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("CST_DATA_DIR") {
        return Ok(PathBuf::from(value).join("devices.json"));
    }
    let base = if let Some(value) = env::var_os("APPDATA") {
        PathBuf::from(value)
    } else if let Some(value) = env::var_os("XDG_CONFIG_HOME") {
        PathBuf::from(value)
    } else {
        let home = env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .ok_or_else(|| "impossible de résoudre le dossier personnel".to_string())?;
        PathBuf::from(home).join(".config")
    };
    Ok(base.join("codex-switch-terminal").join("devices.json"))
}

impl DeviceStore {
    /// Ouvre le store à un emplacement explicite (chargé du disque s'il existe).
    pub fn open(path: PathBuf) -> Self {
        let state = load_state(&path).unwrap_or_default();
        DeviceStore {
            path,
            state: Mutex::new(state),
            tickets: Mutex::new(Vec::new()),
        }
    }

    /// Ouvre le store à l'emplacement standard (honore `CST_DATA_DIR`).
    pub fn from_data_dir() -> Result<Self, String> {
        Ok(Self::open(devices_path()?))
    }

    // --- appairage (QR) ---------------------------------------------------

    /// Crée un code d'appairage à usage unique (à encoder dans le QR desktop).
    pub fn create_pairing_code(
        &self,
        label: &str,
        requested_scopes: &[String],
    ) -> Result<PairingChallenge, String> {
        let code = random_token();
        let created = now();
        let expires_at = created + PAIRING_CODE_TTL_SECS;
        let record = PairingRecord {
            code_hash: hash_token(&code),
            label: label.trim().to_string(),
            scopes: sanitize_scopes(requested_scopes),
            created_at: created,
            expires_at,
            used: false,
        };
        {
            let mut state = self.lock_state()?;
            state.pairings.retain(|p| !p.used && p.expires_at > created);
            state.pairings.push(record);
        }
        self.save()?;
        Ok(PairingChallenge { code, expires_at })
    }

    /// Échange un code d'appairage valide contre un appareil + une session.
    pub fn claim_pairing_code(
        &self,
        code: &str,
        device_label: &str,
    ) -> Result<IssuedSession, String> {
        let code_hash = hash_token(code);
        let ts = now();
        let issued;
        {
            let mut state = self.lock_state()?;
            let index = state
                .pairings
                .iter()
                .position(|p| {
                    !p.used
                        && p.expires_at > ts
                        && constant_time_eq(p.code_hash.as_bytes(), code_hash.as_bytes())
                })
                .ok_or_else(|| "code d'appairage invalide ou expiré".to_string())?;

            let scopes = state.pairings[index].scopes.clone();
            state.pairings[index].used = true;

            let (session, access_token, refresh_token) = new_session(ts);
            let device_id = Uuid::new_v4().to_string();
            issued = IssuedSession {
                device_id: device_id.clone(),
                access_token,
                refresh_token,
                scopes: scopes.clone(),
                access_expires_at: session.access_expires_at,
                refresh_expires_at: session.refresh_expires_at,
            };
            state.devices.push(DeviceRecord {
                id: device_id,
                label: device_label.trim().to_string(),
                scopes,
                created_at: ts,
                last_seen: ts,
                revoked: false,
                session: Some(session),
            });
        }
        self.save()?;
        Ok(issued)
    }

    // --- sessions ---------------------------------------------------------

    /// Résout un access token en identité, si valide (non révoqué, non expiré).
    /// Met à jour `last_seen` en cas de succès.
    pub fn verify_access(&self, access_token: &str) -> Option<CallerContext> {
        let access_hash = hash_token(access_token);
        let ts = now();
        let mut state = self.state.lock().ok()?;
        let device = state.devices.iter_mut().find(|d| {
            !d.revoked
                && d.session
                    .as_ref()
                    .map(|s| {
                        s.access_expires_at > ts
                            && constant_time_eq(s.access_hash.as_bytes(), access_hash.as_bytes())
                    })
                    .unwrap_or(false)
        })?;
        device.last_seen = ts;
        let ctx = CallerContext {
            device_id: device.id.clone(),
            scopes: device.scopes.clone(),
        };
        drop(state);
        // Best-effort : on ne fait pas échouer l'auth si la persistance de
        // `last_seen` échoue.
        let _ = self.save();
        Some(ctx)
    }

    /// Fait tourner la session à partir d'un refresh token valide : émet un
    /// nouveau couple access/refresh et invalide l'ancien.
    pub fn refresh(&self, refresh_token: &str) -> Result<IssuedSession, String> {
        let refresh_hash = hash_token(refresh_token);
        let ts = now();
        let issued;
        {
            let mut state = self.lock_state()?;
            let device = state
                .devices
                .iter_mut()
                .find(|d| {
                    !d.revoked
                        && d.session
                            .as_ref()
                            .map(|s| {
                                s.refresh_expires_at > ts
                                    && constant_time_eq(
                                        s.refresh_hash.as_bytes(),
                                        refresh_hash.as_bytes(),
                                    )
                            })
                            .unwrap_or(false)
                })
                .ok_or_else(|| "refresh token invalide ou expiré".to_string())?;

            let (session, access_token, refresh_token) = new_session(ts);
            issued = IssuedSession {
                device_id: device.id.clone(),
                access_token,
                refresh_token,
                scopes: device.scopes.clone(),
                access_expires_at: session.access_expires_at,
                refresh_expires_at: session.refresh_expires_at,
            };
            device.session = Some(session);
            device.last_seen = ts;
        }
        self.save()?;
        Ok(issued)
    }

    /// Révoque un appareil : coupe sa session et le marque révoqué (API + WS
    /// futurs refusés). Idempotent.
    pub fn revoke(&self, device_id: &str) -> Result<(), String> {
        {
            let mut state = self.lock_state()?;
            let device = state
                .devices
                .iter_mut()
                .find(|d| d.id == device_id)
                .ok_or_else(|| "appareil introuvable".to_string())?;
            device.revoked = true;
            device.session = None;
        }
        // Invalide aussi ses tickets WS en attente.
        if let Ok(mut tickets) = self.tickets.lock() {
            tickets.retain(|t| t.device_id != device_id);
        }
        self.save()
    }

    /// Liste des appareils pour l'écran de gestion desktop (aucun secret).
    pub fn list_devices(&self) -> Result<Vec<DeviceView>, String> {
        let ts = now();
        let state = self.lock_state()?;
        Ok(state
            .devices
            .iter()
            .map(|d| DeviceView {
                id: d.id.clone(),
                label: d.label.clone(),
                scopes: d.scopes.clone(),
                created_at: d.created_at,
                last_seen: d.last_seen,
                revoked: d.revoked,
                has_active_session: d
                    .session
                    .as_ref()
                    .map(|s| s.access_expires_at > ts || s.refresh_expires_at > ts)
                    .unwrap_or(false),
            })
            .collect())
    }

    // --- tickets WebSocket ------------------------------------------------

    /// Émet un ticket WS à usage unique lié à un appareil et à une cible
    /// (terminal ou thread). Le jeton en clair n'est renvoyé qu'ici.
    pub fn mint_ws_ticket(&self, device_id: &str, target: &str) -> Result<String, String> {
        {
            let state = self.lock_state()?;
            let device = state
                .devices
                .iter()
                .find(|d| d.id == device_id)
                .ok_or_else(|| "appareil introuvable".to_string())?;
            if device.revoked {
                return Err("appareil révoqué".to_string());
            }
        }
        let ticket = random_token();
        let ts = now();
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| "registre tickets verrouillé".to_string())?;
        tickets.retain(|t| !t.used && t.expires_at > ts);
        tickets.push(TicketRecord {
            ticket_hash: hash_token(&ticket),
            device_id: device_id.to_string(),
            target: target.to_string(),
            expires_at: ts + WS_TICKET_TTL_SECS,
            used: false,
        });
        Ok(ticket)
    }

    /// Consomme un ticket WS : vérifie qu'il est valide, non utilisé, non
    /// expiré, et lié à la cible demandée. Renvoie l'identité de l'appareil.
    pub fn consume_ws_ticket(&self, ticket: &str, target: &str) -> Result<CallerContext, String> {
        let ticket_hash = hash_token(ticket);
        let ts = now();
        let device_id = {
            let mut tickets = self
                .tickets
                .lock()
                .map_err(|_| "registre tickets verrouillé".to_string())?;
            let index = tickets
                .iter()
                .position(|t| {
                    !t.used
                        && t.expires_at > ts
                        && t.target == target
                        && constant_time_eq(t.ticket_hash.as_bytes(), ticket_hash.as_bytes())
                })
                .ok_or_else(|| "ticket WebSocket invalide ou expiré".to_string())?;
            tickets[index].used = true;
            tickets[index].device_id.clone()
        };

        let state = self.lock_state()?;
        let device = state
            .devices
            .iter()
            .find(|d| d.id == device_id && !d.revoked)
            .ok_or_else(|| "appareil révoqué".to_string())?;
        Ok(CallerContext {
            device_id: device.id.clone(),
            scopes: device.scopes.clone(),
        })
    }

    // --- interne ----------------------------------------------------------

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, PersistedState>, String> {
        self.state
            .lock()
            .map_err(|_| "registre appareils verrouillé".to_string())
    }

    fn save(&self) -> Result<(), String> {
        let state = self.lock_state()?;
        save_state(&self.path, &state)
    }
}

fn new_session(ts: i64) -> (SessionRecord, String, String) {
    let access_token = random_token();
    let refresh_token = random_token();
    let session = SessionRecord {
        access_hash: hash_token(&access_token),
        access_expires_at: ts + ACCESS_TOKEN_TTL_SECS,
        refresh_hash: hash_token(&refresh_token),
        refresh_expires_at: ts + REFRESH_TOKEN_TTL_SECS,
    };
    (session, access_token, refresh_token)
}

fn load_state(path: &Path) -> Option<PersistedState> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn save_state(path: &Path, state: &PersistedState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    crate::fs_util::atomic_write(path, json.as_bytes()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> DeviceStore {
        let path = std::env::temp_dir()
            .join(format!("cst-devices-{}", Uuid::new_v4()))
            .join("devices.json");
        DeviceStore::open(path)
    }

    fn scopes() -> Vec<String> {
        vec!["terminal:view".to_string(), "terminal:control".to_string()]
    }

    #[test]
    fn pairing_then_claim_yields_working_session() {
        let store = temp_store();
        let challenge = store.create_pairing_code("Pixel 8", &scopes()).unwrap();
        let session = store
            .claim_pairing_code(&challenge.code, "Pixel 8")
            .unwrap();

        let ctx = store
            .verify_access(&session.access_token)
            .expect("access ok");
        assert_eq!(ctx.device_id, session.device_id);
        assert!(ctx.has_scope("terminal:control"));
        assert!(!ctx.has_scope("approval:respond"));
    }

    #[test]
    fn pairing_code_is_single_use() {
        let store = temp_store();
        let challenge = store.create_pairing_code("dev", &scopes()).unwrap();
        assert!(store.claim_pairing_code(&challenge.code, "dev").is_ok());
        assert!(store.claim_pairing_code(&challenge.code, "dev").is_err());
    }

    #[test]
    fn expired_pairing_code_is_rejected() {
        let store = temp_store();
        let challenge = store.create_pairing_code("dev", &scopes()).unwrap();
        {
            let mut state = store.state.lock().unwrap();
            for p in &mut state.pairings {
                p.expires_at = now() - 1;
            }
        }
        assert!(store.claim_pairing_code(&challenge.code, "dev").is_err());
    }

    #[test]
    fn bad_access_token_is_rejected() {
        let store = temp_store();
        let challenge = store.create_pairing_code("dev", &scopes()).unwrap();
        store.claim_pairing_code(&challenge.code, "dev").unwrap();
        assert!(store.verify_access("not-a-real-token").is_none());
    }

    #[test]
    fn refresh_rotates_and_invalidates_old_tokens() {
        let store = temp_store();
        let challenge = store.create_pairing_code("dev", &scopes()).unwrap();
        let first = store.claim_pairing_code(&challenge.code, "dev").unwrap();

        let second = store.refresh(&first.refresh_token).unwrap();
        assert_eq!(second.device_id, first.device_id);
        // Nouveau couple valide.
        assert!(store.verify_access(&second.access_token).is_some());
        // Ancien refresh token invalidé.
        assert!(store.refresh(&first.refresh_token).is_err());
        // Ancien access token invalidé.
        assert!(store.verify_access(&first.access_token).is_none());
    }

    #[test]
    fn revoked_device_loses_api_and_refresh() {
        let store = temp_store();
        let challenge = store.create_pairing_code("dev", &scopes()).unwrap();
        let session = store.claim_pairing_code(&challenge.code, "dev").unwrap();

        store.revoke(&session.device_id).unwrap();
        assert!(store.verify_access(&session.access_token).is_none());
        assert!(store.refresh(&session.refresh_token).is_err());
        // Révocation idempotente.
        assert!(store.revoke(&session.device_id).is_ok());
    }

    #[test]
    fn ws_ticket_is_single_use_and_target_bound() {
        let store = temp_store();
        let challenge = store.create_pairing_code("dev", &scopes()).unwrap();
        let session = store.claim_pairing_code(&challenge.code, "dev").unwrap();

        let ticket = store
            .mint_ws_ticket(&session.device_id, "terminal-42")
            .unwrap();
        // Mauvaise cible -> refusé.
        assert!(store.consume_ws_ticket(&ticket, "terminal-99").is_err());
        // Bonne cible -> ok.
        let ctx = store.consume_ws_ticket(&ticket, "terminal-42").unwrap();
        assert_eq!(ctx.device_id, session.device_id);
        // Rejoué -> refusé (usage unique).
        assert!(store.consume_ws_ticket(&ticket, "terminal-42").is_err());
    }

    #[test]
    fn revoked_device_cannot_use_pending_ticket() {
        let store = temp_store();
        let challenge = store.create_pairing_code("dev", &scopes()).unwrap();
        let session = store.claim_pairing_code(&challenge.code, "dev").unwrap();
        let ticket = store.mint_ws_ticket(&session.device_id, "t1").unwrap();

        store.revoke(&session.device_id).unwrap();
        assert!(store.consume_ws_ticket(&ticket, "t1").is_err());
    }

    #[test]
    fn state_persists_across_reopen() {
        let path = std::env::temp_dir()
            .join(format!("cst-devices-{}", Uuid::new_v4()))
            .join("devices.json");
        let device_id;
        let access_token;
        {
            let store = DeviceStore::open(path.clone());
            let challenge = store.create_pairing_code("dev", &scopes()).unwrap();
            let session = store.claim_pairing_code(&challenge.code, "dev").unwrap();
            device_id = session.device_id;
            access_token = session.access_token;
        }
        // Réouverture depuis le disque.
        let reopened = DeviceStore::open(path);
        let ctx = reopened
            .verify_access(&access_token)
            .expect("session persistée");
        assert_eq!(ctx.device_id, device_id);
    }

    #[test]
    fn tokens_are_never_stored_in_clear() {
        let path = std::env::temp_dir()
            .join(format!("cst-devices-{}", Uuid::new_v4()))
            .join("devices.json");
        let store = DeviceStore::open(path.clone());
        let challenge = store.create_pairing_code("dev", &scopes()).unwrap();
        let session = store.claim_pairing_code(&challenge.code, "dev").unwrap();

        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains(&session.access_token));
        assert!(!on_disk.contains(&session.refresh_token));
        assert!(!on_disk.contains(&challenge.code));
    }
}
