#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v brew >/dev/null; then
  print 'Install Homebrew from https://brew.sh first, then rerun this script.'
  exit 1
fi
brew install ffmpeg-full imagemagick-full pandoc qpdf ghostscript oxipng sevenzip tesseract python@3.12
if [ ! -d /Applications/calibre.app ]; then brew install --cask calibre; fi
if [ ! -d /Applications/LibreOffice.app ]; then brew install --cask libreoffice; fi
if [ ! -d /Applications/Blender.app ]; then brew install --cask blender; fi
/opt/homebrew/bin/python3.12 -m venv resources/python-runtime
resources/python-runtime/bin/python -m pip install -r resources/requirements.txt
npm ci
npm run native
npm run build
print 'Ready. Run npm start, or npm run package to build Flux.app.'
