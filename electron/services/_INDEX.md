# electron/services/ — Core Backend Services

Each file exports a single service class or module. These are instantiated in `main.ts` and made available to each other and to the renderer via IPC.

---

## Files

| File | Size | Description |
|---|---|---|
| `AgentService.ts` | 27 KB | **The Mind.** Central orchestrator — manages the cognitive loop (User → Context Injection → LLM → Tool Execution → Response). Key methods: `chat()`, `igniteSoul()`, `headlessInference()`, `performSearch()`, `executeTool()`. |
| `WorkflowEngine.ts` | 25 KB | **Automation Engine.** Executes node-based logic graphs (React Flow format). Supports node types: `agent`, `tool`, `if`, `http`, `transform`, `delay`. Key methods: `executeWorkflow()`, `executeNode()`. |
| `ToolService.ts` | 23 KB | **Tool Registry.** Registers and executes all agent capabilities (filesystem, browser, terminal, git, search, etc.). Key methods: `registerCoreTools()`, `executeTool()`, `getToolSchemas()`. |
| `GitService.ts` | 11 KB | **Git Wrapper.** Interfaces with the system `git` binary for version control. Key methods: `getStatus()`, `getLog()`, `stage()`, `commit()`, `sync()`, `fetchGithubRepos()`, `cloneRepo()`. |
| `FileService.ts` | 9 KB | **Filesystem Operations.** Safe wrappers for directory listing, file reading/writing, copying, moving, deleting, and content searching. Key methods: `listDirectory()`, `readFile()`, `createFile()`, `searchFiles()`. |
| `AstroService.ts` | 7 KB | **Astro Engine Client.** Connects to the `astro-engine` MCP server for astrological emotional state calculation. Key methods: `getEmotionalState()`, `createProfile()`, `igniteEngine()`. |
| `RagService.ts` | 7 KB | **RAG Client.** Connects to the `tala-core` MCP server for vector search and file ingestion. Key methods: `search()`, `logInteraction()`, `ingestFile()`, `deleteFileMemory()`, `listIndexedFiles()`. |
| `InferenceService.ts` | 7 KB | **Local LLM Scanner.** Detects and manages local inference engines (Ollama, Llama.cpp, LM Studio). Key methods: `scanLocal()`, `installEngine()`, `checkPort()`. |
| `SystemService.ts` | 6 KB | **Environment Detection.** Discovers OS info, Node/Python paths, virtual environments, and workspace config. Key methods: `detectEnv()`, `findPython()`, `checkVenv()`. |
| `FunctionService.ts` | 5 KB | **Custom Script Runner.** Manages user-defined agent functions (`.py` / `.js` scripts in `.agent/functions/`). Key methods: `executeFunction()`, `listFunctions()`, `saveFunction()`. |
| `MemoryService.ts` | 5 KB | **Mem0 Client.** Short-term user fact storage via the `mem0-core` MCP server with local JSON fallback. Key methods: `search()`, `add()`, `ignite()`, `loadLocal()`. |
| `McpService.ts` | 4 KB | **MCP Connection Manager.** Spawns and maintains connections to Python microservices via `StdioClientTransport` or `WebSocketClientTransport`. Key methods: `connect()`, `getCapabilities()`, `sync()`. |
| `WorkflowService.ts` | 4 KB | **Workflow CRUD.** File-based persistence for workflow JSON definitions in `.agent/workflows/`. Key methods: `listWorkflows()`, `saveWorkflow()`, `deleteWorkflow()`, `importWorkflow()`. |
| `TerminalService.ts` | 3 KB | **PTY Manager.** Spawns pseudo-terminal sessions (PowerShell/bash) and streams output to the frontend `xterm.js`. Key methods: `createTerminal()`, `write()`, `resize()`. |
| `BackupService.ts` | 3 KB | **Workspace Backup.** Creates zip archives of the workspace on a schedule or on demand. Key methods: `performBackup()`, `scheduleBackup()`. |
