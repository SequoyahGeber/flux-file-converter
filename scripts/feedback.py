#!/usr/bin/env python3
# SHARED-EXPERIENCE: feedback | standard: PROJECT_STANDARDS.md §Feedback | package: SharedKit/Feedback 0.x
"""Flux's feedback inbox: SharedKit's tools/feedback.py with this app's Config/feedback.json.

Copy to scripts/feedback.py unchanged. Agent Studio's inbox runs `scripts/feedback.py pull`.

    python3 -I scripts/feedback.py pull [--env development] [--no-purge]
    python3 -I scripts/feedback.py delete <recordName> [--creator [--dry-run]]
    python3 -I scripts/feedback.py purge-old [--days 365] [--dry-run]
    python3 -I scripts/feedback.py schema

SHAREDKIT_HOME overrides where SharedKit is checked out (default ~/dev/SharedKit).
"""
import os
import pathlib
import subprocess
import sys

COMMANDS = ("pull", "delete", "purge-old", "schema")  # add_parser("pull") is in SharedKit's tools/feedback.py
ROOT = pathlib.Path(__file__).resolve().parent.parent
SHAREDKIT = pathlib.Path(os.environ.get("SHAREDKIT_HOME", str(pathlib.Path.home() / "dev/SharedKit"))).expanduser()
TOOL = SHAREDKIT / "tools" / "feedback.py"

if __name__ == "__main__":
    if not TOOL.is_file():
        sys.exit(f"SharedKit's feedback tool is not at {TOOL}; set SHAREDKIT_HOME.")
    sys.exit(subprocess.call([sys.executable, "-I", str(TOOL), "--config", str(ROOT / "Config" / "feedback.json"),
                              *sys.argv[1:]]))
