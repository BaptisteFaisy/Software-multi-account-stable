import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Vérifie une mise à jour au démarrage de l'app DESKTOP (no-op en mode
// navigateur/remote). La signature Ed25519 est vérifiée par le plugin avant
// installation (clé publique : tauri.conf.json > plugins.updater.pubkey).
export async function initDesktopUpdater(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return; // pas dans la webview Tauri
  try {
    const update = await check();
    if (!update) return;
    const ok = window.confirm(
      `Mise à jour ${update.version} disponible (actuelle ${update.currentVersion}).\n\n` +
        `${update.body ?? ""}\n\nInstaller maintenant ? L'application redémarrera.`,
    );
    if (!ok) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    console.error("[updater] échec de la vérification/installation :", err);
  }
}
