# TALA — The Autonomous Living Agent

> A desktop AI assistant with memory, emotion, and agency.

---

## What Is Tala?

Tala is an **Electron + React desktop application** that turns any LLM into an autonomous agent with persistent memory, real-time emotional modulation, visual workflows, browser automation, and full local system access. Unlike cloud-only chatbots, Tala runs on your machine, talks to your files, remembers your conversations, and adapts its personality through an astrological emotion engine.

The name stands for **The Autonomous Living Agent** — an AI that doesn't just answer questions, but lives alongside you: learning your preferences, executing scripts, browsing the web, managing Git repos, and evolving its own emotional tone over time.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Electron Main Process               │
│                                                         │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────┐  │
│  │ AgentService │───▶│  Brain Layer │    │  ToolService│  │
│  │  (orchestr.) │    │ Cloud/Ollama │    │  (registry) │  │
│  └──────┬───┬──┘    └──────────────┘    └────────────┘  │
│         │   │                                           │
│    ┌────┘   └────┬──────────┬──────────┬─────────┐      │
│    ▼             ▼          ▼          ▼         ▼      │
│  Memory       RAG        Astro     Terminal   Files/Git │
│  Service    Service     Service    Service    Service    │
│    │           │           │                             │
└────┼───────────┼───────────┼────────────────────────────┘
     │           │           │
     ▼           ▼           ▼
┌─────────┐ ┌─────────┐ ┌──────────────┐
│ Mem0 MCP│ │Tala-Core│ │ Astro Engine │
│ (facts) │ │  (RAG)  │ │  (emotions)  │
└─────────┘ └─────────┘ └──────────────┘

┌─────────────────────────────────────────────────────────┐
│                  React Renderer Process                  │
│                                                         │
│  Chat │ FileExplorer │ Terminal │ Browser │ Workflows   │
│  Settings │ UserProfile │ SourceControl │ GitView       │
│  Library │ Search │ A2UI Renderer                       │
└─────────────────────────────────────────────────────────┘
```

The application is split into two Electron processes connected by an IPC bridge:

- **Main process** (Node.js) — runs all backend services with full system access.
- **Renderer process** (React) — the user-facing UI, sandboxed and communicating only through `window.tala.*` APIs exposed by the preload script.

---

## Core Systems

### 1. Brain Layer — LLM Inference

Tala is **model-agnostic**. It defines an `IBrain` interface with two concrete implementations:

| Brain | Backend | Streaming | Use Case |
|-------|---------|-----------|----------|
| **OllamaBrain** | Ollama HTTP API (`/api/chat`) | Newline-delimited JSON | Local/private inference |
| **CloudBrain** | OpenAI-compatible REST (`/v1/chat/completions`) | Server-Sent Events | Cloud providers (OpenAI, Gemini, Azure, Anthropic, etc.) |

Both support streaming token-by-token to the UI and accept an optional `AbortSignal` for mid-stream cancellation. The active brain is hot-swappable at runtime via Settings — no restart required.

**InferenceService** discovers local engines by port-scanning for Ollama (11434), LlamaCPP (8080), LM Studio (1234), and vLLM (8000), and can install Ollama automatically on Windows.

---

### 2. Memory Architecture — Three-Layer Recall

Tala has a **three-layer memory system**, each serving a different temporal and contextual purpose:

```
┌──────────────────────────────────────────────┐
│              Agent Service                    │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │  Mem0     │  │   RAG    │  │   Astro    │ │
│  │  (hours)  │  │  (years) │  │ (identity) │ │
│  └──────────┘  └──────────┘  └────────────┘ │
└──────────────────────────────────────────────┘
```

| Layer | Service | MCP Server | Storage | What It Remembers |
|-------|---------|------------|---------|-------------------|
| **Short-term** | MemoryService | `mem0-core` | Local JSON + MCP | Facts, preferences, and decisions extracted from the current conversation window |
| **Long-term** | RagService | `tala-core` | ChromaDB vectors | Narrative memory — ingested documents, past conversation logs, and knowledge files retrieved by semantic search |
| **Identity** | AstroService | `astro-engine` | Natal chart profiles | Emotional personality derived from astrological birth data, modulated in real-time by planetary transits |

During every chat turn, `AgentService` queries all three layers and injects the results into the system prompt, giving Tala contextual awareness across time scales from minutes to years.

---

### 3. Astro Emotion Engine — Personality Modulation

The most unique subsystem. The Astro Engine computes a **7-axis emotion vector** that subtly shifts Tala's communication style:

| Axis | What It Controls |
|------|-----------------|
| **Warmth** | Friendliness, empathy, approachability |
| **Wit** | Humor, wordplay, playful tone |
| **Intensity** | Passion, urgency, forcefulness |
| **Melancholy** | Reflective depth, poetic sensibility |
| **Confidence** | Assertiveness, directness |
| **Introspection** | Philosophical depth, self-awareness |
| **Calm** | Measured pace, patience, serenity |

The engine uses **12 pluggable influence modules** — each contributing a delta to the emotion vector:

- **Natal modules** — permanent traits from the birth chart (Sun/Moon/Ascendant signs, natal aspects)
- **Planetary modules** — Mercury (communication), Venus (warmth), Mars (intensity), Jupiter (confidence), Saturn (discipline), outer planets (depth)
- **Transit modules** — real-time modulation based on current planetary positions relative to natal positions

The result is a `System Instructions` + `Style Guide` block injected into every prompt, making Tala's personality feel organic and evolving rather than static.

---

### 4. Agent Loop — Tool-Use Orchestration

`AgentService.chat()` is the heart of Tala. It implements an **agentic tool-use loop**:

```
User message
     │
     ▼
Build system prompt (persona + tools + memory + astro)
     │
     ▼
Truncate conversation history to fit context window
     │
     ▼
┌─── Stream response from brain (with AbortSignal) ◀───────┐
│         │                                     │
│         ▼                                     │
│    Contains tool call?                        │
│    ├── Yes → Execute tool → Feed result back ─┘
│    └── No  → Final response → Send to UI
│
└─── Loop until no more tool calls
     │
     ▼
Persist conversation to chat_history.json
```

**Registered tools** include:
- **File I/O** — `read_file`, `write_file`, `list_files`
- **Browser** — `browse`, `browser_click`, `browser_type`, `browser_scroll`, `browser_screenshot`
- **Terminal** — `terminal_run`, `execute_script`
- **Memory** — `mem0_search`, `mem0_add`, `mem0_log_turn`
- **Desktop** — `desktop_screenshot`, `desktop_input`
- **Discord** — `discord_send`, `discord_read_messages` (decommissioned)
- **Custom functions** — user-defined Python/JS scripts invocable via `$keyword` syntax

---

### 5. Browser Automation

Tala can browse the web autonomously through an embedded `<webview>`:

1. **browser-preload.ts** is injected into the webview; it performs optimized DOM scanning with redundancy pruning, accessibility metadata extraction, and numbered markers (max 300).
2. The agent receives a rich text representation of the page (URL, page readiness, scroll position, indexed element list with visibility status).
3. It issues commands (`click`, `type`, `scroll`) by element index.
4. Action confirmation ensures the agent waits for a successful interaction response from the browser.
5. IPC communication is hardened with a two-stage 15s/30s retry logic, request re-emission, and an `executeJavaScript` fallback bridge.
6. Screenshots are captured on demand for vision-capable models.

Additionally, **browser-use-core** (a separate MCP server) provides fully autonomous browser tasks using the `browser-use` library with LLM-driven navigation.

---

### 6. Visual Workflows

The **WorkflowEditor** provides a drag-and-drop canvas (ReactFlow) for building automation pipelines. **20 node types** are available:

| Category | Nodes |
|----------|-------|
| **Control** | `start`, `input`, `manual`, `if`, `split`, `merge`, `wait` |
| **AI** | `agent`, `ai_model`, `model_config`, `guardrail` |
| **Integration** | `function`, `tool`, `http`, `email_read`, `credential` |
| **Data** | `memory_read`, `memory_write`, `edit_fields` |
| **Composition** | `subworkflow` |

Workflows are executed by **WorkflowEngine** using BFS traversal with support for branching, splitting, merging, and circular detection.

---

### 7. Terminal & Script Execution

**TerminalService** spawns a persistent system shell (PowerShell on Windows, bash on macOS/Linux) and streams I/O bidirectionally. The agent can execute arbitrary commands and read the output.

**FunctionService** manages user-defined scripts in `.agent/functions/`. Functions are Python or JavaScript files invocable by the agent using `$keyword` syntax. The agent can also create and modify functions dynamically.

---

## Frontend Components

The React renderer provides a rich IDE-like interface:

| Component | Purpose |
|-----------|---------|
| **Chat pane** | Streaming markdown chat with the agent |
| **FileExplorer** | Tree-view file browser with context menus (create, delete, rename, copy, move) |
| **Terminal** | Embedded xterm.js terminal |
| **Browser** | Embedded webview with URL bar and agent automation |
| **WorkflowEditor** | Visual node-based workflow builder |
| **Settings** | Full configuration: inference, auth, backup, MCP, guardrails |
| **UserProfile** | Deep profile editor (identity, professional, astrology, goals, social) |
| **SourceControl** | Basic Git operations (stage, commit, sync, clone) |
| **GitView** | Advanced Git (branches, stash, diff, history) |
| **Library** | Document library with RAG ingestion and search |
| **Search** | Local file search + web search with result scraping |
| **A2UIRenderer** | Agent-to-UI: the agent can dynamically render React components |

---

## IPC Bridge

The preload script (`preload.ts`) exposes **~55 methods** on `window.tala`, organized into groups: Version, IPC, Profile, Settings, **Chat Control** (cancel, history, clear), System, Files, Terminal, Git, MCP, Functions, Workflows, RAG, and Browser. Every user action in the renderer goes through this bridge to the main process.

A separate **browser-preload.ts** is injected into the embedded webview for DOM perception and interaction commands.

---

## MCP Server Ecosystem

Four Python microservices extend Tala's capabilities via the **Model Context Protocol (MCP)** over stdio:

| Server | Package | Purpose |
|--------|---------|---------|
| **tala-core** | `mcp-servers/tala-core/` | Long-term RAG memory via ChromaDB — file ingestion, semantic search, conversation logging |
| **mem0-core** | `mcp-servers/mem0-core/` | Short-term fact memory — stores and retrieves conversational facts and preferences |
| **browser-use-core** | `mcp-servers/browser-use-core/` | Autonomous browser automation using the `browser-use` library |
| **astro-engine** | `mcp-servers/astro-engine/` | Astrological emotion engine — natal charts, transit calculations, emotion vector computation |

All servers are lifecycle-managed by their respective Electron services (`RagService`, `MemoryService`, `AstroService`) and spawned during `AgentService.igniteSoul()`. `McpService.startHealthLoop()` runs a 30-second heartbeat and auto-reconnects any crashed servers.

---

## Data Flow Summary

```
User types message
     │
     ├──▶ AgentService.chat()
     │       │
     │       ├── Query MemoryService (short-term facts)
     │       ├── Query RagService (long-term narrative)
     │       ├── Query AstroService (emotional state)
     │       │
     │       ├── Build system prompt:
     │       │     persona + guardrails + tool descriptions
     │       │     + memory context + astro style guide
     │       │
     │       ├── Stream to Brain (Ollama or Cloud)
     │       │     │
     │       │     ├── Tool call? → Execute → Loop
     │       │     └── Final text → Stream tokens to UI
     │       │
     │       └── Log turn to Mem0 + RAG
     │
     └──▶ React UI renders streaming markdown
```

---

## User Profile System

Tala maintains a **deep user profile** (`user_profile.json`) covering:

- **Identity** — Name, date/place of birth, roleplay alias
- **Contact** — Address, email, phone
- **Professional** — Work history entries
- **Education** — Schools and degrees
- **Personal** — Hobbies as tags
- **Social** — Network of contacts with relationship types

This profile is injected into the system prompt so Tala can personalize every interaction. The **UserProfile** component provides a full editor UI.

---

## Configuration & Settings

All configuration lives in `app_settings.json`, managed through the Settings UI and protected by `SettingsManager.ts` (corrupt JSON backup, default fallback, atomic writes):

| Section | What It Controls |
|---------|-----------------|
| **Inference** | Active brain (local/cloud), model selection, API keys, endpoints |
| **Storage** | RAG vector store provider and path |
| **Backup** | Scheduled workspace backups (interval, destination) |
| **Auth** | GitHub, Google, Azure, Discord OAuth tokens |
| **Server** | Remote server URL and API key |
| **Agent** | Persona name, personality prompt, custom instructions |
| **Source Control** | Git provider, username, token |
| **MCP** | External MCP server configurations |
| **Guardrails** | Behavioral constraints for the agent |
| **Workflows** | Saved workflow definitions |

---

## Technology Stack

| Layer | Technologies |
|-------|-------------|
| **Desktop shell** | Electron 34+ |
| **Frontend** | React 19, TypeScript, Vite, xterm.js, ReactFlow |
| **Backend** | Node.js 22+, Electron IPC |
| **LLM interface** | Raw HTTP/HTTPS streaming (no SDK dependency) |
| **Memory** | ChromaDB (vectors), local JSON (facts), SQLite (mem0) |
| **Astro Engine** | Python 3.11+, Pydantic, Swiss Ephemeris (optional) |
| **MCP** | Model Context Protocol SDK (TypeScript client, Python servers) |
| **Build** | Vite + electron-builder |

---

## Project Structure

```
tala-app/
├── electron/                    # Electron main process
│   ├── main.ts                  # App entry point + IPC handlers
│   ├── preload.ts               # Context bridge (window.tala API)
│   ├── browser-preload.ts       # Webview DOM automation injection
│   ├── brains/                  # LLM inference backends
│   │   ├── IBrain.ts            #   Abstract interface
│   │   ├── CloudBrain.ts        #   OpenAI-compatible cloud
│   │   └── OllamaBrain.ts       #   Local Ollama
│   └── services/                # Backend services (17 files)
│       ├── AgentService.ts      #   Central AI orchestrator
│       ├── SettingsManager.ts   #   Safe settings I/O (backup, fallback, atomic writes)
│       ├── ToolService.ts       #   Tool registry
│       ├── MemoryService.ts     #   Short-term memory (Mem0)
│       ├── RagService.ts        #   Long-term memory (RAG)
│       ├── AstroService.ts      #   Emotion engine lifecycle
│       ├── FileService.ts       #   Sandboxed file I/O
│       ├── GitService.ts        #   Git CLI wrapper
│       ├── TerminalService.ts   #   PTY shell manager
│       ├── SystemService.ts     #   Environment detection
│       ├── InferenceService.ts  #   Local provider discovery
│       ├── McpService.ts        #   MCP client connections
│       ├── BackupService.ts     #   Scheduled backups
│       ├── FunctionService.ts   #   Custom script manager
│       ├── WorkflowService.ts   #   Workflow CRUD
│       ├── WorkflowEngine.ts    #   Workflow executor
│       └── DiscordService.ts    #   Discord bot (decommissioned)
├── src/                         # React renderer process
│   ├── main.tsx                 # React DOM entry point
│   ├── App.tsx                  # Root component + layout
│   └── renderer/
│       ├── A2UIRenderer.tsx     # Agent-to-UI dynamic rendering
│       ├── Settings.tsx         # Configuration editor
│       ├── UserProfile.tsx      # Deep profile editor
│       ├── settingsData.ts      # Settings types + defaults
│       ├── profileData.ts       # Profile types + defaults
│       ├── types.ts             # A2UI type definitions
│       ├── catalog/
│       │   └── BasicComponents.tsx  # A2UI primitives
│       └── components/
│           ├── ErrorBoundary.tsx # React error boundary with retry UI
│           ├── Browser.tsx      # Embedded webview
│           ├── Terminal.tsx      # xterm.js terminal
│           ├── FileExplorer.tsx  # File tree browser
│           ├── SourceControl.tsx # Basic Git panel
│           ├── GitView.tsx      # Advanced Git panel
│           ├── Library.tsx      # Document library
│           ├── Search.tsx       # File + web search
│           └── WorkflowEditor.tsx  # Visual workflow builder
└── mcp-servers/                 # Python MCP microservices
    ├── tala-core/               # RAG + ChromaDB
    ├── mem0-core/               # Short-term fact memory
    ├── browser-use-core/        # Autonomous browser agent
    └── astro-engine/            # Astrological emotion engine
        └── astro_emotion_engine/
            ├── engine.py        # Core emotion computation
            ├── mcp_server.py    # MCP tool registration
            ├── config.py        # Constants + bounds
            ├── schemas/         # Pydantic models (5 files)
            ├── services/        # Business logic (6 files)
            ├── ephemeris/       # Planetary position providers (3 files)
            ├── modules/         # 12 influence modules
            ├── aggregation/     # Vector normalization
            ├── cli/             # Command-line interface
            └── export/          # JSON schema export
```

---

## What Makes Tala Different

1. **Runs locally** — your data stays on your machine. No cloud required (though cloud LLMs are supported).
2. **Three-layer memory** — short-term facts, long-term narrative, and identity persistence across sessions.
3. **Emotional personality** — not a static persona prompt, but a mathematically computed emotion vector that shifts in real-time.
4. **Full system agency** — file operations, terminal commands, Git, browser automation, custom scripts.
5. **Visual workflows** — drag-and-drop automation with 20 node types, no code required.
6. **Model-agnostic** — works with Ollama, OpenAI, Gemini, Anthropic, Azure, LM Studio, vLLM, or any OpenAI-compatible endpoint.
7. **Extensible** — MCP servers, custom functions, workflow nodes, and A2UI dynamic rendering.
8. **Resilient** — settings validation, React error boundaries, conversation persistence, context window management, MCP auto-restart, hardened browser IPC (retries + fallbacks), and streaming cancel.

---

*For the complete file-by-file API reference, see [CODEWIKI.md](./CODEWIKI.md).*
