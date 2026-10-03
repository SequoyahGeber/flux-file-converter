"""Small App Store Connect API client. Credentials remain outside the repository."""
import base64
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

CONFIG = Path.home() / ".appstoreconnect/flux/AppStoreConnect.local.env"
API = "https://api.appstoreconnect.apple.com/v1"


def credentials():
    values = dict(os.environ)
    if CONFIG.exists():
        for line in CONFIG.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                key, value = line.split("=", 1); values.setdefault(key.strip(), value.strip())
    if not all(values.get(key) for key in ["ASC_KEY_ID", "ASC_ISSUER_ID"]):
        raise SystemExit("Configure ASC_KEY_ID and ASC_ISSUER_ID in the environment or the private Flux configuration.")
    return values["ASC_KEY_ID"], values["ASC_ISSUER_ID"]


def bearer():
    key, issuer = credentials()
    private_key = Path.home() / f".appstoreconnect/private_keys/AuthKey_{key}.p8"
    if not private_key.is_file(): raise SystemExit("The App Store Connect private key is unavailable.")
    def encode(data): return base64.urlsafe_b64encode(data).rstrip(b"=").decode()
    now = int(time.time())
    header = encode(json.dumps({"alg": "ES256", "kid": key, "typ": "JWT"}).encode())
    claims = encode(json.dumps({"iss": issuer, "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"}).encode())
    unsigned = header + "." + claims
    der = subprocess.check_output(["openssl", "dgst", "-sha256", "-sign", str(private_key)], input=unsigned.encode(), stderr=subprocess.DEVNULL)
    if der[0] != 0x30: raise SystemExit("Invalid signing response.")
    index = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7f)
    signature = b""
    for _ in range(2):
        if der[index] != 0x02: raise SystemExit("Invalid signing response.")
        length = der[index + 1]; component = der[index + 2:index + 2 + length].lstrip(b"\0")
        if len(component) > 32: raise SystemExit("Invalid signing response.")
        signature += component.rjust(32, b"\0"); index += length + 2
    return unsigned + "." + encode(signature)


def call(path, method="GET", body=None):
    if not path.startswith("/") or path.startswith("//"): raise ValueError("Use an App Store Connect API path.")
    request = urllib.request.Request(API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + bearer(), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = response.read(); return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        try: titles = "; ".join(item.get("title", "Request failed") for item in json.loads(error.read()).get("errors", []))
        except (ValueError, UnicodeError): titles = "Request failed"
        raise SystemExit(f"Apple API {method} {path}: HTTP {error.code}: {titles}")
