#!/usr/bin/env python3
"""Build and sign the on-device Mac app. Does not upload or release to testers."""
import argparse
import hashlib
import json
import os
import pathlib
import plistlib
import re
import shlex
import subprocess
import tempfile
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = pathlib.Path.home() / ".appstoreconnect/flux/Signing.local.json"


def command(args, **kwargs):
    return subprocess.check_output(args, **kwargs)


def profile(path):
    return plistlib.loads(command(["security", "cms", "-D", "-i", str(path)]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=pathlib.Path, default=DEFAULT_CONFIG)
    parser.add_argument("--build", required=True)
    parser.add_argument("--development", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[1-9][0-9]{0,17}", args.build):
        raise SystemExit("Supply an increasing numeric build number.")
    settings = json.loads(args.config.read_text())
    mode = "development" if args.development else "distribution"
    chosen = settings[mode]
    identity = chosen["identity"]
    keychain = chosen.get("keychain") or (settings.get("keychain") if not args.development else None)
    if keychain:
        password = pathlib.Path(settings["keychainPasswordFile"]).expanduser().read_text()
        result = subprocess.run(["security", "unlock-keychain", "-p", password, keychain], capture_output=True)
        if result.returncode:
            raise SystemExit("The private Flux signing keychain could not be unlocked.")
    identities = command(["security", "find-identity", "-v"] + ([keychain] if keychain else []), text=True)
    if identity not in identities:
        raise SystemExit("The signing identity is unavailable in the keychain.")
    identity_name = re.search(re.escape(identity) + r' "([^"]+)"', identities)
    pattern = r"^Apple Development:|^Mac Developer:" if args.development else r"^Apple Distribution:|^3rd Party Mac Developer Application:"
    if not identity_name or not re.search(pattern, identity_name.group(1)):
        raise SystemExit("The identity does not match development/distribution signing.")
    p = profile(pathlib.Path(chosen["profile"]).expanduser())
    if p["TeamIdentifier"] != [settings["team"]] or p["Entitlements"].get("com.apple.application-identifier") != settings["team"] + "." + settings["bundleId"]:
        raise SystemExit("Use a provisioning profile for this Flux app and team.")
    if p["ExpirationDate"].replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        raise SystemExit("The provisioning profile has expired.")
    # macOS profiles may omit get-task-allow for both modes; development profiles
    # are device-bound, whereas App Store profiles have no provisioned devices.
    if bool(p.get("ProvisionedDevices")) != args.development or p.get("ProvisionsAllDevices"):
        raise SystemExit("The profile does not match the requested development/distribution mode.")
    if identity not in [hashlib.sha1(c).hexdigest().upper() for c in p["DeveloperCertificates"]]:
        raise SystemExit("The profile does not contain the selected signing certificate.")
    if not args.development and settings["installerIdentity"] not in identities:
        raise SystemExit("The installer signing identity is unavailable in the keychain.")
    profile_directory = pathlib.Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles"
    profile_directory.mkdir(parents=True, exist_ok=True)
    installed = profile_directory / (p["UUID"] + ".provisionprofile")
    installed.write_bytes(pathlib.Path(chosen["profile"]).expanduser().read_bytes())
    installed.chmod(0o600)
    command(["python3", str(ROOT / "scripts/mac-project.py")])
    version = (ROOT / "native/VERSION").read_text().strip()
    output = ROOT / "release/native"
    output.mkdir(parents=True, exist_ok=True)
    logs = ROOT / ".test-output"
    logs.mkdir(exist_ok=True)
    env = dict(os.environ)
    # Use the installed release Xcode without changing the user's global selection.
    env["DEVELOPER_DIR"] = settings.get("developerDirectory", "/Applications/Xcode.app/Contents/Developer")
    with tempfile.TemporaryDirectory(prefix="flux-native-release-") as temp:
        temporary = pathlib.Path(temp)
        archive = temporary / "Flux.xcarchive"
        build_args = ["xcodebuild", "-project", str(ROOT / "mac/Flux.xcodeproj"), "-scheme", "Flux",
                      "-configuration", "Release", "-derivedDataPath", str(temporary / "build"),
                      "-archivePath", str(archive), "archive", "CURRENT_PROJECT_VERSION=" + args.build,
                      "MARKETING_VERSION=" + version, "FLUX_SIGNING_IDENTITY=" + identity,
                      "FLUX_PROFILE=" + p["Name"], "DEVELOPMENT_TEAM=" + settings["team"],
                      "PRODUCT_BUNDLE_IDENTIFIER=" + settings["bundleId"],
                      "ENABLE_HARDENED_RUNTIME=YES"]
        if keychain:
            build_args.append("OTHER_CODE_SIGN_FLAGS=--keychain " + shlex.quote(keychain))
        if args.development:
            build_args.append("CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES")
        with (logs / ("mac-" + mode + "-archive.txt")).open("w") as log:
            subprocess.run(build_args, check=True, env=env, stdout=log, stderr=subprocess.STDOUT)
        app = archive / "Products/Applications/Flux Local.app"
        command(["codesign", "--verify", "--deep", "--strict", str(app)])
        entitlements = plistlib.loads(command(["codesign", "-d", "--entitlements", "-", "--xml", str(app)], stderr=subprocess.DEVNULL))
        if entitlements.get("com.apple.security.app-sandbox") is not True or (not args.development and entitlements.get("com.apple.security.get-task-allow", False)):
            raise SystemExit("The archived app's sandbox/signing entitlements are incorrect.")
        expected = {"com.apple.application-identifier", "com.apple.developer.team-identifier",
                    "com.apple.security.app-sandbox",
                    "com.apple.security.files.user-selected.read-write", "com.apple.security.network.client", "com.apple.security.get-task-allow"}
        if set(entitlements) - expected:
            raise SystemExit("Unexpected entitlements in the signed archive.")
        binary = app / "Contents/MacOS/Flux Local"
        architectures = command(["lipo", "-archs", str(binary)], text=True).strip()
        if set(architectures.split()) != {"arm64", "x86_64"}:
            raise SystemExit("The native release must include Apple Silicon and Intel.")
        # Developer-only loopback endpoints must not survive in a release binary.
        strings = command(["strings", "-a", str(binary)], text=True)
        if "--test-origin=" in strings:
            raise SystemExit("A test endpoint override was included in the release binary.")
        manifest = plistlib.loads((app / "Contents/Resources/PrivacyInfo.xcprivacy").read_bytes())
        if manifest.get("NSPrivacyTracking") is not False or manifest.get("NSPrivacyCollectedDataTypes") != []:
            raise SystemExit("The app's privacy manifest is missing or incorrect.")
        name = f"Flux-Local-{version}-{args.build}"
        if args.development:
            artifact = output / (name + "-development.zip")
            command(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(artifact)])
        else:
            artifact = output / (name + ".pkg")
            command(["productbuild", "--component", str(app), "/Applications", "--sign",
                     settings["installerIdentity"]] + (["--keychain", keychain] if keychain else []) + [str(artifact)])
            command(["pkgutil", "--check-signature", str(artifact)])
        archive_zip = output / (name + "-" + mode + "-archive.zip")
        command(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(archive), str(archive_zip)])
        receipt = {"bundleId": settings["bundleId"], "version": version, "build": args.build,
                   "mode": mode, "architectures": architectures, "entitlements": entitlements,
                   "artifact": str(artifact), "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                   "bytes": artifact.stat().st_size, "uploadVerified": False,
                   "testFlightAvailabilityVerified": False}
        (output / (name + "-" + mode + ".json")).write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
