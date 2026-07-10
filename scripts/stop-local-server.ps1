$ErrorActionPreference = "Stop"

$DataDir = Join-Path $env:APPDATA "codex-switch-terminal-server"
$PidFile = Join-Path $DataDir "server.pid"

if (Test-Path $PidFile) {
  $pidValue = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pidValue) {
    Stop-Process -Id ([int]$pidValue) -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Get-Process cst-server -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*codex-switch-terminal*" } |
  Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "Serveur local arrete." -ForegroundColor Green
