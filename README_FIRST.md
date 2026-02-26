# TALA (The Autonomous Local Agent)

Welcome to the TALA source repository!

To keep this repository lightweight and fast to clone, we have **intentionally excluded** heavy environments, binaries, and models from version control. This means:
- No `node_modules\` folder.
- No Python `venv\` folders or installed libraries.
- No pre-compiled `llama-cpp` binaries.
- No heavy LLM `.gguf` model files.

Instead of downloading a massive repository, you will use our automated bootstrap script to construct your local environment freshly on your machine.

---

## 🚀 Installation Guide

### Prerequisites
Before running the installer, ensure you have the following installed on your system and available in your global PATH:
1. **[Node.js](https://nodejs.org/)** (v18 or higher)
2. **[Python](https://python.org/downloads/)** (3.10 or higher) - *Make sure to check "Add Python to PATH" during installation.*

### Step 1: Bootstrap the Environment
Open a terminal in the root directory of this repository and run the setup script for your operating system:

**For Windows (PowerShell):**
```powershell
.\bootstrap.ps1
```

**For macOS / Linux (Bash):**
```bash
chmod +x bootstrap.sh
./bootstrap.sh
```

**What this script does:**
1. Validates your Node.js and Python installations.
2. Creates the missing directory structures (`models\`, `data\`, `memory\`).
3. Automatically downloads a fast, high-quality, quantized Llama 3 LLM (~2GB) directly into your `models\` folder.
4. Runs `npm install` to download all React and Electron UI dependencies.
5. Loops through all the backend AI services (Inference Engine, World Engine, Astro Engine, Mem0) and builds isolated Python virtual environments for each.
6. Installs Python libraries cleanly using pre-built library wheels, allowing you to bypass complex C++ compilation steps for libraries like `llama-cpp-python`.

*Note: Depending on your internet speed, downloading the LLM model and dependencies may take 5–10 minutes.*

### Step 2: Start TALA
Once the bootstrap script finishes with a green `SUCCESS`, you are ready to boot up the autonomous agent!

From the same terminal, run:
```powershell
npm run dev
```

Alternatively, you can double-click the `start.bat` file in the root directory.

The system will start Vite, launch the Electron window, and simultaneously spin up the Local Inference Server and background MCP microservices. 

Enjoy your shiny new local AI agent!
