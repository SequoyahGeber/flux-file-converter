#!/usr/bin/env python3
"""Unit test for beta-review.py's export receipt (an iPhone build exported straight to App Store Connect).

Standard library only, no network: `python3 -I tests/beta-review-receipt.py`.
"""
import importlib.util
import os
from pathlib import Path
import plistlib
import sys
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.modules["asc"] = types.ModuleType("asc")  # beta-review.py imports it; these tests never call App Store Connect
spec = importlib.util.spec_from_file_location("beta_review", ROOT / "scripts/beta-review.py")
beta_review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(beta_review)

BUILD = "2026111702"
BUILD_ID = "86e0d64d-0000-4000-8000-000000000000"


class ExportReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.app = self.root / "release/testflight/ios-x/Flux.xcarchive/Products/Applications/Flux.app"
        (self.app / "Frameworks").mkdir(parents=True)
        (self.app / "Info.plist").write_bytes(plistlib.dumps({"CFBundleVersion": BUILD}))
        (self.app / "Flux").write_bytes(b"binary")
        (self.app / "Frameworks/lib.dylib").write_bytes(b"lib")
        os.symlink("lib.dylib", self.app / "Frameworks/current")
        self.receipt = {"sourceCommit": "4ae8678", "uploadMethod": beta_review.EXPORT_UPLOAD,
                        "archive": "release/testflight/ios-x/Flux.xcarchive",
                        "appSha256": beta_review.app_tree_sha256(self.app), "bundleVersion": BUILD,
                        "ascBuildId": BUILD_ID}
        self.asc = {"id": BUILD_ID, "attributes": {"processingState": "VALID"}}

    def tearDown(self):
        self.temp.cleanup()

    def issues(self, receipt=None, build=BUILD, asc_build="default"):
        return beta_review.export_receipt_issues(receipt or self.receipt, build,
                                                 self.asc if asc_build == "default" else asc_build, self.root)

    def test_a_matching_receipt_holds(self):
        self.assertEqual(self.issues(), [])

    def test_the_digest_is_stable_across_a_copy(self):
        copy = self.root / "copy.app"
        os.system(f"cp -R '{self.app}' '{copy}'")
        self.assertEqual(beta_review.app_tree_sha256(copy), self.receipt["appSha256"])

    def test_a_changed_file_is_refused(self):
        (self.app / "Frameworks/lib.dylib").write_bytes(b"other")
        self.assertIn("archived app digest differs from the receipt", self.issues())

    def test_a_renamed_or_added_file_is_refused(self):
        (self.app / "extra").write_bytes(b"")
        self.assertIn("archived app digest differs from the receipt", self.issues())

    def test_a_changed_symlink_is_refused(self):
        (self.app / "Frameworks/current").unlink()
        os.symlink("elsewhere", self.app / "Frameworks/current")
        self.assertIn("archived app digest differs from the receipt", self.issues())

    def test_another_build_number_is_refused(self):
        self.assertTrue(any("is not build 2026111703" in issue for issue in self.issues(build="2026111703")))

    def test_an_app_store_connect_build_that_is_not_valid_is_refused(self):
        for record in [None, {"id": BUILD_ID, "attributes": {"processingState": "PROCESSING"}},
                       {"id": "other", "attributes": {"processingState": "VALID"}}]:
            self.assertTrue(any("is not VALID" in issue for issue in self.issues(asc_build=record)), record)

    def test_every_field_is_required(self):
        for key in ["sourceCommit", "archive", "appSha256", "bundleVersion", "ascBuildId"]:
            receipt = dict(self.receipt); receipt.pop(key)
            self.assertIn(f"receipt lacks {key}", self.issues(receipt))

    def test_a_missing_archive_is_refused(self):
        receipt = dict(self.receipt, archive="release/testflight/none/Flux.xcarchive")
        self.assertTrue(any("holds no single app" in issue for issue in self.issues(receipt)))

    def test_the_test_is_release_tooling(self):
        self.assertIn("tests/beta-review-receipt.py", beta_review.RELEASE_TOOLING)


if __name__ == "__main__":
    unittest.main()
