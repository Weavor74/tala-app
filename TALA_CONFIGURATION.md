# Tala Configuration & Defaults

## Configuration Files
Tala persists her state in two primary JSON files located in the OS "User Data" directory.
- **Windows**: `%APPDATA%\tala-app\`
- **Linux**: `~/.config/tala-app/`

### 1. `app_settings.json` (System Config)
Stores technical infrastructure settings.
- **Inference**: Array of model backends (Ollama, OpenAI, Custom).
  - Defaults to `http://127.0.0.1:11434` (Ollama) with model `llama3`.
- **Agent**: Profile definitions (System Prompts, Temperatures).
  - Stores `activeProfileId`.
  - Stores `astroBirthDate` / `astroBirthPlace` for the emotional engine.
- **Auth**: Cloud keys for provider APIs (Google, GitHub, Microsoft).
- **Storage**: Paths for local vector database (`tala-core`).

### 2. `user_profile.json` (User Context)
Stores information about YOU (The User) to give Tala context.
- **Identity**: Name, RP Name, Locations.
- **Work**: Current role, company.
- **Education/Skills**.
- **Preferences**.
- **Important**: This is injected into the prompt via the `[USER_CONTEXT]` variable.

---

## Default Architecture Configuration

### **A. Inference (The Brain)**
By default, Tala is configured to run **Local-First**.
```json
"inference": {
  "instances": [
    {
      "id": "default-local",
      "alias": "Ollama (Local)",
      "engine": "ollama",
      "endpoint": "http://127.0.0.1:11434",
      "model": "llama3",
      "priority": 0
    }
  ]
}
```
*Note: This requires Ollama to be installed and running on port 11434.*

### **B. System Prompts (The Personality)**
The default system prompt handles the injection of the various modules:
```text
You are Tala.
[ASTRO_STATE] (Injected by astro-engine)

Context:
[USER_CONTEXT] (Injected from user_profile.json)
[CAPABILITY_CONTEXT] (Injected from System Rules + Tools)

User Query: [USER_QUERY]
```

### **C. Micro-Services (The Soul)**
The `mcp-servers/` directory contains the Python environments.
- **tala-core**: Defaults to storing vectors in `./data/chroma_db`.
- **astro-engine**: Defaults to using `swisseph` for calculations required for the [ASTRO_STATE].

---

## Missing / To-Be-Completed
While the core checks are in place, the following configuration UX is needed:

1.  **Model Manager UI**: A screen to easily switch between Ollama models (e.g., `llama3` vs `mistral` vs `deepseek`) without editing JSON.
2.  **API Key Box**: A secure input field in Settings to add OpenAI/Anthropic/Google keys for the "Cloud fallback" mode.
3.  **Backup Scheduler**: The configuration exists (`intervalHours: 24`), but the automated cron job to actually zip up the `memory/` folder is implemented but not exposed in the UI yet.
