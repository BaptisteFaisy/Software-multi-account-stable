# Lance la version STABLE du serveur cst-server sur le port 8081.
#
# Objectif : faire tourner la STABLE (8081) EN MEME TEMPS que la beta (8080) tout
# en PARTAGEANT les comptes.
#   - CST_ACCOUNTS_DIR = dossier PARTAGE (= le dossier de donnees de la beta) :
#     settings.json + codex-homes/<compte>/auth.json y sont lus/ecrits par les 2
#     versions => memes comptes des deux cotes.
#   - CST_DATA_DIR = dossier RUNTIME ISOLE propre a la stable (agents/, workspaces/,
#     agent-room/, logs/, devices.json...) => aucun conflit de verrou
#     (agents/.owner.lock) avec la beta, les 2 serveurs demarrent ensemble.
#
# La beta reste 100% inchangee : elle continue via scripts/start-local-server.ps1
# (CST_DATA_DIR = dossier partage, port 8080, CST_ACCOUNTS_DIR non defini).

param(
  [switch]$Build
)

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root       = Split-Path -Parent $ScriptDir
$SharedDir  = Join-Path $env:APPDATA "codex-switch-terminal-server"        # comptes partages (= dossier de la beta)
$RuntimeDir = Join-Path $env:APPDATA "codex-switch-terminal-server-8081"   # runtime isole de la stable
$EnvFile    = Join-Path $RuntimeDir "server.local.env.ps1"
$StaticDir  = Join-Path $Root "dist"
$ServerExe  = Join-Path $Root "src-tauri\target\release\cst-server.exe"

function Test-TreeNewerThan {
  param(
    [string[]]$Paths,
    [datetime]$Timestamp
  )

  foreach ($path in $Paths) {
    if (-not (Test-Path $path)) {
      continue
    }

    $item = Get-Item $path
    if (-not $item.PSIsContainer) {
      if ($item.LastWriteTimeUtc -gt $Timestamp.ToUniversalTime()) {
        return $true
      }
      continue
    }

    $newer = Get-ChildItem -Path $path -Recurse -File |
      Where-Object { $_.LastWriteTimeUtc -gt $Timestamp.ToUniversalTime() } |
      Select-Object -First 1
    if ($newer) {
      return $true
    }
  }

  return $false
}

function Test-NeedsBuild {
  param(
    [string]$Output,
    [string[]]$Inputs
  )

  if (-not (Test-Path $Output)) {
    return $true
  }

  $outputTime = (Get-Item $Output).LastWriteTimeUtc
  return Test-TreeNewerThan -Paths $Inputs -Timestamp $outputTime
}

# Dossiers de comptes PARTAGES (crees s'ils manquent, ne touchent pas au contenu).
New-Item -ItemType Directory -Force -Path $SharedDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $SharedDir "codex-homes") | Out-Null

# Dossiers RUNTIME isoles de la stable.
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeDir "workspaces") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeDir "logs") | Out-Null

# Token admin propre a la stable (persiste, distinct de celui de la beta).
if (-not (Test-Path $EnvFile)) {
  $chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".ToCharArray()
  $token = -join (1..56 | ForEach-Object { $chars | Get-Random })
  @"
`$env:CST_ADMIN_TOKEN = "$token"
`$env:CST_GIT_PAT = ""
"@ | Set-Content -Path $EnvFile -Encoding UTF8
}

. $EnvFile

$env:CST_ACCOUNTS_DIR    = $SharedDir
$env:CST_DATA_DIR        = $RuntimeDir
$env:CST_BIND            = if ($env:CST_BIND) { $env:CST_BIND } else { "127.0.0.1:8081" }
$bindPort = ($env:CST_BIND -split ":")[-1]
if (-not $bindPort) { $bindPort = "8081" }
$env:CST_STATIC_DIR      = $StaticDir
if (-not $env:CST_PUBLIC_BASE_URL) { $env:CST_PUBLIC_BASE_URL = "http://127.0.0.1:$bindPort" }
if (-not $env:CST_ALLOWED_ORIGINS) { $env:CST_ALLOWED_ORIGINS = $env:CST_PUBLIC_BASE_URL }
$env:CST_NODE_ID         = if ($env:CST_NODE_ID) { $env:CST_NODE_ID } else { "pc-local-8081" }
$env:CST_NODE_LABEL      = if ($env:CST_NODE_LABEL) { $env:CST_NODE_LABEL } else { "PC local (stable 8081)" }
$env:CST_NODE_CAPACITY   = if ($env:CST_NODE_CAPACITY) { $env:CST_NODE_CAPACITY } else { [Math]::Max(1, [Environment]::ProcessorCount - 1).ToString() }

Push-Location $Root
try {
  $frontendOutput = Join-Path $StaticDir "index.html"
  $frontendInputs = @(
    (Join-Path $Root "src"),
    (Join-Path $Root "index.html"),
    (Join-Path $Root "package.json"),
    (Join-Path $Root "package-lock.json"),
    (Join-Path $Root "tsconfig.json"),
    (Join-Path $Root "vite.config.ts")
  )
  if ($Build -or (Test-NeedsBuild -Output $frontendOutput -Inputs $frontendInputs)) {
    npm run build:frontend
  }

  $serverInputs = @(
    (Join-Path $Root "src-tauri\src"),
    (Join-Path $Root "src-tauri\Cargo.toml"),
    (Join-Path $Root "src-tauri\Cargo.lock")
  )
  if ($Build -or (Test-NeedsBuild -Output $ServerExe -Inputs $serverInputs)) {
    npm run build:server
  }

  Write-Host ""
  Write-Host "Codex Switch Terminal - STABLE (port 8081, comptes partages)" -ForegroundColor Cyan
  Write-Host "Interface web : $env:CST_PUBLIC_BASE_URL"
  Write-Host "Token admin   : $env:CST_ADMIN_TOKEN"
  Write-Host "Comptes       : $env:CST_ACCOUNTS_DIR (PARTAGE avec la beta 8080)"
  Write-Host "Runtime       : $env:CST_DATA_DIR (isole)"
  Write-Host "Noeud         : $env:CST_NODE_LABEL (capacite $env:CST_NODE_CAPACITY)"
  Write-Host "Config token  : $EnvFile"
  Write-Host ""
  Write-Host "Serveur local (127.0.0.1) : la beta (8080) et la stable (8081) partagent les comptes." -ForegroundColor Green
  Write-Host ""

  & $ServerExe
}
finally {
  Pop-Location
}
