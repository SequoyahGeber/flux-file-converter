#!/bin/sh
# Use Calibre's own embedded Python, with built-in MIME mappings. macOS's
# system Apache MIME table is outside the inherited application sandbox.
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$root/apps/calibre.app/Contents/MacOS/calibre-debug" --run-without-debug -c 'import mimetypes; mimetypes.knownfiles = []; mimetypes.init(files=[]); from calibre.ebooks.conversion.cli import main; raise SystemExit(main())' -- "$@"
