#!/usr/bin/env python3
"""Preflight exact Mac/iPhone builds; optionally apply metadata and request Beta App Review.

Read-only by default. Review submission does not enable a public link or invite/notify testers.
--groups adds both exact builds to the "Flux Owner" (internal) and "External testers" groups, with tester
notification off; it runs before --submit.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import urllib.request
import asc

ROOT = Path(__file__).resolve().parents[1]
APP = "6818735397"
SITE = "https://flux.sequoyahgeber.com"
CONTACT = Path.home() / ".appstoreconnect/flux/BetaReviewContact.local.json"
CONTACT_FIELDS = ["contactFirstName", "contactLastName", "contactEmail", "contactPhone"]
DESCRIPTION = ("Flux converts files entirely on your Mac or iPhone, with no account or server connection. "
    "Convert images, compatible media, supported documents, PDF, structured data and subtitles. "
    "Compress supported files, create ZIP archives and extract ZIP safely. Choose output names and save locations. "
    "Explore a sample file uses fictional files and the real converter. Local support depends on content and codecs; "
    "see Supported conversions / All formats. Media is limited to 5 GB and other files to 512 MB. "
    "Keep Flux open during conversion. No advertising, analytics or tracking. Support: " + SITE + "/support/")


# Files whose later changes leave an already-built app unchanged: a receipt or proof made at an earlier commit still
# describes HEAD's app when only these differ (2026111702: iOS built at 4ae8678, Mac at c08e9aa, D-125 follow-up).
RELEASE_TOOLING = {"scripts/mac-release.py", "scripts/ios-release.py", "scripts/testflight.sh", "scripts/beta-review.py",
                   "tests/beta-review-receipt.py"}
EXPORT_UPLOAD = "testflight_upload export"


def app_tree_sha256(app):
    """One sha256 over an .app tree: every file and symlink, in sorted relative-path order, as path, kind and content
    digest (a symlink's target instead of content). Stable across copies and clones of the same tree."""
    app = Path(app)
    if not app.is_dir(): return None
    total = hashlib.sha256()
    entries = []
    for folder, dirs, files in os.walk(app):
        for name in dirs + files:
            path = Path(folder) / name
            if path.is_symlink() or path.is_file(): entries.append(path)
    for path in sorted(entries, key=lambda p: p.relative_to(app).as_posix()):
        relative = path.relative_to(app).as_posix()
        if path.is_symlink(): kind, digest = "link", hashlib.sha256(os.readlink(path).encode()).hexdigest()
        else: kind, digest = "file", hashlib.sha256(path.read_bytes()).hexdigest()
        total.update(f"{relative}\0{kind}\0{digest}\n".encode())
    return total.hexdigest()


def export_receipt_issues(receipt, build, asc_build, root):
    """Problems with an iPhone receipt for a build exported straight to App Store Connect (uploadMethod
    "testflight_upload export"): no .ipa exists, so the receipt names the archive, the archived app's tree digest and
    the App Store Connect build id. `asc_build` is App Store Connect's GET /builds/{id} data (or None). Returns a list
    of issues; empty means the receipt holds. The sourceCommit ancestor rule is checked by the caller."""
    issues = []
    for key in ["sourceCommit", "archive", "appSha256", "bundleVersion", "ascBuildId"]:
        if not receipt.get(key): issues.append(f"receipt lacks {key}")
    if issues: return issues
    archive = Path(receipt["archive"])
    if not archive.is_absolute(): archive = Path(root) / archive
    apps = sorted((archive / "Products/Applications").glob("*.app")) if archive.is_dir() else []
    if len(apps) != 1: return [f"archive {archive} holds no single app"]
    if app_tree_sha256(apps[0]) != receipt["appSha256"]: issues.append("archived app digest differs from the receipt")
    try: version = plistlib.loads((apps[0] / "Info.plist").read_bytes()).get("CFBundleVersion")
    except (OSError, plistlib.InvalidFileException): version = None
    if version != build or receipt["bundleVersion"] != build: issues.append(f"archived CFBundleVersion {version} is not build {build}")
    if not asc_build or asc_build.get("id") != receipt["ascBuildId"] or asc_build.get("attributes", {}).get("processingState") != "VALID":
        issues.append(f"App Store Connect build {receipt['ascBuildId']} is not VALID")
    return issues


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build", help="Exact shared numeric build, never latest")
    parser.add_argument("--apply-metadata", action="store_true")
    parser.add_argument("--submit", action="store_true")
    parser.add_argument("--groups", action="store_true",
                        help='add both exact builds to "Flux Owner" and "External testers" (no tester notification)')
    args = parser.parse_args()
    if not args.build.isdigit(): parser.error("Use a numeric build.")
    issues = []
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    version = (ROOT / "native/VERSION").read_text().strip()
    notes = (ROOT / "docs/beta-review-notes.txt").read_text().strip()
    if len(notes) > 4000: issues.append(f"docs/beta-review-notes.txt is {len(notes)} characters; App Store Connect accepts 4,000.")
    if int(args.build) < 2026100305 or version != "1.0.3": issues.append("Use the review-ready 1.0.3 build or update this preflight for the new release.")
    for page, title in [("privacy", "Flux privacy policy"), ("support", "Flux support")]:
        try:
            # Cloudflare answers 403 to the default Python-urllib user agent.
            request = urllib.request.Request(SITE + "/" + page + "/", headers={"User-Agent": "flux-beta-review-preflight"})
            with urllib.request.urlopen(request, timeout=20) as response:
                live = response.status == 200 and "<h1>" + title + "</h1>" in response.read(200_000).decode()
        except (OSError, UnicodeError): live = False
        print(page + ": " + ("live" if live else "NOT LIVE"))
        if not live: issues.append("Publish the public " + page + " page.")
    def verified_at(source):
        """True when `source` is HEAD, or an ancestor of HEAD whose later commits change only the release tooling below
        (the app built from it is identical). Each platform's receipt and the reviewer proof are checked this way."""
        if source == commit: return True
        if not isinstance(source, str) or not source or subprocess.run(
                ["git", "merge-base", "--is-ancestor", source, commit], cwd=ROOT, capture_output=True).returncode:
            return False
        changed = subprocess.check_output(["git", "diff", "--name-only", source, commit], cwd=ROOT, text=True).split()
        return bool(changed) and set(changed) <= RELEASE_TOOLING
    proof_path = ROOT / ".test-output/beta-review-verification.json"
    proof = json.loads(proof_path.read_text()) if proof_path.is_file() else {}
    if not verified_at(proof.get("sourceCommit")) or not all(proof.get(key) for key in ["macReviewerWalkthrough", "iphoneReleaseReviewerUITest", "inputPreservationTests"]):
        issues.append("Record reviewer-flow verification for this exact source commit.")
    r = asc.call("/builds?filter[app]=" + APP + "&filter[version]=" + args.build + "&include=preReleaseVersion,buildBetaDetail")
    included = {item["id"]: item for item in r.get("included", [])}
    builds = {}
    for item in r["data"]:
        release = included[item["relationships"]["preReleaseVersion"]["data"]["id"]]["attributes"]
        if release.get("version") == version: builds[release["platform"]] = item
    for platform, prefix in [("MAC_OS", "Flux-Local"), ("IOS", "Flux-iPhone")]:
        item = builds.get(platform)
        if not item: issues.append(platform + ": exact build not uploaded."); continue
        attrs = item["attributes"]
        detail = asc.call("/builds/" + item["id"] + "/buildBetaDetail")["data"]["attributes"]
        print(platform, args.build, attrs["processingState"], detail.get("externalBuildState"))
        if attrs["processingState"] != "VALID" or attrs.get("expired") or attrs.get("buildAudienceType") != "APP_STORE_ELIGIBLE" or attrs.get("usesNonExemptEncryption") is None:
            issues.append(platform + ": finish processing/export compliance for an unexpired externally eligible build.")
        suffix = "-distribution" if platform == "MAC_OS" else ""
        path = ROOT / f"release/native/{prefix}-{version}-{args.build}{suffix}.json"
        receipt = json.loads(path.read_text()) if path.is_file() else {}
        print(platform, "receipt source", receipt.get("sourceCommit"), "HEAD", commit)
        if platform == "IOS" and receipt.get("uploadMethod") == EXPORT_UPLOAD:
            # Exported straight to App Store Connect: check the archived app, its build number and Apple's record.
            listed = receipt.get("ascBuildId")
            asc_build = None
            if isinstance(listed, str) and listed and all(c.isalnum() or c == "-" for c in listed):
                try: asc_build = asc.call("/builds/" + listed).get("data")
                except Exception as error: print(platform, "App Store Connect build lookup failed:", type(error).__name__)
            problems = export_receipt_issues(receipt, args.build, asc_build, ROOT)
            if listed != item["id"]: problems.append(f"receipt build id {listed} is not {platform} {args.build} ({item['id']})")
            if not verified_at(receipt.get("sourceCommit")): problems.append("source commit is not HEAD or a tooling-only ancestor")
            for problem in problems: issues.append(platform + ": export receipt: " + problem + ".")
            continue
        artifact = Path(receipt.get("artifact", "/nonexistent-flux-artifact"))
        if not verified_at(receipt.get("sourceCommit")) or not receipt.get("appleUploadAccepted") or not receipt.get("appleValidationVerified") or not artifact.is_file() or hashlib.sha256(artifact.read_bytes()).hexdigest() != receipt.get("sha256"):
            issues.append(platform + ": verified artifact/source receipt is missing or mismatched.")
    review = asc.call("/apps/" + APP + "/betaAppReviewDetail")["data"]
    locales = asc.call("/apps/" + APP + "/betaAppLocalizations")["data"]
    if args.apply_metadata:
        contact = json.loads(CONTACT.read_text()) if CONTACT.is_file() else {}
        if not all(contact.get(key) for key in CONTACT_FIELDS): issues.append("Configure the private beta review contact.")
    else:
        if not all(review["attributes"].get(key) for key in CONTACT_FIELDS) or review["attributes"].get("demoAccountRequired") is not False or review["attributes"].get("notes") != notes:
            issues.append("Apply complete contact, no-sign-in setting and the current reviewer walkthrough.")
        if not any(x["attributes"].get("privacyPolicyUrl") == SITE + "/privacy/" and x["attributes"].get("description") == DESCRIPTION for x in locales):
            issues.append("Apply the matching beta description and privacy URL.")
    if issues: raise SystemExit("Prerequisites:\n" + "\n".join("- " + issue for issue in issues))
    if args.apply_metadata:
        attrs = {key: contact[key] for key in CONTACT_FIELDS}; attrs.update(demoAccountRequired=False, notes=notes)
        asc.call("/betaAppReviewDetails/" + review["id"], "PATCH", {"data": {"type": "betaAppReviewDetails", "id": review["id"], "attributes": attrs}})
        english = next(x for x in locales if x["attributes"]["locale"] == "en-US")
        attrs = {"description": DESCRIPTION, "privacyPolicyUrl": SITE + "/privacy/", "marketingUrl": SITE + "/", "feedbackEmail": contact["contactEmail"]}
        asc.call("/betaAppLocalizations/" + english["id"], "PATCH", {"data": {"type": "betaAppLocalizations", "id": english["id"], "attributes": attrs}})
        saved = asc.call("/apps/" + APP + "/betaAppReviewDetail")["data"]["attributes"]
        localized = asc.call("/apps/" + APP + "/betaAppLocalizations")["data"]
        if saved.get("notes") != notes or saved.get("demoAccountRequired") is not False or not all(saved.get(key) == contact[key] for key in CONTACT_FIELDS) or not any(x["attributes"].get("description") == DESCRIPTION and x["attributes"].get("privacyPolicyUrl") == SITE + "/privacy/" for x in localized):
            raise SystemExit("Apple metadata read-back mismatch.")
        print("Review contact, walkthrough, description and privacy URL verified.")
    if args.groups:
        # "Flux Owner" does not get every build automatically, and SharedKit's beta_review.py refuses internal groups.
        groups = asc.call("/apps/" + APP + "/betaGroups?limit=200")["data"]
        build_ids = [item["id"] for item in builds.values()]
        for bid in build_ids:
            asc.call("/buildBetaDetails/" + bid, "PATCH", {"data": {"type": "buildBetaDetails", "id": bid, "attributes": {"autoNotifyEnabled": False}}})
        for name in ["Flux Owner", "External testers"]:
            group = next((g for g in groups if g["attributes"].get("name") == name), None)
            if not group: raise SystemExit(f"Beta group not found: {name}")
            asc.call("/betaGroups/" + group["id"] + "/relationships/builds", "POST",
                     {"data": [{"type": "builds", "id": bid} for bid in build_ids]})
            added = {item["id"] for item in asc.call("/betaGroups/" + group["id"] + "/builds?limit=200")["data"]}
            if not set(build_ids) <= added: raise SystemExit(f"{name}: builds not listed after adding them.")
            print(f"{name}: builds {args.build} added for {', '.join(sorted(builds))} (testers not notified).")
    if args.submit:
        for platform, item in builds.items():
            bid = item["id"]
            existing = asc.call("/builds/" + bid + "/betaAppReviewSubmission").get("data")
            asc.call("/buildBetaDetails/" + bid, "PATCH", {"data": {"type": "buildBetaDetails", "id": bid, "attributes": {"autoNotifyEnabled": False}}})
            if not existing:
                asc.call("/betaAppReviewSubmissions", "POST", {"data": {"type": "betaAppReviewSubmissions", "relationships": {"build": {"data": {"type": "builds", "id": bid}}}}})
            current = asc.call("/builds/" + bid + "/betaAppReviewSubmission")["data"]
            print(platform, "Beta App Review:", current["attributes"]["betaReviewState"])
    print("Preflight passed. Submission, Apple approval and public tester distribution are separate milestones.")


if __name__ == "__main__": main()
