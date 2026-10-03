#!/usr/bin/env python3
"""Preflight exact Mac/iPhone builds; optionally apply metadata and request Beta App Review.

Read-only by default. Review submission does not enable a public link or invite/notify testers.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request
import asc

ROOT = Path(__file__).resolve().parents[1]
APP = "6818735397"
SITE = "https://sequoyahgeber.github.io/flux-file-converter"
CONTACT = Path.home() / ".appstoreconnect/flux/BetaReviewContact.local.json"
CONTACT_FIELDS = ["contactFirstName", "contactLastName", "contactEmail", "contactPhone"]
DESCRIPTION = ("Flux converts files entirely on your Mac or iPhone, with no account or server connection. "
    "Convert images, compatible media, supported documents, PDF, structured data and subtitles. "
    "Compress supported files, create ZIP archives and extract ZIP safely. Choose output names and save locations. "
    "Try a sample includes fictional files using the real converter. Local support depends on content and codecs; "
    "see Supported conversions / All formats. Media is limited to 5 GB and other files to 512 MB. "
    "Keep Flux open during conversion. No advertising, analytics or tracking. Support: " + SITE + "/support/")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build", help="Exact shared numeric build, never latest")
    parser.add_argument("--apply-metadata", action="store_true")
    parser.add_argument("--submit", action="store_true")
    args = parser.parse_args()
    if not args.build.isdigit(): parser.error("Use a numeric build.")
    issues = []
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    version = (ROOT / "native/VERSION").read_text().strip()
    notes = (ROOT / "docs/beta-review-notes.txt").read_text().strip()
    if int(args.build) < 2026100305 or version != "1.0.3": issues.append("Use the review-ready 1.0.3 build or update this preflight for the new release.")
    for page, title in [("privacy", "Flux privacy policy"), ("support", "Flux support")]:
        try:
            with urllib.request.urlopen(SITE + "/" + page + "/", timeout=20) as response:
                live = response.status == 200 and "<h1>" + title + "</h1>" in response.read(200_000).decode()
        except (OSError, UnicodeError): live = False
        print(page + ": " + ("live" if live else "NOT LIVE"))
        if not live: issues.append("Publish the public " + page + " page.")
    proof_path = ROOT / ".test-output/beta-review-verification.json"
    proof = json.loads(proof_path.read_text()) if proof_path.is_file() else {}
    if proof.get("sourceCommit") != commit or not all(proof.get(key) for key in ["macReviewerWalkthrough", "iphoneReleaseReviewerUITest", "inputPreservationTests"]):
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
        artifact = Path(receipt.get("artifact", "/nonexistent-flux-artifact"))
        if receipt.get("sourceCommit") != commit or not receipt.get("appleUploadAccepted") or not receipt.get("appleValidationVerified") or not artifact.is_file() or hashlib.sha256(artifact.read_bytes()).hexdigest() != receipt.get("sha256"):
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
