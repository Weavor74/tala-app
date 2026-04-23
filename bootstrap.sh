#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
cd "$REPO_ROOT"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

log_ok() { echo -e "      ${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "      ${YELLOW}[WARN]${NC} $*"; }
log_err() { echo -e "      ${RED}[ERROR]${NC} $*"; }

OS_NAME="$(uname -s)"
OS_ARCH="$(uname -m)"

echo -e "${CYAN}=============================================${NC}"
echo -e "${CYAN}      TALA UNIVERSAL BOOTSTRAP SCRIPT        ${NC}"
echo -e "${CYAN}=============================================${NC}"
echo -e "      Repo root: ${REPO_ROOT}"
echo -e "      Platform: ${OS_NAME} (${OS_ARCH})"
echo ""

run_apt_install_if_linux() {
    if [ "$OS_NAME" != "Linux" ]; then
        return 0
    fi

    echo -e "${YELLOW}[1/6] Installing Linux Prerequisites (Debian/Ubuntu)...${NC}"

    if [ ! -r /etc/os-release ]; then
        log_err "Cannot read /etc/os-release; Linux distro detection failed."
        exit 1
    fi

    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_LIKE="${ID_LIKE:-}"

    if [[ "$DISTRO_ID" != "ubuntu" && "$DISTRO_ID" != "debian" && "$DISTRO_LIKE" != *"debian"* ]]; then
        log_warn "Detected distro '${DISTRO_ID}'. Automatic package install is only implemented for Debian/Ubuntu."
        log_warn "Install Linux prerequisites manually, then re-run bootstrap."
        return 0
    fi

    if ! command -v apt-get >/dev/null 2>&1; then
        log_err "apt-get is required for Debian/Ubuntu bootstrap but was not found."
        exit 1
    fi

    APT_PREFIX=()
    if [ "$(id -u)" -ne 0 ]; then
        if command -v sudo >/dev/null 2>&1; then
            APT_PREFIX=(sudo)
        else
            log_err "Root privileges are required for apt-get install. Re-run as root or install sudo."
            exit 1
        fi
    fi

    CORE_PACKAGES=(
        build-essential
        cmake
        pkg-config
        python3
        python3-dev
        python3-pip
        python3-venv
        git
        curl
        wget
        ca-certificates
        libpq-dev
        ripgrep
    )

    ELECTRON_PACKAGES=(
        libasound2
        libatk-bridge2.0-0
        libatk1.0-0
        libcairo2
        libcups2
        libdrm2
        libgbm1
        libglib2.0-0
        libgtk-3-0
        libnotify4
        libnss3
        libpango-1.0-0
        libx11-xcb1
        libxcomposite1
        libxdamage1
        libxext6
        libxfixes3
        libxkbcommon0
        libxrandr2
        libxrender1
        libxshmfence1
        libxss1
        libxtst6
        xdg-utils
    )

    echo "      Running apt-get update..."
    "${APT_PREFIX[@]}" apt-get update

    AVAILABLE_CORE=()
    MISSING_CORE=()
    for pkg in "${CORE_PACKAGES[@]}"; do
        if apt-cache show "$pkg" >/dev/null 2>&1; then
            AVAILABLE_CORE+=("$pkg")
        else
            MISSING_CORE+=("$pkg")
        fi
    done

    AVAILABLE_ELECTRON=()
    MISSING_ELECTRON=()
    for pkg in "${ELECTRON_PACKAGES[@]}"; do
        if apt-cache show "$pkg" >/dev/null 2>&1; then
            AVAILABLE_ELECTRON+=("$pkg")
        else
            MISSING_ELECTRON+=("$pkg")
        fi
    done

    if [ "${#MISSING_CORE[@]}" -gt 0 ]; then
        log_err "Missing required package definitions: ${MISSING_CORE[*]}"
        log_err "Your apt sources may be incomplete. Fix apt repositories and re-run."
        exit 1
    fi

    if [ "${#MISSING_ELECTRON[@]}" -gt 0 ]; then
        log_warn "Some Electron runtime packages were not found in apt metadata: ${MISSING_ELECTRON[*]}"
        log_warn "Continuing because package names vary by distro release."
    fi

    echo "      Installing core Linux packages..."
    "${APT_PREFIX[@]}" apt-get install -y "${AVAILABLE_CORE[@]}"

    if [ "${#AVAILABLE_ELECTRON[@]}" -gt 0 ]; then
        echo "      Installing Electron runtime packages..."
        "${APT_PREFIX[@]}" apt-get install -y "${AVAILABLE_ELECTRON[@]}"
    fi

    if [[ "$OS_ARCH" == "aarch64" || "$OS_ARCH" == "arm64" ]]; then
        log_warn "ARM64 detected (Jetson class likely)."
        log_warn "llama-cpp-python may compile from source and can take longer on Jetson hardware."
        log_warn "If local inference is too heavy, keep core Tala services and run without local model first."
    fi
}

echo -e "${YELLOW}[2/6] Checking Core Tool Prerequisites...${NC}"

run_apt_install_if_linux

if command -v node >/dev/null 2>&1; then
    NODE_VER="$(node --version)"
    log_ok "Node.js found: $NODE_VER"
else
    log_err "Node.js is not installed or not in PATH."
    echo "      Install Node.js v18+ from https://nodejs.org/ and re-run bootstrap."
    exit 1
fi

if command -v npm >/dev/null 2>&1; then
    NPM_VER="$(npm --version)"
    log_ok "npm found: $NPM_VER"
else
    log_err "npm is not installed or not in PATH."
    exit 1
fi

if command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_CMD="python"
else
    log_err "Python 3 is not installed or not in PATH."
    exit 1
fi

PY_VER="$("$PYTHON_CMD" --version 2>&1)"
if [[ "$PY_VER" != *"Python 3"* ]]; then
    log_err "Python 3 required but found: $PY_VER"
    exit 1
fi

if ! "$PYTHON_CMD" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"; then
    log_err "Python 3.10+ is required (found: $PY_VER)."
    exit 1
fi
log_ok "Python found: $PY_VER"

if command -v curl >/dev/null 2>&1; then
    DOWNLOAD_CMD=(curl -L -o)
elif command -v wget >/dev/null 2>&1; then
    DOWNLOAD_CMD=(wget -O)
else
    log_err "Neither 'curl' nor 'wget' was found."
    exit 1
fi

echo -e "\n${YELLOW}[3/6] Creating Runtime Directories...${NC}"

DIRS=("models" "data" "bin/python-mac" "bin/python-linux" "memory")
for dir in "${DIRS[@]}"; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        echo "      Created: $dir"
    else
        echo "      Exists: $dir"
    fi
done

echo -e "\n${YELLOW}[4/6] Downloading Default Local LLM...${NC}"

MODEL_URL="https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf"
MODEL_DEST="$REPO_ROOT/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf"

if [ ! -f "$MODEL_DEST" ]; then
    echo "      Downloading Llama 3.2 3B Instruct (Q4_K_M)..."
    echo "      This is a ~2GB file and may take a few minutes."
    "${DOWNLOAD_CMD[@]}" "$MODEL_DEST" "$MODEL_URL"
    log_ok "Model downloaded successfully."
else
    log_ok "Model already exists. Skipping download."
fi

echo -e "\n${YELLOW}[5/6] Installing Node.js Dependencies...${NC}"

if [ -f "$REPO_ROOT/package.json" ]; then
    if [ -f "$REPO_ROOT/package-lock.json" ]; then
        echo "      package-lock.json found - running npm ci for deterministic install."
        npm ci --ignore-scripts
    else
        echo "      No package-lock.json found - running npm install."
        npm install --ignore-scripts
    fi
    log_ok "Node packages installed."
else
    log_err "package.json not found at $REPO_ROOT"
    exit 1
fi

echo -e "\n${YELLOW}[6/6] Building Python Virtual Environments...${NC}"

build_venv() {
    local module_path="$REPO_ROOT/$1"
    local req_file="$module_path/requirements.txt"
    local venv_dir="$module_path/venv"
    local venv_python="$venv_dir/bin/python"

    if [ ! -f "$req_file" ]; then
        echo "      [SKIP] $1 - no requirements.txt"
        return 0
    fi

    echo "      -> Setting up $1..."

    if [ ! -d "$venv_dir" ]; then
        if ! "$PYTHON_CMD" -m venv "$venv_dir"; then
            log_err "Failed to create venv at $venv_dir"
            return 1
        fi
    fi

    "$venv_python" -m pip install --upgrade pip --quiet

    if [[ "$1" == *"local-inference"* ]]; then
        echo "         Installing dependencies (llama-cpp-python may compile)..."
        if ! "$venv_python" -m pip install -r "$req_file" --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu --quiet; then
            log_err "pip install failed for $1"
            return 1
        fi
    else
        if ! "$venv_python" -m pip install -r "$req_file" --quiet; then
            log_err "pip install failed for $1"
            return 1
        fi
    fi

    log_ok "$1 venv ready"
}

PYTHON_MODULES=(
    "local-inference"
    "mcp-servers/tala-core"
    "mcp-servers/mem0-core"
    "mcp-servers/astro-engine"
    "mcp-servers/tala-memory-graph"
    "mcp-servers/world-engine"
)

for mod in "${PYTHON_MODULES[@]}"; do
    if [ -d "$REPO_ROOT/$mod" ]; then
        build_venv "$mod"
    else
        echo "      [SKIP] $mod - directory not found"
    fi
done

echo -e "\n${YELLOW}[post] Validating environment readiness...${NC}"

if command -v node >/dev/null 2>&1; then
    log_ok "Node check: $(node --version)"
else
    log_err "Node check failed."
    exit 1
fi

if command -v npm >/dev/null 2>&1; then
    log_ok "npm check: $(npm --version)"
else
    log_err "npm check failed."
    exit 1
fi

if "$PYTHON_CMD" -m venv --help >/dev/null 2>&1; then
    log_ok "Python venv module available."
else
    log_err "Python venv module unavailable."
    exit 1
fi

for tool in gcc g++ make; do
    if command -v "$tool" >/dev/null 2>&1; then
        log_ok "Native toolchain check: $tool present"
    else
        log_err "Native toolchain check failed: $tool missing"
        exit 1
    fi
done

if command -v pg_config >/dev/null 2>&1; then
    log_ok "PostgreSQL client headers check: pg_config present"
else
    log_warn "pg_config missing. Install libpq-dev if PostgreSQL-backed services fail to build."
fi

echo -e "\n${CYAN}=============================================${NC}"
echo -e "${GREEN}   BOOTSTRAP COMPLETE!                       ${NC}"
echo -e "${CYAN}=============================================${NC}"
echo "You can now start TALA by running:"
echo "  > npm run dev"
echo ""
echo "To verify the environment is ready, run:"
echo "  > bash scripts/verify-setup.sh"
echo ""
