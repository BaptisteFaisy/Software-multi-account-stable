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

- L'interface affiche directement une grille paginee de chats, sans plafond logiciel de chats ouverts.
- La barre laterale affiche tous les environnements simultanement. Chaque environnement regroupe ses terminaux par agent puis ses conversations, et propose ses boutons `+` et fermer ; la fermeture retire l'environnement des appareils sans supprimer son contenu ni son historique, et le rouvrir annule automatiquement cette fermeture. La recherche traverse tous les groupes sans changer d'environnement actif. Une conversation peut etre glissee sur un autre environnement pour y etre deplacee durablement. Reprendre ou rouvrir une discussion restaure son environnement logique et la rattache a la meme room pour retrouver les autres agents de l'environnement.
- Ouvrir un environnement affiche son mur de terminaux associes. L'environnement est l'identite logique partagee du projet ; chaque terminal conserve en parallele son propre `workspaceId` et son chemin de workspace physique isole, visibles dans l'interface. Plusieurs agents peuvent donc travailler dans des workspaces differents sous un meme environnement.
- La vue terminal est cloisonnee par onglets d'environnement : un onglet n'affiche que les terminaux de son environnement. La touche `` ` `` ouvre le menu global des environnements ; le bouton `+` ouvre un autre environnement dans une session visuellement et physiquement separee. Il n'existe plus de mur melangeant plusieurs projets.
- Dans la grille, `Espace` bascule le chat survole en plein ecran. La touche `Retour arriere` situee au-dessus d'Entree ferme uniquement le panneau de chat et conserve sa discussion ; `Suppr` ferme le chat et archive aussi sa discussion. Le maintien de ces touches est ignore pour ne pas agir en cascade sur les panneaux qui se replacent sous la souris.
- Chaque chat conserve independamment sa discussion, son brouillon, son compte, son mode de travail, son suivi temps reel, son tour en cours et sa position de lecture. Tous les chats restent visibles dans la grille, mais seule la conversation selectionnee affiche sa bulle de saisie.
- `Ctrl+N`, le bouton de la barre laterale et le bouton `Nouveau chat` ajoutent une conversation a la fin de la grille sans fermer les autres. La grille affiche au choix 6, 9, 12 ou 16 chats de taille uniforme par page et ouvre automatiquement la page du nouveau chat.
- Le composer de chaque chat permet de choisir le modele et, pour Codex, l'intensite de raisonnement. Les intensites viennent du catalogue du modele (`model/list`) : GPT-5.6 Sol/Terra proposent donc aussi `max` et `ultra`, tandis que Luna propose `max` sans `ultra`. Ces choix sont enregistres comme valeurs du compte et transmis explicitement a chaque nouveau tour, en desktop comme en mode SaaS.
- Les comptes Codex sont des dossiers utilises comme `CODEX_HOME`.
- L'app detecte automatiquement les dossiers `~\.codex*` qui contiennent `auth.json` ou `config.toml`.
- Les profils proxy sont detectes depuis les fichiers `proxy.txt` presents dans `~\.codex*`.
- Le terminal lance un shell avec `CODEX_HOME`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` et leurs variantes minuscules selon le compte selectionne.
- Chaque compte peut conserver un `Environnement projet` informatif, mais aucun terminal ne demarre implicitement dedans : l'environnement doit etre choisi dans le sas de creation.
- Chaque terminal capture son environnement logique obligatoire a la creation. Le frontend, le backend desktop et le serveur refusent tous un demarrage sans environnement explicite. Changer d'onglet ne modifie donc pas les sessions deja ouvertes ni celles qui sont en train de demarrer.
- La barre laterale regroupe les terminaux par environnement logique, jamais par chemin de worktree. Deux entrees qui designent le meme environnement sont fusionnees automatiquement avec tous leurs agents et terminaux. Le bouton `+` d'un groupe cree directement une nouvelle session dans cet environnement, et les associations Environnement/workspace sont restaurees au prochain lancement.
- A la creation d'un compte/environnement, l'interface demande le mode de securite (bypass ou sandbox), le modele Codex par defaut et son intensite de raisonnement. Ces choix sont propres au compte.
- L'app synchronise ces choix dans le `config.toml` du `CODEX_HOME` (`approval_policy`, `sandbox_mode`, `model`, `model_reasoning_effort`), y compris lors du passage du bypass vers la sandbox.
- Les terminaux PTY restent disponibles comme outil separe de la grille de chats.
- Le bouton `Pool term` pioche le prochain compte qui possede un `auth.json` valide, puis exige le choix de l'environnement avant d'ouvrir le nouvel onglet PTY.
- La vue `Pool` permet d'importer des fichiers JSON de comptes (`*_cpa.json`, exports avec `accounts[].credentials`, dossier de JSON ou wildcard `*.json`).
- Il est aussi possible de coller directement un blob de session ChatGPT (copie de `chatgpt.com/api/auth/session`) dans la zone d'import : le champ `accessToken` est utilise comme jeton d'acces. Sans `refresh_token`, le compte est valide ~10 jours (jusqu'a l'expiration du JWT) et n'est pas renouvelable.
- Les imports creent des `CODEX_HOME` dans `%USERPROFILE%\.codex-pool-*` et ajoutent les comptes a la configuration sans stocker les tokens dans `settings.json`.
- La configuration de l'app est stockee dans `%APPDATA%\codex-switch-terminal\settings.json`.
- La vue `Collab` montre la coordination native des agents de l'environnement actif.
- Le build Windows utilise un patch local de `tauri-utils` dans `src-tauri/vendor` pour eviter un proc-macro bloque par Windows App Control sur cette machine.

Pour ajouter un nouveau compte Codex, cree un dossier de compte dans l'interface, ouvre un terminal dessus, puis lance :

```powershell
codex login
```

Le login sera enregistre dans le `CODEX_HOME` du compte selectionne.

## Collaboration native par dossier

Chaque nouveau chat ou terminal rejoint automatiquement la collaboration de son
dossier logique. Il n'existe aucun salon global a activer : les agents du meme
dossier/depot se voient et peuvent echanger, tandis que deux dossiers
differents restent strictement invisibles l'un pour l'autre.

### En bref

```text
  Agent A (terminal 1)                         Agent B (terminal 2)
        |                                              |
        |  send_message("j'ai fini X") [ DOSSIER ]     |  read_messages()
        | -------------------------->  (serveur MCP) ---------------> voit le message
        |                                              |
        |  send_message("verifie Y", to=agentB)  ----------------->  DM prive
```

Chaque processus agent devient automatiquement un participant. Les agents echangent via
des outils, pas en s'injectant du texte dans le terminal : c'est propre et sans
risque de corrompre la saisie.

### Ce que les agents peuvent faire

Chaque agent Codex ou Claude voit automatiquement les outils MCP internes
`workspace_collab` :

- `list_agents` / `whoami` : lister les agents presents / connaitre sa propre
  identite (son `ident` public).
- `send_message(text)` : diffuser un message aux agents du meme dossier.
- `send_message(text, to)` : envoyer un message prive (DM) a un agent precis,
  ou `to` est l'`ident` public renvoye par `list_agents`.
- `read_messages(since)` : lire les messages qui le concernent (diffusions du
  dossier + DM pour lui) posterieurs a un curseur `since`.
- `wait_for_messages(since, timeoutMs)` : comme `read_messages`, mais **bloque**
  jusqu'a l'arrivee d'un nouveau message (pour attendre la reponse d'un autre
  agent sans interroger en boucle).

Les outils sont disponibles, mais c'est le modele qui decide de les utiliser :
une consigne du type « coordonne-toi avec l'autre agent du dossier » suffit a
les declencher.

### La vue Collab

La vue `Collab` affiche uniquement le dossier actif :

- la liste des agents presents (a gauche) ;
- le fil d'activite : diffusions, DM, et messages systeme (arrivees/departs) ;
- un composer pour poster toi-meme, en tant qu'`Operateur`, un message au dossier
  ou un DM a un agent choisi dans le menu deroulant. Les agents peuvent te
  repondre en DM (tu es l'`ident` reserve `operator`).

Le bouton `Activite live`, visible directement dans la barre du dossier et
dans le selecteur de dossiers des chats, ouvre une representation graphique
actualisee chaque seconde : agents actifs, task board, merge queue, derniers
merges integres et flux recent de messages.

### Sous le capot

- L'app lance un petit **serveur MCP en HTTP**, en local uniquement
  (`http://127.0.0.1:8123/mcp` par defaut ; en mode SaaS il tourne dans
  `cst-server`). Tous les agents s'y connectent.
- A l'ouverture d'un agent, l'app ajoute `workspace_collab` uniquement dans son
  home isole ephemere. Le home canonique du compte n'est pas modifie.
- Chaque terminal recoit un **jeton unique** (`CST_ROOM_TOKEN`) injecte dans son
  environnement : c'est ce qui permet au serveur de distinguer deux agents, meme
  quand ils partagent un meme `CODEX_HOME`.
- Les messages portent un `CST_ROOM_ID` opaque derive du dossier et sont
  filtres cote serveur avant toute remise a un agent ou a l'operateur.

### Securite et reversibilite

- Le serveur ecoute **uniquement sur `127.0.0.1`** (jamais expose au reseau) et
  un jeton inconnu est refuse (`401`).
- Garde-fous integres : limite de debit par agent, taille de message bornee, et
  anti-boucle (un message identique consecutif du meme emetteur n'est pas rejoue).
- Le provisioning appelle le CLI du provider dans le home isole : s'il echoue,
  le chat demarre quand meme et l'erreur est journalisee.

### En mode SaaS

La collaboration fonctionne aussi cote serveur : elle est montee dans `cst-server`
(endpoint `/mcp` + API `/api/room/status`, `/api/room/messages`,
`/api/room/send`). Les agents lances par le serveur le rejoignent en local, et
la vue `Collab` de l'interface web fonctionne a l'identique.

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
- demarre `cst-server` en local sur `127.0.0.1:8080` (aucune fenetre pare-feu)
- affiche l'URL locale a ouvrir : `http://127.0.0.1:8080`

Par defaut le serveur n'ecoute qu'en local, donc aucune fenetre "Pare-feu
Windows". Pour l'ouvrir aux autres appareils du meme reseau (telephone, autre
PC, noeud Oracle), definis `CST_BIND` avant le lanceur :

```powershell
$env:CST_BIND = "0.0.0.0:8080"
& ".\Lancer Codex Switch Terminal.cmd" server
```

La fenetre pare-feu n'apparait alors qu'une seule fois (ou lance une bonne fois
`scripts/allow-local-server-firewall.ps1` en admin), et le lanceur affiche
l'URL reseau, par exemple `http://192.168.1.20:8080`. Ouvre l'URL affichee puis
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

Par defaut le serveur n'ecoute qu'en local (`127.0.0.1`), donc aucune fenetre
pare-feu. Pour l'ouvrir depuis un telephone ou un autre PC du meme reseau,
definis `CST_BIND=0.0.0.0:8080` avant de lancer le serveur : le lanceur affiche
alors l'URL reseau, par exemple `http://192.168.1.20:8080`.

### Setup PC + Oracle avec choix automatique

Le setup le plus simple est de mettre tes machines dans le meme reseau prive
Tailscale/WireGuard, puis de lancer un `cst-server` sur chaque machine.
L'app ou le site garde Oracle comme serveur principal, mais les nouveaux
terminaux peuvent partir sur ton PC si disponible, sinon sur Oracle.

1. Lance le serveur sur ton PC en l'exposant au reseau prive (sinon il n'ecoute
qu'en local) :

```powershell
$env:CST_BIND = "0.0.0.0:8080"
& ".\Lancer Codex Switch Terminal.cmd" server
```

Note l'URL Tailscale ou LAN du PC et le token admin. La premiere fois, accepte
la fenetre pare-feu (ou lance une bonne fois `scripts/allow-local-server-firewall.ps1`
en admin). Le script annonce aussi le nom du noeud et sa capacite.

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

### Application iPhone / iPad

Un client natif iOS/iPadOS est disponible dans `ios/`. Comme le client Android,
il utilise une `WKWebView` pour afficher l'interface du serveur, garde l'URL sur
l'appareil et conserve le token admin dans le trousseau iOS. L'interface mobile
gere les encoches, la barre d'accueil, le clavier logiciel et les rotations.

La compilation et la signature Apple doivent etre effectuees sur un Mac avec
Xcode. Ouvre `ios/CodexTerminal.xcodeproj`, choisis ton equipe dans **Signing &
Capabilities**, puis lance l'application sur l'iPhone/iPad. Sur macOS, le build
du simulateur peut aussi etre verifie avec :

```bash
bash scripts/build-ios.sh simulator
```

Le guide d'installation sur appareil et de creation d'une archive TestFlight est
dans `ios/README.md`.

#### Sans posseder de Mac : utilisation sur iPad et build distant

L'interface peut maintenant etre installee directement depuis Safari comme une
web app plein ecran : ouvre l'URL HTTPS du serveur, touche **Partager**, puis
**Sur l'ecran d'accueil** et active **Ouvrir comme app web**. Aucun compte Apple
Developer n'est necessaire pour cette version.

Le workflow GitHub Actions **iOS - Build distant** permet aussi de lancer depuis
un iPad une vraie compilation Xcode sur un runner macOS. Il produit un artefact
de simulateur non installable sur un appareil physique, mais valide le projet
natif. Le parcours complet est explique dans `ios/IPAD-SANS-MAC.md`.

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

## Execution multi-agents isolee (sans plafond logiciel)

Chaque terminal et chaque tour de chat recoit desormais :

- un worktree Git detache propre (ou une copie physique pour un dossier non-Git) ;
- un `CODEX_HOME` / `CLAUDE_CONFIG_DIR` propre ;
- `CST_AGENT_ID`, `CST_WORKSPACE_ID`, `CST_ROOM_ID` et `CST_BASE_SHA` ;
- les conventions `AGENTS.md` et `CLAUDE.md` dans son home isole ;
- les outils MCP internes de collaboration pour les messages, le task board et la merge queue.

`CST_WORKSPACE_ID` identifie le checkout physique unique de l'agent, tandis que
`CST_ROOM_ID` identifie le dossier logique. Deux chats ouverts sur le meme
dossier/depot recoivent automatiquement la meme collaboration. Des dossiers differents
ne peuvent ni se voir, ni s'envoyer de broadcast/DM, ni partager leurs taches ou
leurs statuts de merge. En SaaS, cette collaboration est toujours active pour les
chats et terminaux lances par le serveur.

En SaaS, un seul miroir bare est maintenu par URL de depot et les agents ne
font plus chacun un clone complet. Les chemins runtime se trouvent sous
`<CST_DATA_DIR>/agents/` (`mirrors`, `workspaces`, `agent-homes`, `recoveries`).
Les transcripts sont recopies dans le home canonique a la fin du process ; les
configs temporaires ne le sont jamais.

Workflow agent recommande :

1. `claim_task({ taskId, description })` ;
2. travailler et committer dans le worktree courant ;
3. `submit_for_merge({ verify: true|false })` ;
4. suivre `merge_status({ id })` et `list_landed()` ;
5. en cas de conflit, rebaser depuis la nouvelle base annoncee dans le dossier et
   resoumettre.

La file est FIFO avec un seul worker. Elle rejoue les commits sur la tete
courante, lance eventuellement le verify, puis effectue un CAS sur la ref cible.
Le journal durable de merge est separe de `messages.jsonl`. Pour un miroir SaaS,
le land met a jour la branche du miroir local ; le push/deploiement distant reste
une etape explicite. Pour un checkout local dont `main` est actuellement ouvert,
le fast-forward n'est accepte que si le checkout est propre.

Variables utiles :

- `CST_MAX_AGENTS` : `0`, absent ou `unlimited` = admission sans plafond
  logiciel (comportement par defaut). Une valeur positive reactive un cap dur ;
- `CST_NODE_CAPACITY` : indice de capacite utilise par le routage SaaS, sans
  refuser la creation de nouveaux agents ;
- `CST_MERGE_VERIFY_COMMAND` : commande executee dans le worktree d'integration
  lorsque la soumission demande `verify: true`.

Des verrous d'ownership OS garantissent qu'un seul processus ecrit un store
`agent-room`/merge donne et qu'un seul processus admet/nettoie les worktrees
d'un runtime agents. Les autres instances sont passives ou refusees au demarrage
et doivent passer par l'endpoint REST/MCP du processus proprietaire. Le journal de collaboration est
segmente a 16 Mio, garde huit segments et borne son index memoire a 20 000
messages. Le sweeper ne supprime jamais un lease dont le PID proprietaire est
encore vivant ; apres crash, commits et home sont conserves dans les recoveries.

## Plan cible : datacenter elastique sans plafond fixe

> **Statut : architecture cible, non encore implementee integralement.**
> L'execution locale et la merge queue FIFO decrites dans la section precedente
> restent le comportement actuel pendant la migration.

Dans ce plan, « nombre infini d'agents » signifie qu'aucun plafond n'est code
dans l'application et que de nouveaux noeuds peuvent etre ajoutes
horizontalement. La limite effective devient celle des CPU, GPU, du reseau, du
stockage, des fournisseurs de modeles et du parallelisme reel de la tache.

L'objectif principal n'est pas de garder le plus grand nombre possible d'agents
occupes. Il est de minimiser le temps total jusqu'a un resultat valide : un agent
supplementaire n'est active que s'il raccourcit le chemin critique, produit une
alternative utile ou retire un goulet d'etranglement.

```text
Demande utilisateur
        |
        v
Decomposition recursive en graphe de taches
        |
        v
Ordonnanceurs distribues par ressource
        |
        +--> pools elastiques d'agents
        +--> tests et validations paralleles
        +--> propositions pour les zones deja reservees
        |
        v
Arbre de fusion des patches compatibles
        |
        v
Mise a jour Git finale, courte et atomique
```

### Principes invariants

- Un Dossier reste l'identite logique du projet, mais ne constitue jamais une
  partition technique unique. Ses taches et evenements sont repartis par
  sous-graphe, ressource et symbole afin d'eviter un point chaud central.
- Le nombre d'agents connectes n'a pas de plafond applicatif. Le nombre d'agents
  actifs est limite dynamiquement au parallelisme utile disponible.
- La coherence forte est reservee aux operations qui l'exigent : attribution
  exclusive d'une ressource, fencing token et mise a jour de la branche cible.
  La presence, la telemetrie et les vues agregees peuvent etre eventuellement
  coherentes pour ne pas ralentir le travail.
- Les agents ne communiquent jamais en diffusion generale `N x N`. Chaque agent
  s'abonne uniquement aux taches, ressources et dependances qui le concernent.
- Toutes les commandes sont idempotentes : un retry apres panne ne doit jamais
  creer deux claims, deux patches ou deux integrations.

### Controle distribue et partitionnable

L'application Tauri et les clients web deviennent des clients du control plane,
pas les proprietaires uniques de son etat. Le control plane cible comprend :

- un journal d'evenements durable partitionne par Dossier, tache et ressource ;
- un stockage transactionnel pour les taches, leases, dependances et commits ;
- des coordinateurs courts et locaux a une ressource, jamais un chef global ;
- des files de travail partitionnees et du work stealing entre pools ;
- du backpressure, de la pagination et des curseurs par consommateur ;
- des adaptateurs mono-noeud pour le desktop et distribues pour le datacenter.

Un Dossier tres actif doit pouvoir utiliser plusieurs partitions. Une branche
Git cible conserve un point de linearisation final, mais cette operation reste
petite ; la planification, la production des patches, les rebases, la compilation
et les tests avancent en parallele avant ce point.

### Graphe de taches et decomposition recursive

Un objectif est transforme en DAG de taches. Plusieurs planificateurs peuvent
decomposer en parallele des sous-arbres differents afin qu'un planificateur
unique ne devienne pas lui-meme la limite du systeme.

Chaque tache declare au minimum :

- ses entrees et livrables ;
- les fichiers lus et modifies ;
- les symboles ou blocs logiques concernes ;
- son SHA et les hashes de contenu de depart ;
- ses dependances, sa priorite et son cout estime ;
- les capacites requises : modele, outils, CPU, GPU, memoire et tests.

L'ordonnanceur privilegie le chemin critique, les taches qui debloquent le plus
de dependances, la localite des donnees et des caches, puis le risque historique
de conflit. Les pools sous-utilises volent des taches compatibles aux pools
satures. Le nombre de workers est ajuste en continu selon la largeur du DAG,
les ressources disponibles et les limites autorisees des fournisseurs.

```text
agents actifs = min(
  taches pretes et non conflictuelles,
  capacite calcul et memoire,
  capacite d'inference,
  capacite de test et d'integration,
  limites reseau et stockage
)
```

### Reservations distribuees et application obligatoire

Une tache d'ecriture obtient un lease sur un fichier, un symbole ou un bloc
stable. Les numeros de lignes seuls ne sont pas suffisants, car ils changent
apres chaque patch. Pour les langages pris en charge, la cle de ressource utilise
le chemin, le symbole AST et le hash du blob de depart.

Chaque lease possede une expiration, un heartbeat et un fencing token monotone.
Si un agent disparait, sa ressource est liberee automatiquement. S'il revient
apres l'expiration, son ancien token ne peut plus autoriser une integration.

`submit_for_merge` recalcule le diff reel et le compare aux reservations :

- un patch conforme poursuit son integration ;
- une modification hors perimetre est refusee ou demande une extension ;
- une base obsolete declenche une resynchronisation ou un nouveau calcul ;
- un lease expire ou un fencing token ancien est toujours refuse.

Le respect des regles ne depend donc plus uniquement du comportement du modele :
la frontiere d'integration les applique de facon deterministe.

### Ordonnancement oriente latence

Le mode datacenter privilegie la vitesse finale. Les taches critiques ou dont la
duree est tres variable peuvent etre executees speculativement par plusieurs
agents. Le premier resultat valide est conserve et les autres executions sont
annulees. Cette duplication est adaptative et reservee aux endroits ou elle
reduit statistiquement le chemin critique.

Les agents supplementaires peuvent aussi etre affectes a la recherche, aux
tests, a la revue, a la generation d'alternatives ou a la verification de
proprietes. Ils ne deviennent pas automatiquement des ecrivains concurrents.

### Fichiers chauds et modifications concurrentes

Lorsqu'un grand nombre de taches cible le meme fichier, le systeme active un
mode « fichier chaud » :

- analyse AST et decoupage par fonctions, classes, methodes, objets ou cles ;
- ecrivains paralleles uniquement sur des symboles independants ;
- proprietaire unique pour un symbole partage ou un fichier monolithique ;
- agents secondaires produisant des propositions, tests et revues ;
- retour automatique au mode proprietaire si le taux de conflit augmente.

Si plusieurs agents doivent modifier exactement les memes instructions dans le
meme ordre, cette partie du travail est causalement sequentielle. La strategie
la plus rapide est alors un ecrivain, eventuellement aide de plusieurs agents
qui explorent des solutions concurrentes, puis une selection rapide du meilleur
resultat. Lancer tous les agents comme ecrivains ne peut pas accelerer ce cas.

### Graphe de conflits et arbre de fusion

La FIFO unique est remplacee par un graphe de conflits. Les patches sans arete
commune sont prepares, rebases et testes en parallele. Ils sont ensuite combines
par reduction hierarchique :

```text
patches independants
   |-- lot A --\
   |-- lot B ---+--> combinaison intermediaire --\
   |-- lot C ---+                                  +--> CAS Git final
   |-- lot D --/                                   /
   `-- composants conflictuels --> integrateur ---'
```

Pour `N` patches independants, la profondeur cible de combinaison est
`O(log N)` plutot que `O(N)`. Les composants connectes du graphe de conflits
sont traites par un integrateur specialise. Les tests affectes sont executes en
parallele et caches par contenu ; une suite plus large valide les lots finaux.
Un lot en echec peut etre divise automatiquement pour isoler le patch fautif.

### Workspaces et execution a tres grande echelle

Un worktree complet et un terminal graphique par agent consommeraient trop de
disque et de memoire. Le data plane cible utilise :

- des snapshots immuables et adresses par contenu ;
- des couches copy-on-write et des checkouts partiels ;
- des caches Git, dependances et compilation partages mais des sorties isolees ;
- des workers headless prechauffes, crees et arretes elastiquement ;
- des pools d'inference repartis selon le modele et la capacite GPU ;
- des patches delta comme livrables, plutot que des copies completes du depot.

Les terminaux deviennent une vue d'observabilite materialisee a la demande.
L'interface pagine et virtualise les agents, taches et sorties ; elle n'essaie
jamais d'afficher simultanement tous les processus du datacenter.

### Communication, stockage et observabilite

Les messages libres restent possibles, mais la coordination courante passe par
des evenements structures : tache prete, lease obtenu, patch soumis, test passe,
base avancee ou agent indisponible. Les abonnements cibles evitent les tempetes
de broadcast et maintiennent un cout de controle global proche de `O(N)`.

La telemetrie doit mesurer au minimum :

- largeur du DAG et longueur du chemin critique ;
- temps d'attente, d'execution, de validation et de fusion ;
- taux de conflits evites et tardifs ;
- travail annule ou duplique ;
- taux de reutilisation des caches ;
- CPU, GPU, RAM, disque, reseau et cout d'inference par tache ;
- saturation et repartition de chaque partition.

Ces mesures alimentent automatiquement les decisions d'autoscaling, de
speculation, de placement et de passage en mode fichier chaud.

### Tolerance aux pannes

- Les agents sont sans etat durable local indispensable et peuvent etre
  remplaces sur un autre noeud.
- Les leases expirent et les fencing tokens neutralisent les travailleurs
  retardataires.
- Les evenements sont livres au moins une fois, avec consommateurs idempotents.
- Les retries utilisent un backoff et la cancellation se propage dans tout le
  sous-graphe devenu inutile.
- Une panne de partition, de pool ou de zone ne bloque pas les sous-graphes
  independants.
- La branche finale reste deterministe et aucun commit accepte ne peut etre
  perdu lors d'un failover.

### Phases d'implementation

1. Construire un benchmark reproductible pour 1, 10, 100 puis 1 000 agents
   simules : fichiers distincts, symboles distincts et memes lignes.
2. Etendre le task board avec ressources, leases, heartbeats, fencing tokens et
   validation obligatoire du diff, d'abord dans le runtime mono-noeud.
3. Ajouter le DAG, le chemin critique, l'ordonnanceur adaptatif et le work
   stealing local.
4. Implementer le mode fichier chaud et le decoupage semantique conservateur,
   avec repli vers un proprietaire unique.
5. Remplacer la FIFO par le graphe de conflits, l'arbre de fusion, les tests
   affectes et les caches de contenu.
6. Introduire les snapshots copy-on-write, sparse checkouts et workers headless.
7. Extraire le control plane et brancher le stockage, les evenements et les
   files distribues tout en conservant un adaptateur desktop embarque.
8. Ajouter les pools prechauffes, l'autoscaling, le placement par localite et
   l'execution speculative sur le chemin critique.
9. Executer des tests de charge et de chaos a 100, 1 000, 10 000 agents simules,
   puis augmenter le nombre de partitions et de noeuds sans modifier le
   protocole applicatif.

### Criteres de reussite

- aucun plafond applicatif sur le nombre total d'agents ;
- aucune mutex, file ou partition globale partagee par tous les Dossiers ;
- aucune collision entre deux leases d'ecriture incompatibles ;
- aucun patch accepte avec un fencing token obsolete ;
- trafic de controle `O(N)` et fusion `O(log N)` pour les patches independants ;
- memoire, historique et buffers bornes par partition et consommateur ;
- reprise automatique d'un agent ou noeud mort sans perte de commit ;
- resultat Git deterministe et tests finaux valides ;
- debit augmentant avec l'ajout de noeuds jusqu'a saturation du parallelisme
  utile, et non jusqu'a une limite artificielle de l'application.

Ce plan retire donc la cible fixe de 100 agents. Il permet une montee en charge
horizontale continue, tout en respectant la limite fondamentale suivante : le
nombre d'agents utiles sur une zone de code ne peut jamais depasser le nombre de
travaux reellement independants, sauf lorsque la duplication speculative reduit
le temps d'attente d'un resultat critique.
