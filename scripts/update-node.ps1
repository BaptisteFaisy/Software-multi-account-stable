param(
  [int]$Port = 8080,
  [string]$TaskName = "Codex Switch Terminal Node",
  [int]$DrainTimeoutSec = 300,
  [int]$VerifyTimeoutSec = 60,
  [switch]$Force,
  [switch]$SkipBuild,
  # --- Mode release (Phase 2 : artefacts CI signes) ---
  [string]$ReleaseTag = "",
  [string]$Repo = "BaptisteFaisy/Software-multi-account",
  [string]$Asset = "cst-server-windows-x86_64.zip",
  [string]$MinisignPubKey = "",
  [switch]$AllowUnsigned
)

# Mise a jour SURE d'un noeud Windows.
#
# DEUX modes pour peupler releases\<v> :
#   - build   (defaut)       : compile sur l'hote (ou -SkipBuild pour reutiliser
#                              un binaire deja compile).
#   - release (-ReleaseTag)  : TELECHARGE l'artefact signe de la GitHub Release,
#                              verifie SHA-256 + signature minisign (fail-closed),
#                              puis l'installe.
#
# Sequence commune ensuite : self-check `--version` -> installe dans
# releases\<version> -> drain -> attente activeTerminals==0 (borne) -> stop
# tache (l'exe est verrouille tant qu'il tourne) -> bascule de la jonction
# 'current' -> (re)demarrage tache -> verification "vraiment revenu" -> rollback
# de la jonction si echec.
#
# Layout : %LOCALAPPDATA%\codex-switch-terminal-node\releases\<v>\{cst-server.exe,dist}
#          + jonction 'current'. Donnees separees dans %APPDATA%\codex-switch-terminal-server.

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$IsReleaseMode = [bool]$ReleaseTag

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$DataDir = Join-Path $env:APPDATA "codex-switch-terminal-server"
$EnvFile = Join-Path $DataDir "server.local.env.ps1"
$NodeHome = Join-Path $env:LOCALAPPDATA "codex-switch-terminal-node"
$ReleasesDir = Join-Path $NodeHome "releases"
$CurrentLink = Join-Path $NodeHome "current"
$StartNode = Join-Path $ScriptDir "start-node.ps1"

if (-not (Test-Path $EnvFile)) { throw "Config introuvable: $EnvFile (lance setup-pc-node.ps1 d'abord)." }
. $EnvFile
if (-not $env:CST_ADMIN_TOKEN) { throw "CST_ADMIN_TOKEN absent de $EnvFile." }

$base = "http://127.0.0.1:$Port"
$authHeaders = @{ Authorization = "Bearer $env:CST_ADMIN_TOKEN" }

function Get-Healthz {
  try { return Invoke-RestMethod -Uri "$base/healthz" -TimeoutSec 3 } catch { return $null }
}

function Set-Junction {
  param([string]$Link, [string]$Target)
  # rmdir sur une jonction retire UNIQUEMENT le point de reparse (jamais la
  # cible), contrairement a Remove-Item qui peut suivre le lien. mklink /J ne
  # requiert pas de droits admin ni le Developer Mode.
  if (Test-Path $Link) { & cmd /c rmdir "$Link" | Out-Null }
  & cmd /c mklink /J "$Link" "$Target" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "mklink /J a echoue: $Link -> $Target" }
}

function Register-NodeTask {
  $userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $powershell = Join-Path $PSHOME "powershell.exe"
  $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartNode`" -Port $Port"
  $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description "Noeud Codex Switch Terminal (release active via 'current')" -Force | Out-Null
}

function Test-NodeBack {
  param([string]$Want)
  $deadline = (Get-Date).AddSeconds($VerifyTimeoutSec)
  while ($true) {
    $h = Get-Healthz
    if ($h -and $h.version -eq $Want -and $h.ready -eq $true -and $h.draining -eq $false) {
      # Sonde d'acceptation : compte bidon -> 400/500 sur un noeud sain, 503 si
      # draine, 401 si token invalide. On accepte tout sauf 503/401/echec.
      $code = 0
      try {
        Invoke-WebRequest -Uri "$base/api/terminals" -Method Post -Headers $authHeaders `
          -ContentType "application/json" -TimeoutSec 8 -UseBasicParsing `
          -Body '{"accountId":"__cst_update_probe__","repoUrl":"","cols":80,"rows":24}' | Out-Null
        $code = 200
      } catch {
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode.value__ }
      }
      if ($code -ne 503 -and $code -ne 401 -and $code -ne 0) { return $true }
    }
    if ((Get-Date) -ge $deadline) { return $false }
    Start-Sleep -Seconds 2
  }
}

# --- 1. Peupler la release : mode build OU mode release (download + verif) ---
$distSrc = $null
$builtExe = $null

if ($IsReleaseMode) {
  if (-not $MinisignPubKey) { $MinisignPubKey = $env:CST_MINISIGN_PUBKEY }
  $dl = Join-Path ([System.IO.Path]::GetTempPath()) ("cst-dl-" + [System.IO.Path]::GetRandomFileName())
  $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("cst-stage-" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Force -Path $dl, $stage | Out-Null

  $baseUrl = "https://github.com/$Repo/releases/download/$ReleaseTag"
  $zipPath = Join-Path $dl $Asset
  Write-Host "Telechargement de $Asset depuis $Repo@$ReleaseTag" -ForegroundColor Cyan
  foreach ($suffix in @("", ".sha256", ".minisig")) {
    Invoke-WebRequest -Uri "$baseUrl/$Asset$suffix" -OutFile "$zipPath$suffix" -UseBasicParsing -TimeoutSec 180
  }

  # 1a. Empreinte SHA-256 (fail-closed). Le .sha256 contient "<hash>  <basename>".
  $expected = (((Get-Content "$zipPath.sha256" -TotalCount 1) -split '\s+')[0]).Trim().ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
  if ($expected -ne $actual) { throw "SHA-256 invalide: attendu $expected, obtenu $actual." }
  Write-Host "SHA-256 verifiee." -ForegroundColor Green

  # 1b. Signature minisign (fail-closed sauf -AllowUnsigned explicite).
  if ($AllowUnsigned) {
    Write-Warning "Verification de signature IGNOREE (-AllowUnsigned)."
  } else {
    if (-not $MinisignPubKey -or $MinisignPubKey -like "RWQPLACEHOLDER*") {
      throw "Cle publique minisign non configuree (-MinisignPubKey / CST_MINISIGN_PUBKEY ; voir deploy/PHASE2-UPDATES.md)."
    }
    if (-not (Get-Command minisign -ErrorAction SilentlyContinue)) {
      throw "minisign introuvable sur le PATH (installe-le, ou -AllowUnsigned). Voir deploy/PHASE2-UPDATES.md."
    }
    & minisign -Vm $zipPath -x "$zipPath.minisig" -P $MinisignPubKey
    if ($LASTEXITCODE -ne 0) { throw "Signature minisign INVALIDE pour $Asset." }
    Write-Host "Signature minisign verifiee." -ForegroundColor Green
  }

  # 1c. Extraction (l'archive contient cst-server.exe + dist\).
  Expand-Archive -Path $zipPath -DestinationPath $stage -Force
  $builtExe = Join-Path $stage "cst-server.exe"
  $distSrc = Join-Path $stage "dist"
  if (-not (Test-Path $builtExe)) { throw "Archive invalide: cst-server.exe introuvable." }
  if (-not (Test-Path $distSrc)) { throw "Archive invalide: dist\ introuvable." }
} else {
  if (-not $SkipBuild) {
    Push-Location $Root
    try {
      $rev = & git -C $Root rev-parse --short HEAD 2>$null
      if ($LASTEXITCODE -eq 0 -and $rev) { $env:CST_GIT_COMMIT = ([string]$rev).Trim() }
      npm run build:frontend; if ($LASTEXITCODE -ne 0) { throw "Le build frontend a echoue." }
      npm run build:server;   if ($LASTEXITCODE -ne 0) { throw "Le build serveur a echoue." }
    } finally { Pop-Location }
  }
  $builtExe = Join-Path $Root "src-tauri\target\release\cst-server.exe"
  if (-not (Test-Path $builtExe)) { throw "Binaire introuvable: $builtExe (retire -SkipBuild ?)." }
  $distSrc = Join-Path $Root "dist"
}

# --- 2. Self-check version ---
$verLine = & $builtExe --version
$version = ($verLine -split '\s+')[1]
if (-not $version) { throw "Version illisible via 'cst-server --version'." }
if ($IsReleaseMode -and ($ReleaseTag.TrimStart('v') -ne $version)) {
  throw "Incoherence: tag $ReleaseTag mais binaire en version $version."
}
Write-Host "Nouvelle release : $verLine" -ForegroundColor Cyan

# Release active actuelle (cible du rollback).
$prevTarget = $null
if (Test-Path $CurrentLink) {
  $item = Get-Item $CurrentLink -Force
  if ($item.Target) { $prevTarget = [string](@($item.Target)[0]) }
}

# --- 3. Installer la release ---
$releaseDir = Join-Path $ReleasesDir $version
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
Copy-Item $builtExe (Join-Path $releaseDir "cst-server.exe") -Force
$releaseDist = Join-Path $releaseDir "dist"
if (Test-Path $releaseDist) { Remove-Item $releaseDist -Recurse -Force }
Copy-Item $distSrc $releaseDist -Recurse -Force

# --- 4. Drain (si un noeud tourne deja) ---
$running = $null -ne (Get-Healthz)
if ($running) {
  Write-Host "Passage du noeud en drain..." -ForegroundColor Yellow
  Invoke-RestMethod -Uri "$base/api/admin/drain" -Method Post -Headers $authHeaders `
    -ContentType "application/json" -Body '{"draining":true}' -TimeoutSec 5 | Out-Null

  # --- 5. Attente activeTerminals==0 ---
  $deadline = (Get-Date).AddSeconds($DrainTimeoutSec)
  while ($true) {
    $h = Get-Healthz
    $active = if ($h) { [int]$h.activeTerminals } else { 0 }
    if ($active -eq 0) { break }
    if ((Get-Date) -ge $deadline) {
      if ($Force) { Write-Warning "Timeout, -Force : on poursuit malgre $active session(s)."; break }
      throw "Timeout: $active session(s) actives. Noeud laisse EN DRAIN, MAJ abandonnee (retente plus tard)."
    }
    Start-Sleep -Seconds 3
  }
}

# --- 6. Stop tache (l'exe est verrouille tant que le process tourne) ---
$taskExists = [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
if ($taskExists) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

# --- 7. Bascule de la jonction 'current' ---
Write-Host "Bascule current -> releases\$version" -ForegroundColor Cyan
Set-Junction -Link $CurrentLink -Target $releaseDir

# --- 8. (Re)creer + demarrer la tache ---
Register-NodeTask
Start-ScheduledTask -TaskName $TaskName

# --- 9. Verification ---
if (Test-NodeBack -Want $version) {
  Write-Host "OK : noeud en version $version, pret et non draine." -ForegroundColor Green
  exit 0
}

# --- 10. Rollback ---
Write-Warning "ECHEC de la verification en $version."
if ($prevTarget -and (Test-Path $prevTarget) -and ($prevTarget -ne $releaseDir)) {
  $prevVersion = Split-Path $prevTarget -Leaf
  Write-Host "Rollback -> $prevTarget" -ForegroundColor Yellow
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Set-Junction -Link $CurrentLink -Target $prevTarget
  Start-ScheduledTask -TaskName $TaskName
  if (Test-NodeBack -Want $prevVersion) {
    Write-Host "Rollback OK : noeud restaure en $prevVersion." -ForegroundColor Green
  } else {
    Write-Error "ALERTE : le rollback n'a pas restaure un etat sain, intervention manuelle requise."
  }
} else {
  Write-Error "ALERTE : pas de release precedente valide pour le rollback."
}
exit 1
