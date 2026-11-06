#!/usr/bin/env python3
"""Makes short-lived App Store signing assets through the App Store Connect API, for CI.

Xcode's own automatic signing on GitHub's Macs kept failing to sign in, even with a valid Admin key,
so this does the same job directly:

  setup OUT_DIR    → new private key + Apple Distribution certificate (cert.p12), and one App Store
                     provisioning profile per bundle ID (*.mobileprovision). Writes OUT_DIR/state.json.
  cleanup OUT_DIR  → deletes those profiles and revokes the certificate, so CI never piles up
                     certificates (Apple allows only a few). Builds already uploaded are not affected:
                     Apple re-signs App Store and TestFlight builds with its own certificate.

Needs ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH in the environment. Uses only the standard library + openssl.
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from asc_auth_check import make_token  # noqa: E402

API = "https://api.appstoreconnect.apple.com/v1"
BUNDLE_IDS = {"app": "com.diondavid.rizzio", "keyboard": "com.diondavid.rizzio.keyboard"}


def api(method, path, body=None):
    token = make_token(os.environ["ASC_KEY_ID"], os.environ["ASC_ISSUER_ID"], os.environ["ASC_KEY_PATH"])
    req = urllib.request.Request(
        f"{API}{path}",
        method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")
        try:
            errors = json.loads(detail).get("errors", [])
            detail = "; ".join(f"{e.get('title')}: {e.get('detail')}" for e in errors)
        except Exception:
            pass
        raise SystemExit(f"App Store Connect API {method} {path} failed (HTTP {err.code}): {detail}")


def run(*cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, **kw)


def bundle_resource_id(identifier):
    data = api("GET", f"/bundleIds?filter[identifier]={identifier}&limit=50")["data"]
    for item in data:
        if item["attributes"]["identifier"] == identifier:
            return item["id"]
    raise SystemExit(
        f"Bundle ID {identifier} isn't registered. Add it at developer.apple.com → Identifiers "
        "(with the App Groups capability), then run again."
    )


APP_GROUP = "group.com.diondavid.Rizzio"  # matches the group registered on developer.apple.com (case-sensitive)


def profile_app_groups(raw: bytes):
    """Reads the application-groups entitlement out of a .mobileprovision (a signed plist)."""
    import plistlib
    start, end = raw.find(b"<?xml"), raw.find(b"</plist>")
    if start < 0 or end < 0:
        return None
    plist = plistlib.loads(raw[start : end + len(b"</plist>")])
    return plist.get("Entitlements", {}).get("com.apple.security.application-groups")


def describe_capabilities(resource_id):
    caps = api("GET", f"/bundleIds/{resource_id}/bundleIdCapabilities")["data"]
    return sorted(c["attributes"].get("capabilityType", "?") for c in caps)


# Permanent certificate, stored encrypted in the repo (like fastlane match). Only used when the
# SIGNING_PASSWORD secret is set; without it, a temporary certificate is made and revoked each run.
STORE_DIR = Path(__file__).resolve().parent.parent / "signing"
STORED_P12 = STORE_DIR / "distribution.p12.enc"
STORED_INFO = STORE_DIR / "distribution.json"


def certificate_is_valid(cert_id):
    token = make_token(os.environ["ASC_KEY_ID"], os.environ["ASC_ISSUER_ID"], os.environ["ASC_KEY_PATH"])
    req = urllib.request.Request(f"{API}/certificates/{cert_id}", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            attrs = json.load(resp)["data"]["attributes"]
    except urllib.error.HTTPError:
        return False
    expires = attrs.get("expirationDate", "")
    return not expires or expires > time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() + 7 * 86400))


def load_stored_certificate(out, password):
    """Decrypts the saved certificate. Returns its Apple ID, or None if there isn't a usable one."""
    if not (STORED_P12.exists() and STORED_INFO.exists()):
        return None
    cert_id = json.loads(STORED_INFO.read_text())["certificateId"]
    if not certificate_is_valid(cert_id):
        print("  The saved certificate was revoked or is about to expire; making a new one.", flush=True)
        return None
    run("openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-in", str(STORED_P12),
        "-out", str(out / "cert.p12"), "-pass", "env:SIGNING_PASSWORD")
    return cert_id


def create_certificate(out, p12_password):
    key = out / "dist.key"
    csr = out / "dist.csr"
    run("openssl", "genrsa", "-out", str(key), "2048")
    run("openssl", "req", "-new", "-key", str(key), "-out", str(csr), "-subj", "/CN=Rizzio CI/O=Rizzio")
    cert = api("POST", "/certificates", {
        "data": {"type": "certificates", "attributes": {"certificateType": "DISTRIBUTION", "csrContent": csr.read_text()}}
    })["data"]
    cer = out / "dist.cer"
    cer.write_bytes(base64.b64decode(cert["attributes"]["certificateContent"]))
    run("openssl", "x509", "-inform", "DER", "-in", str(cer), "-out", str(out / "dist.pem"))
    p12_cmd = ["openssl", "pkcs12", "-export", "-inkey", str(key), "-in", str(out / "dist.pem"),
               "-out", str(out / "cert.p12"), "-passout", f"pass:{p12_password}"]
    # macOS's keychain can't read OpenSSL 3's default p12 encryption; ask for the legacy format when available.
    try:
        run(*(p12_cmd + ["-legacy"]))
    except subprocess.CalledProcessError:
        run(*p12_cmd)
    key.unlink()
    return cert["id"]


def setup(out):
    out.mkdir(parents=True, exist_ok=True)
    permanent_password = os.environ.get("SIGNING_PASSWORD", "")
    state = {"profiles": {}}

    if permanent_password:
        state["p12Password"] = permanent_password
        cert_id = load_stored_certificate(out, permanent_password)
        if cert_id:
            print("  Using the saved distribution certificate.", flush=True)
        else:
            print("  Creating the permanent distribution certificate (one time)…", flush=True)
            cert_id = create_certificate(out, permanent_password)
            STORE_DIR.mkdir(exist_ok=True)
            run("openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-in", str(out / "cert.p12"),
                "-out", str(STORED_P12), "-pass", "env:SIGNING_PASSWORD")
            STORED_INFO.write_text(json.dumps({"certificateId": cert_id}, indent=2) + "\n")
            print("  ✓ Saved it, encrypted, to ios/signing/ (CI commits it so later builds reuse it).", flush=True)
        state["certificateId"] = cert_id
        state["permanent"] = True
    else:
        print("  Creating a temporary Apple Distribution certificate…", flush=True)
        state["p12Password"] = base64.b64encode(os.urandom(18)).decode()
        state["certificateId"] = create_certificate(out, state["p12Password"])
    (out / "state.json").write_text(json.dumps(state))
    cert = {"id": state["certificateId"]}

    stamp = time.strftime("%Y%m%d%H%M%S")
    for role, identifier in BUNDLE_IDS.items():
        print(f"  Creating an App Store profile for {identifier}…", flush=True)
        profile = api("POST", "/profiles", {
            "data": {
                "type": "profiles",
                "attributes": {"name": f"Rizzio CI {role} {stamp}", "profileType": "IOS_APP_STORE"},
                "relationships": {
                    "bundleId": {"data": {"type": "bundleIds", "id": bundle_resource_id(identifier)}},
                    "certificates": {"data": [{"type": "certificates", "id": cert["id"]}]},
                },
            }
        })["data"]
        attrs = profile["attributes"]
        path = out / f"{role}.mobileprovision"
        raw = base64.b64decode(attrs["profileContent"])
        path.write_bytes(raw)
        state["profiles"][role] = {"id": profile["id"]}  # so cleanup deletes it even if we stop below
        (out / "state.json").write_text(json.dumps(state))
        groups = profile_app_groups(raw)
        if not groups or APP_GROUP not in groups:
            print(f"  ✗ {identifier}: Apple's profile has App Groups = {groups!r}.", flush=True)
            caps = describe_capabilities(bundle_resource_id(identifier))
            print(f"    Capabilities enabled on this ID: {', '.join(caps) or 'none'}")
            if "APP_GROUPS" not in caps:
                print("    → App Groups isn't ticked on this ID. Tick it at developer.apple.com → Identifiers → this ID → Save.")
            else:
                print(f"    → App Groups is on, but {APP_GROUP} isn't assigned to this ID.")
                print("      developer.apple.com → Identifiers → this ID → App Groups → Configure/Edit → tick the group → Continue → Save.")
            raise SystemExit(1)
        print(f"  ✓ {identifier} profile includes {APP_GROUP}.")
        state["profiles"][role] = {
            "id": profile["id"], "name": attrs["name"], "uuid": attrs["uuid"],
            "bundleId": identifier, "path": str(path),
        }
        (out / "state.json").write_text(json.dumps(state))
    print("  ✓ Signing certificate and profiles ready.")


def cleanup(out):
    state_file = out / "state.json"
    if not state_file.exists():
        return
    state = json.loads(state_file.read_text())
    for profile in state.get("profiles", {}).values():
        try:
            api("DELETE", f"/profiles/{profile['id']}")
        except SystemExit as err:
            print(f"  (couldn't delete profile: {err})")
    if state.get("certificateId") and not state.get("permanent"):
        try:
            api("DELETE", f"/certificates/{state['certificateId']}")
            print("  ✓ Temporary certificate revoked.")
        except SystemExit as err:
            print(f"  (couldn't revoke certificate: {err})")


if __name__ == "__main__":
    command, out_dir = sys.argv[1], Path(sys.argv[2])
    {"setup": setup, "cleanup": cleanup}[command](out_dir)
