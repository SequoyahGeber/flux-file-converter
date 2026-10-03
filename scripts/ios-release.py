#!/usr/bin/env python3
"""Archive and sign the on-device iPhone app; never upload or release it to testers."""
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=pathlib.Path, default=DEFAULT_CONFIG)
    parser.add_argument("--build", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[1-9][0-9]{0,17}", args.build):
        raise SystemExit("Supply an increasing numeric build number.")
    settings = json.loads(args.config.read_text())
    chosen = settings["ios"]
    identity = chosen["identity"]
    keychain = settings.get("keychain")
    if keychain:
        password = pathlib.Path(settings["keychainPasswordFile"]).expanduser().read_text()
        result = subprocess.run(["security", "unlock-keychain", "-p", password, keychain], capture_output=True)
        if result.returncode:
            raise SystemExit("The private Flux signing keychain could not be unlocked.")
    identities = command(["security", "find-identity", "-v"] + ([keychain] if keychain else []), text=True)
    if not re.search(re.escape(identity) + r' "Apple Distribution:', identities):
        raise SystemExit("Use an available Apple Distribution identity.")
    profile_path = pathlib.Path(chosen["profile"]).expanduser()
    p = plistlib.loads(command(["security", "cms", "-D", "-i", str(profile_path)]))
    if p["TeamIdentifier"] != [settings["team"]] or p["Entitlements"].get("application-identifier") != settings["team"] + "." + chosen["bundleId"]:
        raise SystemExit("Use a provisioning profile for this Flux app and team.")
    if p["ExpirationDate"].replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        raise SystemExit("The provisioning profile has expired.")
    if p.get("ProvisionedDevices") or p.get("ProvisionsAllDevices") or p["Entitlements"].get("get-task-allow"):
        raise SystemExit("Use an iPhone App Store distribution profile.")
    if "iOS" not in p["Platform"] or not p["Entitlements"].get("beta-reports-active"):
        raise SystemExit("The profile is not valid for iPhone TestFlight distribution.")
    if identity not in [hashlib.sha1(c).hexdigest().upper() for c in p["DeveloperCertificates"]]:
        raise SystemExit("The profile does not contain the selected signing certificate.")
    profile_directory = pathlib.Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles"
    profile_directory.mkdir(parents=True, exist_ok=True)
    installed = profile_directory / (p["UUID"] + ".mobileprovision")
    installed.write_bytes(profile_path.read_bytes())
    installed.chmod(0o600)
    command(["python3", str(ROOT / "scripts/ios-project.py")])
    version = (ROOT / "native/VERSION").read_text().strip()
    output = ROOT / "release/native"
    output.mkdir(parents=True, exist_ok=True)
    logs = ROOT / ".test-output"
    logs.mkdir(exist_ok=True)
    env = dict(os.environ)
    env["DEVELOPER_DIR"] = settings.get("developerDirectory", "/Applications/Xcode.app/Contents/Developer")
    with tempfile.TemporaryDirectory(prefix="flux-ios-release-") as temp:
        temporary = pathlib.Path(temp)
        archive = temporary / "Flux.xcarchive"
        build_args = ["xcodebuild", "-project", str(ROOT / "ios/Flux.xcodeproj"), "-scheme", "Flux",
                      "-configuration", "Release", "-destination", "generic/platform=iOS",
                      "-derivedDataPath", str(temporary / "build"), "-archivePath", str(archive),
                      "archive", "CURRENT_PROJECT_VERSION=" + args.build, "MARKETING_VERSION=" + version,
                      "FLUX_SIGNING_IDENTITY=" + identity, "FLUX_PROFILE=" + p["Name"],
                      "DEVELOPMENT_TEAM=" + settings["team"], "PRODUCT_BUNDLE_IDENTIFIER=" + chosen["bundleId"]]
        if keychain:
            build_args.append("OTHER_CODE_SIGN_FLAGS=--keychain " + shlex.quote(keychain))
        with (logs / "ios-distribution-archive.txt").open("w") as log:
            subprocess.run(build_args, check=True, env=env, stdout=log, stderr=subprocess.STDOUT)
        app = archive / "Products/Applications/Flux.app"
        command(["codesign", "--verify", "--deep", "--strict", str(app)])
        entitlements = plistlib.loads(command(["codesign", "-d", "--entitlements", "-", "--xml", str(app)], stderr=subprocess.DEVNULL))
        if entitlements.get("get-task-allow", False) or entitlements.get("application-identifier") != settings["team"] + "." + chosen["bundleId"]:
            raise SystemExit("The archived app's signing entitlements are incorrect.")
        allowed = {"application-identifier", "com.apple.developer.team-identifier", "beta-reports-active", "get-task-allow"}
        if set(entitlements) - allowed:
            raise SystemExit("Unexpected entitlements in the signed archive.")
        binary = app / "Flux"
        if command(["lipo", "-archs", str(binary)], text=True).strip() != "arm64":
            raise SystemExit("Use an arm64 iPhone device archive.")
        if "--test-origin=" in command(["strings", "-a", str(binary)], text=True):
            raise SystemExit("A test endpoint override was included in the release binary.")
        manifest = plistlib.loads((app / "PrivacyInfo.xcprivacy").read_bytes())
        if manifest.get("NSPrivacyTracking") is not False or manifest.get("NSPrivacyCollectedDataTypes") != []:
            raise SystemExit("The app's privacy manifest is missing or incorrect.")
        # The archive is already signed with its App Store profile. This client has
        # no extensions/embedded frameworks or thinning assets; preserve the signed
        # bundle in the standard IPA payload, without an automatic upload/export.
        payload = temporary / "Payload"
        payload.mkdir()
        command(["ditto", str(app), str(payload / "Flux.app")])
        artifact = output / f"Flux-iPhone-{version}-{args.build}.ipa"
        command(["ditto", "-c", "-k", "--keepParent", str(payload), str(artifact)])
        archive_zip = output / f"Flux-iPhone-{version}-{args.build}-archive.zip"
        command(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(archive), str(archive_zip)])
        receipt = {"bundleId": chosen["bundleId"], "version": version, "build": args.build,
                   "platform": "iOS", "architectures": "arm64", "entitlements": entitlements,
                   "artifact": str(artifact), "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                   "bytes": artifact.stat().st_size, "uploadVerified": False, "testFlightAvailabilityVerified": False}
        (output / f"Flux-iPhone-{version}-{args.build}.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
