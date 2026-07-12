<#
.SYNOPSIS
  Construit l'APK Android (coque WebView) de Codex Switch Terminal.

.DESCRIPTION
  Detecte le JDK fourni par Android Studio (jbr) et le SDK Android, puis lance
  le wrapper Gradle du dossier android/. Copie l'APK produit a la racine du repo
  et sur le Bureau.

.PARAMETER Release
  Construit un APK release (non signe) au lieu du debug. Par defaut : debug
  (signe automatiquement avec la cle debug, donc installable directement).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-android-apk.ps1
#>
param(
  [switch]$Release
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$AndroidDir = Join-Path $Root "android"

# --- JDK (fourni par Android Studio) ---
$JbrCandidates = @(
  "C:\Program Files\Android\Android Studio\jbr",
  "C:\Program Files\Android\Android Studio1\jbr",
  (Join-Path $env:LOCALAPPDATA "Programs\Android Studio\jbr")
)
$Jbr = $JbrCandidates | Where-Object { Test-Path (Join-Path $_ "bin\java.exe") } | Select-Object -First 1
if (-not $Jbr) {
  if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
    $Jbr = $env:JAVA_HOME
  } else {
    throw "JDK introuvable. Installe Android Studio (fournit un JDK dans jbr) ou definis JAVA_HOME."
  }
}

# --- SDK Android ---
$Sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME }
       elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT }
       else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
if (-not (Test-Path $Sdk)) {
  throw "SDK Android introuvable ($Sdk). Installe-le via Android Studio ou definis ANDROID_HOME."
}

$env:JAVA_HOME = $Jbr
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk

Write-Host "JDK  : $Jbr"       -ForegroundColor Cyan
Write-Host "SDK  : $Sdk"       -ForegroundColor Cyan
Write-Host "Proj : $AndroidDir" -ForegroundColor Cyan

$Task = if ($Release) { "assembleRelease" } else { "assembleDebug" }

Push-Location $AndroidDir
try {
  & (Join-Path $AndroidDir "gradlew.bat") $Task --console=plain
  if ($LASTEXITCODE -ne 0) { throw "Echec du build Gradle ($Task)." }
}
finally {
  Pop-Location
}

$Variant = if ($Release) { "release" } else { "debug" }
$ApkName = if ($Release) { "app-release-unsigned.apk" } else { "app-debug.apk" }
$ApkPath = Join-Path $AndroidDir "app\build\outputs\apk\$Variant\$ApkName"
if (-not (Test-Path $ApkPath)) {
  # Fallback : premier APK trouve dans le dossier de sortie.
  $ApkPath = Get-ChildItem -Path (Join-Path $AndroidDir "app\build\outputs\apk\$Variant") -Filter *.apk -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ApkPath -or -not (Test-Path $ApkPath)) {
  throw "APK introuvable apres le build."
}

$Dest1 = Join-Path $Root "CodexTerminal-$Variant.apk"
$Dest2 = Join-Path ([Environment]::GetFolderPath("Desktop")) "CodexTerminal-$Variant.apk"
Copy-Item $ApkPath $Dest1 -Force
Copy-Item $ApkPath $Dest2 -Force

Write-Host ""
Write-Host "APK genere :" -ForegroundColor Green
Write-Host "  $ApkPath"
Write-Host "  -> $Dest1"
Write-Host "  -> $Dest2"
Write-Host ""
Write-Host "Installer par USB (debogage USB active sur le tel) :" -ForegroundColor Yellow
Write-Host "  `"$Sdk\platform-tools\adb.exe`" install -r `"$Dest1`""
