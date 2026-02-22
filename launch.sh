#!/bin/bash
# ============================================================
# TALA UNIVERSAL LAUNCHER - macOS / Linux
# ============================================================
# Usage: ./launch.sh

cd "$(dirname "$0")"

if [[ "$OSTYPE" == "darwin"* ]]; then
    PLATFORM="mac"
    APP_PATH="platforms/mac/Tala.app/Contents/MacOS/Tala"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    PLATFORM="linux"
    APP_PATH="platforms/linux/tala"
else
    echo "[ERROR] Unsupported platform: $OSTYPE"
    exit 1
fi

echo "[TALA] Detected platform: $PLATFORM"

if [ -f "$APP_PATH" ]; then
    echo "[TALA] Launching..."
    chmod +x "$APP_PATH"
    "$APP_PATH" &
elif [ -f "platforms/$PLATFORM/tala" ]; then
    chmod +x "platforms/$PLATFORM/tala"
    "platforms/$PLATFORM/tala" &
else
    echo "[ERROR] Tala binary not found at: $APP_PATH"
    echo ""
    echo "This platform may not have been built yet."
    echo "Build on this platform with: npm run dist"
    exit 1
fi

echo "[TALA] Running."
