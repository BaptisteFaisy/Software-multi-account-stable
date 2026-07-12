# Codex Terminal — coque Android (WebView)

Application Android minimale qui affiche l'interface web de **Codex Switch
Terminal** servie par `cst-server` (via Tailscale, en HTTPS tailnet). C'est une
coque : toute la logique vit dans le web (xterm.js + le SPA). L'app fournit
juste une WebView plein écran, la persistance de session, et le pont
`window.CstAndroid` attendu par `src/platform.ts`.

## Ce que fait l'app

- Charge par défaut `https://pc-fixe-cst.tail3a8bdf.ts.net` (modifiable :
  `res/values/strings.xml` → `server_url`).
- Active JavaScript + DOM storage (le **token** saisi une fois est conservé),
  cookies, WebSocket `wss://` (flux terminal).
- Clavier virtuel : `adjustResize` + `interactive-widget` → le terminal reste
  visible pendant la frappe.
- Bouton **Retour** = revenir dans l'historique de la WebView.
- Pont natif `CstAndroid` (`getBaseUrl` / `getToken` / `setConfig` /
  `openSettings`) adossé aux `SharedPreferences`. Le token **n'est pas** embarqué
  dans l'APK : l'écran de connexion web le demande une fois.

## Prérequis (déjà présents sur ce poste)

- **Android SDK** : `%LOCALAPPDATA%\Android\Sdk` (build-tools 36.1.0, platform
  android-36, platform-tools).
- **JDK 21** : fourni par Android Studio (`…\Android Studio\jbr`).
- **Gradle 8.9** : le *wrapper* (`gradlew`) est déjà généré dans ce dossier.

## Construire l'APK

Le plus simple, depuis la racine du repo :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-android-apk.ps1
```

Le script règle `JAVA_HOME`/`ANDROID_HOME`, lance `gradlew assembleDebug`, et
copie l'APK à la racine du repo **et** sur le Bureau
(`CodexTerminal-debug.apk`).

À la main :

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
cd android
./gradlew.bat assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

## Installer sur le téléphone

**Option A — transfert de fichier (le plus simple)**
1. Copie `CodexTerminal-debug.apk` sur le téléphone (câble, Drive, etc.).
2. Ouvre-le depuis le gestionnaire de fichiers ; autorise « installer des
   applis inconnues » pour cette source si demandé.

**Option B — ADB (débogage USB activé)**
```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r CodexTerminal-debug.apk
```

## Première utilisation

1. Assure-toi que **Tailscale est actif** sur le téléphone (même hors du réseau
   du PC : 4G + Tailscale suffit).
2. Ouvre **Codex Terminal**. L'écran de connexion s'affiche, l'URL du serveur
   est pré-remplie.
3. Colle le **token admin** → *Se connecter*. Il est mémorisé pour les fois
   suivantes.

## Notes

- **APK debug** : signé avec la clé de debug d'Android, donc installable
  directement (pas destiné au Play Store). Pour une version signée de
  distribution, générer une keystore (`keytool`) et un build `assembleRelease`.
- **`applicationId`** en debug : `com.codexswitch.terminal.debug` (suffixe
  `.debug`), il peut donc cohabiter avec une future version release
  `com.codexswitch.terminal`.
- **HTTPS uniquement** (`usesCleartextTraffic=false`). Le certificat `*.ts.net`
  de Tailscale est reconnu par Android (chaîne Let's Encrypt), aucune config
  réseau supplémentaire n'est nécessaire.
