/**
 * Electron Preload Script
 * 
 * This script acts as a secure bridge between the Electron main process
 * and the renderer UI. It exposes the `window.tala` object using 
 * the `contextBridge` API.
 * 
 * **Security Boundary:**
 * - Uses `ipcRenderer.invoke` for request-response patterns.
 * - Uses `ipcRenderer.send` for fire-and-forget events.
 * - Restricts communication to a whitelist of approved IPC channels.
 */
import { contextBridge, ipcRenderer } from 'electron';

/**
 * Electron Preload Script — Main Window Context Bridge
 * 
 * This script runs in a sandboxed context between the Electron main process
 * and the renderer (React UI). It uses `contextBridge.exposeInMainWorld()`
 * to safely expose a `window.tala` API object that the renderer can call
 * to communicate with the main process via IPC.
 * 
 * **Security model:**
 * - `send()` and `on()` whitelist specific channel names to prevent
 *   arbitrary IPC access from the renderer.
 * - `ipcRenderer.invoke()` calls use Electron's request/response pattern
 *   for secure two-way communication.
 * - The raw `ipcRenderer` and `event` objects are never exposed to the renderer.
 * 
 * **API groups exposed on `window.tala`:**
 * - **Versions** — Node, Chrome, Electron version strings.
 * - **IPC primitives** — `send()`, `on()`, `off()` for raw messaging.
 * - **Profile & Settings** — User profile and app settings CRUD.
 * - **System** — System info, login, local provider scanning.
 * - **File operations** — Directory listing, file R/W, copy, move, delete.
 * - **Terminal** — PTY initialization, resize, input.
 * - **Git** — Full Git workflow (status, stage, commit, sync, branches, stash).
 * - **MCP** — Capabilities retrieval for connected MCP servers.
 * - **Functions** — User-defined custom function CRUD.
 * - **Workflows** — Workflow CRUD, import, and execution.
 * - **RAG** — File ingestion, deletion, and search.
 * - **Browser** — `provideBrowserData()` for browser→agent data relay.
 */
contextBridge.exposeInMainWorld('tala', {
    // ─── Version Info ─────────────────────────────────────────────
    /** Returns runtime version strings (Node.js, Chrome, Electron). */
    versions: {
        node: () => process.versions.node,
        chrome: () => process.versions.chrome,
        electron: () => process.versions.electron,
    },

    // ─── IPC Primitives ───────────────────────────────────────────
    /**
     * Sends a one-way message to the main process on a whitelisted channel.
     * 
     * @param {string} channel - Channel name (`'toMain'` or `'chat-message'`).
     * @param {any} data - Payload to send.
     */
    send: (channel: string, data: any) => {
        let validChannels = ["toMain", "chat-message", "chat-cancel"];
        if (validChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        }
    },

    /**
     * Subscribes to messages from the main process on a whitelisted channel.
     * 
     * The raw Electron `event` object is stripped for security — only the
     * message payload is forwarded to the callback.
     * 
     * @param {string} channel - Channel name to listen on.
     * @param {Function} func - Callback receiving the message data.
     */
    on: (channel: string, func: (...args: any[]) => void) => {
        let validChannels = ["fromMain", "chat-token", "chat-done", "chat-error", "profile-data", "terminal-data", "agent-event", "file-changed", "sessions-update", "debug-update", "startup-status", "astro-update", "reflection:proposal-created", "system:notification", "reflection:telemetry", "reflection:activityUpdated", "execution:dashboardUpdate", "execution:telemetry", "governance:dashboardUpdate", "autonomy:dashboardUpdate", "autonomy:telemetry", "campaign:dashboardUpdate", "harmonization:dashboardUpdate", "crossSystem:dashboardUpdate", "strategyRouting:dashboardUpdate"];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    },

    /**
     * Removes all listeners from a channel.
     * Uses brute-force cleanup since the original callback is wrapped.
     */
    off: (channel: string, func: (...args: any[]) => void) => {
        ipcRenderer.removeAllListeners(channel);
    },

    // ─── Profile & Settings ──────────────────────────────────────
    /** Saves user profile data to disk. */
    saveProfile: (data: any) => ipcRenderer.invoke('save-profile', data),
    /** Retrieves the user profile from disk. */
    getProfile: () => ipcRenderer.invoke('get-profile'),
    /** Ensures a default profile exists, creating one if necessary. */
    ensureProfile: () => ipcRenderer.invoke('ensure-profile'),
    /** Saves application settings to `app_settings.json`. */

    // ─── Chat Control ────────────────────────────────────────────
    /** Cancels the active streaming response. */
    cancelChat: () => ipcRenderer.send('chat-cancel'),
    /** Returns persisted chat history for UI restoration. */
    getChatHistory: () => ipcRenderer.invoke('get-chat-history'),
    /** Clears persisted chat history. */
    /** Request a response regeneration (rewind history). */
    rewindChat: (index: number) => ipcRenderer.invoke('rewind-chat', index),

    /** Export chat history to file. */
    exportChat: (format: 'json' | 'md' | 'txt') => ipcRenderer.invoke('export-chat', format),

    /** Request a clear of chat history. */

    /** Request a clear of chat history. */
    clearChatHistory: () => ipcRenderer.invoke('clear-chat-history'),
    /** Lists all saved chat sessions (newest first). */
    listSessions: () => ipcRenderer.invoke('list-sessions'),
    /** Loads a session by ID and returns its messages. */
    loadSession: (id: string) => ipcRenderer.invoke('load-session', id),
    /** Deletes a session by ID. */
    deleteSession: (id: string) => ipcRenderer.invoke('delete-session', id),
    /** Creates a new empty session and returns its ID. */
    newSession: () => ipcRenderer.invoke('new-session'),
    /** Forks a session at a specific message index, creating a branched copy. */
    branchSession: (sourceId: string, messageIndex: number) => ipcRenderer.invoke('branch-session', { sourceId, messageIndex }),
    /** Returns the current astro state string (including emotional vector). */
    getEmotionState: () => ipcRenderer.invoke('get-emotion-state'),
    saveSettings: (data: any) => ipcRenderer.invoke('save-settings', data),
    /** Sets the active notebook context (ID and source paths) for the agent. */
    setActiveNotebookContext: (id: string | null, sourcePaths: string[]) => ipcRenderer.invoke('set-active-notebook-context', { id, sourcePaths }),
    /** Saves workspace-specific settings to `.tala/settings.json`. */
    saveWorkspaceSettings: (data: any) => ipcRenderer.invoke('save-workspace-settings', data),
    /** Exports global settings to a user-selected JSON file. */
    exportSettings: () => ipcRenderer.invoke('export-settings'),
    /** Imports settings from a JSON file, overwriting global config. returns { success, settings? } */
    importSettings: () => ipcRenderer.invoke('import-settings'),
    /** Retrieves application settings (Global + Workspace). */
    getSettings: () => ipcRenderer.invoke('get-settings'),

    // ─── Session Persistence ──────────────────────────────────────
    /** Saves the current session state (tabs, active tab). */
    saveSession: (data: any) => ipcRenderer.invoke('save-session', data),
    /** Retrieves the last saved session state. */
    getSession: () => ipcRenderer.invoke('get-session'),

    // ─── Settings (Authoritative) ────────────────────────────────
    settings: {
        setActiveMode: (mode: string) => {
            console.log(`[Preload] setActiveMode called with: ${mode}`);
            return ipcRenderer.invoke('settings:setActiveMode', mode);
        },
        getActiveMode: () => {
            return ipcRenderer.invoke('settings:getActiveMode');
        }
    },

    /** Returns a list of all registered tools (core + MCP). */
    getAllTools: () => ipcRenderer.invoke('get-all-tools'),

    // ─── System ──────────────────────────────────────────────────
    /** Triggers a clean shutdown of the application. */
    shutdown: () => ipcRenderer.invoke('app:shutdown'),
    /** Gets system environment info (OS, Python/Node paths). */
    getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
    /** Gets the current startup progress status. */
    getStartupStatus: () => ipcRenderer.invoke('get-startup-status'),
    /** Gets current model status (low-fidelity warning). */
    getModelStatus: () => ipcRenderer.invoke('get-model-status'),
    /** Initiates OAuth login for a cloud provider. */
    login: (provider: string) => ipcRenderer.invoke('login', provider),
    /** Scans for locally-available inference providers (Ollama, LlamaCPP, etc.). */
    scanLocalProviders: () => ipcRenderer.invoke('scan-local-providers'),
    /** Returns the latest runtime inference provider inventory. */
    inferenceListProviders: () => ipcRenderer.invoke('inference:listProviders'),
    /** Forces a live re-probe of inference providers and returns fresh inventory. */
    inferenceRefreshProviders: () => ipcRenderer.invoke('inference:refreshProviders'),
    /** Scans for running local models (Ollama, LM Studio). */
    scanLocalModels: () => ipcRenderer.invoke('scan-local-models'),
    /** Installs a local inference engine by ID (downloads binaries). */
    installLocalEngine: (engineId: string) => ipcRenderer.invoke('install-local-engine', engineId),
    /** Starts the built-in local inference engine (llama.cpp). */
    startLocalEngine: (args: { modelPath: string, options?: any }) => ipcRenderer.invoke('local-engine-start', args),
    /** Stops the built-in local inference engine. */
    stopLocalEngine: () => ipcRenderer.invoke('local-engine-stop'),
    /** Gets the status of the built-in local inference engine. */
    getLocalEngineStatus: () => ipcRenderer.invoke('local-engine-status'),
    /** Downloads the llama-server binary. */
    downloadLocalEngineBinary: () => ipcRenderer.invoke('local-engine-download-binary'),
    /** Downloads the default LLM model. */
    downloadLocalEngineModel: () => ipcRenderer.invoke('local-engine-download-model'),
    /** Downloads the portable Python runtime. */
    downloadLocalEnginePython: () => ipcRenderer.invoke('local-engine-download-python'),
    /**
     * Subscribes to engine asset download progress.
     * Returns an unsubscribe function.
     */
    onLocalEngineDownloadProgress: (callback: (data: { type: 'binary' | 'model' | 'python', progress: number }) => void) => {
        const listener = (event: any, data: any) => callback(data);
        ipcRenderer.on('local-engine-download-progress', listener);
        return () => ipcRenderer.removeListener('local-engine-download-progress', listener);
    },

    // ─── Backup ──────────────────────────────────────────────────
    /** Triggers an immediate backup of the workspace. */
    backupNow: () => ipcRenderer.invoke('backup-now'),
    /** Tests the connection to the configured backup provider. */
    testBackupConnection: (config: any) => ipcRenderer.invoke('test-backup-connection', config),

    // ─── Memory Operations ───────────────────────────────────────
    /** Retrieves all memory items. */
    getAllMemoryItems: () => ipcRenderer.invoke('get-all-memories'),
    /** Adds a new memory item. */
    addMemoryItem: (text: string) => ipcRenderer.invoke('add-memory', text),
    /** Deletes a memory item by ID. */
    deleteMemoryItem: (id: string) => ipcRenderer.invoke('delete-memory', id),
    /** Updates a memory item. */
    updateMemoryItem: (id: string, text: string) => ipcRenderer.invoke('update-memory', { id, text }),

    /** Prunes memory items. */
    pruneMemory: (ttlDays: number, maxItems: number) => ipcRenderer.invoke('memory-prune', ttlDays, maxItems),

    /** Returns the current MemoryOperatorReviewModel for the operator review panel. Read-only. */
    getMemoryOperatorReviewModel: () => ipcRenderer.invoke('memory:getOperatorReviewModel'),
    /** Triggers an immediate memory maintenance analytics run. Human-gated. */
    runMemoryMaintenanceNow: () => ipcRenderer.invoke('memory:runMaintenanceNow'),

    // ─── File Operations ─────────────────────────────────────────
    /** Lists contents of a directory. */
    listDirectory: (path: string) => ipcRenderer.invoke('list-directory', path),
    /** Reads a file's content as a string. */
    readFile: (path: string) => ipcRenderer.invoke('read-file', path),
    /** Creates a new directory. */
    createDirectory: (path: string) => ipcRenderer.invoke('create-directory', path),
    /** Deletes a file or directory. */
    deletePath: (path: string) => ipcRenderer.invoke('delete-path', path),
    /** Creates a new file with the given content. */
    createFile: (path: string, content: string) => ipcRenderer.invoke('create-file', path, content),
    /** Copies a file or directory from src to dest. */
    copyPath: (src: string, dest: string) => ipcRenderer.invoke('copy-path', src, dest),
    /** Moves a file or directory from src to dest. */
    movePath: (src: string, dest: string) => ipcRenderer.invoke('move-path', src, dest),
    /** Opens a native folder-picker dialog and returns the selected path. */
    openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
    /** Opens a native file-picker dialog and returns the selected path. */
    selectFile: (filters?: any) => ipcRenderer.invoke('select-file', filters),
    /** Gets the current workspace root path. */
    getRoot: () => ipcRenderer.invoke('get-root'),
    /** Resolves the absolute path to a bundled asset file. */
    getAssetPath: (filename: string) => ipcRenderer.invoke('get-asset-path', filename),

    // ─── Terminal ─────────────────────────────────────────────────
    /** Spawns a new PTY terminal process and returns its ID. */
    initTerminal: (id?: string) => ipcRenderer.invoke('terminal-init', id),
    /** Resizes the terminal. */
    resizeTerminal: (id: string, cols: number, rows: number) => ipcRenderer.invoke('terminal-resize', { id, cols, rows }),
    /** Sends raw input data to the terminal's stdin (one-way). */
    sendTerminalInput: (id: string, data: string) => ipcRenderer.send('terminal-input', { id, data }),
    /** Kills a terminal process by ID. */
    killTerminal: (id: string) => ipcRenderer.invoke('terminal-kill', id),

    // ─── Git Operations ───────────────────────────────────────────
    /** Checks if Git is installed and if the workspace is a valid Git repository. */
    gitCheck: () => ipcRenderer.invoke('git-check'),
    /** Returns the working tree status (staged, unstaged, untracked). */
    gitStatus: () => ipcRenderer.invoke('git-status'),
    /** Stages a file for commit. */
    gitStage: (file: string) => ipcRenderer.invoke('git-stage', file),
    /** Unstages a file. */
    gitUnstage: (file: string) => ipcRenderer.invoke('git-unstage', file),
    /** Creates a commit with the given message. */
    gitCommit: (msg: string) => ipcRenderer.invoke('git-commit', msg),
    /** Pushes/pulls to/from the remote with the provided credentials. */
    gitSync: (creds: { token: string, username: string }) => ipcRenderer.invoke('git-sync', creds),
    /** Scans for configured remotes. */
    gitRemotes: () => ipcRenderer.invoke('git-remotes'),
    /** Fetches the user's GitHub repositories using their token. */
    gitFetchRepos: (creds: { username: string, token: string }) => ipcRenderer.invoke('git-fetch-repos', creds),
    gitGetSlug: () => ipcRenderer.invoke('git-get-slug'),
    gitFetchIssues: (args: { owner: string, repo: string, token: string }) => ipcRenderer.invoke('git-fetch-issues', args),
    gitFetchPRs: (args: { owner: string, repo: string, token: string }) => ipcRenderer.invoke('git-fetch-prs', args),
    /** Initializes a new Git repository in the workspace. */
    gitInit: () => ipcRenderer.invoke('git-init'),
    /** Lists all local and remote branches. */
    gitBranches: () => ipcRenderer.invoke('git-branches'),
    /** Gets the name of the currently checked-out branch. */
    gitCurrentBranch: () => ipcRenderer.invoke('git-current-branch'),
    /** Checks out a branch. */
    gitCheckout: (branch: string) => ipcRenderer.invoke('git-checkout', branch),
    /** Creates a new branch from HEAD. */
    gitCreateBranch: (name: string) => ipcRenderer.invoke('git-create-branch', name),
    /** Deletes a branch (local). */
    gitDeleteBranch: (name: string) => ipcRenderer.invoke('git-delete-branch', name),
    /** Gets the commit log (limited entries). */
    gitLog: (limit?: number) => ipcRenderer.invoke('git-log', limit),
    /** Gets the diff for a specific file or the entire working tree. */
    gitDiff: (file?: string) => ipcRenderer.invoke('git-diff', file),
    /** Stashes all uncommitted changes. */
    gitStashPush: () => ipcRenderer.invoke('git-stash-push'),
    /** Pops the most recent stash entry. */
    gitStashPop: () => ipcRenderer.invoke('git-stash-pop'),

    // ─── MCP ──────────────────────────────────────────────────────
    /** Gets the tool/resource capabilities of a connected MCP server. */
    getMcpCapabilities: (serverId: string) => ipcRenderer.invoke('get-mcp-capabilities', serverId),

    // ─── Functions ────────────────────────────────────────────────
    /** Lists all user-defined custom functions. */
    getFunctions: () => ipcRenderer.invoke('get-functions'),
    /** Saves a custom function (Python or JavaScript). */
    saveFunction: (data: { name: string, content: string, type: string }) => ipcRenderer.invoke('save-function', data),
    /** Deletes a custom function by name and type. */
    deleteFunction: (data: { name: string, type: string }) => ipcRenderer.invoke('delete-function', data),

    // ─── Workflows ────────────────────────────────────────────────
    /** Lists all saved workflows. */
    getWorkflows: () => ipcRenderer.invoke('get-workflows'),
    /** Saves a workflow definition (JSON). */
    saveWorkflow: (workflow: any) => ipcRenderer.invoke('save-workflow', workflow),
    /** Deletes a workflow by ID. */
    deleteWorkflow: (id: string) => ipcRenderer.invoke('delete-workflow', id),
    /** Imports workflow definitions from a URL. */
    importWorkflows: (url: string) => ipcRenderer.invoke('import-workflows', url),
    /** Executes a workflow by ID with optional initial input data. */
    executeWorkflow: (workflowId: string, input?: any) => ipcRenderer.invoke('execute-workflow', { workflowId, input }),
    /** Lists execution runs for a workflow. */
    getWorkflowRuns: (workflowId: string) => ipcRenderer.invoke('get-workflow-runs', workflowId),
    /** Deletes a workflow run record. */
    deleteWorkflowRun: (workflowId: string, runId: string) => ipcRenderer.invoke('delete-workflow-run', { workflowId, runId }),

    // Workflow Debugging
    debugWorkflowStart: (workflow: any, input: any) => ipcRenderer.invoke('debug-workflow-start', { workflow, input }),
    debugWorkflowStep: (workflowId: string) => ipcRenderer.invoke('debug-workflow-step', workflowId),
    debugWorkflowStop: (workflowId: string) => ipcRenderer.invoke('debug-workflow-stop', workflowId),
    /**
     * Subscribes to engine install progress events.
     * Returns an unsubscribe function for cleanup.
     */
    onInstallProgress: (callback: any) => {
        const listener = (event: any, data: any) => callback(data);
        ipcRenderer.on('install-progress', listener);
        return () => ipcRenderer.removeListener('install-progress', listener);
    },


    // ─── Guardrails ───────────────────────────────────────────────
    /** Saves the user's content guardrail rules (legacy). */
    saveGuardrails: (guardrails: any[]) => ipcRenderer.invoke('save-guardrails', guardrails),

    // ─── Guard Builder (GuardrailsAI-compatible) ──────────────────
    /** Lists all Guard definitions. */
    listGuards: () => ipcRenderer.invoke('guardrail:list'),
    /** Gets a Guard by ID. */
    getGuard: (id: string) => ipcRenderer.invoke('guardrail:get', id),
    /** Creates or updates a Guard definition. */
    saveGuard: (definition: any) => ipcRenderer.invoke('guardrail:save', definition),
    /** Deletes a Guard by ID. */
    deleteGuard: (id: string) => ipcRenderer.invoke('guardrail:delete', id),
    /** Validates text against a Guard's validator stack. */
    validateWithGuard: (guardId: string, value: string, target: 'input' | 'output') =>
        ipcRenderer.invoke('guardrail:validate', { guardId, value, target }),
    /** Returns the full validator registry (types, labels, args schemas). */
    getValidatorRegistry: () => ipcRenderer.invoke('guardrail:get-validators'),
    /** Exports a Guard to a standalone Python script via save dialog. */
    exportGuardToPython: (guardId: string) => ipcRenderer.invoke('guardrail:export-to-python', guardId),

    // ─── RAG & Search ─────────────────────────────────────────────
    /** Triggers a background scan and ingestion of the memory folder. */
    scanAndIngest: () => ipcRenderer.invoke('ingest-scan'),
    /** Ingests a file into the RAG vector database. */
    ingestFile: (path: string) => ipcRenderer.invoke('ingest-file', path),
    /** Removes a file from the RAG index. */
    deleteMemory: (path: string) => ipcRenderer.invoke('rag-delete', path),
    /** Lists all files currently indexed in RAG. */
    listIndexedFiles: () => ipcRenderer.invoke('rag-list'),
    /** Searches local files by query string. */
    searchFiles: (query: string) => ipcRenderer.invoke('search-local', query),
    /** Searches remote/web sources by query string. */
    searchRemote: (query: string) => ipcRenderer.invoke('search-remote', query),
    /** Scrapes a URL and returns its text content. */
    scrapeUrl: (url: string, title?: string) => ipcRenderer.invoke('search-scrape', { url, title }),

    // ─── Research Collections ─────────────────────────────────────
    /** List all notebooks from PostgreSQL. */
    researchListNotebooks: () => ipcRenderer.invoke('research:listNotebooks'),
    /** Get a single notebook by id. */
    researchGetNotebook: (id: string) => ipcRenderer.invoke('research:getNotebook', id),
    /** Create a new notebook. */
    researchCreateNotebook: (input: { name: string; description?: string }) => ipcRenderer.invoke('research:createNotebook', input),
    /** Update an existing notebook. */
    researchUpdateNotebook: (id: string, input: Record<string, unknown>) => ipcRenderer.invoke('research:updateNotebook', id, input),
    /** Delete a notebook. */
    researchDeleteNotebook: (id: string) => ipcRenderer.invoke('research:deleteNotebook', id),
    /** List items in a notebook. */
    researchListNotebookItems: (notebookId: string) => ipcRenderer.invoke('research:listNotebookItems', notebookId),
    /** Add items to a notebook. */
    researchAddItemsToNotebook: (notebookId: string, items: unknown[], searchRunId?: string) => ipcRenderer.invoke('research:addItemsToNotebook', notebookId, items, searchRunId),
    /** Remove an item from a notebook. */
    researchRemoveNotebookItem: (notebookId: string, itemKey: string) => ipcRenderer.invoke('research:removeNotebookItem', notebookId, itemKey),
    /** Remove multiple items from a notebook in one operation. */
    researchRemoveNotebookItems: (notebookId: string, itemKeys: string[]) => ipcRenderer.invoke('research:removeNotebookItems', notebookId, itemKeys),
    /** Create a search run and return its id. */
    researchCreateSearchRun: (input: { query_text: string; notebook_id?: string }) => ipcRenderer.invoke('research:createSearchRun', input),
    /** Add results to a search run. */
    researchAddSearchRunResults: (searchRunId: string, results: unknown[]) => ipcRenderer.invoke('research:addSearchRunResults', searchRunId, results),
    /** Get results for a search run. */
    researchGetSearchRunResults: (searchRunId: string) => ipcRenderer.invoke('research:getSearchRunResults', searchRunId),
    /** Create a notebook from all results in a search run. */
    researchCreateNotebookFromSearchRun: (searchRunId: string, notebookName: string, description?: string, selectedItemKeys?: string[]) => ipcRenderer.invoke('research:createNotebookFromSearchRun', searchRunId, notebookName, description, selectedItemKeys),
    /** Copy all results from a search run into an existing notebook. */
    researchAddSearchRunResultsToNotebook: (searchRunId: string, notebookId: string, selectedItemKeys?: string[]) => ipcRenderer.invoke('research:addSearchRunResultsToNotebook', searchRunId, notebookId, selectedItemKeys),
    /** Resolve notebook scope (URIs and source paths) for retrieval scoping. */
    researchResolveNotebookScope: (notebookId: string) => ipcRenderer.invoke('research:resolveNotebookScope', notebookId),

    // ─── Content Ingestion ────────────────────────────────────────────────────
    /** Ingest all notebook items in a notebook into source_documents and document_chunks. */
    ingestNotebook: (notebookId: string, options?: Record<string, unknown>, refetch?: boolean) =>
        ipcRenderer.invoke('ingestion:ingestNotebook', notebookId, options, refetch),
    /** Ingest a list of notebook items by item_key into source_documents and document_chunks. */
    ingestItems: (itemKeys: string[], notebookId?: string, options?: Record<string, unknown>, refetch?: boolean) =>
        ipcRenderer.invoke('ingestion:ingestItems', itemKeys, notebookId, options, refetch),

    // ─── Chunk Embeddings ─────────────────────────────────────────────────────
    /** Embed all document_chunks for items in a notebook into chunk_embeddings. */
    embedNotebook: (notebookId: string, options?: { reembed?: boolean }) =>
        ipcRenderer.invoke('embeddings:embedNotebook', notebookId, options),
    /** Embed document_chunks for a list of item_keys into chunk_embeddings. */
    embedItems: (itemKeys: string[], options?: { reembed?: boolean }) =>
        ipcRenderer.invoke('embeddings:embedItems', itemKeys, options),
    /** Embed a list of document_chunks by their chunk IDs. */
    embedChunks: (chunkIds: string[], options?: { reembed?: boolean }) =>
        ipcRenderer.invoke('embeddings:embedChunks', chunkIds, options),

    // ─── Retrieval Orchestration ──────────────────────────────────────────────
    /** Execute a canonical retrieval request via RetrievalOrchestrator. */
    retrievalRetrieve: (request: import('../shared/retrieval/retrievalTypes').RetrievalRequest) => ipcRenderer.invoke('retrieval:retrieve', request),
    /** List all currently registered retrieval providers. */
    retrievalListProviders: () => ipcRenderer.invoke('retrieval:listProviders'),
    /** Refresh external search provider registration from current settings. */
    retrievalRefreshExternalProvider: () => ipcRenderer.invoke('retrieval:refreshExternalProvider'),

    // ─── Context Assembly (Step 5B) ───────────────────────────────────────────
    /**
     * Assemble policy-governed, prompt-ready context from retrieval results.
     * Resolves the active MemoryPolicy, retrieves candidates, enforces budget,
     * and returns a ContextAssemblyResult with full citation/provenance metadata.
     * Policy logic is backend-owned and runs in the main process only.
     */
    contextAssemble: (request: import('../shared/policy/memoryPolicyTypes').ContextAssemblyRequest) => ipcRenderer.invoke('context:assemble', request),

    // ─── Browser Data Relay ───────────────────────────────────────
    /**
     * Sends browser data (DOM or screenshot) from the renderer back to the
     * main process for the AgentService's `provideBrowserData()` method.
     * 
     * @param {string} type - Data type (`'dom'`, `'screenshot'`, or `'debug'`).
     * @param {any} data - The payload (DOM string or base64 screenshot).
     */
    provideBrowserData: (type: string, data: any) => ipcRenderer.send('browser-data-reply', { type, data }),

    // ─── Reflection System ───────────────────────────────────────
    getDashboardState: (activeMode?: string) => ipcRenderer.invoke('reflection:getDashboardState', activeMode),
    triggerReflection: (activeMode?: string) => ipcRenderer.invoke('reflection:trigger', activeMode),
    runReflectionNow: (activeMode?: string) => ipcRenderer.invoke('reflection:runNow', activeMode),
    listIssues: () => ipcRenderer.invoke('reflection:listIssues'),
    listGoals: () => ipcRenderer.invoke('reflection:listGoals'),
    createGoal: (goalDef: any) => ipcRenderer.invoke('reflection:createGoal', goalDef),
    updateGoal: (goalId: string, status: string) => ipcRenderer.invoke('reflection:updateGoal', goalId, status),
    listProposals: () => ipcRenderer.invoke('reflection:listProposals'),
    getProposal: (id: string) => ipcRenderer.invoke('reflection:getProposal', id),
    listJournalEntries: () => ipcRenderer.invoke('reflection:listJournalEntries'),
    listPromotions: () => ipcRenderer.invoke('reflection:listPromotions'),
    listRollbacks: () => ipcRenderer.invoke('reflection:listRollbacks'),
    promoteProposal: (id: string) => ipcRenderer.invoke('reflection:promoteProposal', id),
    rollbackPromotion: (id: string) => ipcRenderer.invoke('reflection:rollbackPromotion', id),
    getQueueState: () => ipcRenderer.invoke('reflection:getQueueState'),
    getSchedulerState: () => ipcRenderer.invoke('reflection:getSchedulerState'),
    processNextGoal: () => ipcRenderer.invoke('reflection:processNextGoal'),
    cancelQueueItem: (id: string) => ipcRenderer.invoke('reflection:cancelQueueItem', id),
    retryQueueItem: (id: string) => ipcRenderer.invoke('reflection:retryQueueItem', id),
    autoFixEvaluate: (proposalId: string) => ipcRenderer.invoke('reflection:autoFixEvaluate', proposalId),
    autoFixDryRun: (proposalId: string) => ipcRenderer.invoke('reflection:autoFixDryRun', proposalId),
    autoFixRun: (proposalId: string) => ipcRenderer.invoke('reflection:autoFixRun', proposalId),
    listAutoFixProposals: () => ipcRenderer.invoke('reflection:listAutoFixProposals'),
    listAutoFixOutcomes: () => ipcRenderer.invoke('reflection:listAutoFixOutcomes'),

    // ─── Phase 3.5 integration: promote a Phase 2 planned proposal + trigger governance ──
    /** Promotes a classified SafeChangeProposal and triggers automatic governance evaluation. */
    promotePlannedProposal: (proposalId: string) => ipcRenderer.invoke('planning:promoteProposal', proposalId),

    /** Gets reflection system metrics (legacy). */
    getReflectionMetrics: () => ipcRenderer.invoke('reflection:getMetrics'),
    /** Lists pending proposals awaiting approval (legacy). */
    getReflectionProposals: (status?: string) => ipcRenderer.invoke('reflection:get-proposals', status),
    /** Lists historical reflection events (legacy). */
    getReflectionEvents: () => ipcRenderer.invoke('reflection:getReflections'),
    /** Approves a proposal by ID (legacy). */
    approveProposal: (id: string) => ipcRenderer.invoke('reflection:approveProposal', id),
    /** Rejects a proposal by ID (legacy). */
    rejectProposal: (id: string) => ipcRenderer.invoke('reflection:rejectProposal', id),
    /** Forces a heartbeat tick (debug). */
    forceHeartbeat: () => ipcRenderer.invoke('reflection:forceTick'),
    /** Subscribes to new proposal notifications. Returns cleanup function. */
    onProposalCreated: (callback: (data: any) => void) => {
        const listener = (event: any, data: any) => callback(data);
        ipcRenderer.on('reflection:proposal-created', listener);
        return () => ipcRenderer.removeListener('reflection:proposal-created', listener);
    },
    /** Subscribes to new reflection telemetry events. Returns cleanup function. */
    onReflectionTelemetry: (callback: (data: any) => void) => {
        const listener = (event: any, data: any) => callback(data);
        ipcRenderer.on('reflection:telemetry', listener);
        return () => ipcRenderer.removeListener('reflection:telemetry', listener);
    },
    /** Subscribes to reflection pipeline activity updates. */
    onReflectionActivityUpdated: (callback: (data: any) => void) => {
        const listener = (event: any, data: any) => callback(data);
        ipcRenderer.on('reflection:activityUpdated', listener);
        return () => ipcRenderer.removeListener('reflection:activityUpdated', listener);
    },

    // ─── Phase 3: Controlled Execution ────────────────────────────
    /** Starts a controlled execution run for a promoted proposal. */
    startExecution: (request: any) => ipcRenderer.invoke('execution:startRun', request),
    /** Starts a dry-run (no filesystem mutations). */
    startDryRun: (request: any) => ipcRenderer.invoke('execution:startDryRun', request),
    /** Gets the current state of an execution run. */
    getExecutionStatus: (executionId: string) => ipcRenderer.invoke('execution:getRunStatus', executionId),
    /** Lists recent execution runs. */
    listExecutions: (windowMs?: number) => ipcRenderer.invoke('execution:listRuns', windowMs),
    /** Aborts an active execution run. */
    abortExecution: (request: any) => ipcRenderer.invoke('execution:abortRun', request),
    /** Reads the audit log for an execution run. */
    getExecutionAuditLog: (executionId: string) => ipcRenderer.invoke('execution:getAuditLog', executionId),
    /** Gets the execution dashboard state (KPIs + active run). */
    getExecutionDashboardState: (promotedProposalsReady?: number) => ipcRenderer.invoke('execution:getDashboardState', promotedProposalsReady),
    /** Records a manual verification check result. */
    recordManualCheck: (executionId: string, passed: boolean, notes?: string) => ipcRenderer.invoke('execution:recordManualCheck', executionId, passed, notes),
    /** Subscribes to execution dashboard updates. Returns cleanup function. */
    onExecutionUpdate: (callback: (data: any) => void) => {
        const listener = (event: any, data: any) => callback(data);
        ipcRenderer.on('execution:dashboardUpdate', listener);
        return () => ipcRenderer.removeListener('execution:dashboardUpdate', listener);
    },
    /** Subscribes to execution telemetry events. Returns cleanup function. */
    onExecutionTelemetry: (callback: (data: any) => void) => {
        const listener = (event: any, data: any) => callback(data);
        ipcRenderer.on('execution:telemetry', listener);
        return () => ipcRenderer.removeListener('execution:telemetry', listener);
    },

    // ─── Phase 3.5: Human-in-the-Loop Governance ─────────────────
    /** Gets the governance decision for a proposal. */
    getGovernanceDecision: (proposalId: string) => ipcRenderer.invoke('governance:getDecision', proposalId),
    /** Lists governance decisions, optionally filtered by status. */
    listGovernanceDecisions: (filter?: { status?: string }) => ipcRenderer.invoke('governance:listDecisions', filter),
    /** Gets the governance dashboard state (KPIs + approval queue). */
    getGovernanceDashboardState: () => ipcRenderer.invoke('governance:getDashboardState'),
    /** Evaluates governance policy for a proposal (creates/returns decision). */
    evaluateGovernance: (proposalId: string) => ipcRenderer.invoke('governance:evaluateProposal', proposalId),
    /** Records a human approval for a governance proposal. */
    approveGovernanceProposal: (request: { proposalId: string; reason?: string }) => ipcRenderer.invoke('governance:approve', request),
    /** Records a human rejection for a governance proposal. */
    rejectGovernanceProposal: (request: { proposalId: string; reason: string }) => ipcRenderer.invoke('governance:reject', request),
    /** Records a deferral for a proposal. */
    deferProposal: (request: { proposalId: string; reason?: string }) => ipcRenderer.invoke('governance:defer', request),
    /** Marks a confirmation requirement as satisfied. */
    satisfyGovernanceConfirmation: (request: { proposalId: string; confirmationId: string }) => ipcRenderer.invoke('governance:satisfyConfirmation', request),
    /** Reads the governance audit log for a proposal. */
    getGovernanceAuditLog: (proposalId: string) => ipcRenderer.invoke('governance:getAuditLog', proposalId),
    /** Checks whether a proposal's governance decision authorizes execution. */
    getGovernanceAuthorizationDecision: (proposalId: string) => ipcRenderer.invoke('governance:getAuthorizationDecision', proposalId),
    /** Gets the active governance policy. */
    getActiveGovernancePolicy: () => ipcRenderer.invoke('governance:getActivePolicy'),
    /** Subscribes to governance dashboard updates. Returns cleanup function. */
    onGovernanceUpdate: (callback: (data: any) => void) => {
        const listener = (event: any, data: any) => callback(data);
        ipcRenderer.on('governance:dashboardUpdate', listener);
        return () => ipcRenderer.removeListener('governance:dashboardUpdate', listener);
    },

    // ─── Phase 4: Autonomous Self-Improvement ────────────────────
    autonomy: {
        /** Gets the full autonomy dashboard state. */
        getDashboardState: () => ipcRenderer.invoke('autonomy:getDashboardState'),
        /** Lists all autonomous goals (scored, active, completed). */
        listGoals: () => ipcRenderer.invoke('autonomy:listGoals'),
        /** Gets a specific autonomous goal by ID. */
        getGoal: (goalId: string) => ipcRenderer.invoke('autonomy:getGoal', goalId),
        /** Lists autonomous runs within the given window. */
        listRuns: (windowMs?: number) => ipcRenderer.invoke('autonomy:listRuns', windowMs),
        /** Gets a specific autonomous run by ID. */
        getRun: (runId: string) => ipcRenderer.invoke('autonomy:getRun', runId),
        /** Manually triggers one detection + scoring + execution cycle. */
        runCycleOnce: () => ipcRenderer.invoke('autonomy:runCycleOnce'),
        /** Enables or disables global autonomy. */
        setGlobalEnabled: (enabled: boolean) => ipcRenderer.invoke('autonomy:setGlobalEnabled', enabled),
        /** Gets the active autonomy policy. */
        getPolicy: () => ipcRenderer.invoke('autonomy:getPolicy'),
        /** Updates the autonomy policy. */
        updatePolicy: (policy: any) => ipcRenderer.invoke('autonomy:updatePolicy', policy),
        /** Gets the audit log for a goal. */
        getAuditLog: (goalId: string) => ipcRenderer.invoke('autonomy:getAuditLog', goalId),
        /** Gets all learning records. */
        getLearningRecords: () => ipcRenderer.invoke('autonomy:getLearningRecords'),
        /** Operator override: clears a cooldown for a subsystem+patternKey. */
        clearCooldown: (subsystemId: string, patternKey: string) =>
            ipcRenderer.invoke('autonomy:clearCooldown', subsystemId, patternKey),
        /** Checks for governance-resolved pending runs and resumes them. */
        checkPendingRuns: () => ipcRenderer.invoke('autonomy:checkPendingRuns'),
        /**
         * Phase 4.3: Gets the recovery pack dashboard state.
         * Returns null when the recovery pack layer is not active.
         */
        getRecoveryPackDashboardState: () => ipcRenderer.invoke('autonomy:getRecoveryPackDashboardState'),
        /** Subscribes to autonomy dashboard updates. Returns cleanup function. */
        onDashboardUpdate: (callback: (data: any) => void) => {
            const listener = (event: any, data: any) => callback(data);
            ipcRenderer.on('autonomy:dashboardUpdate', listener);
            return () => ipcRenderer.removeListener('autonomy:dashboardUpdate', listener);
        },
        /** Subscribes to autonomy telemetry events. Returns cleanup function. */
        onTelemetry: (callback: (data: any) => void) => {
            const listener = (event: any, data: any) => callback(data);
            ipcRenderer.on('autonomy:telemetry', listener);
            return () => ipcRenderer.removeListener('autonomy:telemetry', listener);
        },
    },

    // ─── Phase 5.5: Multi-Step Repair Campaigns ──────────────────
    campaign: {
        /** Gets the full campaign dashboard state. */
        getDashboardState: () => ipcRenderer.invoke('campaign:getDashboardState'),
        /** Lists all repair campaigns. */
        listCampaigns: () => ipcRenderer.invoke('campaign:listCampaigns'),
        /** Gets a specific campaign by ID. */
        getCampaign: (campaignId: string) => ipcRenderer.invoke('campaign:getCampaign', campaignId),
        /** Lists campaign outcome summaries within the given window. */
        listOutcomes: (windowMs?: number) => ipcRenderer.invoke('campaign:listOutcomes', windowMs),
        /** Defers an active campaign (operator action). */
        deferCampaign: (campaignId: string) => ipcRenderer.invoke('campaign:deferCampaign', campaignId),
        /** Aborts an active campaign (operator action). */
        abortCampaign: (campaignId: string) => ipcRenderer.invoke('campaign:abortCampaign', campaignId),
        /** Resumes a deferred campaign. */
        resumeCampaign: (campaignId: string) => ipcRenderer.invoke('campaign:resumeCampaign', campaignId),
        /** Subscribes to campaign dashboard push updates. Returns cleanup function. */
        onDashboardUpdate: (callback: (data: any) => void) => {
            const listener = (_event: any, data: any) => callback(data);
            ipcRenderer.on('campaign:dashboardUpdate', listener);
            return () => ipcRenderer.removeListener('campaign:dashboardUpdate', listener);
        },
    },

    // ─── Phase 5.6: Code Harmonization Campaigns ─────────────────
    harmonization: {
        /** Gets the full harmonization dashboard state. */
        getDashboardState: () => ipcRenderer.invoke('harmonization:getDashboardState'),
        /** Lists all harmonization campaigns. */
        listCampaigns: () => ipcRenderer.invoke('harmonization:listCampaigns'),
        /** Gets a specific harmonization campaign by ID. */
        getCampaign: (campaignId: string) => ipcRenderer.invoke('harmonization:getCampaign', campaignId),
        /** Lists all canon rules with runtime confidence fields. */
        listCanonRules: () => ipcRenderer.invoke('harmonization:listCanonRules'),
        /** Gets a specific canon rule by ID. */
        getCanonRule: (ruleId: string) => ipcRenderer.invoke('harmonization:getCanonRule', ruleId),
        /** Lists harmonization outcome records. */
        listOutcomes: (windowMs?: number) => ipcRenderer.invoke('harmonization:listOutcomes', windowMs),
        /** Defers an active harmonization campaign. */
        deferCampaign: (campaignId: string) => ipcRenderer.invoke('harmonization:deferCampaign', campaignId),
        /** Aborts an active harmonization campaign. */
        abortCampaign: (campaignId: string) => ipcRenderer.invoke('harmonization:abortCampaign', campaignId),
        /** Resumes a deferred harmonization campaign. */
        resumeCampaign: (campaignId: string) => ipcRenderer.invoke('harmonization:resumeCampaign', campaignId),
        /** Subscribes to harmonization dashboard push updates. Returns cleanup function. */
        onDashboardUpdate: (callback: (data: any) => void) => {
            const listener = (_event: any, data: any) => callback(data);
            ipcRenderer.on('harmonization:dashboardUpdate', listener);
            return () => ipcRenderer.removeListener('harmonization:dashboardUpdate', listener);
        },
    },

    crossSystem: {
        /** Gets the full cross-system intelligence dashboard state. */
        getDashboardState: () => ipcRenderer.invoke('crossSystem:getDashboardState'),
        /** Gets all open incident clusters. */
        getClusters: () => ipcRenderer.invoke('crossSystem:getClusters'),
        /** Gets a specific incident cluster by ID. */
        getCluster: (clusterId: string) => ipcRenderer.invoke('crossSystem:getCluster', clusterId),
        /** Gets root cause hypotheses for a cluster. */
        getRootCauses: (clusterId: string) => ipcRenderer.invoke('crossSystem:getRootCauses', clusterId),
        /** Gets recent strategy decision records. */
        getRecentDecisions: () => ipcRenderer.invoke('crossSystem:getRecentDecisions'),
        /** Records the outcome of a strategy decision. */
        recordOutcome: (outcomeId: string, clusterId: string, succeeded: boolean, notes: string) =>
            ipcRenderer.invoke('crossSystem:recordOutcome', outcomeId, clusterId, succeeded, notes),
        /** Subscribes to cross-system dashboard push updates. Returns cleanup function. */
        onDashboardUpdate: (callback: (data: any) => void) => {
            const listener = (_event: any, data: any) => callback(data);
            ipcRenderer.on('crossSystem:dashboardUpdate', listener);
            return () => ipcRenderer.removeListener('crossSystem:dashboardUpdate', listener);
        },
    },

    // ─── Phase 6.1: Strategy Routing ─────────────────────────────
    strategyRouting: {
        /** Gets the full strategy routing dashboard state. */
        getDashboardState: () => ipcRenderer.invoke('strategyRouting:getDashboardState'),
        /** Lists all routing decisions. */
        listDecisions: () => ipcRenderer.invoke('strategyRouting:listDecisions'),
        /** Gets a specific routing decision by ID. */
        getDecision: (decisionId: string) => ipcRenderer.invoke('strategyRouting:getDecision', decisionId),
        /** Lists routing outcome records. */
        listOutcomes: (windowMs?: number) => ipcRenderer.invoke('strategyRouting:listOutcomes', windowMs),
        /** Subscribes to strategy routing dashboard push updates. Returns cleanup function. */
        onDashboardUpdate: (callback: (data: any) => void) => {
            const listener = (_event: any, data: any) => callback(data);
            ipcRenderer.on('strategyRouting:dashboardUpdate', listener);
            return () => ipcRenderer.removeListener('strategyRouting:dashboardUpdate', listener);
        },
    },

    // ─── Session Export ───────────────────────────────────────────
    /** Exports the current session as Markdown or JSON string. */
    exportSessionContent: (format: 'markdown' | 'json', sessionId?: string) => ipcRenderer.invoke('session:export', format, sessionId),
    /** Exports the current session to a file via save dialog. */
    exportSessionFile: (format: 'markdown' | 'json', sessionId?: string) => ipcRenderer.invoke('session:export-file', format, sessionId),
    /** Exports an agent profile as a standalone Python codeset. */
    exportAgentToPython: (profileId: string) => ipcRenderer.invoke('agent:export-to-python', profileId),
    /** Exports a workflow as a standalone Python codeset. */
    exportWorkflowToPython: (workflowId: string) => ipcRenderer.invoke('workflow:export-to-python', workflowId),

    // ─── Voice ────────────────────────────────────────────────────
    /** Transcribes an audio file using Whisper. */
    voiceTranscribe: (audioPath: string) => ipcRenderer.invoke('voice:transcribe', audioPath),
    /** Synthesizes text to speech using ElevenLabs. */
    voiceSynthesize: (text: string) => ipcRenderer.invoke('voice:synthesize', text),
    /** Transcribes an audio buffer (from microphone). */
    voiceTranscribeBuffer: (audioBuffer: Buffer, format: string) => ipcRenderer.invoke('voice:transcribe-buffer', audioBuffer, format),
    /** Gets voice service status (STT/TTS availability). */
    voiceStatus: () => ipcRenderer.invoke('voice:status'),

    // ─── Soul & Identity ──────────────────────────────────────────
    /** Gets Tala's current identity state (values, boundaries, roles). */
    getSoulIdentity: () => ipcRenderer.invoke('soul:get-identity'),
    /** Updates Tala's identity state with a context reason. */
    updateSoulIdentity: (changes: any, context: string) => ipcRenderer.invoke('soul:update-identity', changes, context),
    /** Gets recent behavioral reflection events. */
    getSoulReflections: (count?: number) => ipcRenderer.invoke('soul:get-reflections', count),
    /** Evaluates a decision against ethical frameworks. */
    evaluateEthics: (ctx: any) => ipcRenderer.invoke('soul:evaluate-ethics', ctx),
    /** Generates an in-universe narrative log. */
    generateNarrative: (ctx: any) => ipcRenderer.invoke('soul:generate-narrative', ctx),
    /** Proposes a hypothesis to test an ambiguity. */
    proposeHypothesis: (ambiguity: string, hypothesis: string, test: string) =>
        ipcRenderer.invoke('soul:propose-hypothesis', ambiguity, hypothesis, test),
    /** Resolves a previous hypothesis. */
    resolveHypothesis: (id: string, status: 'accepted' | 'rejected') =>
        ipcRenderer.invoke('soul:resolve-hypothesis', id, status),
    /** Gets a cross-engine summary of Tala's state. */
    getSoulSummary: () => ipcRenderer.invoke('soul:get-summary'),

    // ─── Log Viewer ───────────────────────────────────────────────
    logs: {
        listSources: () => ipcRenderer.invoke('logs:listSources'),
        readEntries: (args: { sourceId: string, limit?: number, offset?: number }) =>
            ipcRenderer.invoke('logs:readEntries', args),
        getEntryDetails: (args: { sourceId: string, entryId: string }) =>
            ipcRenderer.invoke('logs:getEntryDetails', args),
        getHealthSnapshot: () => ipcRenderer.invoke('logs:getHealthSnapshot'),
        getCorrelationEntries: (args: { sessionId?: string, turnId?: string }) =>
            ipcRenderer.invoke('logs:getCorrelationEntries', args),
    },

    // ─── A2UI Workspace Surfaces (Phase 4C) ──────────────────────
    a2ui: {
        /**
         * Opens or refreshes a named A2UI workspace surface in the document/editor pane.
         * The payload is pushed to the renderer via 'agent-event' with type 'a2ui-surface-open'.
         */
        openSurface: (surfaceId: 'cognition' | 'world' | 'maintenance', options?: { focus?: boolean }) =>
            ipcRenderer.invoke('a2ui:openSurface', surfaceId, options),
        /**
         * Dispatches an allowlisted A2UI action to the main process.
         * Invalid action names are rejected before execution.
         */
        dispatchAction: (action: { surfaceId: string; actionName: string; payload?: Record<string, unknown> }) =>
            ipcRenderer.invoke('a2ui:dispatchAction', action),
        /** Retrieves the current cognitive diagnostics snapshot. */
        getCognitiveSnapshot: () => ipcRenderer.invoke('a2ui:getCognitiveSnapshot'),
        /** Retrieves A2UI surface and action diagnostics summary. */
        getDiagnostics: () => ipcRenderer.invoke('a2ui:getDiagnostics'),
    },
    // ─── Retrieval ────────────────────────────────────────────────
    retrieval: {
        /**
         * Returns the list of available curated search providers for the Settings UI dropdown.
         * Each entry includes: providerId, displayName, configured, enabled, and optionally
         * reasonUnavailable.
         */
        getCuratedProviders: () => ipcRenderer.invoke('retrieval:getCuratedProviders'),
        /**
         * Forces a reload of the external search provider from current settings.
         * Call after saving search settings to apply changes immediately.
         */
        refreshExternalProvider: () => ipcRenderer.invoke('retrieval:refreshExternalProvider'),
        /**
         * Test a specific external search provider connection.
         */
        testProvider: (providerId: string) => ipcRenderer.invoke('retrieval:testProvider', providerId),
    },

    // ─── Self-Model (Phase 1) ─────────────────────────────────────────────────
    selfModel: {
        init: () => ipcRenderer.invoke('selfModel:init'),
        refresh: () => ipcRenderer.invoke('selfModel:refresh'),
        getRefreshStatus: () => ipcRenderer.invoke('selfModel:getRefreshStatus'),
        getSnapshot: () => ipcRenderer.invoke('selfModel:getSnapshot'),
        getInvariants: (filter?: any) => ipcRenderer.invoke('selfModel:getInvariants', filter),
        getCapabilities: (filter?: any) => ipcRenderer.invoke('selfModel:getCapabilities', filter),
        getArchitectureSummary: () => ipcRenderer.invoke('selfModel:getArchitectureSummary'),
        getComponents: () => ipcRenderer.invoke('selfModel:getComponents'),
        getOwnershipMap: () => ipcRenderer.invoke('selfModel:getOwnershipMap'),
        queryInvariant: (filter?: any) => ipcRenderer.invoke('selfModel:queryInvariant', filter),
        queryCapability: (filter?: any) => ipcRenderer.invoke('selfModel:queryCapability', filter),
    },

    // ─── Telemetry Bus (read-only) ────────────────────────────────
    telemetry: {
        /**
         * Returns a snapshot of the most recent runtime events from the
         * TelemetryBus ring buffer (up to 200 events).
         *
         * Both chat (AgentKernel) and autonomy (AutonomousRunOrchestrator)
         * lifecycle events are included.  The result is a serialized copy —
         * callers cannot mutate internal bus state.
         *
         * Schema: RuntimeEvent[]
         *   id          — unique event id (tevt-<uuid>)
         *   timestamp   — ISO 8601 UTC
         *   executionId — matches the originating ExecutionRequest
         *   correlationId? — optional chain id
         *   subsystem   — emitting subsystem (kernel | autonomy | …)
         *   event       — lifecycle type (execution.created | execution.completed | …)
         *   phase?      — optional sub-phase label
         *   payload?    — optional structured data (no raw content)
         */
        getRecentEvents: () => ipcRenderer.invoke('telemetry:getRecentEvents'),
    },
});
