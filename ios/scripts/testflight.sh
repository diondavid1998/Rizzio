#!/usr/bin/env bash
# Builds Rizzio and uploads it to TestFlight in one go. Run on your Mac from the ios/ folder:
#
#   ASC_KEY_ID=ABC123XYZ ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
#   ASC_KEY_PATH=~/.appstoreconnect/AuthKey_ABC123XYZ.p8 \
#   ./scripts/testflight.sh
#
# The three ASC_* values come from App Store Connect → Users and Access → Integrations → App Store Connect API
# (the key needs the Admin role, or App Manager with "Access to Cloud Managed Distribution Certificate", so it can sign; the key StreamScout uses works if it has that). Download the .p8 once and keep it out of git.
# Each run uses a new build number (the current date and time), so you can upload as often as you like.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${ASC_KEY_ID:?Set ASC_KEY_ID (App Store Connect API key ID)}"
: "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID (App Store Connect issuer ID)}"
: "${ASC_KEY_PATH:?Set ASC_KEY_PATH (path to the AuthKey_XXXX.p8 file)}"
ASC_KEY_PATH="${ASC_KEY_PATH/#\~/$HOME}"

# Check the API key before spending 10 minutes on a build. Prints only pass/fail, never the key.
echo "Checking App Store Connect API key…"
ok=1
[[ "$ASC_KEY_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo "  ✗ ASC_KEY_ID should be 10 capital letters/digits (e.g. 2X9R4HM3KD). Got ${#ASC_KEY_ID} characters."; ok=0; }
[[ "$ASC_ISSUER_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "  ✗ ASC_ISSUER_ID should look like 69a6de7e-1234-47e3-e053-5b8c7c11a4d1. Got ${#ASC_ISSUER_ID} characters."; ok=0; }
if [ ! -s "$ASC_KEY_PATH" ]; then
  echo "  ✗ The .p8 key is empty or missing."; ok=0
elif ! grep -q "BEGIN PRIVATE KEY" "$ASC_KEY_PATH"; then
  echo "  ✗ The .p8 key doesn't start with -----BEGIN PRIVATE KEY-----. Copy the whole file contents."; ok=0
elif ! openssl pkey -in "$ASC_KEY_PATH" -noout 2>/dev/null; then
  echo "  ✗ The .p8 key is damaged (line breaks lost or text cut off). Re-copy it with: pbcopy < AuthKey_XXXX.p8"; ok=0
fi
[ "$ok" = 1 ] || exit 1
echo "  ✓ Key ID, Issuer ID and .p8 look valid."
python3 scripts/asc_auth_check.py "$ASC_KEY_ID" "$ASC_ISSUER_ID" "$ASC_KEY_PATH"

if grep -q "CHANGE_ME" project.yml; then
  echo "Edit project.yml first: replace com.CHANGE_ME with your bundle prefix and set DEVELOPMENT_TEAM." >&2
  exit 1
fi

command -v xcodegen >/dev/null || { echo "Installing XcodeGen…"; brew install xcodegen; }

BUILD_NUMBER="$(date +%Y%m%d%H%M)"
ARCHIVE="build/Rizzio.xcarchive"
SIGNING="build/signing"
KEYCHAIN="$PWD/build/rizzio-ci.keychain-db"
rm -rf build
mkdir -p build

# 1. Make a temporary distribution certificate + App Store profiles through Apple's API.
#    Always clean them up afterwards, even if something fails.
cleanup() {
  echo "Cleaning up signing…"
  python3 scripts/asc_signing.py cleanup "$SIGNING" || true
  security delete-keychain "$KEYCHAIN" 2>/dev/null || true
  [ -f build/project.yml.orig ] && cp build/project.yml.orig project.yml || true
}
trap cleanup EXIT

echo "Preparing signing…"
python3 scripts/asc_signing.py setup "$SIGNING"
read_state() { python3 -c "import json,sys; s=json.load(open('$SIGNING/state.json')); print(eval(sys.argv[1]))" "$1"; }
P12_PASSWORD="$(read_state 's["p12Password"]')"
APP_PROFILE="$(read_state 's["profiles"]["app"]["name"]')"
KB_PROFILE="$(read_state 's["profiles"]["keyboard"]["name"]')"

# 2. Put the certificate in a throwaway keychain and install the profiles where Xcode looks.
security create-keychain -p "" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "" "$KEYCHAIN"
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
security import "$SIGNING/cert.p12" -k "$KEYCHAIN" -P "$P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KEYCHAIN" >/dev/null
for dir in "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
  mkdir -p "$dir"
  for role in app keyboard; do
    uuid="$(read_state "s['profiles']['$role']['uuid']")"
    cp "$SIGNING/$role.mobileprovision" "$dir/$uuid.mobileprovision"
  done
done

# 3. Sign manually with those profiles (CI only; project.yml is restored afterwards).
cp project.yml build/project.yml.orig
python3 - "$APP_PROFILE" "$KB_PROFILE" <<'PY'
import sys
app_profile, kb_profile = sys.argv[1], sys.argv[2]
text = open("project.yml").read()
def manual(profile):
    return ("        CODE_SIGN_STYLE: Manual\n"
            "        CODE_SIGN_IDENTITY: Apple Distribution\n"
            f"        PROVISIONING_PROFILE_SPECIFIER: \"{profile}\"\n")
for bundle_line, profile in [("        PRODUCT_BUNDLE_IDENTIFIER: $(BUNDLE_PREFIX).rizzio\n", app_profile),
                             ("        PRODUCT_BUNDLE_IDENTIFIER: $(BUNDLE_PREFIX).rizzio.keyboard\n", kb_profile)]:
    assert bundle_line in text, bundle_line
    text = text.replace(bundle_line, bundle_line + manual(profile), 1)
open("project.yml", "w").write(text)
PY
xcodegen

echo "Archiving build ${BUILD_NUMBER}…"
xcodebuild archive \
  -project Rizzio.xcodeproj \
  -scheme Rizzio \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  CURRENT_PROJECT_VERSION="${BUILD_NUMBER}" \
  OTHER_CODE_SIGN_FLAGS="--keychain $KEYCHAIN"

cat > build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>teamID</key><string>4DKL5S4CND</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>com.diondavid.rizzio</key><string>${APP_PROFILE}</string>
    <key>com.diondavid.rizzio.keyboard</key><string>${KB_PROFILE}</string>
  </dict>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

echo "Uploading to App Store Connect…"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist build/ExportOptions.plist \
  -exportPath build/export \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"

echo "Done. Build ${BUILD_NUMBER} is processing; it shows up in TestFlight in about 5–15 minutes."
