# Flux public beta review

The review-ready release is 1.0.3, build 2026100305, for Mac and iPhone in the same App Store Connect record (`6818735397`). The previous local release is 1.0.2; the older server-client builds are retired.

## Trove precedent

Trove’s Guideline 2.1(a) issue required a complete reviewer path, including account-gated integrations. The fixes were a normal Release demo using fictional records, reachable offline privacy/support information, complete review contact, live public policy/support URLs and notes describing the exact binary. App Store Connect read-back on October 3 confirmed both October 1 Trove submissions were APPROVED.

Flux needs no account or demo credentials. Its fictional PNG, styled DOCX, MP4, JSON and ZIP samples use the real on-device converter and normal save flow. Both platforms include an offline privacy policy; Mac keeps the original sidebar workspace. The reviewer instructions in [beta-review-notes.txt](beta-review-notes.txt) match these screens and explicitly disclose format, codec, layout and resource limits.

## Public information

- [Privacy policy](https://sequoyahgeber.github.io/flux-file-converter/privacy/)
- [Support](https://sequoyahgeber.github.io/flux-file-converter/support/)

`scripts/prepare-beta-resources.py` reproduces the sample files, offline policy/help and static pages from source. GitHub Pages receives only `docs/site`, through the pinned workflow in `.github/workflows/review-pages.yml`. It contains no upload endpoint, account gate or analytics. The separate Unraid converter and its domain are unaffected.

## Verification and release

Run the shared engine tests, the Release iPhone `ReviewerAccessTests` from the generated project and the Mac walkthrough. The tests exercise all five bundled samples and verify PDF → PNG keeps original bytes unchanged through conversion, save-copy, cancellation, failed naming and temporary cleanup. iPhone UI tests launch normally, use no private test mode or launch arguments, read the offline policy and reach the system save picker. Simulator checks do not establish physical-iPhone TestFlight acceptance.

Generate both projects, build signed artifacts with `scripts/mac-release.py` and `scripts/ios-release.py`, validate/upload those exact hashes with Apple’s CLI, then confirm VALID, externally eligible and export-compliant states by platform. Keep artifacts, private keys, review contacts and raw logs outside Git.

`python3 scripts/beta-review.py 2026100305` is read-only. It checks live pages, exact source/artifact receipts, reviewer evidence, processing, export compliance, complete contacts and current metadata. `--apply-metadata` reads the existing owner contact from `~/.appstoreconnect/flux/BetaReviewContact.local.json`, writes the walkthrough/description/privacy URL and verifies Apple’s saved values without printing private contact details. `--submit` requests Beta App Review, verifies its state and disables automatic tester notification. Credentials live in the private Flux App Store Connect configuration.

Submission does not enable public links or invite testers. WAITING_FOR_REVIEW is not approval. Verify Apple’s final review state before enabling a public external group. Existing internal testing remains separate.

## Apple references

- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), especially 2.1, 2.3, 4.2 and 5.1.1.
- [Provide TestFlight test information](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information/).
- [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/).
