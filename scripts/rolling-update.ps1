param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$')]
  [string]$OracleSshTarget,
  [string]$OracleIdentityFile = "",
  [string]$OracleUrl = "",
  [int]$Port = 8080,
  [string]$TaskName = "Codex Switch Terminal Node",
  [int]$DrainTimeoutSec = 300,
  [switch]$SkipOracle,
  [switch]$SkipPc
)

# Mise a jour ROLLING de la flotte : Oracle d'abord (draine, bascule, verifie,
# rollback si besoin), puis SEULEMENT s'il est sain, le PC. On ne met jamais les
# deux hors service en meme temps : la capacite du tailnet ne tombe jamais a 0.
# deploy-oracle-node.ps1 et update-node.ps1 gerent chacun leur propre
# drain/verif/rollback ; ce script ne fait qu'orchestrer l'ordre.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $SkipOracle) {
  Write-Host "== Etape 1/2 : mise a jour Oracle ==" -ForegroundColor Cyan
  try {
    $deployArgs = @{ SshTarget = $OracleSshTarget }
    if ($OracleIdentityFile) { $deployArgs.IdentityFile = $OracleIdentityFile }
    if ($OracleUrl) { $deployArgs.OracleUrl = $OracleUrl }
    & (Join-Path $ScriptDir "deploy-oracle-node.ps1") @deployArgs
    if ($LASTEXITCODE -ne 0) { throw "deploy-oracle-node.ps1 a renvoye le code $LASTEXITCODE." }
  } catch {
    throw "Mise a jour Oracle en echec: $($_.Exception.Message). On N'ENCHAINE PAS sur le PC (capacite preservee)."
  }
  Write-Host "Oracle a jour et verifie." -ForegroundColor Green
} else {
  Write-Host "Oracle: ignore (-SkipOracle)." -ForegroundColor DarkGray
}

if (-not $SkipPc) {
  Write-Host "== Etape 2/2 : mise a jour du noeud PC ==" -ForegroundColor Cyan
  try {
    & (Join-Path $ScriptDir "update-node.ps1") -Port $Port -TaskName $TaskName -DrainTimeoutSec $DrainTimeoutSec
    if ($LASTEXITCODE -ne 0) { throw "update-node.ps1 a renvoye le code $LASTEXITCODE." }
  } catch {
    throw "Mise a jour du noeud PC en echec: $($_.Exception.Message)."
  }
  Write-Host "Noeud PC a jour et verifie." -ForegroundColor Green
} else {
  Write-Host "PC: ignore (-SkipPc)." -ForegroundColor DarkGray
}

Write-Host "Rolling update terminee." -ForegroundColor Green
