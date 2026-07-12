<#
.SYNOPSIS
  Matrice d'authentification du cst-server : verifie que TOUTES les routes
  sensibles sont fermees sans credential valide, et ouvertes avec.

.DESCRIPTION
  A lancer contre le serveur de test isole (port 8081) AVANT toute bascule sur
  le noeud live. Couvre le correctif "pool fail-closed" :
    - /admin/status, /v1/models, POST /v1/chat/completions -> 401 sans token
    - memes routes -> autorisees (pas 401) avec le token
    - /api/health -> 401 sans token, 200 avec
    - /healthz -> 200 (liveness publique, jamais authentifiee)

  Sort avec le code 1 si une seule assertion echoue (utilisable en CI / gate).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/auth-smoke.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/auth-smoke.ps1 -BaseUrl http://127.0.0.1:8081 -Token test-8081
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = "http://127.0.0.1:8081",
  [string]$Token   = "test-8081"
)

$ErrorActionPreference = "Stop"
$BaseUrl = $BaseUrl.TrimEnd("/")
$failures = 0

function Get-Status {
  param([string]$Method, [string]$Path, [string]$Bearer)
  $args = @("-s", "-o", "NUL", "-w", "%{http_code}", "--max-time", "10", "-X", $Method)
  if ($Bearer) { $args += @("-H", "Authorization: Bearer $Bearer") }
  if ($Method -eq "POST") {
    $args += @("-H", "Content-Type: application/json",
               "-d", '{"model":"gpt-5.5","messages":[{"role":"user","content":"ping"}]}')
  }
  $args += "$BaseUrl$Path"
  return (& curl.exe @args)
}

# nom, methode, path, token?, predicat sur le code, description attendue
$checks = @(
  @{ n = "healthz public";              m = "GET";  p = "/healthz";              tok = $false; ok = { param($c) $c -eq "200" };            exp = "200" },
  @{ n = "admin/status sans token";     m = "GET";  p = "/admin/status";         tok = $false; ok = { param($c) $c -eq "401" };            exp = "401" },
  @{ n = "v1/models sans token";        m = "GET";  p = "/v1/models";            tok = $false; ok = { param($c) $c -eq "401" };            exp = "401" },
  @{ n = "chat/completions sans token"; m = "POST"; p = "/v1/chat/completions";  tok = $false; ok = { param($c) $c -eq "401" };            exp = "401" },
  @{ n = "admin/status avec token";     m = "GET";  p = "/admin/status";         tok = $true;  ok = { param($c) $c -eq "200" };            exp = "200" },
  @{ n = "v1/models avec token";        m = "GET";  p = "/v1/models";            tok = $true;  ok = { param($c) $c -eq "200" };            exp = "200" },
  @{ n = "chat/completions avec token"; m = "POST"; p = "/v1/chat/completions";  tok = $true;  ok = { param($c) $c -ne "401" };            exp = "!= 401 (200/503 selon comptes)" },
  @{ n = "api/health sans token";       m = "GET";  p = "/api/health";           tok = $false; ok = { param($c) $c -eq "401" };            exp = "401" },
  @{ n = "api/health avec token";       m = "GET";  p = "/api/health";           tok = $true;  ok = { param($c) $c -eq "200" };            exp = "200" }
)

Write-Host "Matrice d'auth cst-server -> $BaseUrl" -ForegroundColor Cyan
foreach ($c in $checks) {
  $bearer = if ($c.tok) { $Token } else { $null }
  $code = Get-Status -Method $c.m -Path $c.p -Bearer $bearer
  $pass = & $c.ok $code
  if ($pass) {
    Write-Host ("  [PASS] {0,-32} -> {1} (attendu {2})" -f $c.n, $code, $c.exp) -ForegroundColor Green
  } else {
    Write-Host ("  [FAIL] {0,-32} -> {1} (attendu {2})" -f $c.n, $code, $c.exp) -ForegroundColor Red
    $failures++
  }
}

if ($failures -eq 0) {
  Write-Host "OK : toutes les routes sensibles sont fermees sans token." -ForegroundColor Green
  exit 0
} else {
  Write-Host "ECHEC : $failures assertion(s) en echec." -ForegroundColor Red
  exit 1
}
