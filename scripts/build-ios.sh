#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/ios/CodexTerminal.xcodeproj"
SCHEME="CodexTerminal"
DERIVED_DATA="$ROOT_DIR/ios/build/DerivedData"
MODE="${1:-simulator}"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "Erreur: xcodebuild est requis. Lance ce script sur un Mac avec Xcode installe." >&2
  exit 1
fi

case "$MODE" in
  simulator)
    xcodebuild \
      -project "$PROJECT" \
      -scheme "$SCHEME" \
      -configuration Debug \
      -destination "generic/platform=iOS Simulator" \
      -derivedDataPath "$DERIVED_DATA" \
      CODE_SIGNING_ALLOWED=NO \
      build
    ;;
  archive)
    : "${DEVELOPMENT_TEAM:?Definis DEVELOPMENT_TEAM avec le code de ton equipe Apple.}"
    BUNDLE_ID="${PRODUCT_BUNDLE_IDENTIFIER:-com.codexswitch.terminal}"
    xcodebuild \
      -project "$PROJECT" \
      -scheme "$SCHEME" \
      -configuration Release \
      -destination "generic/platform=iOS" \
      -archivePath "$ROOT_DIR/ios/build/CodexTerminal.xcarchive" \
      DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
      PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
      -allowProvisioningUpdates \
      archive
    ;;
  *)
    echo "Usage: bash scripts/build-ios.sh [simulator|archive]" >&2
    exit 2
    ;;
esac
