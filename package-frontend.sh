#!/bin/bash
# Package the Goose Electron frontend assets into a tarball
# Run this on Windows (Git Bash) or wherever the Goose desktop app is installed
#
# The frontend assets come from the Goose Electron app's Vite output.
# On Windows: %TEMP%\goose-app\.vite\renderer\main_window\
# On macOS:   /tmp/goose-app/.vite/renderer/main_window/

set -euo pipefail

if [ -d "/c/Users/$USER/AppData/Local/Temp/goose-app/.vite/renderer/main_window" ]; then
    SRC="/c/Users/$USER/AppData/Local/Temp/goose-app/.vite/renderer/main_window"
elif [ -d "/tmp/goose-app/.vite/renderer/main_window" ]; then
    SRC="/tmp/goose-app/.vite/renderer/main_window"
else
    echo "ERROR: Goose frontend assets not found."
    echo "Make sure the Goose desktop app has been run at least once."
    exit 1
fi

OUTPUT="${1:-goose-frontend.tar.gz}"
echo "Packaging frontend from: $SRC"
tar czf "$OUTPUT" -C "$SRC" .
echo "Created: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo ""
echo "Transfer to target machine and install with:"
echo "  ./install.sh $OUTPUT"
