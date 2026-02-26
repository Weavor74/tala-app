#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

# Define color codes for output
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}=============================================${NC}"
echo -e "${CYAN}      TALA UNIVERSAL BOOTSTRAP SCRIPT        ${NC}"
echo -e "${CYAN}=============================================${NC}"
echo ""

# ---------------------------------------------------------
# 1. Environment Checks
# ---------------------------------------------------------
echo -e "${YELLOW}[1/5] Checking Prerequisites...${NC}"

# Check Node
if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node --version)
    echo -e "      ${GREEN}[OK] Node.js found: $NODE_VER${NC}"
else
    echo -e "      ${RED}[ERROR] Node.js is not installed or not in PATH.${NC}"
    echo "      Please install Node.js (v18+) from https://nodejs.org/"
    exit 1
fi

# Check Python (Try python3 first, then python)
if command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_CMD="python"
else
    echo -e "      ${RED}[ERROR] Python 3 is not installed or not in PATH.${NC}"
    echo "      Please install Python 3.10+ from https://python.org/"
    exit 1
fi

PY_VER=$($PYTHON_CMD --version)
echo -e "      ${GREEN}[OK] Python found: $PY_VER${NC}"

# Check for curl or wget for downloading
if command -v curl >/dev/null 2>&1; then
    DOWNLOAD_CMD="curl -L -o"
elif command -v wget >/dev/null 2>&1; then
    DOWNLOAD_CMD="wget -O"
else
    echo -e "      ${RED}[ERROR] Neither 'curl' nor 'wget' was found.${NC}"
    echo "      Please install one of them to download the model."
    exit 1
fi

# ---------------------------------------------------------
# 2. Create Missing Folders
# ---------------------------------------------------------
echo -e "\n${YELLOW}[2/5] Creating Runtime Directories...${NC}"

DIRS=("models" "data" "bin/python-mac" "bin/python-linux" "memory")
for DIR in "${DIRS[@]}"; do
    if [ ! -d "$DIR" ]; then
        mkdir -p "$DIR"
        echo "      Created: $DIR"
    else
        echo "      Exists: $DIR"
    fi
done

# ---------------------------------------------------------
# 3. Download LLM (.gguf)
# ---------------------------------------------------------
echo -e "\n${YELLOW}[3/5] Downloading Default Local LLM...${NC}"

MODEL_URL="https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf"
MODEL_DEST="models/Llama-3.2-3B-Instruct-Q4_K_M.gguf"

if [ ! -f "$MODEL_DEST" ]; then
    echo "      Downloading Llama 3.2 3B Instruct (Q4_K_M)..."
    echo "      This is a ~2GB file and may take a few minutes depending on your connection."
    $DOWNLOAD_CMD "$MODEL_DEST" "$MODEL_URL"
    echo -e "      ${GREEN}[OK] Model downloaded successfully.${NC}"
else
    echo -e "      ${GREEN}[OK] Model already exists. Skipping download.${NC}"
fi

# ---------------------------------------------------------
# 4. Install Node Libraries
# ---------------------------------------------------------
echo -e "\n${YELLOW}[4/5] Installing Node.js Dependencies...${NC}"

if [ -f "package.json" ]; then
    echo "      Running npm install..."
    npm install
    echo -e "      ${GREEN}[OK] Node packages installed.${NC}"
else
    echo -e "      ${RED}[ERROR] package.json not found. Are you in the TALA project root?${NC}"
    exit 1
fi

# ---------------------------------------------------------
# 5. Setup Python Virtual Envs & MCP Servers
# ---------------------------------------------------------
echo -e "\n${YELLOW}[5/5] Building Python Virtual Environments...${NC}"

build_venv() {
    local PATH_DIR=$1
    local REQ_FILE="$PATH_DIR/requirements.txt"
    local VENV_DIR="$PATH_DIR/venv"
    local VENV_PYTHON="$VENV_DIR/bin/python"

    if [ ! -f "$REQ_FILE" ]; then
        return
    fi

    echo "      -> Setting up $PATH_DIR..."

    # Create Venv
    if [ ! -d "$VENV_DIR" ]; then
        $PYTHON_CMD -m venv "$VENV_DIR"
    fi

    # Upgrade pip
    "$VENV_PYTHON" -m pip install --upgrade pip --quiet

    # Install dependencies
    if [[ "$PATH_DIR" == *"local-inference"* ]]; then
        echo "         Installing dependencies (this may compile llama-cpp-python)..."
        # On Mac/Linux, we generally rely on pip finding a compatible wheel or 
        # compiling it using local build tools (Xcode/build-essential).
        # We also pass the extra index URL just in case a compatible wheel exists there.
        "$VENV_PYTHON" -m pip install -r "$REQ_FILE" --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu --quiet
    else
        "$VENV_PYTHON" -m pip install -r "$REQ_FILE" --quiet
    fi

    echo -e "         ${GREEN}[OK] Installed.${NC}"
}

PYTHON_MODULES=(
    "local-inference"
    "mcp-servers/tala-core"
    "mcp-servers/mem0-core"
    "mcp-servers/astro-engine"
    "mcp-servers/world-engine"
)

for MOD in "${PYTHON_MODULES[@]}"; do
    if [ -d "$MOD" ]; then
        build_venv "$MOD"
    fi
done

echo -e "\n${CYAN}=============================================${NC}"
echo -e "${GREEN}   BOOTSTRAP COMPLETE!                       ${NC}"
echo -e "${CYAN}=============================================${NC}"
echo "You can now start TALA by running:"
echo "  > npm run dev"
echo ""
