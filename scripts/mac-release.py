#!/usr/bin/env python3
# SHARED-EXPERIENCE: engineering | standard: PROJECT_STANDARDS.md §Engineering | local implementation; changes must be mirrored in every app listed there
"""Build and sign the on-device Mac app. Does not upload or release to testers."""
import argparse
import contextlib
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
# A locally signed (development) build has its own id: signed and sandboxed as the release id, it would run inside the
# owner's installed Flux container (D-142). Distribution keeps the configured release id.
DEVELOPMENT_ID = "com.sequoyah.flux.mac.dev"


def command(args, **kwargs):
    return subprocess.check_output(args, **kwargs)


def profile(path):
    return plistlib.loads(command(["security", "cms", "-D", "-i", str(path)]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=pathlib.Path, default=DEFAULT_CONFIG)
    parser.add_argument("--build", required=True)
    parser.add_argument("--development", action="store_true")
    parser.add_argument("--work-dir", type=pathlib.Path, help="Keep build intermediates here for local packaging diagnostics.")
    parser.add_argument("--full-engine", action="store_true", help="Bundle the personal full converter stage instead of the restricted on-device engine.")
    args = parser.parse_args()
    # Without --full-engine this builds the restricted OfflineKit app that can be
    # distributed; the bridge only uses converters that are actually bundled.
    conversion_root = pathlib.Path(os.environ.get("FLUX_MAC_ENGINE_RESOURCES", "/private/tmp/flux-full-engine/ConversionEngine"))
    engine_manifest = {}
    if args.full_engine:
        if not (conversion_root / "capabilities.json").is_file():
            raise SystemExit("Build the bundled converters with scripts/mac-engines.py before packaging the full engine.")
        engine_manifest = json.loads((conversion_root / "engines.json").read_text())
        if not args.development and engine_manifest.get("distributionReady") is not True:
            raise SystemExit("This full engine bundle is for personal use. Public packaging requires completed third-party licensing and corresponding-source review.")
        if not args.development and set(engine_manifest.get("architectures", [])) != {"arm64", "x86_64"}:
            raise SystemExit("Distribution requires complete bundled engines for Apple Silicon and Intel.")
    # Build number (PROJECT_STANDARDS.md §Engineering): YYYYMMDDNN, the day the build is cut (Asia/Tokyo) plus a counter from 01.
    if not re.fullmatch(r"20[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[0-9]{2}", args.build) or args.build.endswith("00"):
        raise SystemExit("Use the build number YYYYMMDDNN, for example 2026111501.")
    settings = json.loads(args.config.read_text())
    mode = "development" if args.development else "distribution"
    bundle_id = DEVELOPMENT_ID if args.development else settings["bundleId"]
    if not args.development and bundle_id == DEVELOPMENT_ID:
        raise SystemExit("Distribution must use the release bundle id, not the development one.")
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
    if p["TeamIdentifier"] != [settings["team"]] or p["Entitlements"].get("com.apple.application-identifier") != settings["team"] + "." + bundle_id:
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
    if args.work_dir: args.work_dir.mkdir(parents=True, exist_ok=True)
    workspace = contextlib.nullcontext(str(args.work_dir.resolve())) if args.work_dir else tempfile.TemporaryDirectory(prefix="flux-native-release-")
    with workspace as temp:
        temporary = pathlib.Path(temp)
        archive = temporary / "Flux.xcarchive"
        build_args = ["xcodebuild", "-project", str(ROOT / "mac/Flux.xcodeproj"), "-scheme", "Flux",
                      "-configuration", "Release", "-derivedDataPath", str(temporary / "build"),
                      "-archivePath", str(archive), "archive", "CURRENT_PROJECT_VERSION=" + args.build,
                      "MARKETING_VERSION=" + version, "FLUX_SIGNING_IDENTITY=" + identity,
                      "FLUX_PROFILE=" + p["Name"], "DEVELOPMENT_TEAM=" + settings["team"],
                      "PRODUCT_BUNDLE_IDENTIFIER=" + bundle_id,
                      "ENABLE_HARDENED_RUNTIME=YES"]
        if keychain:
            build_args.append("OTHER_CODE_SIGN_FLAGS=--keychain " + shlex.quote(keychain))
        if args.development:
            build_args.append("CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES")
        else:
            # Distribution: the profile allows both CloudKit environments, and without the key Apple's validation reads
            # an empty value and refuses the package (altool 90046). Sign Production here only; the checked-in
            # entitlements (Debug and development builds) stay without it, so those keep Development.
            signing = plistlib.loads((ROOT / "mac/Flux/Flux.entitlements").read_bytes())
            signing["com.apple.developer.icloud-container-environment"] = "Production"
            distribution_entitlements = temporary / "Flux-distribution.entitlements"
            distribution_entitlements.write_bytes(plistlib.dumps(signing))
            build_args.append("CODE_SIGN_ENTITLEMENTS=" + str(distribution_entitlements))
        with (logs / ("mac-" + mode + "-archive.txt")).open("w") as log:
            subprocess.run(build_args, check=True, env=env, stdout=log, stderr=subprocess.STDOUT)
        app = archive / "Products/Applications/Flux File Converter.app"
        if args.full_engine:
            # Copy after compilation: Xcode otherwise indexes every tool/data file.
            command(["ditto", "--noextattr", "--norsrc", str(conversion_root), str(app / "Contents/Resources/ConversionEngine")])
            # Converter children inherit the app sandbox, including its network
            # client and open user-selected scopes; they receive staged copies.
            import importlib.util
            spec = importlib.util.spec_from_file_location("mac_sign_engines", ROOT / "scripts/mac-sign-engines.py")
            signer = importlib.util.module_from_spec(spec); spec.loader.exec_module(signer)
            signer.sign(app, identity, keychain)
        elif (app / "Contents/Resources/ConversionEngine").exists():
            raise SystemExit("The restricted build must not contain ConversionEngine.")
        command(["codesign", "--verify", "--deep", "--strict", str(app)])
        entitlements = plistlib.loads(command(["codesign", "-d", "--entitlements", "-", "--xml", str(app)], stderr=subprocess.DEVNULL))
        if entitlements.get("com.apple.security.app-sandbox") is not True or (not args.development and entitlements.get("com.apple.security.get-task-allow", False)):
            raise SystemExit("The archived app's sandbox/signing entitlements are incorrect.")
        expected = {"com.apple.application-identifier", "com.apple.developer.team-identifier",
                    "com.apple.security.app-sandbox",
                    "com.apple.security.files.user-selected.read-write", "com.apple.security.files.bookmarks.app-scope",
                    "com.apple.security.network.client", "com.apple.security.get-task-allow",
                    # Feedback reports (SharedKit feedback): the iCloud container, CloudKit, and the
                    # environment the signing step adds.
                    "com.apple.developer.icloud-container-identifiers", "com.apple.developer.icloud-services",
                    "com.apple.developer.icloud-container-environment"}
        if set(entitlements) - expected:
            raise SystemExit("Unexpected entitlements in the signed archive.")
        if entitlements.get("com.apple.developer.icloud-container-identifiers") != ["iCloud.com.sequoyah.flux"]:
            raise SystemExit("The signed archive lacks the iCloud container iCloud.com.sequoyah.flux (feedback).")
        if not args.development and entitlements.get("com.apple.developer.icloud-container-environment") != "Production":
            raise SystemExit("The distribution archive must sign com.apple.developer.icloud-container-environment = Production "
                             "(Apple rejects an empty value, altool 90046).")
        binary = app / "Contents/MacOS/Flux File Converter"
        architectures = command(["lipo", "-archs", str(binary)], text=True).strip()
        if set(architectures.split()) != {"arm64", "x86_64"}:
            raise SystemExit("The native release must include Apple Silicon and Intel.")
        # Developer-only loopback endpoints must not survive in a release binary.
        strings = command(["strings", "-a", str(binary)], text=True)
        if "--test-origin=" in strings:
            raise SystemExit("A test endpoint override was included in the release binary.")
        manifest = plistlib.loads((app / "Contents/Resources/PrivacyInfo.xcprivacy").read_bytes())
        # Only what a person sends with feedback is collected. Reports carry the sender's CloudKit user record id,
        # which the inbox tooling queries (feedback.py delete --creator), so they are linked to the person; never tracking.
        collected = manifest.get("NSPrivacyCollectedDataTypes")
        feedback_types = {"NSPrivacyCollectedDataTypeOtherUserContent", "NSPrivacyCollectedDataTypeCrashData",
                          "NSPrivacyCollectedDataTypePerformanceData", "NSPrivacyCollectedDataTypeOtherDiagnosticData",
                          "NSPrivacyCollectedDataTypeUserID", "NSPrivacyCollectedDataTypeCustomerSupport"}  # D-118
        if (manifest.get("NSPrivacyTracking") is not False or not isinstance(collected, list)
                or {c.get("NSPrivacyCollectedDataType") for c in collected} != feedback_types
                or any(c.get("NSPrivacyCollectedDataTypeLinked") is not True or c.get("NSPrivacyCollectedDataTypeTracking") is not False
                       for c in collected)):
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
        receipt = {"bundleId": bundle_id, "version": version, "build": args.build,
                   "mode": mode, "architectures": architectures, "entitlements": entitlements,
                   "engine": "full" if args.full_engine else "restricted",
                   "engineArchitectures": engine_manifest.get("architectures", []),
                   "excludedEngines": engine_manifest.get("excludedEngines", []),
                   "distributionReady": engine_manifest.get("distributionReady", False),
                   "artifact": str(artifact), "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                   "bytes": artifact.stat().st_size, "uploadVerified": False,
                   "testFlightAvailabilityVerified": False}
        (output / (name + "-" + mode + ".json")).write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
