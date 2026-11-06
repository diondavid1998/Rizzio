#!/usr/bin/env bash
# Builds Rizzio and uploads it to TestFlight in one go. Run on your Mac from the ios/ folder:
#
#   ASC_KEY_ID=ABC123XYZ ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
#   ASC_KEY_PATH=~/.appstoreconnect/AuthKey_ABC123XYZ.p8 \
#   ./scripts/testflight.sh
#
# The three ASC_* values come from App Store Connect → Users and Access → Integrations → App Store Connect API
# (create a key with the "App Manager" role, download the .p8 once, keep it out of git).
# Each run uses a new build number (the current date and time), so you can upload as often as you like.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${ASC_KEY_ID:?Set ASC_KEY_ID (App Store Connect API key ID)}"
: "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID (App Store Connect issuer ID)}"
: "${ASC_KEY_PATH:?Set ASC_KEY_PATH (path to the AuthKey_XXXX.p8 file)}"
ASC_KEY_PATH="${ASC_KEY_PATH/#\~/$HOME}"

if grep -q "CHANGE_ME" project.yml; then
  echo "Edit project.yml first: replace com.CHANGE_ME with your bundle prefix and set DEVELOPMENT_TEAM." >&2
  exit 1
fi

command -v xcodegen >/dev/null || { echo "Installing XcodeGen…"; brew install xcodegen; }
xcodegen

BUILD_NUMBER="$(date +%Y%m%d%H%M)"
ARCHIVE="build/Rizzio.xcarchive"
rm -rf build
mkdir -p build

AUTH=(-allowProvisioningUpdates
      -authenticationKeyPath "$ASC_KEY_PATH"
      -authenticationKeyID "$ASC_KEY_ID"
      -authenticationKeyIssuerID "$ASC_ISSUER_ID")

echo "Archiving build $BUILD_NUMBER…"
xcodebuild archive \
  -project Rizzio.xcodeproj \
  -scheme Rizzio \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  "${AUTH[@]}"

cat > build/ExportOptions.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

echo "Uploading to App Store Connect…"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist build/ExportOptions.plist \
  -exportPath build/export \
  "${AUTH[@]}"

echo "Done. Build $BUILD_NUMBER is processing; it shows up in TestFlight in about 5–15 minutes."
