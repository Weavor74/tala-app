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
        let validChannels = ["fromMain", "chat-token", "chat-done", "chat-error", "profile-data", "terminal-data", "agent-event", "file-changed", "sessions-update", "debug-update", "startup-status", "astro-update", "reflection:proposal-created", "system:notification"];
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
    /** Sends raw input data to the terminal's stdin. */
    sendTerminalInput: (id: string, data: string) => ipcRenderer.send('terminal-input', { id, data }),
    /** Kills a terminal process. */
    killTerminal: (id: string) => ipcRenderer.invoke('terminal-kill', id),

    // ─── Git ──────────────────────────────────────────────────────
    /** Checks if Git is available and the workspace is a repo. */
    gitCheck: () => ipcRenderer.invoke('git-check'),
    /** Gets the working tree status (staged, unstaged, untracked files). */
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
    /** Gets reflection system metrics (counts, success rate). */
    getReflectionMetrics: () => ipcRenderer.invoke('reflection:get-metrics'),
    /** Lists pending proposals awaiting approval. */
    getReflectionProposals: (status?: string) => ipcRenderer.invoke('reflection:get-proposals', status),
    /** Lists historical reflection events. */
    getReflectionEvents: () => ipcRenderer.invoke('reflection:get-reflections'),
    /** Approves a proposal by ID. */
    approveProposal: (id: string) => ipcRenderer.invoke('reflection:approve-proposal', id),
    /** Rejects a proposal by ID. */
    rejectProposal: (id: string) => ipcRenderer.invoke('reflection:reject-proposal', id),
    /** Forces a heartbeat tick (debug). */
    forceHeartbeat: () => ipcRenderer.invoke('reflection:force-tick'),
    /** Subscribes to new proposal notifications. Returns cleanup function. */
    onProposalCreated: (callback: (data: any) => void) => {
        const listener = (event: any, data: any) => callback(data);
        ipcRenderer.on('reflection:proposal-created', listener);
        return () => ipcRenderer.removeListener('reflection:proposal-created', listener);
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
});
