#!/usr/bin/env bash
set -euo pipefail

# Mise a jour SURE d'un noeud Linux deja installe.
#
# DEUX modes pour peupler releases/<v> :
#   - build    (defaut) : compile sur l'hote depuis /opt/codex-switch-terminal-src.
#   - release  (--release <tag>) : TELECHARGE l'artefact signe de la GitHub
#                Release, verifie SHA-256 + signature minisign (fail-closed),
#                puis l'installe. C'est le mode Phase 2 (artefacts CI signes).
#
# Sequence commune ensuite : self-check `--version` -> drain -> attente
# activeTerminals==0 (borne, timeout -> abandon sans tuer les sessions) ->
# bascule atomique de 'current' -> restart -> verification "vraiment revenu"
# -> rollback automatique si echec.
#
# Usage :
#   # build sur l'hote (Phase 1)
#   sudo bash update-node.sh [--source cst-source.tar.gz] [--commit <sha>]
#   # download d'une release signee (Phase 2)
#   sudo bash update-node.sh --release v0.1.0 [--repo owner/repo] \
#        [--minisign-pubkey 'RW...'] [--asset cst-server-linux-x86_64.tar.gz]
#   # options communes : [--drain-timeout <sec>] [--force] [--allow-unsigned]

APP_DIR="/opt/codex-switch-terminal"
SOURCE_DIR="/opt/codex-switch-terminal-src"
SOURCE_ARCHIVE="/tmp/cst-source.tar.gz"
RELEASES_DIR="$APP_DIR/releases"
CURRENT_LINK="$APP_DIR/current"
ENV_FILE="/etc/codex-switch-terminal.env"
SERVICE="codex-switch-terminal.service"
CST_GIT_COMMIT="${CST_GIT_COMMIT:-}"
DRAIN_TIMEOUT=300
VERIFY_TIMEOUT=60
FORCE=0

# --- Mode release (Phase 2) ---
MODE="build"                                   # build | release
RELEASE_TAG=""
REPO="${CST_REPO:-BaptisteFaisy/Software-multi-account}"
ASSET="${CST_ASSET:-cst-server-linux-x86_64.tar.gz}"
# Cle publique minisign (NON secrete). Remplace le placeholder par ta vraie cle
# (voir deploy/PHASE2-UPDATES.md) ou passe --minisign-pubkey / CST_MINISIGN_PUBKEY.
MINISIGN_PUBKEY="${CST_MINISIGN_PUBKEY:-RWQPLACEHOLDER_REMPLACE_MOI}"
ALLOW_UNSIGNED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE_ARCHIVE="$2"; shift 2 ;;
    --commit) CST_GIT_COMMIT="$2"; shift 2 ;;
    --drain-timeout) DRAIN_TIMEOUT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --release) MODE="release"; RELEASE_TAG="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --asset) ASSET="$2"; shift 2 ;;
    --minisign-pubkey) MINISIGN_PUBKEY="$2"; shift 2 ;;
    --allow-unsigned) ALLOW_UNSIGNED=1; shift ;;
    *) echo "Argument inconnu: $1" >&2; exit 2 ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || { echo "Lance ce script avec sudo." >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "$ENV_FILE introuvable : noeud non installe ?" >&2; exit 1; }
REQUIRED_TOOLS=(curl jq awk sed tar)
if [[ "$MODE" == "release" ]]; then
  REQUIRED_TOOLS+=(sha256sum)
  [[ "$ALLOW_UNSIGNED" == "1" ]] || REQUIRED_TOOLS+=(minisign)
fi
for tool in "${REQUIRED_TOOLS[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Outil requis introuvable: $tool" >&2; exit 1; }
done

# Charge token + bind depuis l'EnvironmentFile (format KEY="value").
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a
ADMIN_TOKEN="${CST_ADMIN_TOKEN:-}"
BIND="${CST_BIND:-127.0.0.1:8080}"
PORT="${BIND##*:}"
BASE="http://127.0.0.1:$PORT"
[[ -n "$ADMIN_TOKEN" ]] || { echo "CST_ADMIN_TOKEN absent de $ENV_FILE." >&2; exit 1; }

log() { echo "[update-node] $*"; }
healthz() { curl -fsS --max-time 3 "$BASE/healthz" 2>/dev/null || true; }
hfield() { jq -r --arg k "$2" '.[$k] // empty' <<<"${1:-}" 2>/dev/null || true; }

# --- Release actuellement active (cible du rollback) ---
PREV_TARGET=""
[[ -L "$CURRENT_LINK" ]] && PREV_TARGET="$(readlink "$CURRENT_LINK")"   # ex: releases/0.1.0

# --- Peupler la nouvelle release : mode build OU mode release (download+verif) ---
if [[ "$MODE" == "release" ]]; then
  DL="$(mktemp -d)"; STAGE="$(mktemp -d)"
  trap 'rm -rf "$DL" "$STAGE"' EXIT
  base_url="https://github.com/$REPO/releases/download/$RELEASE_TAG"
  log "Telechargement de $ASSET depuis $REPO@$RELEASE_TAG"
  for suffix in "" ".sha256" ".minisig"; do
    curl -fSL --retry 3 --retry-delay 2 --max-time 180 \
      -o "$DL/$ASSET$suffix" "$base_url/$ASSET$suffix"
  done

  # 1) Empreinte SHA-256 (fail-closed). Le .sha256 contient le seul basename.
  log "Verification SHA-256"
  ( cd "$DL" && sha256sum -c "$ASSET.sha256" )

  # 2) Signature minisign (fail-closed sauf --allow-unsigned explicite).
  if [[ "$ALLOW_UNSIGNED" == "1" ]]; then
    log "ATTENTION: verification de signature IGNOREE (--allow-unsigned)."
  else
    if [[ "$MINISIGN_PUBKEY" == RWQPLACEHOLDER* ]]; then
      echo "Cle publique minisign non configuree (voir deploy/PHASE2-UPDATES.md" >&2
      echo "ou passe --minisign-pubkey / CST_MINISIGN_PUBKEY)." >&2
      exit 1
    fi
    log "Verification signature minisign"
    minisign -Vm "$DL/$ASSET" -x "$DL/$ASSET.minisig" -P "$MINISIGN_PUBKEY"
  fi

  # 3) Extraction (l'archive contient cst-server + dist/).
  tar -xzf "$DL/$ASSET" -C "$STAGE"
  BUILT_BIN="$STAGE/cst-server"
  DIST_SRC="$STAGE/dist"
  [[ -f "$BUILT_BIN" ]] || { echo "Archive invalide: cst-server introuvable." >&2; exit 1; }
  [[ -d "$DIST_SRC" ]] || { echo "Archive invalide: dist/ introuvable." >&2; exit 1; }
  chmod 0755 "$BUILT_BIN"
else
  # Mode build (Phase 1) : nouvelle source (push deploy) puis compilation hote.
  if [[ -f "$SOURCE_ARCHIVE" ]]; then
    log "Extraction de la nouvelle source dans $SOURCE_DIR"
    install -d -o cst -g cst "$SOURCE_DIR"
    rm -rf "${SOURCE_DIR:?}"/*
    tar -xzf "$SOURCE_ARCHIVE" -C "$SOURCE_DIR"
    chown -R cst:cst "$SOURCE_DIR"
  fi
  log "Build de la nouvelle release depuis $SOURCE_DIR"
  runuser -u cst -- env \
    HOME=/home/cst \
    PATH=/home/cst/.cargo/bin:/usr/local/bin:/usr/bin:/bin \
    CST_GIT_COMMIT="$CST_GIT_COMMIT" \
    bash -c "cd '$SOURCE_DIR' && cargo +1.88.0 build --manifest-path src-tauri/Cargo.toml --release --bin cst-server"
  BUILT_BIN="$SOURCE_DIR/src-tauri/target/release/cst-server"
  DIST_SRC="$SOURCE_DIR/dist"
fi

# --- Self-check : le binaire repond a --version (commun aux deux modes) ---
VLINE="$("$BUILT_BIN" --version)"
VERSION="$(awk '{print $2}' <<<"$VLINE")"
[[ -n "$VERSION" ]] || { echo "Version illisible via 'cst-server --version'." >&2; exit 1; }
if [[ "$MODE" == "release" && "${RELEASE_TAG#v}" != "$VERSION" ]]; then
  echo "Incoherence: tag $RELEASE_TAG mais binaire en version $VERSION." >&2
  exit 1
fi
log "Nouvelle release : $VLINE"

# --- Installer dans releases/<version> (commun) ---
RELEASE_DIR="$RELEASES_DIR/$VERSION"
install -d -o cst -g cst "$RELEASES_DIR" "$RELEASE_DIR"
install -m 0755 "$BUILT_BIN" "$RELEASE_DIR/cst-server"
rm -rf "$RELEASE_DIR/dist"
cp -a "$DIST_SRC" "$RELEASE_DIR/dist"
chown -R cst:cst "$RELEASE_DIR"

# --- Drain ---
log "Passage du noeud en drain"
curl -fsS --max-time 5 -X POST "$BASE/api/admin/drain" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"draining":true}' >/dev/null || { echo "Drain impossible (serveur injoignable ?)." >&2; exit 1; }

# --- Attente activeTerminals==0 (borne) ---
log "Attente des sessions ouvertes (timeout ${DRAIN_TIMEOUT}s)"
deadline=$(( $(date +%s) + DRAIN_TIMEOUT ))
while :; do
  active="$(hfield "$(healthz)" activeTerminals)"; active="${active:-0}"
  [[ "$active" == "0" ]] && break
  if [[ "$(date +%s)" -ge "$deadline" ]]; then
    if [[ "$FORCE" == "1" ]]; then
      log "Timeout atteint ; --force : on poursuit malgre $active session(s)."
      break
    fi
    log "Timeout : $active session(s) encore actives. Noeud LAISSE EN DRAIN, MAJ abandonnee (sera retentee)."
    exit 3
  fi
  sleep 3
done

# --- Bascule atomique de 'current' ---
log "Bascule current -> releases/$VERSION"
ln -sfnT "releases/$VERSION" "$APP_DIR/current.tmp"
mv -Tf "$APP_DIR/current.tmp" "$CURRENT_LINK"
chown -h cst:cst "$CURRENT_LINK"

# --- Redemarrage (efface aussi le drain, etat en memoire) ---
log "Redemarrage de $SERVICE"
systemctl restart "$SERVICE"

# --- Verification "vraiment revenu" ---
verify() {
  local want="$1" hz ver rdy drn code
  local vdeadline=$(( $(date +%s) + VERIFY_TIMEOUT ))
  while :; do
    hz="$(healthz)"
    ver="$(hfield "$hz" version)"; rdy="$(hfield "$hz" ready)"; drn="$(hfield "$hz" draining)"
    if [[ "$ver" == "$want" && "$rdy" == "true" && "$drn" == "false" ]]; then
      # Sonde d'acceptation : POST /api/terminals avec un compte bidon. Un noeud
      # sain repond 400/500 (compte introuvable) ; un noeud draine repondrait
      # 503, un token invalide 401. On accepte donc tout sauf 503/401/000.
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST "$BASE/api/terminals" \
        -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
        -d '{"accountId":"__cst_update_probe__","repoUrl":"","cols":80,"rows":24}' 2>/dev/null || echo 000)"
      case "$code" in
        503|401|000) : ;;    # pas encore pret / probleme -> on continue d'attendre
        *) return 0 ;;
      esac
    fi
    [[ "$(date +%s)" -ge "$vdeadline" ]] && return 1
    sleep 2
  done
}

if verify "$VERSION"; then
  log "OK : noeud en version $VERSION, pret et non draine."
  exit 0
fi

# --- Rollback ---
log "ECHEC de la verification en $VERSION."
if [[ -n "$PREV_TARGET" && "$PREV_TARGET" != "releases/$VERSION" ]]; then
  PREV_VERSION="${PREV_TARGET##*/}"
  log "Rollback -> $PREV_TARGET"
  ln -sfnT "$PREV_TARGET" "$APP_DIR/current.tmp"
  mv -Tf "$APP_DIR/current.tmp" "$CURRENT_LINK"
  chown -h cst:cst "$CURRENT_LINK"
  systemctl restart "$SERVICE"
  if verify "$PREV_VERSION"; then
    log "Rollback OK : noeud restaure en $PREV_VERSION."
  else
    log "ALERTE : rollback n'a pas restaure un etat sain, intervention manuelle requise."
  fi
else
  log "ALERTE : pas de release precedente pour le rollback."
fi
exit 1
