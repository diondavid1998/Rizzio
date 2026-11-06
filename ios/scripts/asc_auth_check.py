#!/usr/bin/env python3
"""Asks Apple's App Store Connect API "who am I?" with the API key, to tell a bad key
apart from an Xcode signing problem. Uses only the standard library plus the openssl CLI.
Prints a status and Apple's error title, never the key or the token.

Usage: asc_auth_check.py KEY_ID ISSUER_ID PATH_TO_P8
"""
import base64
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def der_to_raw(sig: bytes) -> bytes:
    """openssl gives an ASN.1 DER ECDSA signature; JWT ES256 wants r||s (32 bytes each)."""
    assert sig[0] == 0x30
    i = 2 if sig[1] < 0x80 else 2 + (sig[1] & 0x7F)
    out = b""
    for _ in range(2):
        assert sig[i] == 0x02
        length = sig[i + 1]
        value = sig[i + 2 : i + 2 + length].lstrip(b"\x00")
        out += value.rjust(32, b"\x00")
        i += 2 + length
    return out


def make_token(key_id: str, issuer_id: str, p8_path: str) -> str:
    header = {"alg": "ES256", "kid": key_id, "typ": "JWT"}
    now = int(time.time())
    payload = {"iss": issuer_id, "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"}
    signing_input = f"{b64url(json.dumps(header).encode())}.{b64url(json.dumps(payload).encode())}"
    der = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", p8_path],
        input=signing_input.encode(), capture_output=True, check=True,
    ).stdout
    return f"{signing_input}.{b64url(der_to_raw(der))}"


def main() -> int:
    key_id, issuer_id, p8_path = sys.argv[1:4]
    token = make_token(key_id, issuer_id, p8_path)
    req = urllib.request.Request(
        "https://api.appstoreconnect.apple.com/v1/apps?limit=50&fields[apps]=bundleId",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            apps = json.load(resp).get("data", [])
    except urllib.error.HTTPError as err:
        try:
            title = json.load(err)["errors"][0].get("title", "")
        except Exception:
            title = ""
        print(f"  ✗ Apple rejected the API key (HTTP {err.code}: {title}).")
        if err.code == 401:
            print("    The Key ID, Issuer ID and .p8 don't belong together, or the key was revoked.")
            print("    Check: it's under Team Keys (not Individual), the Key ID matches the AuthKey_<ID>.p8 file name,")
            print("    and the Issuer ID is the one shown above the Team Keys list.")
        elif err.code == 403:
            print("    The key works but lacks permission. Give it the Admin role.")
        return 1
    # Xcode also needs the developer-portal side (certificates, profiles) to sign the app.
    portal_req = urllib.request.Request(
        "https://api.appstoreconnect.apple.com/v1/certificates?limit=1",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(portal_req, timeout=30):
            print("  ✓ The key can manage certificates and profiles.")
    except urllib.error.HTTPError as err:
        print(f"  ✗ The key can see your apps but can't manage certificates (HTTP {err.code}).")
        print("    Xcode needs that to sign the app. In App Store Connect → Users and Access → Integrations,")
        print("    make a new Team key with Access set to Admin, then update ASC_KEY_ID and ASC_KEY_P8 in GitHub.")
        return 1
    bundle_ids = [a["attributes"]["bundleId"] for a in apps]
    print(f"  ✓ Apple accepted the API key ({len(bundle_ids)} apps visible).")
    if "com.diondavid.rizzio" not in bundle_ids:
        print("  ! No app with bundle ID com.diondavid.rizzio yet. Create it in App Store Connect before uploading.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
