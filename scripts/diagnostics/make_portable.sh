#!/bin/bash
set -e

# Resolve repo root from this script's location (scripts/diagnostics/ -> scripts/ -> repo root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

echo "============================================================"
echo "     TALA - FULLY PORTABLE BUILD CREATOR (Linux/Mac)"
echo "============================================================"
echo ""
echo "This script creates a ZERO-INSTALLATION portable build."
echo "Target machines will NOT need Python or Node.js installed."
echo "Repo root: $REPO_ROOT"
echo ""
echo "PREREQUISITES:"
echo "1. Download Python 3.13 for your platform:"
echo "   Linux: https://www.python.org/ftp/python/3.13.3/Python-3.13.3.tar.xz"
echo "   Mac: https://www.python.org/ftp/python/3.13.3/python-3.13.3-macos11.pkg"
echo "2. For Linux: Extract to resources/python-3.13-linux/"
echo "   For Mac: Install and copy from /Library/Frameworks/Python.framework/Versions/3.13"
echo ""
read -p "Press Enter to continue..."

# Detect platform
if [[ "$OSTYPE" == "darwin"* ]]; then
    PLATFORM="mac"
    PYTHON_DIR="bin/python-portable"
    PYTHON_SOURCE="/Library/Frameworks/Python.framework/Versions/3.13"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    PLATFORM="linux"
    PYTHON_DIR="bin/python-portable"
    PYTHON_SOURCE="resources/python-3.13-linux"
else
    echo "[ERROR] Unsupported platform: $OSTYPE"
    exit 1
fi

echo "[PLATFORM] Detected: $PLATFORM"

# Check for Python source
if [ ! -d "$PYTHON_SOURCE" ]; then
    echo "[ERROR] Python source not found at $PYTHON_SOURCE"
    echo "Please install/extract Python 3.13 first."
    exit 1
fi

# Create directories
mkdir -p "resources"
if [ -d "$PYTHON_DIR" ]; then
    echo "[INFO] Removing old portable python..."
    rm -rf "$PYTHON_DIR"
fi
mkdir -p "$PYTHON_DIR"

# Copy Python runtime
echo "[STEP 1/5] Copying Python 3.13 runtime..."
if [ "$PLATFORM" == "mac" ]; then
    cp -R "$PYTHON_SOURCE/"* "$PYTHON_DIR/"
else
    # For Linux, we need to compile or use pyenv
    echo "[WARNING] For Linux, consider using pyenv to create a relocatable environment"
    echo "Or use a pre-built Python from python.org"
    # Simplified: assume user provides a working Python installation
    cp -R "$PYTHON_SOURCE/"* "$PYTHON_DIR/"
fi

# Ensure pip is available
echo "[STEP 2/5] Ensuring pip is installed..."
"$PYTHON_DIR/bin/python3" -m ensurepip --upgrade

# Install local-inference dependencies
echo "[STEP 3/5] Installing Local Inference dependencies..."
if [ -f "local-inference/requirements.txt" ]; then
    "$PYTHON_DIR/bin/python3" -m pip install -r "local-inference/requirements.txt"
else
    echo "[SKIP] local-inference/requirements.txt not found"
fi

# Install MCP server dependencies
echo "[STEP 4/5] Installing MCP Server dependencies..."
for dir in "mcp-servers/tala-core" "mcp-servers/mem0-core" "mcp-servers/astro-engine"; do
    if [ -f "$dir/requirements.txt" ]; then
        echo "  Installing $dir..."
        "$PYTHON_DIR/bin/python3" -m pip install -r "$dir/requirements.txt"
    fi
done

# Make executable
echo "[STEP 5/5] Setting permissions..."
if [ -n "$PYTHON_DIR" ] && [ -f "$PYTHON_DIR/bin/python3" ]; then
    chmod +x "$PYTHON_DIR/bin/python3"
else
    echo "[WARN] Could not find $PYTHON_DIR/bin/python3 to set permissions"
fi

echo ""
echo "============================================================"
echo "[SUCCESS] Portable Build Created!"
echo ""
echo "Next Steps:"
echo "1. Run: npm run dist"
echo "2. Copy dist/ to USB"
echo "3. Test on a clean machine (no Python/Node installed)"
echo "============================================================"
