# TALA - Exhaustive Technical Reference Document

**Classification:** Federal-Level Source Code Documentation
**Purpose:** Comprehensive, line-by-line function mapping, variable tracking, architectural connection outlining, and deprecation analysis for the entire TALA autonomous agent environment.
**Status:** DRAFT IN PROGRESS

## Table of Contents
1. [Core Orchestrator (Electron Main Process)](#1-core-orchestrator-electron-main-process)
2. [Cognitive Engines (Python MCP Servers)](#2-cognitive-engines-python-mcp-servers)
3. [User Interface (React Frontend)](#3-user-interface-react-frontend)
4. [Infrastructure & Deployment Scripts](#4-infrastructure--deployment-scripts)

---

## 1. Core Orchestrator (Electron Main Process)
The Electron Main Process acts as the central hub (the "spinal cord") for all inter-process communication (IPC), tool execution, and LLM brain coordination.

### 1.1 Entry Points & IPC

#### `main.ts` (Path: `/electron/main.ts`)
**Purpose:** The ultimate entry point of the Electron application. Responsible for window creation, deep linking handling, system tray management, background service ignition (RAG/Astro/World), and registering all IPC listeners for frontend communication.
**Status:** **WORKING** (Heavy, monolithic; requires refactoring into separate IPC routers in the future).

**Key State Variables:**
*   `mainWindow`: Reference to the primary `BrowserWindow`.
*   `tray`: Reference to the OS system tray icon.
*   `agent`: Instance of `AgentService` (The core AI orchestrator).
*   `memory`: Instance of `MemoryService` (Database manager).
*   `tools`: Instance of `ToolService` (Local tool registry).
*   `guardrails`: Instance of `GuardrailService` (Validation engine).
*   `ragService`: Instance of `RagService` (Document embeddings).
*   `appLifecycle`: Instance of `AppLifecycleService` (Graceful shutdown manager).

**Key Functions:**
*   `createWindow()` -> Creates the main 1230x900 frameless window. Customizes CSP headers.
*   `setupIpcHandlers()` -> Connects UI actions (React) to backend services.
    *   *Connections:* `chat-message` -> `agent.chat()`; `open-file-dialog` -> `dialog.showOpenDialog`; `fetch-agent-profile` -> Reads `agent_profiles.json`.
*   *App Event Listeners:* `app.on('ready')`, `app.on('window-all-closed')`, `app.on('before-quit')`. The `before-quit` handler triggers `appLifecycle.cleanupAndExit()` to prevent Python zombie processes.

#### `preload.ts` (Path: `/electron/preload.ts`)
**Purpose:** Secure context bridge. Exposes a strictly whitelisted set of APIs (IPC channels) to the React renderer process, preventing arbitrary Node.js code execution from the frontend.
**Status:** **WORKING** (Secure, Context Isolation enabled).

**Key Variables:**
*   `api`: The object injected into the `window` scope in the renderer.

**Key Functions:**
*   `api.send(channel, data)` -> Sends data from UI to Main.
*   `api.receive(channel, func)` -> Listens for data from Main to UI.
*   `api.invoke(channel, data)` -> Two-way Promise-based communication.
*   *Exposed Channels:* `chat-message`, `app-quit`, `mcp-disconnect`, `open-url`, `open-file-dialog`, `a2ui-update`.

### 1.2 Core Orchestration Services

#### `AgentService.ts` (Path: `/electron/services/AgentService.ts`)
**Purpose:** The central orchestrator that governs the "Mind" of Tala. This service coordinates all AI capabilities: inference (brain), memory, RAG, emotion (astro), tool execution, backup, and browser/terminal interaction.
**Status:** **WORKING** (Highly complex, handles a 10-turn recursive agent loop).

**Key State Variables:**
*   `brain`: Instance of `IBrain` (The active LLM inference backend).
*   `activeSessionId`: The current chat thread UUID.
*   `chatHistory`: Array of `ChatMessage` objects representing the conversation.
*   `goals`: Instance of `GoalManager` for graph-based planning.
*   `isSoulReady`: Boolean tracking if the python MCP servers have successfully ignited.

**Key Functions:**
*   `igniteSoul()` -> Bootstraps the backend Python MCP servers sequentially (`Astro`, `World`, `Mem0`).
*   `chat(userMessage, images, onToken, onEvent)` -> The primary message handler. Initiates a multi-turn tool-use loop (max 10 iterations). 
*   `streamWithBrain(...)` -> Executes the generation payload, implements a 3-strike retry logic (Circuit Breaker) for inference timeouts or errors.
*   `truncateHistory()` -> Aggressively prunes the chat context. If a 3B local model is active, it strictly caps history at 3072 tokens to prevent "lost-in-the-middle" degradation.
*   *Connections:* Invokes `Router` to pick a brain. Calls `ToolService.getToolDefinitions()` to build the system prompt. Calls `RagService.search()` to fetch narrative lore.

#### `ToolService.ts` (Path: `/electron/services/ToolService.ts`)
**Purpose:** Central registry for all executable tools available to the Tala AI agent. Exposes local OS capabilities (File I/O, Terminal, Browser) and dynamically registers external MCP tools.
**Status:** **WORKING** (Recently fortified with `makeStrictSchema` to prevent V8 crashes).

**Key State Variables:**
*   `tools`: `Map<string, ToolDefinition>` of native tools.
*   `mcpTools`: `Map<string, { serverId, def }>` of dynamically loaded tools from Python servers.
*   `workspaceDir`: The constrained root directory for file operations.

**Key Functions:**
*   `registerCoreTools()` -> Immediately registers file actions (`write_file`, `read_file`), terminal actions (`execute_command`), and browser actions (`browse`, `search_web`).
*   `setMemoryService(memory)` -> Dynamically injects `mem0_search`, `mem0_add`, and desktop inputs into the tool registry once the memory service boots.
*   `makeStrictSchema(schema)` -> Recursively enforces GBNF strict JSON generation parameters (`additionalProperties: false`, explicitly listing `required` arrays) on all tool definitions. Employs `structuredClone` for cycle prevention.
*   `executeTool(name, args)` -> Routes and executes the chosen tool. Returns the observation.
*   *Connections:* Feeds definitions to `AgentService`. Connected to the `TerminalService`, `MemoryService`, and `McpService` execution layers.

#### `RagService.ts` (Path: `/electron/services/RagService.ts`)
**Purpose:** Manages the connection to the `tala-core` RAG (Retrieval-Augmented Generation) MCP server. Handles long-term narrative memory retrieval and document chunking/ingestion from the `/memory` directory.
**Status:** **WORKING** (Relies on StdioClientTransport for MCP connections).

**Key State Variables:**
*   `client`: `@modelcontextprotocol/sdk/client` instance connected to Python.
*   `isReady`: Boolean tracking verified MCP tool listing.

**Key Functions:**
*   `ignite(pythonPath, scriptPath)` -> Spawns `server.py` in the `tala-core` venv. Connects via Stdio transport and races a 15-second timeout.
*   `search(query, options)` -> Calls the `search_memory` MCP tool. Formats FastMCP list responses into Markdown lists for the LLM.
*   `ingestFile(filePath)` -> Calls the `ingest_file` MCP tool to chunk and embed a new text document into ChromaDB.
*   *Connections:* Tightly coupled to `/mcp-servers/tala-core/server.py`. Required by `AgentService` during the prompt-building phase.

#### `MemoryService.ts` (Path: `/electron/services/MemoryService.ts`)
**Purpose:** Provides short-term, conversational memory for the Tala agent (facts, user preferences). Implements a dual-storage strategy: remote MCP backend (`mem0-core`) as primary, local JSON fallback (`tala_memory.json`).
**Status:** **WORKING** (Fallback search logic handles missing MCP connections gracefully).

**Key State Variables:**
*   `client`: Remote MCP client instance wrapper.
*   `localMemories`: In-memory array of `MemoryItem` records loaded from disk.
*   `localPath`: The JSON fallback path in `app.getPath('userData')`.

**Key Functions:**
*   `search(query, limit)` -> Cascading block. First attempts the `mem0_search` MCP tool. If it fails, executes a keyword-based split-and-match scoring loop against the local JSON cache.
*   `add(text, metadata)` -> Cascading block. Always saves to the local disk array first for redundancy, then pushes to the `mem0_add` MCP tool.
*   `prune(ttlDays, maxItems)` -> Automated cache cleaning based on timestamps.
*   *Connections:* Integrates with `mem0-core` python microservice. Injected into `ToolService` dynamically by `AgentService`.

#### `McpService.ts` (Path: `/electron/services/McpService.ts`)
**Purpose:** The central registry and network manager for all external Model Context Protocol (MCP) servers. Handles spawning stdio pipes (local python servers) or connecting to remote WebSocket URLs.
**Status:** **WORKING** (Crucial for extensibility; manages health checks flawlessly).

**Key State Variables:**
*   `connections`: `Map<string, Connection>` containing the active SDK clients, transports, and child processes.
*   `healthInterval`: A 30s JS interval loop checking server heartbeats.

**Key Functions:**
*   `connect(config)` -> Instantiates the `StdioClientTransport` or `WebSocketClientTransport` based on the user's config object and registers the connection.
*   `sync(configs)` -> Reconciles the live connection map against the User Settings. Connects new servers and drops removed ones dynamically.
*   `startHealthLoop()` -> Pings all registered servers every 30 seconds using `client.listTools()`. If a server crashes, it initiates an auto-reconnect sequence.
*   *Connections:* Called heavily during `AgentService.igniteSoul()`. Reacts to UI modifications from `Settings.tsx`.

#### `SmartRouterService.ts` (Path: `/electron/services/SmartRouterService.ts`)
**Purpose:** Implements 'Economic Intelligence' by dynamically routing inference workflows between high-fidelity (Cloud) and low-fidelity (Local) models based on prompt complexity.
**Status:** **WORKING** (Keyword detection is rudimentary but functional).

**Key State Variables:**
*   `localBrain`: Instance of `OllamaBrain`.
*   `cloudBrain`: Instance of `CloudBrain`.
*   `mode`: Routing mode overrides (`auto`, `local-only`, `cloud-only`).

**Key Functions:**
*   `route(messages, systemPrompt)` -> Examines the tail user message. If it detects complexity (e.g., 'refactor', 'design', 'calculate_strategies'), it returns the CloudBrain. Otherwise, defaults to the cheaper LocalBrain.
*   *Connections:* Bound inside `AgentService.chat()`.

#### `AstroService.ts` (Path: `/electron/services/AstroService.ts`)
**Purpose:** Manages the lifecycle and communication with the embedded Astro Emotion Engine MCP server (`astro-engine`). Calculates real-time emotional states based on astrological transits.
**Status:** **WORKING** (Spawns a background python instance correctly).

**Key State Variables:**
*   `client`: Remote MCP client instance wrapper.
*   `isReady`: Boolean tracking verified MCP tool listing.

**Key Functions:**
*   `ignite(pythonPath, scriptPath)` -> Spawns the `astro_emotion_engine.mcp_server` python module via Stdio transport.
*   `getEmotionalState(agentId, recentContext)` -> *DEPRECATED* internally; the AI now calls the split `get_agent_emotional_state` directly via MCP tools.
*   *Connections:* Required by `AgentService` during prompt building. Corresponds to `mcp-servers/astro-engine`.

#### `TerminalService.ts` (Path: `/electron/services/TerminalService.ts`)
**Purpose:** Manages a pseudo-terminal (PTY) session within the Electron application. Bridges standard I/O between native OS shells (PowerShell/bash) and the frontend `xterm.js` component.
**Status:** **WORKING** (Uses `node-pty` for robust TTY behavior; gracefully handles missing node-pty binaries as a fallback).

**Key State Variables:**
*   `shells`: `Map<string, any>` tracking active PTY processes.
*   `window`: Reference to the `BrowserWindow` for IPC broadcasting.
*   `outputBuffer`: A rolling string (last 1000 characters) for LLM context reading.
*   `allowedCommands`: Quantum Firewall whitelist of safe commands for autonomous execution (e.g., `ls`, `git`, `npm`).

**Key Functions:**
*   `createTerminal(id)` -> Spawns `node-pty` using `powershell.exe` or `bash`. Wires up `onData` listeners to IPC.
*   `write(id, data)` -> Sends input to the PTY. If the terminal belongs to the AI, it intercepts the command and blocks it if it is not in `allowedCommands` or if it looks destructive (`rm -rf /`).
*   `getRecentOutput()` -> Drains the 1000-char buffer and returns it to the calling Tool.
*   *Connections:* Tied to the `/tools` definitions (`terminal_run`). Emits `terminal-data` IPC events to the UI.

#### `BackupService.ts` (Path: `/electron/services/BackupService.ts`)
**Purpose:** Provides automated, scheduled `.zip` backups of the workspace directory. Supports local archiving and direct upload to S3-compatible cloud providers.
**Status:** **WORKING** (Uses `archiver` and `@aws-sdk/client-s3`).

**Key State Variables:**
*   `interval`: NodeJS interval handle for schedule execution.

**Key Functions:**
*   `schedule()` -> Reads `app_settings.json` and sets a `setInterval` loop (minimum 1 hour).
*   `performBackup()` -> Zips the `Documents/TalaWorkspace` directory. If S3 is configured, uploads the zip to the `tala-backups/` bucket prefix.
*   `testConnection(config)` -> Validates S3 credentials using `ListBucketsCommand`.
*   *Connections:* Modifiable from the frontend Settings overlay. Running transparently in the background of `main.ts`.

#### `GuardrailService.ts` (Path: `/electron/services/GuardrailService.ts`)
**Purpose:** A GuardrailsAI-compatible validation system for Tala. Filters input/output streams to prevent toxic language, PII leaks, and prompt injections using both regex rules and secondary LLM checks.
**Status:** **WORKING** (Highly extensive schema, implements on-fail behaviors like `fix`, `filter`, and `exception`).

**Key State Variables:**
*   `configPath`: File path to `guardrails.json`.
*   `guards`: In-memory array of active `GuardDefinition` structures.
*   `VALIDATOR_REGISTRY`: A massive static dictionary mapping validation types (e.g., `ToxicLanguage`) to logical implementations.

**Key Functions:**
*   `validate(target, text, agentId, workflowId)` -> The main entry point. Scans active guards applicable to the current context. Chains rule-based regex evaluations and LLM-based API calls. Returns `ValidationResult` with `passed` boolean and adjusted text.
*   `applyPolicy(text, original, policy, violation)` -> In the event of a failure, handles mutating the string (redaction) based on the strictness rules.
*   *Connections:* Used conceptually by `AgentService` interceptors and `WorkflowEngine` nodes.

#### `InferenceService.ts` (Path: `/electron/services/InferenceService.ts`)
**Purpose:** Scans the host machine's open network ports (11434, 8080, 1234) to auto-detect LLM inference backends (Ollama, LM Studio, Llama.cpp).
**Status:** **WORKING** (Uses raw HTTP GETs and JSON parsing to avoid heavy SDK dependencies).

**Key Functions:**
*   `checkPort(port)` -> Attempts a TCP handshake against loopback IPs.
*   `scanLocal()` -> Parallelizes discovery requests. Normalizes `api/tags` vs `v1/models` formats.
*   *Connections:* Invoked by the `Settings` UI component to populate the AI configuration drop-down menus.

#### `WorkflowService.ts` (Path: `/electron/services/WorkflowService.ts`)
**Purpose:** Provides CRUD (Create, Read, Update, Delete) capability for visual automation graphs inside `.agent/workflows/`. Specifically responsible for I/O bounds and scheduling.
**Status:** **WORKING** (Includes a fully-featured Python exporter).

**Key Functions:**
*   `listWorkflows()` -> Reads `.json` definitions from disk and handles basic schema validation.
*   `exportWorkflowToPython(workflowId, outputDir)` -> A massive translation layer that compiles visual JSON graphs into standalone Python CLI applications using BFS traversal code generation (`workflow_runner.py`).
*   `initScheduler(onExecute)` -> Runs a 60-second polling loop against the `schedule` cron strings attached to workflow definitions.
*   *Connections:* Drives the state for the `WorkflowEditor.tsx` React component. Feeds graphs into the `WorkflowEngine.ts`.

#### `WorkflowEngine.ts` (Path: `/electron/services/WorkflowEngine.ts`)
**Purpose:** Executes visual node-based workflows created in the React UI. Implements a Directed Acyclic Graph (DAG) BFS traversal engine that passes data along edges between nodes.
**Status:** **WORKING** (Includes an interactive step-by-step `startDebug` session mode that transmits execution state back to the UI).

**Key State Variables:**
*   `debugSessions`: `Map<string, SessionData>` tracking paused BFS queue states for step-through debugging.

**Key Functions:**
*   `executeWorkflow(workflow, startNodeId, initialInput)` -> The core runner loop. Identifies entry points, walks the graph evaluating conditions (`if`, `guardrail`) and array fan-outs (`split`), and accumulates a `Context` history array. Fails safe at 100 maximum edges.
*   `executeNode(node, input, log)` -> Dispatches the logic based on `node.type`. Instantiates `AgentService.headlessInference` for nodes of type `agent`, or `AgentService.executeTool` for nodes of type `tool`/`memory_read`. Embeds specific NPM libraries directly (e.g., `imapflow` for the `email_read` node).
*   *Connections:* Dependent on `FunctionService` and `AgentService`. Triggered by IPC calls from the frontend or scheduled crons from `WorkflowService`.

#### `FileService.ts` (Path: `/electron/services/FileService.ts`)
**Purpose:** Provides a sandboxed file system API restricted strictly to the user's workspace root (e.g., `~/Documents/TalaWorkspace`).
**Status:** **WORKING** (Implements `chokidar` for real-time filesystem watchers).

**Key State Variables:**
*   `workspaceDir`: The constrained root boundary.
*   `watcher`: Chokidar instance reporting mutations.

**Key Functions:**
*   `listDirectory(dirPath)` -> Safely reads file stat types.
*   `searchFiles(query)` -> Deep-scans the repository text content (excluding `.git`, `node_modules`, and binary extensions), capping at 50 snippet results for performance.
*   *Connections:* Powers the frontend `FileExplorer` component and the Agent's file tools.

#### `VoiceService.ts` (Path: `/electron/services/VoiceService.ts`)
**Purpose:** Handles Speech-to-Text (STT) via the OpenAI Whisper API endpoint and Text-to-Speech (TTS) via ElevenLabs.
**Status:** **WORKING** (Direct manual `fetch` calls, bypasses heavyweight SDKs).

**Key Functions:**
*   `transcribe(audioPath, language)` -> Builds a manual `multipart/form-data` MIME payload using native Node buffers to upload a `.webm` capture.
*   `synthesize(text, outputFileName)` -> Invokes ElevenLabs using API keys stored in env/app_settings, saving MP3s to `userData`.

#### `SettingsManager.ts` (Path: `/electron/services/SettingsManager.ts`)
**Purpose:** Centralized, safe settings loader and writer for `app_settings.json` located in the Electron `userData` folder.
**Status:** **WORKING** (Provides defaults and corruption recovery).

**Key State Variables:**
*   `DEFAULT_SETTINGS`: A massive structural default tree ensuring keys like `inference.mode` and `reflection.heartbeatMinutes` always exist.

**Key Functions:**
*   `loadSettings(settingsPath)` -> Reads JSON, returning defaults on failure, and deep merges partial configs to ensure completeness. Corrupt files are backed up automatically to `.bak`.
*   `saveSettings(settingsPath, data)` -> Atomic write using a `.tmp` file and synchronous rename to prevent partial writes.

#### `FunctionService.ts` (Path: `/electron/services/FunctionService.ts`)
**Purpose:** Manages custom agent functions (user-created Python and JS scripts) invoked via the `$keyword` syntax in chat.
**Status:** **WORKING** (Spawns raw scripts using `child_process.spawn`).

**Key Functions:**
*   `listFunctions()` -> Scans `.agent/functions/` and returns code strings.
*   `saveFunction(name, content, type)` -> Sanitizes script names to prevent path traversal and writes out `.py` or `.js files`.
*   `executeFunction(keyword, args)` -> Asks `SystemService` for the Python/Node binary, spawns it, injects `.env` contexts, and captures stdout cleanly.

#### `AnnotationParser.ts` (Path: `/electron/services/AnnotationParser.ts`)
**Purpose:** Scans source files for inline Tala annotations (e.g., `// @tala:warn Keep this stable`). Builds context maps over the codebase for the AI.
**Status:** **WORKING** (Supports all major comment styles using Regex, including tag categorization).

**Key Functions:**
*   `parseFile(filePath)` -> Reads a file (skipping large/binary files) and extracts `TalaAnnotation` objects containing line numbers and tags (`ignore`, `pin`, `warn`, `todo`, `reflect`).
*   `generateProjectSummary(dirPath)` -> Crawls the workspace to compute an aggregate digest of all active annotations.

#### `AuditService.ts` (Path: `/electron/services/AuditService.ts`)
**Purpose:** A legally defensible, append-only JSONL event logger tracking every self-modification, tool call, and system decision Tala makes.
**Status:** **WORKING** (Actively hashing and signing events with HMAC-SHA256).

**Key State Variables:**
*   `SECRET_KEY`: Uses `TALA_AUDIT_SECRET` env var for HMAC signing to prove immutability.

**Key Functions:**
*   `logAuditEvent(event)`, `logFileWrite(...)`, `logToolCall(...)` -> Captures the timestamp, target, payload hash, and emotional state into `DOCS_TODAY/audit-log.jsonl`.
*   `generateAuditReport()` -> Exports a human-readable summary of the immutable log into `audit-report.md`.

#### `GitService.ts` (Path: `/electron/services/GitService.ts`)
**Purpose:** Wraps standard `git` CLI operations to orchestrate source control from the Tala UI, without heavy native Git modules.
**Status:** **WORKING** (Robust detection logic for custom Windows Git installation paths).

**Key Functions:**
*   `checkOk()` -> Probes the `PATH` and common hardcoded `C:\Program Files\Git` paths, caching the result.
*   `getStatus()`, `stage(file)`, `commit(msg)`, `sync(token)` -> Wrappers for typical commands. `sync` handles URL patching for OAuth/PAT injection.
*   `fetchGithubRepos`, `fetchGithubIssues`, `fetchGithubPRs` -> Direct `fetch` calls to the GitHub API for UI data population.
*   *Connections:* Used heavily by the `SourceControl` React component.

#### `IngestionService.ts` (Path: `/electron/services/IngestionService.ts`)
**Purpose:** Monitors the `memory/` directory and automatically ingests/indexes dropped `.md`, `.txt`, and `.docx` files into the RAG vector database.
**Status:** **WORKING** (Moves successfully ingested files to a `processed/` subdirectory to prevent duplicate indexing).

**Key Functions:**
*   `scanAndIngest()` -> Performs a full scan of the `memory/root`, `memory/roleplay`, and `memory/assistant` folders if the `RagService` is ready. Calls `RagService.ingestFile()`.
*   `startAutoIngest(intervalMs)` -> Initiates a background `setInterval` polling loop (default 5 minutes).

#### `LocalEngineService.ts` (Path: `/electron/services/LocalEngineService.ts`)
**Purpose:** Manages the lifecycle of a built-in `llama-server` (llama.cpp) instance to provide zero-dependency, offline local AI inference.
**Status:** **WORKING** (Responsible for spawning the actual native platform binaries and monitoring their HTTP ready states).

**Key State Variables:**
*   `binaryPath`: Discovered path to the `llama-server.exe` (Windows) or `llama-server` (Unix).
*   `serverProcess`: The active `ChildProcess` handle holding the running inference engine.

**Key Functions:**
*   `findBinary()` -> Scans the `bin/` directory within both the unpacked project root and the packaged Electron `appPath()`.
*   `ignite(modelPath, options)` -> Spawns the binary, allocating Context Size (`-c`) and GPU Layers (`-ngl`). Parses stderr to wait for the HTTP server ready line.
*   `extinguish()` -> Kills the child process.
*   `downloadBinary(onProgress)`, `downloadModel(onProgress)`, `downloadPython(onProgress)` -> Native unauthenticated HTTPS downloaders to fetch the minimal binaries needed to hydrate a fully portable install.

#### `OrchestratorService.ts` (Path: `/electron/services/OrchestratorService.ts`)
**Purpose:** A headless extraction of the multi-turn agentic loop used by `AgentService`. Allows background processes (or "Minions") to execute multiple tools and reason toward a goal without emitting chat events to the UI.
**Status:** **WORKING** (Provides an isolated agent context).

**Key Functions:**
*   `runHeadlessLoop(prompt, systemPrompt, maxTurns)` -> While loop that feeds context back into an `IBrain`, parses tool calls, invokes the `ToolService`, and appends tool outputs until a final non-tool response is reached (capped at `maxTurns`).

#### `SystemService.ts` (Path: `/electron/services/SystemService.ts`)
**Purpose:** Detects host OS information and resolves the absolute paths to portable or system-level Node.js and Python runtimes. Crucial for environment isolation and executing tools.
**Status:** **WORKING** (Handles complex virtual environment detection and `.env` file hydration).

**Key Functions:**
*   `detectEnv(workspaceDir)` -> Deep-scans the repository for `venv/`, `.venv/`, or `env/` folders. If found, runs a tiny inline Python script to dump `os.environ`, effectively capturing the activated Python environment variables. Merges this with `process.env` and parses any local `.env` files. Prioritizes the `tala-core` virtual environment.

#### `IBrain.ts` (Path: `/electron/brains/IBrain.ts`)
**Purpose:** Defines the abstract interface for all Tala inference backends (Cloud vs Local). Provides the standard typing for `ChatMessage`, `ToolCall`, and `BrainResponse`.
**Status:** **WORKING** (Foundation for polymorphic LLM support).

**Key State Variables:**
*   `ChatMessage`: Standardizes representation across roles (`system`, `user`, `assistant`, `tool`), matching the OpenAI spec. Supports multimodal image passing.

**Key Functions:**
*   `ping()` -> Checks if the endpoint is reachable.
*   `generateResponse(messages... )` -> Blocking generation.
*   `streamResponse(messages...)` -> Token-by-token streaming generator.

#### `CloudBrain.ts` (Path: `/electron/brains/CloudBrain.ts`)
**Purpose:** Implements `IBrain` to orchestrate cloud-based LLM inference via OpenAI-compatible REST APIs (OpenAI, Anthropic via proxy, OpenRouter, Groq, Gemini).
**Status:** **WORKING** (Supports advanced reasoning tokens, tool constraint injection, and aggressive error recovery).

**Key Functions:**
*   `streamResponse()` -> Uses Node's native `http`/`https` modules with chunk boundary parsing for Server-Sent Events (SSE). Reconstructs JSON function calls chunk by chunk. Uses `ToolService.makeStrictSchema` to forcefully rewrite tool constraints.
*   `repairMangled(val)` -> Robust string sanitation function to recover corrupted tool call syntax emitted by smaller open-weight models (e.g., duplicated names like "browsebrowse").

#### `OllamaBrain.ts` (Path: `/electron/brains/OllamaBrain.ts`)
**Purpose:** Implements `IBrain` for local, cost-free LLM inference using a locally running Ollama server.
**Status:** **WORKING** (Utilizes `undici` to bypass deep timeout limits, allowing large context generations on lower-end hardware).

**Key Functions:**
*   `prepareMessages(messages, systemPrompt)` -> Trims and massages the standard `ChatMessage` array into the format expected by the exact Ollama `/api/chat` schema, dealing with nested JSON parsing inside tool definitions.
*   `streamResponse()` -> Dispatches a POST to `localhost:11434` and parses the `newline-delimited JSON` Stream, buffering tool fragments until complete.

#### `SmartRouterService.ts` (Path: `/electron/services/SmartRouterService.ts`)
**Purpose:** Defines "Economic Intelligence" by deciding on a per-query basis whether to spend compute on the heavy `CloudBrain` or the free `OllamaBrain`.
**Status:** **WORKING** (Heuristic matching based on action intent).

**Key Functions:**
*   `route(messages, systemPrompt)` -> Inspects the latest user intent against an array of heavy action terms (`calculate_strategies`, `delegate_task`, `refactor`). If matched, returns the Cloud provider; otherwise, drops to base local routing.

#### `WorldService.ts` (Path: `/electron/services/WorldService.ts`)
**Purpose:** A lightweight lifecycle manager for the external "World Engine" Python MCP server.
**Status:** **WORKING** (Standard `ChildProcess` spawner).

**Key Functions:**
*   `ignite(pythonPath, scriptPath, env)` -> Spawns the python script and pipes stdout/stderr to the console log.
*   `shutdown()` -> Kills the process.

## 3. Python MCP Servers (Cognitive Engines)

The Tala architecture offloads domain-specific cognitive tasks to external FastMCP servers written in Python. These run as sidecars and communicate via stdio.

#### `astro-engine` (Path: `/mcp-servers/astro-engine/astro_emotion_engine/mcp_server.py`)
**Purpose:** Analyzes chronological transit data against a generated natal chart to produce an "Emotional Vector" and dynamic System Prompts.
**Status:** **WORKING** (Exposes 7 MCP tools for Chart and Profile Management).

**Key Tools Exchanged:**
*   `get_agent_emotional_state`, `get_ad_hoc_emotional_state`, `get_current_state` -> Generates the actual float vector representing Warmth, Focus, Calm, Empowerment, Conflict.
*   `create_agent_profile`, `list_agent_profiles`, `update_agent_profile`, `delete_agent_profile` -> CRUD operations for persistent agent personas based on birth data.

#### `mem0-core` (Path: `/mcp-servers/mem0-core/server.py`)
**Purpose:** Fast, short-term conversational fact memory backed by the `mem0` library, using Qdrant (local DB) and HuggingFace Sentence-Transformers.
**Status:** **WORKING** (Configured for local/portable execution using `sentence-transformers/all-MiniLM-L6-v2`).

**Key Tools Exchanged:**
*   `add(text, user_id, metadata)` -> Stores a text memory snippet with tags.
*   `search(query, user_id, limit)` -> Performs a semantic vector similarity search against the Qdrant DB.

#### `tala-core` (Path: `/mcp-servers/tala-core/server.py`)
**Purpose:** A dependency-free, pure-Numpy RAG implementation. Used for Long-Term Narrative memory and file ingestion without requiring heavy databases like Chroma or SQLite.
**Status:** **WORKING** (Saves directly to `.npy` and `.json` files).

**Key Tools Exchanged:**
*   `add_to_memory`, `search_memory` -> Basic dot-product semantic search.
*   `delete_by_source` -> Erases embeddings linked to a specific source file path, allowing dynamic updating of the RAG index when files change.

#### `world-engine` (Path: `/mcp-servers/world-engine/server.py`)
**Purpose:** Structural File Analyzer. Helps the LLM immediately understand the shape of code files by extracting AST definitions rather than simply grepping text.
**Status:** **WORKING** (Uses Python `ast` for parsing `.py` and heuristics/regex for parsing `.ts`/`.js`).

**Key Tools Exchanged:**
*   `analyze_structure(target_path)` -> Returns a structured dictionary containing classes, functions, and public methods found within the code.

## 4. React Frontend (UI)

The frontend is built with React and Vite, structured to resemble a modern IDE (VS Code-like layout) with resizable panels, an activity bar, and integrated browser/terminal views.

#### `main.tsx` (Path: `/src/main.tsx`)
**Purpose:** Standard React 18 bootstrap entry point.
**Status:** **WORKING**.

#### `App.tsx` (Path: `/src/App.tsx`)
**Purpose:** The massive Root Application Component that composes the entire Tala IDE layout.
**Status:** **WORKING** (Handles complex panel resizing, tab management, and heavy IPC event routing).

**Key Responsibilities & Event Handlers:**
*   **Layout Orchestration:** Manages states for `isLeftPanelOpen`, `isRightPanelOpen`, `isBottomPanelOpen`. Mouse event handlers (`handleMove`, `handleUp`) drive the draggable panel boundaries.
*   **Window Tabs:** Tracks open files in the `activeTab` state. Rendering an embedded `<Browser>` or `<textarea>` editor.
*   **IPC Event Sinks:** Registers multiple `window.tala.on(...)` listeners for the core loop:
    *   `chat-token`: Streams incoming LLM tokens into the chat panel.
    *   `chat-done`: Signals completion, updating the conversation history block.
    *   `agent-event`: Evaluates `window.tala.evaluateJS(...)` injections or routes A2UI server payloads (e.g., `<A2UIRenderer>`).
    *   `external-chat`: Bridges messages captured from the Discord bot directly into the UI.

#### `A2UIRenderer.tsx` (Path: `/src/renderer/A2UIRenderer.tsx`)
**Purpose:** Recursively walks a server-emitted A2UI JSON tree and renders React GUI elements dynamically on the fly.
**Status:** **INCOMPLETE / BROKEN** (Missing a definitive React UI widget library implementation).
**Details:** Contains a `COMPONENT_MAP` that maps string identifiers like `"button"` and `"card"` to their actual React implementations in `/catalog/BasicComponents`, but currently lacks the underlying UI widget set to render correctly. Injects `onClick` handlers that trigger `onAction({"action": ...})` events back to the backend.

#### `Settings.tsx` (Path: `/src/renderer/Settings.tsx`)
**Purpose:** The master configuration dashboard (~5000 lines). Controls Inference (Ollama/Cloud), Storage (RAG Config), Agent Profiles, Workflows, MCP Servers, and system variables.
**Status:** **WORKING** (Has deeply nested UI for managing prompt arrays, sliders for temperature, and Astro Birth Data inputs).
**Details:** Distinguishes between `Global Scope` and `Workspace Scope` using a tabbed UI. Automatically deep-merges configurations.

#### `Browser.tsx` (Path: `/src/renderer/components/Browser.tsx`)
**Purpose:** Renders an internal Electron `<webview>` panel for AI-driven web surfing and scraping.
**Status:** **WORKING** (Injects `browser-preload.js` to expose DOM queries to Tala).
**Key Behaviors:** Listens to `agent-event` IPC commands like `browser-navigate`, `browser-click`, and `browser-get-dom`. Visually simulates mouse click ripples and movements so the user can watch the AI browse.

#### `FileExplorer.tsx` (Path: `/src/renderer/components/FileExplorer.tsx`)
**Purpose:** Side-panel tree-view representing the local workspace directory.
**Status:** **WORKING** (Supports lazy loading, context menus, and CRUD operations).
**Key Behaviors:** Uses `window.tala.listDirectory(...)` to hydrate branches. Supports cut/copy/paste file operations mapping back to native filesystem updates.

#### `ChatSessions.tsx` (Path: `/src/renderer/components/ChatSessions.tsx`)
**Purpose:** Side-panel list of historical conversation threads.
**Status:** **WORKING** (Fetches sessions from IPC; supports branching indicators).

## 5. Build, Scripts & Infrastructure

Tala is designed to be highly portable, capable of running securely from a USB stick with zero host-machine dependencies.

#### `make_portable.bat` & `make_universal.bat` (Path: `/scripts/`)
**Purpose:** Orchestrates the creation of a "Zero-Installation" footprint.
**Status:** **WORKING** (Produces a `universal-build/` artifact).
**Details:** 
*   **Python Sandboxing:** Uses `powershell` to download and extract the `python-3.13-embed-amd64.zip` directly into the `/bin/python-portable/` folder alongside the app.
*   **Dependency Injection:** Installs all `requirements.txt` from `/mcp-servers/` directly into this portable python environment.
*   **Universal Build:** `make_universal.bat` goes further by downloading Python binaries for Windows, macOS, and Linux simultaneously, using `pip install --platform` to cross-compile wheels for all target OSes into a massive 8GB+ standalone folder.

#### `launch-inference.bat` (Path: `/scripts/`)
**Purpose:** The single entrypoint for booting the local LLaMA engine.
**Status:** **WORKING**.
**Details:** First checks if an external `Ollama` instance is running on port `:11434` using `netstat`. If found, it safely enters a standby loop to prevent port clashing. Otherwise, it discovers the `python-portable` runtime and boots `llama_cpp.server` using the dynamically located `.gguf` file.

#### `package.json` (Path: `/package.json`)
**Purpose:** Node.js project definition and build orchestrator.
**Status:** **WORKING**.
**Details:**
*   Uses `concurrently` to boot Vite (React dev server), Electron (Main Process), and `./scripts/launch-inference.bat` simultaneously during `npm run dev`.
*   Highly customized `electron-builder` configuration in the `"build"` block. Critical folders (`/models`, `/memory`, `/mcp-servers`) are mapped into `extraFiles` to prevent them from being compressed into `app.asar`, ensuring the local Python instances can read/write them dynamically.

#### `vite.config.ts` (Path: `/vite.config.ts`)
**Purpose:** React frontend bundler configuration.
**Status:** **WORKING**.
**Details:** Employs a custom Rollup plugin (`strip-crossorigin`) to aggressively strip `crossorigin` tags from the injected index.html script tags, ensuring the `file://` protocol loads assets without triggering false CORS violations in the strict Electron sandbox.
