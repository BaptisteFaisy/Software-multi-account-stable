param(
  [int]$Port = 8080
)

# Demarreur LEGER du noeud Windows, lance par la tache planifiee. Ne build PAS :
# il lance la release active via la jonction 'current' (voir update-node.ps1).
# Separer "demarrer" de "builder/mettre a jour" permet la bascule atomique :
# la tache pointe toujours vers current\cst-server.exe, seule la cible de la
# jonction change.

$ErrorActionPreference = "Stop"

$DataDir = Join-Path $env:APPDATA "codex-switch-terminal-server"
$EnvFile = Join-Path $DataDir "server.local.env.ps1"
$NodeHome = Join-Path $env:LOCALAPPDATA "codex-switch-terminal-node"
$CurrentExe = Join-Path $NodeHome "current\cst-server.exe"
$CurrentDist = Join-Path $NodeHome "current\dist"

if (Test-Path $EnvFile) { . $EnvFile }
if (-not $env:CST_ADMIN_TOKEN) { throw "CST_ADMIN_TOKEN absent de $EnvFile." }

$env:CST_DATA_DIR = $DataDir
$env:CST_STATIC_DIR = $CurrentDist
if (-not $env:CST_BIND) { $env:CST_BIND = "127.0.0.1:$Port" }

if (-not (Test-Path $CurrentExe)) {
  throw "Release active introuvable: $CurrentExe (lance d'abord update-node.ps1)."
}

& $CurrentExe
