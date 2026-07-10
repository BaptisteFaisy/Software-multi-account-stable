# Auto-update desktop — comment ça marche & comment l'activer

Ce document explique **quand** l'app se met à jour toute seule, **ce qui le
déclenche**, et **comment la rendre 100 % automatique (sans clic)**.

> Complément opérationnel (clés, secrets, CI) : `deploy/PHASE2-UPDATES.md`.

---

## 1. Le flux en un coup d'œil

```
  Lancement de l'app desktop (Codex Switch Terminal)
          │
          ▼
  boot() ─► void initDesktopUpdater()          ← src/main.ts
          │
          ▼
  Pas dans la webview Tauri ? (mode navigateur/remote) ──► ne fait RIEN
          │  (oui, on est bien dans l'app desktop)
          ▼
  check()                                        ← @tauri-apps/plugin-updater
          │   GET https://github.com/<repo>/releases/latest/download/latest.json
          │   compare la version installée à la version publiée
          │
          ├── aucune nouvelle version ───────────────────────► rien à faire
          │
          ▼  une version plus récente existe
  [ confirmation ]  window.confirm(...)          ← option : à retirer pour du 100 % auto
          │  l'utilisateur accepte
          ▼
  update.downloadAndInstall()
          │   • télécharge l'installeur (NSIS/MSI) depuis la Release
          │   • VÉRIFIE la signature Ed25519 avec la clé publique
          │     (tauri.conf.json > plugins.updater.pubkey)  ← refuse si invalide
          │   • installe
          ▼
  relaunch()                                     ← @tauri-apps/plugin-process
          │
          ▼
  L'app redémarre sur la nouvelle version. ✅
```

**Ce qui est automatique dès aujourd'hui :** la **vérification** se lance
**à chaque démarrage** de l'app, sans aucune action de ta part.
**Ce qui demande un clic (pour l'instant) :** l'**installation**, via une boîte
de confirmation. Voir §4 pour l'enlever.

---

## 2. Les pièces (déjà en place)

| Pièce | Où | Rôle |
|---|---|---|
| Vérification au boot | `src/main.ts` → `initDesktopUpdater()` | déclenche le check à chaque lancement |
| Logique updater | `src/updater.ts` | `check()` → `downloadAndInstall()` → `relaunch()` |
| Plugins runtime | `src-tauri/src/lib.rs` | `.plugin(updater)` + `.plugin(process)` |
| Dépendances | `Cargo.toml` / `package.json` | `tauri-plugin-updater/process` (Rust + JS) |
| Permissions | `capabilities/default.json` | `updater:default`, `process:default` |
| Clé publique + endpoint | `tauri.conf.json` → `plugins.updater` | vérifie la signature + où chercher `latest.json` |
| Artefacts signés + `latest.json` | CI `.github/workflows/release.yml` | produits à chaque tag `v*` |
| Clé privée de signature | *GitHub Actions secret* `TAURI_SIGNING_PRIVATE_KEY` | signe l'installeur en CI |

---

## 3. Comment « rendre l'auto-update actif » (checklist)

L'auto-update ne peut fonctionner que s'il existe une **Release publiée** contenant
un `latest.json` signé. Étapes :

1. **Committer la registration `lib.rs`** (les 2 lignes `.plugin(...)`).
   Elles sont dans le working tree et compilent ; il faut juste qu'elles entrent
   dans un commit (elles partiront avec le prochain commit de l'agent Discussions,
   ou je peux les committer dès que l'arbre est propre).
   > Sans ça, l'installeur produit par la CI **n'activera pas** l'updater au runtime.

2. **Bumper la version aux 3 endroits** (identiques, = tag sans `v`) :
   - `src-tauri/Cargo.toml` → `version = "0.1.1"`
   - `src-tauri/tauri.conf.json` → `"version": "0.1.1"`
   - `package.json` → `"version": "0.1.1"`

3. **Tagger + pousser** :
   ```bash
   git commit -am "release: v0.1.1"
   git tag v0.1.1
   git push origin feat/agent-room --tags
   ```

4. La CI compile, **signe** l'installeur, génère `latest.json`, et **publie** la
   Release (le track serveur/minisign est optionnel : la release desktop se publie
   sans lui).

5. **C'est tout.** Toute app installée en version ≤ 0.1.0 verra la 0.1.1 **au
   prochain lancement**.

> ⚠️ Il faut que la Release soit **publiée** (pas *draft*) et **non *prerelease*** :
> l'endpoint `releases/latest/download/latest.json` ne pointe que sur la « latest »
> publiée. La CI s'en charge (`publish-release`).

---

## 4. Rendre l'installation 100 % automatique (sans clic)

Aujourd'hui `src/updater.ts` **demande confirmation** avant d'installer
(`window.confirm`). Pour installer **silencieusement**, remplace le corps de
`initDesktopUpdater()` par :

```ts
export async function initDesktopUpdater(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    const update = await check();
    if (!update) return;
    // Plus de confirmation : on télécharge, installe et redémarre directement.
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    console.error("[updater] échec de la mise à jour :", err);
  }
}
```

Variantes utiles :

- **Prévenir sans bloquer** (petit toast, install au prochain lancement) : appelle
  `check()` mais n'appelle `downloadAndInstall()` que si l'utilisateur clique un
  bouton « Mettre à jour » que tu ajoutes dans l'UI.
- **Re-vérifier périodiquement** (app longtemps ouverte) — en plus du boot :
  ```ts
  setInterval(() => { void initDesktopUpdater(); }, 6 * 60 * 60 * 1000); // toutes les 6 h
  ```
- **Barre de progression** : `downloadAndInstall((event) => { /* event.event: Started|Progress|Finished */ })`.

> ⚠️ Sur Windows, l'installeur **NSIS** gère l'install silencieuse + relance nativement.
> C'est le format recommandé pour l'auto-update (déjà couvert par `targets: "all"`).

---

## 5. Vérifier que ça marche (test bout-en-bout)

1. Installe l'app en **0.1.0** (l'installeur de la release précédente).
2. Publie la **0.1.1** (étape §3).
3. **Relance** l'app 0.1.0 → elle doit détecter la 0.1.1 (pop-up, ou install
   silencieuse si tu as appliqué §4), puis redémarrer en 0.1.1.
4. Vérifie la version : menu/à-propos, ou `--version` du serveur si tu testes ce côté.

---

## 6. Dépannage

| Symptôme | Cause probable | Fix |
|---|---|---|
| L'app ne détecte jamais de MAJ | Release en *draft* / *prerelease* | Publier la release (non-draft, non-prerelease) |
| `latest.json` en 404 | Pas encore de release publiée, ou mauvais `endpoints` | Vérifier l'URL dans `tauri.conf.json` + qu'une release est publiée |
| « signature verification failed » | `pubkey` ≠ clé qui a signé en CI | La `pubkey` de `tauri.conf.json` doit correspondre au secret `TAURI_SIGNING_PRIVATE_KEY` |
| CI : pas de `.sig` / `latest.json` | `createUpdaterArtifacts` absent ou secret manquant | Vérifier `bundle.createUpdaterArtifacts: true` + secrets Tauri |
| L'updater ne fait rien en local | Normal : `__TAURI_INTERNALS__` absent hors app desktop | Tester sur l'app installée, pas dans le navigateur |
| MAJ détectée mais pas installée | L'utilisateur a refusé la confirmation | Voir §4 pour l'install silencieuse |

---

## 7. Sécurité (pourquoi c'est sûr)

- L'installeur est **signé Ed25519** en CI avec une clé privée qui ne quitte
  jamais les *GitHub secrets*.
- Le plugin updater **vérifie cette signature** avec la **clé publique** embarquée
  dans `tauri.conf.json` **avant** d'installer quoi que ce soit. Un binaire
  altéré ou non signé par ta clé est **refusé**.
- `latest.json` seul ne suffit pas à pousser une mise à jour : sans signature
  valide, l'install échoue. Compromettre la release ne suffit donc pas — il
  faudrait aussi la clé privée.

---

## 8. Résumé

- **Le check est déjà automatique** à chaque lancement.
- Pour l'**activer réellement** : committer les 2 lignes `lib.rs`, puis tagger une
  version (§3).
- Pour le rendre **sans clic** : retirer le `window.confirm` (§4).
- **Signature vérifiée** à chaque install → sûr par construction.
