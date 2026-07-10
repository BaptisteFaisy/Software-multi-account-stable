# Codex Switch Terminal

Terminal Tauri + xterm.js pour lancer Codex avec un `CODEX_HOME` et un proxy par compte.

## Prerequis

- Node.js 20+
- Rust + Cargo via rustup
- Codex CLI disponible dans le `PATH`

## Demarrage

```powershell
npm install
npm run dev
```

Sous Windows, tu peux aussi double-cliquer sur
`Lancer Codex Switch Terminal.cmd`. C'est l'unique lanceur : il affiche un menu
pour ouvrir l'app locale, l'app Cloud, le site web local, demarrer ou arreter le
serveur et configurer le pare-feu.

Depuis PowerShell, une action peut etre lancee directement :

```powershell
& ".\Lancer Codex Switch Terminal.cmd" app
& ".\Lancer Codex Switch Terminal.cmd" cloud
& ".\Lancer Codex Switch Terminal.cmd" web
& ".\Lancer Codex Switch Terminal.cmd" server
& ".\Lancer Codex Switch Terminal.cmd" stop
& ".\Lancer Codex Switch Terminal.cmd" firewall
```

## Fonctionnement

- Les comptes Codex sont des dossiers utilises comme `CODEX_HOME`.
- L'app detecte automatiquement les dossiers `~\.codex*` qui contiennent `auth.json` ou `config.toml`.
- Les profils proxy sont detectes depuis les fichiers `proxy.txt` presents dans `~\.codex*`.
- Le terminal lance un shell avec `CODEX_HOME`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` et leurs variantes minuscules selon le compte selectionne.
- Chaque compte peut avoir un `Dossier projet`; les nouveaux terminaux demarrent directement dans ce dossier pour que Codex prenne ce workspace comme environnement.
- Le bouton `Terminal` cree un nouvel onglet PTY sans fermer les sessions existantes.
- Le bouton `Pool term` ouvre un nouvel onglet PTY en piochant le prochain compte qui possede un `auth.json` valide.
- La vue `Pool` permet d'importer des fichiers JSON de comptes (`*_cpa.json`, exports avec `accounts[].credentials`, dossier de JSON ou wildcard `*.json`).
- Il est aussi possible de coller directement un blob de session ChatGPT (copie de `chatgpt.com/api/auth/session`) dans la zone d'import : le champ `accessToken` est utilise comme jeton d'acces. Sans `refresh_token`, le compte est valide ~10 jours (jusqu'a l'expiration du JWT) et n'est pas renouvelable.
- Les imports creent des `CODEX_HOME` dans `%USERPROFILE%\.codex-pool-*` et ajoutent les comptes a la configuration sans stocker les tokens dans `settings.json`.
- La configuration de l'app est stockee dans `%APPDATA%\codex-switch-terminal\settings.json`.
- Le build Windows utilise un patch local de `tauri-utils` dans `src-tauri/vendor` pour eviter un proc-macro bloque par Windows App Control sur cette machine.

Pour ajouter un nouveau compte Codex, cree un dossier de compte dans l'interface, ouvre un terminal dessus, puis lance :

```powershell
codex login
```

Le login sera enregistre dans le `CODEX_HOME` du compte selectionne.

## Mode SaaS MVP

Le mode SaaS ajoute un serveur Rust/Axum qui sert le frontend web et lance les
terminaux sur une VM distante. En v1, les terminaux tournent directement sur
l'hote sous l'utilisateur du service : a utiliser uniquement pour toi ou des
utilisateurs de confiance.

### Demarrage avec ton PC comme serveur

Au debut, tu peux utiliser ton PC Windows comme serveur. Lance simplement :

```powershell
& ".\Lancer Codex Switch Terminal.cmd" server
```

Le script :

- cree un dossier serveur dans `%APPDATA%\codex-switch-terminal-server`
- genere un token admin local la premiere fois
- build le frontend / serveur si besoin
- demarre `cst-server` sur `0.0.0.0:8080`
- affiche l'URL a ouvrir, par exemple `http://192.168.1.20:8080`

Depuis ton PC ou un autre appareil du meme reseau, ouvre l'URL affichee puis
colle le token admin affiche dans la console.

Pour ouvrir directement le site web dans ton navigateur :

```powershell
& ".\Lancer Codex Switch Terminal.cmd" web
```

Ce lanceur demarre le serveur si besoin, ouvre `http://127.0.0.1:8080`, et
copie le token admin dans le presse-papiers pour que tu puisses le coller dans
l'ecran de connexion. Pour l'arreter :

```powershell
& ".\Lancer Codex Switch Terminal.cmd" stop
```

Si tu veux l'ouvrir depuis un telephone ou un autre PC du meme reseau, utilise
l'URL reseau affichee par le lanceur, par exemple `http://192.168.1.20:8080`.

### Setup PC + Oracle avec choix automatique

Le setup le plus simple est de mettre tes machines dans le meme reseau prive
Tailscale/WireGuard, puis de lancer un `cst-server` sur chaque machine.
L'app ou le site garde Oracle comme serveur principal, mais les nouveaux
terminaux peuvent partir sur ton PC si disponible, sinon sur Oracle.

1. Lance le serveur sur ton PC :

```powershell
& ".\Lancer Codex Switch Terminal.cmd" server
```

Note l'URL Tailscale ou LAN du PC et le token admin. Le script annonce aussi le
nom du noeud et sa capacite.

2. Lance le serveur sur Oracle avec les memes fichiers `dist/` et `cst-server`.
Dans `/etc/codex-switch-terminal.env`, mets au minimum :

```bash
CST_BIND=0.0.0.0:8080
CST_DATA_DIR=/srv/cst
CST_STATIC_DIR=/opt/codex-switch-terminal/dist
CST_PUBLIC_BASE_URL=http://IP_TAILSCALE_ORACLE:8080
CST_ADMIN_TOKEN=le-meme-token-que-le-pc
CST_GIT_PAT=
CST_NODE_ID=oracle-free
CST_NODE_LABEL=Oracle Free
CST_NODE_CAPACITY=1
```

3. Importe les memes comptes Codex sur les deux serveurs, ou copie le meme
`settings.json` et les dossiers `codex-homes/` dans les deux `CST_DATA_DIR`.
Le choix automatique retente un autre noeud si le compte n'existe pas sur le
premier, mais le routage est plus fluide si les comptes sont synchronises.

4. Ouvre l'app Cloud ou le site Oracle. Sur l'ecran de connexion :

```text
Serveur: http://IP_TAILSCALE_ORACLE:8080
Token admin: le-meme-token-que-le-pc
Noeuds terminaux auto:
PC local|http://IP_TAILSCALE_PC:8080||0
Oracle Free|http://IP_TAILSCALE_ORACLE:8080||20
```

Format d'une ligne : `Nom|URL|token optionnel|priorite`. Un token vide reutilise
le token admin principal. Plus la priorite est basse, plus le noeud est prefere.
Au clic sur `Terminal`, l'app appelle `/api/health` sur chaque noeud et choisit
le meilleur score `terminaux actifs / capacite + priorite`.

### Application Android

Un client Android natif est disponible dans `android/`. Il embarque une WebView
qui se connecte au serveur SaaS, garde l'URL et le token admin dans le stockage
local de l'app, puis laisse l'interface web lancer les terminaux via HTTP et
WebSocket.

Pour l'utiliser :

```powershell
& ".\Lancer Codex Switch Terminal.cmd" server
```

Puis ouvre `android/` dans Android Studio, lance l'app sur ton telephone, colle
l'URL reseau affichee par le serveur et le token admin. Les details de build
sont dans `android/README.md`.

Pour verifier depuis l'app desktop connectee au serveur local, lance :

```powershell
& ".\Codex Switch Terminal Cloud.exe"
```

Cette variante force le mode SaaS, pointe par defaut vers
`http://127.0.0.1:8080` et recupere automatiquement le token local dans
`%APPDATA%\codex-switch-terminal-server\server.local.env.ps1`.

Tu peux aussi passer par le lanceur unique :

```powershell
& ".\Lancer Codex Switch Terminal.cmd" cloud
```

Le token et le PAT Git local se trouvent dans :

```text
%APPDATA%\codex-switch-terminal-server\server.local.env.ps1
```

Pour cloner des repos prives, renseigne `CST_GIT_PAT` dans ce fichier puis
relance le serveur.

Si l'URL ne repond pas depuis un autre appareil, autorise le port 8080 dans le
pare-feu Windows :

```powershell
& ".\Lancer Codex Switch Terminal.cmd" firewall
```

Cette etape ouvre uniquement le port TCP 8080 sur le profil reseau prive.

### Build local

```powershell
npm run build:frontend
npm run build:server
```

Le binaire serveur est produit dans :

```text
src-tauri/target/release/cst-server
```

### Variables d'environnement

Copie `deploy/cst-server.env.example` vers `/etc/codex-switch-terminal.env` sur
la VM, puis remplace au minimum :

- `CST_PUBLIC_BASE_URL` par `http://IP_DE_LA_VM:8080`
- `CST_ADMIN_TOKEN` par un token long et aleatoire
- `CST_GIT_PAT` par un token GitHub/GitLab si tu clones des repos prives

Les donnees serveur vivent par defaut dans `/srv/cst` :

- `settings.json`
- `codex-homes/`
- `workspaces/`
- `logs/`

### Lancement manuel

```bash
export CST_ADMIN_TOKEN="change-me"
export CST_GIT_PAT="ghp_xxx"
export CST_PUBLIC_BASE_URL="http://IP_DE_LA_VM:8080"
./cst-server
```

L'interface web est ensuite disponible sur `http://IP_DE_LA_VM:8080`.

### Service systemd

Sur Ubuntu, cree un utilisateur dedie puis installe le service :

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin cst
sudo mkdir -p /opt/codex-switch-terminal /srv/cst
sudo chown -R cst:cst /srv/cst
sudo cp deploy/codex-switch-terminal.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now codex-switch-terminal
```

Le frontend doit etre copie dans `/opt/codex-switch-terminal/dist` et le binaire
`cst-server` dans `/opt/codex-switch-terminal/cst-server`.
