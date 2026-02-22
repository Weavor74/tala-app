# Tala App — Master Code Documentation

> **Auto-generated reference** describing every folder, file, class, and public method in the Tala codebase.  
> Documentation lives inline in each file as JSDoc / Python docstrings; this file is a single-point index.

---

## Table of Contents

1. [Project Root](#project-root)
2. [electron/](#electron) — Electron Main Process
   - [main.ts](#electronmaints)
   - [preload.ts](#electronpreloadts)
   - [browser-preload.ts](#electronbrowser-preloadts)
   - [brains/](#electronbrains)
   - [services/](#electronservices)
3. [src/](#src) — React Frontend (Renderer Process)
   - [App.tsx](#srcapptsx)
   - [renderer/](#srcrenderer)
   - [renderer/components/](#srcrenderercomponents)
4. [mcp-servers/](#mcp-servers) — Python MCP Backend
   - [tala-core/](#mcp-serverstala-core)
   - [mem0-core/](#mcp-serversmem0-core)
   - [browser-use-core/](#mcp-serversbrowser-use-core)
   - [astro-engine/](#mcp-serversastro-engine)

---

## Project Root

| Path | Purpose |
|------|---------|
| `tala-app/` | Monorepo root for the Tala desktop AI assistant |
| `package.json` | Node dependencies, scripts (`dev`, `build`, `start`) |
| `vite.config.ts` | Vite build config for both Electron main and renderer |
| `tsconfig.json` | TypeScript compiler config |
| `index.html` | HTML shell loaded by the renderer process |

---

## electron/

The **Electron main process** — all backend logic that runs in Node.js with full system access.

### electron/main.ts

**The application entry point.** Bootstraps all services, creates the BrowserWindow, and registers ~60 IPC handlers that bridge the renderer (React UI) to the backend.

| Section | Lines | Description |
|---------|-------|-------------|
| Service instantiation | 1-60 | Creates `SystemService`, `FileService`, `GitService`, `TerminalService`, `FunctionService`, `AgentService`, `WorkflowService`, `WorkflowEngine`, `InferenceService`, `DiscordService`, `McpService` |
| Window creation | — | Creates `BrowserWindow` with `preload.ts`, dark theme, 1400×900 |
| Settings IPC | — | `get-settings`, `save-settings`, `get-profile`, `save-profile` |
| Auth / OAuth IPC | — | `login` handler with local HTTP callback server for GitHub, Google, Azure, Discord |
| Inference IPC | — | `scan-local-providers`, `install-local-engine` |
| File system IPC | — | `list-directory`, `read-file`, `create-file`, `delete-path`, `copy-path`, `move-path` |
| Terminal IPC | — | `init-terminal`, `terminal-input`, `terminal-resize` |
| Git IPC | — | `git-check`, `git-status`, `git-stage`, `git-unstage`, `git-commit`, `git-sync`, `git-*` |
| Chat IPC | — | `chat-message` — the core loop that calls `AgentService.chat()` with token/event streaming |
| Chat control IPC | — | `chat-cancel` (streaming), `get-chat-history`, `clear-chat-history` (legacy), plus Session Management: `list-sessions`, `load-session`, `delete-session`, `new-session` |
| Memory IPC | — | `add-memory`, `get-all-memories`, `delete-memory`, `update-memory` |
| Astro IPC | — | `get-emotion-state` |
| RAG IPC | — | `rag-ingest`, `rag-delete`, `rag-list`, `rag-search` |
| MCP IPC | — | `get-mcp-capabilities` |
| Functions / Workflows | — | CRUD handlers for custom functions and workflows |
| Lifecycle | — | `window-all-closed`, `before-quit`, `activate` — shutdown agent, kill terminals |

---

### electron/preload.ts

**Context bridge** between main process and renderer. Exposes a `window.tala` API with ~50 methods organized into groups:

| Group | Methods |
|-------|---------|
| **Version** | `versions.node()`, `versions.chrome()`, `versions.electron()` |
| **IPC** | `send(channel, data)`, `on(channel, func)`, `off(channel, func)` |
| **Profile** | `saveProfile(data)`, `getProfile()`, `ensureProfile()` |
| **Settings** | `saveSettings(data)`, `getSettings()` |
| **Chat Control** | `cancelChat()`, `getChatHistory()`, `clearChatHistory()`, `listSessions()`, `loadSession(id)`, `deleteSession(id)`, `newSession()` |
| **Memory** | `getAllMemoryItems()`, `addMemoryItem(text)`, `deleteMemoryItem(id)`, `updateMemoryItem(id, text)` |
| **Astro** | `getEmotionState()` |
| **System** | `getSystemInfo()`, `login(provider)`, `scanLocalProviders()`, `installLocalEngine(id)` |
| **Files** | `listDirectory(path)`, `readFile(path)`, `createDirectory(path)`, `deletePath(path)`, `createFile(path, content)`, `copyPath(src, dest)`, `movePath(src, dest)`, `openFolderDialog()`, `getRoot()`, `getAssetPath(name)` |
| **Terminal** | `initTerminal()`, `resizeTerminal(cols, rows)`, `sendTerminalInput(data)` |
| **Git** | `gitCheck()`, `gitStatus()`, `gitStage(file)`, `gitUnstage(file)`, `gitCommit(msg)`, `gitSync(token, user)`, `gitInit()`, `gitClone(url, path)`, `gitRemotes()`, `gitLog(n)`, `gitBranches()`, `gitCheckout(branch)`, `gitCreateBranch(name)`, `gitStash()`, `gitStashPop()`, `gitDiff(file)` |
| **MCP** | `getMcpCapabilities(id)` |
| **Functions** | `getFunctions()`, `saveFunction(name, content, type)`, `deleteFunction(name, type)` |
| **Workflows** | `getWorkflows()`, `saveWorkflow(data)`, `deleteWorkflow(id)`, `importWorkflows(url)`, `executeWorkflow(data)` |
| **RAG** | `ragIngest(file)`, `ragDelete(file)`, `ragList()`, `ragSearch(query)` |
| **Browser** | `provideBrowserData(type, data)` |

---

### electron/browser-preload.ts

**Injected into the `<webview>` tag** for agent-driven web automation.

| Export / Function | Description |
|-------------------|-------------|
| `getInteractiveElements()` | Scans the page DOM (max 800 elements), filters redundant nested elements (pruning), labels interactive elements with numbered markers (max 300), and returns a text representation including ARIA roles, accessibility labels, and viewport visibility status |
| `ensureCursor()` | Maintains a visual cursor SVG in the DOM |
| IPC `agent-action` listener | Handles commands: `ping`, `get_dom`, `cursor_move`, `click_visual`, `click`, `type`, `scroll` |

---

### electron/brains/

Abstraction layer for LLM inference backends.

#### IBrain.ts

**Abstract interface** for all brain implementations.

| Type | Description |
|------|-------------|
| `ChatMessage` | `{ role: 'system'│'user'│'assistant', content: string, images?: string[] }` |
| `BrainResponse` | `{ content: string, tool_calls?: any[], metadata?: any }` |
| `IBrain` (interface) | Contract: `id`, `ping()`, `generateResponse(messages, systemPrompt)`, `streamResponse(messages, systemPrompt, onChunk, signal?)` — optional `AbortSignal` for mid-stream cancellation |

#### CloudBrain.ts

**Cloud inference** via OpenAI-compatible REST APIs (`/v1/chat/completions` with SSE streaming).

| Member | Description |
|--------|-------------|
| `CloudBrainConfig` | `{ endpoint, apiKey?, model }` |
| `constructor(config)` | Stores API config |
| `ping()` | GET `/models` health check |
| `generateResponse(messages, systemPrompt)` | Non-streaming (delegates to `streamResponse`) |
| `streamResponse(messages, systemPrompt, onChunk, signal?)` | SSE streaming via raw `http`/`https` — handles various endpoint URL formats, Gemini-specific body modifications. Optional `AbortSignal` destroys the request for mid-stream cancellation |

#### OllamaBrain.ts

**Local inference** via Ollama HTTP API (`/api/chat`).

| Member | Description |
|--------|-------------|
| `constructor(baseUrl, model)` | Defaults to `localhost:11434`, `llama3` |
| `configure(baseUrl, model)` | Runtime reconfiguration |
| `ping()` | GET `/api/tags` health check |
| `generateResponse(messages, systemPrompt)` | Non-streaming, supports multimodal images |
| `streamResponse(messages, systemPrompt, onChunk, signal?)` | Newline-delimited JSON streaming. Optional `AbortSignal` cancels the fetch and breaks the read loop |

---

### electron/services/

Core backend services (17 files).

---

#### AgentService.ts

**The central AI orchestrator** — coordinates brain, memory, RAG, astro, tools, backup, browser, and terminal.

| Method | Description |
|--------|-------------|
| `constructor(terminal?, functions?)` | Instantiates sub-services: `MemoryService`, `AstroService`, `RagService`, `ToolService`, `BackupService`; defaults to `OllamaBrain`; loads persisted chat history |
| `reloadConfig()` | Hot-swaps brain (Ollama ↔ Cloud) based on `app_settings.json` (via `SettingsManager`) |
| `setSystemInfo(info)` | Injects OS/runtime info for script execution |
| `setDiscordService(discord)` | Registers Discord tools |
| `loadBrainConfig()` | Selection logic: `activeLocalId` → cloud vs. Ollama based on provider type |
| `igniteSoul()` | Boots RAG, Memory, and Astro MCP servers in parallel + starts BackupService |
| `getAstroState()` | Queries Astro Engine for emotional modulation |
| `chat(userMessage, onToken, onEvent?)` | **Main loop**: intercepts `/command` shortcuts → builds system prompt → truncates history to context window → agentic tool-use loop with streaming → handles browser/terminal events. Creates `AbortController` per call. Persists history on completion. |
| `cancelChat()` | Aborts the active streaming response via `AbortController.abort()` |
| `getChatHistory()` | Returns the persisted chat history array |
| `clearChatHistory()` | Empties chat history and deletes `chat_history.json` |
| `estimateTokens(text)` | Rough token count (≈ 4 chars/token) |
| `truncateHistory(messages, maxTokens)` | Drops oldest messages to fit within token budget |
| `waitForBrowserData(type, retry?)` | Promise-based wait for DOM/screenshot/action-response (15s/30s timeout with request re-emission and fallback support) |
| `provideBrowserData(type, data)` | Resolves pending browser data waiters (DOM, screenshot, or click/type confirmation) |
| `getSystemPrompt()` | Builds the full system prompt with guardrails, tools, memory context, astro state |
| `shutdown()` | Kills RAG service |

---

#### ToolService.ts

**Central tool registry** — all callable functions available to the AI.

| Method | Description |
|--------|-------------|
| `constructor()` | Registers core tools immediately |
| `setSystemInfo(info)` | For script execution environment |
| `setRoot(newRoot)` | Sandboxes file I/O |
| `setDiscordService(discord)` | Registers: `discord_list_channels`, `discord_send`, `discord_read_messages` |
| `setMemoryService(memory)` | Registers: `mem0_search`, `mem0_add`, `mem0_log_turn`, `desktop_screenshot`, `desktop_input` |
| `registerCoreTools()` | Registers: `write_file`, `read_file`, `list_files`, `browse`, `browser_click`, `browser_hover`, `browser_type`, `browser_scroll`, `browser_screenshot`, `execute_script`, `terminal_run` |
| `register(tool)` | Adds a `ToolDefinition` to the registry |
| `describeTools()` | Generates prompt injection text listing all tools with JSON Schema parameters |

**ToolDefinition interface**: `{ name, description, parameters, execute(args) → string│{result, images} }`

---

#### McpService.ts

**Manages MCP (Model Context Protocol) server connections** — stdio and WebSocket transports.

| Type / Method | Description |
|---------------|-------------|
| `Connection` | `{ client: Client, transport, process?, config }` |
| `connect(config)` | Establishes stdio or WebSocket connection; deduplicates by ID |
| `disconnect(id)` | Closes client and transport, kills child process |
| `getCapabilities(id)` | Lists tools and resources via MCP SDK |
| `sync(configs)` | Two-phase reconciliation: removes stale connections, adds new ones |
| `startHealthLoop()` | Starts 30s interval health check; auto-reconnects crashed servers using stored config |
| `stopHealthLoop()` | Stops the health check interval |

---

#### MemoryService.ts

**Short-term conversational memory** — dual storage (MCP remote + local JSON fallback).

| Type / Method | Description |
|---------------|-------------|
| `MemoryItem` | `{ id, text, metadata?, score?, timestamp }` |
| `constructor()` | Loads `tala_memory.json` from userData |
| `loadLocal()` / `saveLocal()` | JSON file persistence |
| `ignite(pythonPath, scriptPath)` | Spawns Mem0 MCP server via stdio |
| `connect(command, args)` | Lower-level MCP connection |
| `search(query, limit)` | Cascading: remote MCP → local keyword → combined results |
| `add(text, metadata?)` | Saves locally first, then pushes to remote |

---

#### RagService.ts

**Long-term narrative memory** via vector search (ChromaDB).

| Method | Description |
|--------|-------------|
| `ignite(pythonPath, scriptPath, envVars)` | Spawns tala-core MCP server |
| `search(query)` | Semantic search via `search_memory` MCP tool |
| `logInteraction(userText, agentText)` | Logs conversation turns for continuity |
| `ingestFile(filePath)` | Embeds and stores a file in ChromaDB |
| `deleteFile(filePath)` | Removes file embeddings |
| `listIndexedFiles()` | Lists all ingested file paths |
| `shutdown()` | Nullifies MCP client reference |

---

#### AstroService.ts

**Astro Emotion Engine lifecycle manager** — computes Tala's real-time emotional state.

| Method | Description |
|--------|-------------|
| `ignite(pythonPath, scriptPath)` | Spawns MCP server + debug process for stderr capture |
| `getEmotionalState(agentId, contextPrompt)` | Calls `get_emotional_state` MCP tool → returns emotion vector + style guide |
| `createProfile(agentId, name, birthDate, birthPlace)` | Creates a natal chart profile |
| `listProfiles()` | Lists all agent profiles |
| `shutdown()` | Kills Python process |

---

#### FileService.ts

**Sandboxed filesystem operations** — all paths confined to workspace root.

| Type / Method | Description |
|---------------|-------------|
| `FileEntry` | `{ name, path, isDirectory, children? }` |
| `constructor(initialRoot?)` | Determines workspace root (CWD in dev, `~/Documents/TalaWorkspace` in prod) |
| `setRoot(newPath)` / `getRoot()` | Workspace root management |
| `listDirectory(dirPath)` | Sorted listing (directories first) |
| `createDirectory(dirPath)` | Recursive creation |
| `deletePath(targetPath)` | Recursive force deletion |
| `createFile(filePath, content)` | Write/overwrite a file |
| `copyPath(srcPath, destPath)` | Copy with auto-`_copy` suffix for duplicates |
| `movePath(srcPath, destPath)` | Rename with copy-then-delete fallback |
| `readFile(filePath)` | UTF-8 text read |
| `writeFile(filePath, content)` | UTF-8 text write |
| `searchFiles(query)` | Recursive filename search |

---

#### GitService.ts

**Complete Git interface** wrapping the `git` CLI.

| Type / Method | Description |
|---------------|-------------|
| `GitStatus` | `{ path, status: 'M'│'A'│'D'│'?'│'U', staged }` |
| `constructor(workspaceDir)` | Sets working directory |
| `init()` | `git init` |
| `run(command)` | Executes a git command, returns stdout |
| `checkOk()` | Multi-step Git detection (PATH, common Windows paths) |
| `getStatus()` | Parses `git status --porcelain` |
| `stage(file)` / `unstage(file)` | Staging operations |
| `commit(message)` | Creates a commit |
| `scanRemotes()` | Lists remote URLs |
| `sync(token?, username?)` | Fetch → pull → push with optional GitHub token injection |
| `clone(url, targetDir?)` | Clones a repository |
| `getLog(limit)` | Commit history |
| `getBranches()` / `checkout(branch)` / `createBranch(name)` | Branch management |
| `stash()` / `stashPop()` | Stash operations |
| `getDiff(file)` | File diff |

---

#### TerminalService.ts

**PTY session manager** — spawns a system shell and streams I/O.

| Method | Description |
|--------|-------------|
| `constructor()` | Creates instance (shell not started) |
| `setWindow(win)` | Sets BrowserWindow for output forwarding |
| `setRoot(path)` | Sets shell working directory |
| `setCustomEnv(env)` | Merges custom env vars (venv, API keys) |
| `getRecentOutput()` | Drains and returns the 1000-char rolling buffer |
| `createTerminal()` | Spawns PowerShell (Windows) or bash (macOS/Linux); wires stdout/stderr |
| `write(data)` | Writes to stdin; auto-restarts shell if exited |
| `resize(cols, rows)` | No-op placeholder (needs node-pty for real resize) |
| `kill()` | SIGTERM to shell process |

---

#### SystemService.ts

**System environment detection** — foundation service for runtime path resolution.

| Type / Method | Description |
|---------------|-------------|
| `SystemInfo` | `{ os, platform, arch, nodePath, nodeVersion, pythonPath, pythonVersion, pythonEnvPath?, workspaceEnvFile?, envVariables? }` |
| `detectEnv(workspaceDir?)` | Detects OS, Node.js, Python (with venv probing: `venv/`, `.venv/`, `env/`), and `.env` file parsing |

---

#### SettingsManager.ts

**Centralized settings I/O** — safe loading, validation, backup, and atomic writing for `app_settings.json`.

| Function | Description |
|----------|-------------|
| `loadSettings(filePath, defaults?)` | Reads and parses settings JSON. If corrupt: backs up to `.bak`, returns defaults. If missing: returns defaults. |
| `saveSettings(filePath, data)` | Atomic write via temp file + rename to prevent partial writes on crash |

---

#### ErrorBoundary.tsx (`src/renderer/components/`)

**React error boundary** — catches render errors in child components.

| Member | Description |
|--------|-------------|
| `componentDidCatch(error, info)` | Logs the error and component stack |
| `render()` | Shows fallback UI (error message + **Retry** button) when an error is caught, or renders children normally |

---

#### InferenceService.ts

**Local AI inference provider discovery** via port scanning.

| Type / Method | Description |
|---------------|-------------|
| `ScannedProvider` | `{ engine: 'ollama'│'llamacpp'│'vllm', endpoint, models[] }` |
| `checkPort(port)` | TCP health check on `127.0.0.1` |
| `fetchOllamaModels(endpoint)` | Queries `/api/tags` |
| `fetchOpenAIModels(endpoint)` | Queries `/v1/models` |
| `scanLocal()` | Checks ports 11434 (Ollama), 8080 (LlamaCPP), 1234 (LM Studio), 8000 (vLLM) |
| `installEngine(engineId)` | Downloads and launches Ollama installer (Windows only) |
| `downloadFile(url, dest, onProgress)` | HTTPS download with progress callback |

---

#### BackupService.ts

**Scheduled workspace backups** as zip archives.

| Method | Description |
|--------|-------------|
| `init()` | Reads config from `app_settings.json`, starts schedule |
| `getConfig()` | Returns `{ enabled, intervalHours, localPath }` from settings |
| `schedule()` | Sets up `setInterval` (clears previous); converts hours to ms |
| `performBackup()` | Creates timestamped zip via PowerShell `Compress-Archive` |

---

#### FunctionService.ts

**Custom agent function manager** — Python/JS scripts invocable via `$keyword` syntax.

| Type / Method | Description |
|---------------|-------------|
| `AgentFunction` | `{ name, content, type: 'python'│'javascript', path }` |
| `constructor(systemService, initialRoot)` | Sets up `.agent/functions/` directory |
| `setRoot(newRoot)` | Updates functions directory |
| `listFunctions()` | Scans for `.py` and `.js` files |
| `saveFunction(name, content, type)` | Sanitizes name, writes script file |
| `deleteFunction(name, type)` | Removes script file |
| `exists(keyword)` | Checks for `.py` or `.js` variant |
| `executeFunction(keyword, args)` | Spawns child process (Python preferred over JS) |

---

#### WorkflowService.ts

**Workflow CRUD** — JSON file persistence for visual workflow definitions.

| Type / Method | Description |
|---------------|-------------|
| `WorkflowEntry` | `{ id, name, description, nodes[], edges[], active }` |
| `constructor(initialRoot)` | Sets up `.agent/workflows/` directory |
| `listWorkflows()` | Scans for `.json` files, validates structure |
| `saveWorkflow(workflow)` | Sanitizes ID, writes JSON |
| `deleteWorkflow(id)` | Removes JSON file |
| `importFromUrl(url)` | Fetches remote workflows (array, single, or `{workflows:[]}` formats) |

---

#### WorkflowEngine.ts

**Executes visual node-based workflows** designed in the WorkflowEditor UI.

| Type | Description |
|------|-------------|
| `WorkflowNode` | `{ id, type, data, position? }` — types: `start`, `input`, `manual`, `agent`, `function`, `tool`, `http`, `email_read`, `if`, `split`, `merge`, `wait`, `guardrail`, `subworkflow`, `credential`, `memory_read`, `memory_write`, `edit_fields`, `ai_model`, `model_config` |
| `WorkflowEdge` | `{ id, source, target, sourceHandle?, targetHandle? }` |
| `WorkflowContext` | `{ data, history[], variables }` |

| Method | Description |
|--------|-------------|
| `constructor(functionService, agentService)` | Injects service dependencies |
| `executeWorkflow(workflow, startNodeId?)` | BFS traversal from start/trigger nodes; handles branching (`if`), splitting, merging, and circular detection |
| `getCredential(keyName)` | Reads from `app_settings.json` auth vault |
| `executeNode(node, input, log)` | Core dispatch — `switch` on `node.type` for all 20 node types |

---

#### DiscordService.ts

**Discord bot integration** (decommissioned; code retained for reference).

| Method | Description |
|--------|-------------|
| `constructor(agent)` | Creates discord.js client with gateway intents |
| `setInteractionCallback(callback)` | Mirrors Discord messages to main UI |
| `setEventCallback(callback)` | Forwards agent events |
| `setupListeners()` | `ready` + `messageCreate` handlers; routes through `AgentService.chat()` |
| `chunkString(str, length)` | Splits messages to ≤2000 chars (Discord limit) |
| `sendToChannel(channelId, content)` | Sends to a specific text channel |
| `getChannels()` | Lists all text channels across guilds |
| `login(token, allowedUsers)` | Authenticates and starts listening |
| `logout()` | Disconnects client |
| `getMessages(channelId, limit)` | Fetches recent messages |

---

## src/

The **React renderer process** — all UI components.

### src/main.tsx

**Renderer entry point.** Mounts the React application into the DOM using `createRoot`. Wraps `<App />` in `<StrictMode>` for development checks. Imports global `index.css` stylesheet.

---

### src/App.tsx

**Root React component.** Manages the overall layout with a sidebar, chat pane, terminal panel, and dynamic side panels (settings, file explorer, browser, etc.).

| Feature | Description |
|---------|-------------|
| State | Messages array, input, sidebar/panel visibility, A2UI tree, agent events |
| Chat | Streams tokens via `window.tala.on('chat-token')`, renders markdown |
| A2UI | Renders agent-generated UI via `<A2UIRenderer>` |
| Panels | Toggleable: FileExplorer, SourceControl, Library, Search, GitView, Settings, UserProfile, WorkflowEditor, Browser, Terminal |

---

### src/renderer/

#### A2UIRenderer.tsx

Recursively renders an **A2UI component tree** (agent-generated JSON → React components).

| Export | Description |
|--------|-------------|
| `COMPONENT_MAP` | Maps type strings → React components: `button`, `card`, `input`, `text`, `container`, `html` |
| `RecursiveRenderer` | Depth-first tree walker; injects `onClick` for action-capable nodes |
| `A2UIRenderer` | Top-level wrapper component |

#### catalog/BasicComponents.tsx

**A2UI primitive component catalog** — the base UI widgets that Tala's AI can dynamically render.

| Component | Description |
|-----------|-------------|
| `Button` | Styled button with `variant` support (`'primary'` = blue, others = dark gray) |
| `Card` | Dark-themed card container with optional `title` |
| `Input` | Labeled text input with dark theme styling |
| `Text` | Simple paragraph renderer for `content` prop |

#### types.ts

**A2UI type definitions** shared by the renderer.

| Interface | Description |
|-----------|-------------|
| `A2UIComponent` | `{ id, type, props?, children?: A2UIComponent[] }` — recursive tree node for agent-generated UI |
| `A2UIState` | `{ components: A2UIComponent[] }` — top-level state wrapper |

#### Settings.tsx

**Application settings editor** with tabbed sections.

| Sub-component | Description |
|---------------|-------------|
| `Field` | Reusable labeled input (text, password, select, checkbox, number) |
| `ProgressBar` | Visual download progress indicator |
| `ModeSwitcher` | Toggles between Local/Cloud inference |
| `Settings` | Full settings form: inference, storage, backup, auth, server, agent, source control, system |

#### UserProfile.tsx

**Deep profile editor** for personal information.

| Sub-component | Description |
|---------------|-------------|
| `Field` | Labeled text input |
| `SectionTitle` | Styled section header |
| `UserProfile` | Form with sections: Basics, Professional, Personality/Astrology, Goals, Lifestyle, Social, Appearance |

#### WorkflowEditor.tsx

**Visual workflow builder** using ReactFlow.

| Feature | Description |
|---------|-------------|
| Node palette | 20 draggable node types |
| Canvas | ReactFlow graph with custom node rendering |
| Execution | Runs workflow via `window.tala.executeWorkflow()` |
| Persistence | Save/load via `window.tala.saveWorkflow()` / `getWorkflows()` |

#### profileData.ts

**User profile data models.** Defines TypeScript interfaces and default values for the user's "deep profile" stored as `user_profile.json`.

| Interface | Description |
|-----------|-------------|
| `Address` | Physical mailing address (street, city, state, zip, country) |
| `Job` | Work history entry (company, role, dates, description) |
| `School` | Education entry (institution, degree, graduation year) |
| `Contact` | Social network person (name, relation, contact info, notes) |
| `UserDeepProfile` | Complete profile: identity, contact, work history, education, hobbies, social network |
| `DEFAULT_PROFILE` | Empty default used when no saved profile exists on disk |

#### settingsData.ts

**Settings type definitions and defaults.** Defines `AppSettings` interface and `defaultSettings` covering: inference instances, cloud providers, storage provider, backup config, auth keys/tokens, server config, agent persona, source control settings, system flags, MCP server configs, guardrails, and workflows.

---

### src/renderer/components/

#### Browser.tsx

**Embedded browser panel** with `<webview>` tag.

| Feature | Description |
|---------|-------------|
| URL bar | Navigation (back, forward, reload) |
| Agent actions | Dispatches `get_dom`, `click`, `type`, `scroll` commands to the webview preload |
| Screenshot | Captures webview content on agent request |
| IPC bridge | Relays `agent-response` from webview back to main process |

#### Terminal.tsx

**Embedded terminal** using xterm.js.

| Feature | Description |
|---------|-------------|
| PTY I/O | Streams data via `window.tala.on('terminal-data')` / `sendTerminalInput()` |
| Resize | Reports `cols`/`rows` changes to main process |
| Theme | Dark terminal with cyan cursor |

#### FileExplorer.tsx

**Tree-view file browser** with lazy-loading directories.

| Feature | Description |
|---------|-------------|
| Lazy loading | Expands directories on click |
| Context menus | Right-click: New File, New Folder, Delete, Rename, Copy, Paste |
| File operations | Create, delete, rename, copy, move via IPC |

#### SourceControl.tsx

**Basic Git operations panel.**

| Feature | Description |
|---------|-------------|
| Status list | Shows staged/unstaged files with stage/unstage buttons |
| Commit | Message input + commit button |
| Sync | Push/pull with optional GitHub token |
| Clone | Clone a repository by URL |

#### GitView.tsx

**Advanced Git operations panel.**

| Feature | Description |
|---------|-------------|
| Branch management | List, create, checkout branches |
| Commit history | Scrollable log |
| Stash | Stash / pop operations |
| Diff viewer | File-level diff display |

#### Library.tsx

**Document library** for local and RAG-indexed files.

| Feature | Description |
|---------|-------------|
| Bulk ingestion | Multi-file import into RAG |
| File management | Import, delete individual files |
| Search | Full-text search through indexed documents |

#### Search.tsx

**Local file search + web search.**

| Feature | Description |
|---------|-------------|
| Local search | Filename search through workspace |
| Web search | External web search with result scraping |
| Bulk scrape | Scrapes multiple web results at once |

#### ChatSessions.tsx

**Sidebar panel for managing conversation history.**

| Feature | Description |
|---------|-------------|
| Session list | Lists saved chat sessions with timestamps |
| Actions | Load, delete, create new session |
| Persistence | Reads from `userData/chat_sessions/` via IPC |

#### MemoryViewer.tsx

**Sidebar panel for short-term memory management.**

| Feature | Description |
|---------|-------------|
| CRUD | Add, read, update, delete memory items |
| Search | Filter memories by text |
| Local/Remote | Syncs with local JSON |

#### EmotionDisplay.tsx

**Real-time emotion visualization.**

| Feature | Description |
|---------|-------------|
| Radar Chart | SVG visualization of 7-axis emotional vector |
| Tooltip | Hover to see exact values and mood label |
| Live updates | Fetches state after every chat turn |

#### ToastNotification.tsx

**System-wide notification provider.**

| Feature | Description |
|---------|-------------|
| Toasts | Auto-dismissing alerts (Success, Error, Info, Warning) |
| Event-driven | Triggered by agent events (terminal, browser, errors) |

---

## mcp-servers/

Python microservices communicating via **Model Context Protocol (MCP)** over stdio.

---

### mcp-servers/tala-core/

**RAG (Retrieval-Augmented Generation) server** — long-term narrative memory via ChromaDB vector search.

#### server.py

| Function / Tool | Description |
|-----------------|-------------|
| `init_vector_store(provider, path?)` | Initializes the ChromaDB collection; supports `local-chroma` provider |
| `search_memory` (MCP tool) | Semantic similarity search against the vector store |
| `ingest_memory_file` (MCP tool) | Reads, chunks, embeds, and stores a file |
| `reindex_directory` (MCP tool) | Bulk ingests all `.md`/`.txt`/`.docx` files from a directory |
| `delete_file_memory` (MCP tool) | Removes a file's embeddings from the store |
| `list_indexed_files` (MCP tool) | Returns all indexed file paths |
| `log_interaction` (MCP tool) | Stores a conversation turn |

---

### mcp-servers/mem0-core/

**Short-term conversational memory** — fact extraction and semantic search.

#### server.py

| Function / Tool | Description |
|-----------------|-------------|
| `mem0_add` (MCP tool) | Stores a fact/memory with metadata |
| `mem0_search` (MCP tool) | Searches memories by semantic similarity |
| `mem0_add_turn` (MCP tool) | Stores a conversation turn (user + assistant text) |

---

### mcp-servers/browser-use-core/

**Browser automation** backend via the `browser-use` library.

#### server.py

| Function / Tool | Description |
|-----------------|-------------|
| `browser_use_run_task` (MCP tool) | Executes an autonomous browser task (navigate, click, type, extract) using an LLM-driven agent |

---

### mcp-servers/astro-engine/

**Astro Emotion Engine** — computes astrological emotional states for agent persona modulation.

#### astro_emotion_engine/

The main Python package, organized into subpackages:

---

##### config.py

Global constants: `DOMAIN_MODEL_VERSION`, `BASE_EMOTIONS` (warmth, wit, intensity, melancholy, confidence, introspection, calm), `EMOTION_CEILING`/`EMOTION_FLOOR` bounds.

---

##### engine.py — `AstroEmotionEngine`

| Method | Description |
|--------|-------------|
| `__init__(ephemeris_path?)` | Selects ephemeris provider (SwissEph → Fallback), registers 12 influence modules |
| `compute_emotion_state(request)` | Full pipeline: compute ephemeris → run all modules → merge deltas → normalize → render prompt injection |
| `_render_injection(emotion, bias)` | Converts emotion vector into System Instructions + Style Guide text for persona modulation |

---

##### mcp_server.py

**MCP entry point** — registers tools and launches the stdio server.

| MCP Tool | Description |
|----------|-------------|
| `get_emotional_state` | Computes emotional state for an agent (by profile ID) or one-off birth data |
| `create_agent_profile` | Creates a persistent profile with birth data |
| `get_agent_profile` | Retrieves profile details |
| `update_agent_profile` | Updates profile fields |
| `delete_agent_profile` | Removes a profile |
| `list_agent_profiles` | Lists all registered profiles |

---

##### schemas/

Pydantic models for data validation and serialization.

| File | Contents |
|------|----------|
| `domain.py` | `EmotionDomain` enum (7 emotion axes), `DomainWeight` bounds |
| `request.py` | `EmotionRequest` — input model: `birth_date`, `birth_place`, `context_prompt?`, `agent_id?` |
| `response.py` | `EmotionResponse` — output model: `emotions`, `influences[]`, `mood_label`, `system_instructions`, `style_guide` |
| `influences.py` | `InfluenceRecord` — per-module contribution: `module_name`, `deltas{}`, `reasoning` |
| `natal.py` | `Planet`, `NatalAspect`, `NatalChart` — structured natal chart data |

---

##### services/

Business logic services for the engine.

| File | Class | Description |
|------|-------|-------------|
| `profile_manager.py` | `AgentProfile`, `ProfileManager` | Thread-safe CRUD for agent profiles in JSON storage |
| `chart_factory.py` | `ChartFactory` | Creates `NatalChart` objects from birth data using ephemeris and geocoder |
| `chart_cache.py` | `ChartCache` | In-memory LRU cache for expensive natal chart computations (keyed by date+place hash) |
| `house_engine.py` | `HouseEngine` | Calculates astrological house positions using the Placidus house system |
| `aspect_engine.py` | `AspectEngine` | Detects angular relationships (conjunction, opposition, trine, square, sextile) between planets with configurable orb tolerances |
| `geocoder.py` | `Geocoder` | Resolves city names → `(latitude, longitude)` coordinates using a built-in lookup table of ~200 major cities |

---

##### ephemeris/

Planetary position calculation providers.

| File | Class | Description |
|------|-------|-------------|
| `provider.py` | `EphemerisProvider` (ABC) | Abstract interface: `get_planet_position(planet, datetime)` → `(longitude, latitude, distance)` |
| `swisseph_provider.py` | `SwissEphProvider` | High-precision planetary positions using the Swiss Ephemeris (`pyswisseph`). Requires `.se1` data files at `ASTRO_EPHE_PATH` |
| `fallback_provider.py` | `FallbackProvider` | Approximate planetary positions using simplified Keplerian orbital elements. No external dependencies — used when Swiss Ephemeris is unavailable |

---

##### modules/

Pluggable **influence modules** — each calculates a delta to the emotion vector.

| File | Class | Description |
|------|-------|-------------|
| `base.py` | `BaseInfluenceModule` (ABC) | Abstract base: `name`, `compute(request, chart, positions)` → `InfluenceRecord` |
| `natal_baseline.py` | `NatalBaselineModule` | Starting emotion values derived from Sun, Moon, and Ascendant signs |
| `natal_aspects.py` | `NatalAspectsModule` | Permanent personality traits from birth chart aspect patterns (e.g., Sun trine Moon → +warmth) |
| `moon_phase.py` | `MoonPhaseModule` | Current lunar phase influence — full moon amplifies intensity, new moon increases introspection |
| `mercury.py` | `MercuryModule` | Mercury sign/transit effects on wit and communication style; handles retrograde periods |
| `venus.py` | `VenusModule` | Venus sign/transit effects on warmth, creativity, and aesthetic sensitivity |
| `mars.py` | `MarsModule` | Mars sign/transit effects on assertiveness, intensity, and directness |
| `jupiter.py` | `JupiterModule` | Jupiter sign/transit effects on confidence, optimism, and philosophical expansiveness |
| `saturn.py` | `SaturnModule` | Saturn sign/transit effects on discipline, melancholy, and cautious pragmatism |
| `outer_planets.py` | `OuterPlanetsModule` | Uranus, Neptune, Pluto — generational/transpersonal influences on intuition, unconventionality, and depth |
| `transit_volatility.py` | `TransitVolatilityModule` | Measures how much current planetary positions deviate from natal positions → emotional turbulence |
| `transit_aspects.py` | `TransitAspectsModule` | Real-time aspects between transiting planets and natal positions → moment-by-moment modulation |

---

##### \_\_init\_\_.py Package Markers

Seven `__init__.py` files exist across the astro-engine subpackages:

| File | Contents |
|------|----------|
| `astro_emotion_engine/__init__.py` | Exports `__version__ = "0.1.0"` |
| `schemas/__init__.py` | Package marker (empty or re-exports) |
| `services/__init__.py` | Package marker (empty or re-exports) |
| `modules/__init__.py` | Package marker (empty or re-exports) |
| `aggregation/__init__.py` | Package marker (empty or re-exports) |
| `cli/__init__.py` | Package marker (empty or re-exports) |
| `export/__init__.py` | Package marker (empty or re-exports) |

---

##### aggregation/

| File | Function | Description |
|------|----------|-------------|
| `normalize.py` | `normalize_emotion_vector(vector)` | Clamps values to `[EMOTION_FLOOR, EMOTION_CEILING]`, ensures all 7 axes are present |
| | `merge_deltas(base, deltas_list)` | Additively combines all module deltas into the base emotion vector |

---

##### cli/

| File | Description |
|------|-------------|
| `main.py` | Command-line interface with subcommands: `compute` (run full pipeline), `profile` (CRUD profiles), `schema` (export JSON schema) |

---

##### export/

| File | Function | Description |
|------|----------|-------------|
| `json_schema.py` | `export_json_schema()` | Exports Pydantic model schemas (request, response, domain) as a JSON file for external tooling |

---

*End of Master Documentation*
