/**
 * Tala — Electron Main Process Entry Point
 *
 * This file is the heart of the application. It:
 * 1. Detects the deployment mode (local, USB-portable, or remote).
 * 2. Instantiates every backend service (Agent, File, Terminal, Git, MCP, etc.).
 * 3. Creates the BrowserWindow and loads the Vite-built React renderer.
 * 4. Registers ~50 IPC handlers that bridge the renderer (preload.ts) to services.
 * 5. Manages the app lifecycle (ready, quit, activate, window-all-closed).
 *
 * **IPC Handler Groups (in order of appearance):**
 * - Profile & Settings — CRUD for user profile and `app_settings.json`.
 * - Functions — User-defined custom function CRUD.
 * - Workflows — Workflow CRUD, import, and execution.
 * - Guardrails — Content guardrail persistence.
 * - System — Environment detection, OAuth 2.0 login flow.
 * - Inference — Local provider scanning and engine installation.
 * - File System — Directory listing, file R/W, copy, move, delete.
 * - Terminal — PTY spawn, input, resize.
 * - Chat — Main AI conversation loop with streaming tokens.
 * - RAG — File ingestion, deletion, indexed-file listing.
 * - Search — Local file search and remote DuckDuckGo web search.
 * - Scraping — URL fetch, HTML-to-text conversion, auto-ingest.
 * - Browser — Relays browser data (DOM/screenshots) to AgentService.
 * - Git — Full Git workflow (status, stage, commit, branches, stash, sync).
 * - System Dialogs — File/folder picker.
 */
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { AgentService } from './services/AgentService';
import { FileService } from './services/FileService';
import { TerminalService } from './services/TerminalService';
import { SystemService } from './services/SystemService';
import { McpService } from './services/McpService';
import { FunctionService } from './services/FunctionService';
import { WorkflowService } from './services/WorkflowService';
import { WorkflowEngine } from './services/WorkflowEngine';
import { GitService } from './services/GitService';
import { BackupService } from './services/BackupService';
import { InferenceService } from './services/InferenceService';
import { loadSettings, saveSettings } from './services/SettingsManager';

// ═══════════════════════════════════════════════════════════════════════
// PATH & MODE DETECTION (Local / Portable Storage)
// ═══════════════════════════════════════════════════════════════════════

// Use a dynamic root to ensure portability even if the folder is moved
const APP_ROOT = app.isPackaged
  ? path.dirname(app.getPath('exe'))
  : app.getAppPath();

const LOCAL_DATA_DIR = path.join(APP_ROOT, 'data');

// Create local data directory if it doesn't exist
if (!fs.existsSync(LOCAL_DATA_DIR)) {
  fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
}

// Override Electron's system paths to stay within the local folder
// This moves app_settings.json, chat_sessions, and memories from Roaming (C:) to APP_ROOT/data (D:)
console.log(`[Main] Using local storage directory: ${LOCAL_DATA_DIR}`);
app.setPath('userData', LOCAL_DATA_DIR);
app.setPath('documents', path.join(LOCAL_DATA_DIR, 'documents'));

const EXE_DIR = path.dirname(app.getPath('exe'));
const PORTABLE_FLAG = path.join(EXE_DIR, 'portable.flag');
const IS_PORTABLE = fs.existsSync(PORTABLE_FLAG) || true; // Force local/portable logic by default as requested

const APP_DIR = app.getAppPath();
const USER_DATA_DIR = app.getPath('userData');
const SYSTEM_SETTINGS_PATH = path.join(USER_DATA_DIR, 'app_settings.json');
const PORTABLE_SETTINGS_PATH = path.join(APP_DIR, 'app_settings.json');

// Determine effective settings path (App-relative takes precedence if file exists)
let SETTINGS_PATH = fs.existsSync(PORTABLE_SETTINGS_PATH) ? PORTABLE_SETTINGS_PATH : SYSTEM_SETTINGS_PATH;
let deploymentMode: 'usb' | 'local' | 'remote' = IS_PORTABLE ? 'usb' : 'local';

if (fs.existsSync(SETTINGS_PATH)) {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    deploymentMode = s.deploymentMode || deploymentMode;
  } catch (e) { }
}

const USER_DATA_PATH = path.join(USER_DATA_DIR, 'user_profile.json');
const EFFECTIVE_WORKSPACE_ROOT = deploymentMode === 'usb'
  ? path.join(EXE_DIR, 'workspace')
  : (app.isPackaged ? undefined : process.cwd());

const terminalService = new TerminalService();
const mcpService = new McpService();
const systemService = new SystemService();
const fileService = new FileService(EFFECTIVE_WORKSPACE_ROOT);
const functionService = new FunctionService(systemService, fileService.getRoot());

const inferenceService = new InferenceService();
const workflowService = new WorkflowService(fileService.getRoot());
const agent = new AgentService(terminalService, functionService, mcpService, inferenceService);
const workflowEngine = new WorkflowEngine(functionService, agent); // Instantiate Engine
const gitService = new GitService(fileService.getRoot());
const backupService = new BackupService();

// Outstanding setup identified in previous session
agent.setMcpService(mcpService);
agent.setGitService(gitService);

// Initialize Workflow Scheduler
workflowService.initScheduler(async (workflowId) => {
  try {
    const workflows = workflowService.listWorkflows();
    const wf = workflows.find((w: any) => w.id === workflowId);
    if (!wf) return;

    console.log(`[Scheduler] Executing workflow ${wf.name} (${wf.id})...`);

    const result = await workflowEngine.executeWorkflow(wf);

    const runId = Date.now().toString();
    workflowService.saveRun(workflowId, runId, {
      id: runId,
      workflowId,
      timestamp: parseInt(runId),
      success: result.success,
      error: result.error,
      logs: result.logs,
      context: result.context
    });
  } catch (e) {
    console.error(`[Scheduler] Failed to execute workflow ${workflowId}:`, e);
  }
});

const TEMP_SYSTEM_PATH = path.join(USER_DATA_DIR, 'temp_system_info.json');

// Detect environment on launch
systemService.detectEnv(fileService.getRoot()).then(info => {
  console.log(`[System] Mode: ${deploymentMode} | Root: ${fileService.getRoot()}`);
  agent.setSystemInfo(info);
  agent.setWorkspaceRoot(fileService.getRoot());
  gitService.setRoot(fileService.getRoot());
  fs.writeFileSync(TEMP_SYSTEM_PATH, JSON.stringify(info, null, 2));
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

/**
 * Creates the main application window.
 *
 * Configures the BrowserWindow with:
 * - Dark background (#1a1a1a) for seamless loading.
 * - Context isolation and sandboxed preload for security.
 * - `webviewTag: true` for the embedded browser component.
 * - `backgroundThrottling: false` to keep the agent responsive when minimized.
 *
 * In development, loads from Vite's dev server and opens DevTools.
 * In production, loads the built `dist/index.html`.
 */
const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });

  /**
   * Loads the React app — from Vite dev server (development)
   * or the bundled dist (production).
   */
  const loadApp = () => {
    if (process.env.VITE_DEV_SERVER_URL) {
      mainWindow?.loadURL(process.env.VITE_DEV_SERVER_URL);
      mainWindow?.webContents.openDevTools();
    } else {
      mainWindow?.loadFile(path.join(__dirname, '../dist/index.html'));
    }
  };

  loadApp();
  terminalService.setWindow(mainWindow);
  agent.setMainWindow(mainWindow);
};

// ═══════════════════════════════════════════════════════════════════════
// APP LIFECYCLE — READY
// ═══════════════════════════════════════════════════════════════════════
/** On app ready: create window, ignite the AI soul, auto-connect services. */
app.on('ready', async () => {
  createWindow();

  // Determine Python Path for services
  const info = await systemService.detectEnv(fileService.getRoot());
  const pythonPath = info.pythonEnvPath || info.pythonPath;
  console.log(`[Main] Using Python for Soul: ${pythonPath}`);

  // Set system info in agent immediately
  agent.setSystemInfo(info);

  // Ignite Soul in background but with correct path
  agent.igniteSoul(pythonPath);
  mcpService.setPythonPath(pythonPath);

  mcpService.startHealthLoop();
  if (mainWindow) fileService.watchWorkspace(mainWindow);
  backupService.init();

  // Startup Status Polling
  ipcMain.handle('get-startup-status', async () => agent.getStartupStatus());

  // Auto-sync services if configured
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      if (settings.mcpServers) {
        const userServers = settings.mcpServers.filter((s: any) =>
          !['astro-emotion', 'tala-core', 'memory'].includes(s.id)
        );
        await mcpService.sync(userServers);
        await agent.refreshMcpTools();
      }
      if (settings.system?.env) {
        terminalService.setCustomEnv(settings.system.env);
      }
    } catch (e) { console.error('Failed to auto-sync services:', e); }
  }
});

app.on('window-all-closed', () => {
  console.log('[Main] window-all-closed triggered');
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (event: any) => {
  console.log('[Main] before-quit triggered');
  if (isQuitting) return;

  event.preventDefault();
  isQuitting = true;
  console.log('[Main] Application shutting down...');

  try {
    await agent.shutdown();
    await mcpService.shutdown();
  } catch (e) {
    console.error('[Main] Shutdown error:', e);
  } finally {
    console.log('[Main] Cleanup complete. Exiting.');
    app.exit(0);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — PROFILE & SETTINGS
// ═══════════════════════════════════════════════════════════════════════

ipcMain.handle('ingest-scan', async () => {
  return await agent.scanAndIngest();
});

ipcMain.handle('ingest-file', async (event, path) => {
  return await agent.ingestFile(path);
});

/** Writes the user profile JSON to disk (`user_profile.json`). */
ipcMain.handle('save-profile', async (event, data) => {
  fs.writeFileSync(USER_DATA_PATH, JSON.stringify(data, null, 2));
  return true;
});

/** Reads and returns the user profile from disk, or null if it doesn't exist. */
ipcMain.handle('get-profile', async () => {
  if (fs.existsSync(USER_DATA_PATH)) {
    return JSON.parse(fs.readFileSync(USER_DATA_PATH, 'utf-8'));
  }
  return null;
});

/**
 * Saves the full app settings object to `app_settings.json`.
 *
 * Also handles:
 * - Path migration between USB portable and system paths.
 * - Environment variable updates for the terminal.
 * - MCP server sync.
 * - Agent brain reload and Discord login/logout.
 * - Astro Engine profile sync if birth data is present.
 */
ipcMain.handle('save-settings', async (event, data) => {
  // If the user just switched to USB mode, we should migrate the file to the app dir
  let targetPath = SETTINGS_PATH;
  if (data.deploymentMode === 'usb' && !SETTINGS_PATH.startsWith(APP_DIR)) {
    targetPath = PORTABLE_SETTINGS_PATH;
    console.log(`[Main] Migrating settings to Portable Path: ${targetPath}`);
    // We update the local reference for subsequent saves in this session
    SETTINGS_PATH = targetPath;
  } else if (data.deploymentMode !== 'usb' && SETTINGS_PATH.startsWith(APP_DIR)) {
    targetPath = SYSTEM_SETTINGS_PATH;
    console.log(`[Main] Migrating settings to System Path: ${targetPath}`);
    SETTINGS_PATH = targetPath;
  }

  fs.writeFileSync(targetPath, JSON.stringify(data, null, 2));

  // Update Environment Variables
  if (data.system?.env) {
    terminalService.setCustomEnv(data.system.env);
  }

  // Sync MCP Servers
  if (data.mcpServers) {
    await mcpService.sync(data.mcpServers);
    await agent.refreshMcpTools();
  }

  // Auto-sync Astro Engine profile if agent has birth data
  if (data.agent?.profiles && data.agent.activeProfileId) {
    const activeProfile = data.agent.profiles.find((p: any) => p.id === data.agent.activeProfileId);
    if (activeProfile && activeProfile.astroBirthDate && activeProfile.astroBirthPlace) {
      try {
        // Sync to Astro Engine (AgentService will handle this on next ignition)
        console.log(`[Main] Agent profile has birth data - Astro Engine will sync on next ignition`);
      } catch (e) {
        console.warn('[Main] Astro profile sync skipped:', e);
      }
    }
  }

  // Reload Agent Brain
  agent.reloadConfig();

  return true;
});




const getWorkspaceSettingsPath = () => {
  const root = fileService.getRoot();
  if (!root) return null;
  return path.join(root, '.tala', 'settings.json');
};

/** Reads and returns the app settings (Global + Workspace) from disk. */
ipcMain.handle('get-settings', async () => {
  let globalSettings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      globalSettings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    } catch (e) { console.error("Failed to parse global settings", e); }
  }

  let workspaceSettings = {};
  const wsPath = getWorkspaceSettingsPath();
  if (wsPath && fs.existsSync(wsPath)) {
    try {
      workspaceSettings = JSON.parse(fs.readFileSync(wsPath, 'utf-8'));
    } catch (e) { console.error("Failed to parse workspace settings", e); }
  }

  return { global: globalSettings, workspace: workspaceSettings };
});

ipcMain.handle('save-workspace-settings', async (event, settings) => {
  const wsPath = getWorkspaceSettingsPath();
  if (!wsPath) throw new Error("No active workspace");

  try {
    const dir = path.dirname(wsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(wsPath, JSON.stringify(settings, null, 2));
    return true;
  } catch (e) {
    console.error("Failed to save workspace settings", e);
    return false;
  }
});

/** Exports global settings to a user-selected file. */
ipcMain.handle('export-settings', async () => {
  if (!mainWindow) return false;

  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Settings',
    defaultPath: 'tala-settings.json',
    filters: [{ name: 'JSON Files', extensions: ['json'] }]
  });

  if (!filePath) return false; // Canceled

  try {
    const content = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH, 'utf-8') : '{}';
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to export settings:', e);
    return false;
  }
});

/** Imports settings from a user-selected file, overwriting global settings. */
ipcMain.handle('import-settings', async () => {
  if (!mainWindow) return { success: false };

  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Settings',
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
    properties: ['openFile']
  });

  if (!filePaths || filePaths.length === 0) return { success: false, doc: null };

  try {
    const content = fs.readFileSync(filePaths[0], 'utf-8');
    const settings = JSON.parse(content);

    // Basic validation: check if it looks like settings
    if (typeof settings !== 'object') throw new Error('Invalid JSON format');

    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

    // Return the new settings so UI can update
    return { success: true, settings };
  } catch (e: any) {
    console.error('Failed to import settings:', e);
    return { success: false, error: e.message };
  }
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — SESSION PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════

const getSessionPath = () => {
  return path.join(USER_DATA_DIR, 'session.json');
};

ipcMain.handle('save-session', async (event, sessionData) => {
  try {
    const sessionPath = getSessionPath();
    fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
    return true;
  } catch (e) {
    console.error('[Main] Failed to save session:', e);
    return false;
  }
});

ipcMain.handle('get-session', async () => {
  try {
    const sessionPath = getSessionPath();
    if (fs.existsSync(sessionPath)) {
      return JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    }
  } catch (e) {
    console.error('[Main] Failed to load session:', e);
  }
  return null;
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — ASTRO
// ═══════════════════════════════════════════════════════════════════════

/** Returns the current astro state string (including emotional vector). */
ipcMain.handle('get-emotion-state', async () => agent.getEmotionState());

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — MEMORY
// ═══════════════════════════════════════════════════════════════════════

ipcMain.handle('add-memory', async (_e, text) => agent.addMemory(text));
ipcMain.handle('get-all-memories', async () => agent.getAllMemories());
ipcMain.handle('delete-memory', async (_e, id) => agent.deleteMemory(id));
ipcMain.handle('update-memory', async (_e, { id, text }) => agent.updateMemory(id, text));

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — MCP
// ═══════════════════════════════════════════════════════════════════════

/** Returns the tool/resource capabilities of a connected MCP server by ID. */
ipcMain.handle('get-mcp-capabilities', async (event, serverId) => {
  return await mcpService.getCapabilities(serverId);
});

/** Returns a list of all registered tools (core + MCP). */
ipcMain.handle('get-all-tools', async () => {
  return agent.getAllTools();
});

ipcMain.handle('get-model-status', async () => {
  return agent.getModelStatus();
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/** Lists all user-defined custom functions from `.agent/functions/`. */
ipcMain.handle('get-functions', async () => {
  return functionService.listFunctions();
});

/** Saves a custom function file (Python or JavaScript). */
ipcMain.handle('save-function', async (event, { name, content, type }) => {
  return functionService.saveFunction(name, content, type);
});

/** Deletes a custom function by name and type. */
ipcMain.handle('delete-function', async (event, { name, type }) => {
  return functionService.deleteFunction(name, type);
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — WORKFLOWS
// ═══════════════════════════════════════════════════════════════════════

/** Lists all saved workflow definitions. */
ipcMain.handle('get-workflows', async () => {
  return workflowService.listWorkflows();
});

/** Saves a workflow definition to `.agent/workflows/`. */
ipcMain.handle('save-workflow', async (event, workflow) => {
  return workflowService.saveWorkflow(workflow);
});

/** Deletes a workflow by its ID. */
ipcMain.handle('delete-workflow', async (event, id) => {
  return workflowService.deleteWorkflow(id);
});

/** Imports workflow definitions from a remote URL. */
ipcMain.handle('import-workflows', async (event, url) => {
  return await workflowService.importFromUrl(url);
});

/**
 * Executes a workflow by ID using the WorkflowEngine.
 * Looks up the workflow, then runs it through the BFS engine.
 * Start node is auto-detected (first trigger node).
 */
ipcMain.handle('execute-workflow', async (event, { workflowId, input }) => {
  const workflows = workflowService.listWorkflows();
  const wf = workflows.find((w: any) => w.id === workflowId);
  if (!wf) throw new Error('Workflow not found');

  const runId = Date.now().toString();
  const result = await workflowEngine.executeWorkflow(wf, undefined, input);

  // Save Run Log
  workflowService.saveRun(workflowId, runId, {
    id: runId,
    workflowId,
    timestamp: parseInt(runId),
    success: result.success,
    error: result.error,
    logs: result.logs,
    context: result.context
  });

  return result;
});

/** Lists past execution runs for a workflow. */
ipcMain.handle('get-workflow-runs', async (event, workflowId) => {
  return workflowService.listRuns(workflowId);
});

/** Deletes a specific workflow run record. */
ipcMain.handle('delete-workflow-run', async (event, { workflowId, runId }) => {
  return workflowService.deleteRun(workflowId, runId);
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — WORKFLOW DEBUGGING
// ═══════════════════════════════════════════════════════════════════════

workflowEngine.setDebugCallback((workflowId, type, data) => {
  // Broadcast debug updates to all windows
  BrowserWindow.getAllWindows().forEach(w => {
    w.webContents.send('debug-update', { workflowId, type, data });
  });
});

ipcMain.handle('debug-workflow-start', async (event, { workflow, input }) => {
  workflowEngine.startDebug(workflow, input);
  return true;
});

ipcMain.handle('debug-workflow-step', async (event, workflowId) => {
  await workflowEngine.step(workflowId);
  return true;
});

ipcMain.handle('debug-workflow-stop', async (event, workflowId) => {
  workflowEngine.stopDebug(workflowId);
  return true;
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — GUARDRAILS & SYSTEM
// ═══════════════════════════════════════════════════════════════════════

/** Saves content guardrail rules into the settings file. */
ipcMain.handle('save-guardrails', async (event, guardrails) => {
  let settings: any = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  }
  settings.guardrails = guardrails;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  return true;
});

/** Detects and returns the system environment info (OS, Python, Node paths). */
ipcMain.handle('get-system-info', async () => {
  return await systemService.detectEnv(fileService.getRoot());
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — BACKUP
// ═══════════════════════════════════════════════════════════════════════

ipcMain.handle('backup-now', async () => {
  return await backupService.performBackup();
});

ipcMain.handle('test-backup-connection', async (event, config) => {
  return await backupService.testConnection(config);
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — OAUTH 2.0 LOGIN
// ═══════════════════════════════════════════════════════════════════════

/**
 * Initiates a full OAuth 2.0 Authorization Code flow for a cloud provider.
 *
 * **Supported providers:** Google, GitHub, Microsoft.
 *
 * **Flow:**
 * 1. Reads client ID/secret from settings.
 * 2. Starts a local HTTP loopback server on a random port.
 * 3. Opens the provider's authorization URL in the system browser.
 * 4. Listens for the redirect callback with the authorization code.
 * 5. Exchanges the code for an access token via HTTPS POST.
 * 6. Returns `{ success, provider, token, refreshToken }`.
 *
 * @param {string} provider - `'google'`, `'github'`, or `'microsoft'`.
 * @returns {Promise<{ success: boolean, provider: string, token: string }>}
 */
ipcMain.handle('login', async (event, provider) => {
  const { shell } = require('electron');
  const http = require('http');
  const https = require('https');
  const url = require('url');
  const querystring = require('querystring');

  console.log(`[AuthService] Initializing OAuth 2.0 Flow for ${provider}...`);

  return new Promise((resolve, reject) => {
    // 1. Load Keys from Settings first to validate
    let settings = { auth: { keys: {} as any } };
    if (fs.existsSync(SETTINGS_PATH)) {
      try {
        settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      } catch (e) {
        console.error('[AuthService] Settings parse error:', e);
      }
    }

    let clientId = '';
    let clientSecret = '';
    let authUrl = '';
    let tokenUrl = '';

    switch (provider) {
      case 'google':
        clientId = settings.auth.keys?.googleClientId;
        clientSecret = settings.auth.keys?.googleClientSecret;
        if (!clientId || !clientSecret) return reject(new Error('Missing Google Client ID or Secret in Settings. Please configure them in the Security tab.'));
        authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=code&scope=email%20profile&access_type=offline&prompt=consent`;
        tokenUrl = 'https://oauth2.googleapis.com/token';
        break;
      case 'github':
        clientId = settings.auth.keys?.githubClientId;
        clientSecret = settings.auth.keys?.githubClientSecret;
        if (!clientId || !clientSecret) return reject(new Error('Missing GitHub Client ID or Secret in Settings.'));
        authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=user:email`;
        tokenUrl = 'https://github.com/login/oauth/access_token';
        break;
      case 'microsoft':
        clientId = settings.auth.keys?.microsoftClientId;
        clientSecret = settings.auth.keys?.microsoftClientSecret;
        if (!clientId || !clientSecret) return reject(new Error('Missing Microsoft Client ID or Secret in Settings.'));
        authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&scope=User.Read%20offline_access`;
        tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
        break;
      default:
        return reject(new Error('Unsupported Provider: ' + provider));
    }

    // 2. Start Local Loopback Server

    const server = http.createServer(async (req: any, res: any) => {
      /*
      // IPC HANDLERS — INFERENCE (Local Engine)
      // ═══════════════════════════════════════════════════════════════════════
  
      ipcMain.handle('scan-local-providers', async () => {
  
        return await inferenceService.scanLocal();
      });
  
      ipcMain.handle('scan-local-models', async () => {
        return await agent.scanLocalModels();
      });
  
      ipcMain.handle('install-local-engine', async (event, engineId) => {
        return await inferenceService.installEngine(engineId, mainWindow?.webContents);
      });
  
      // Built-in Local Engine Handlers
  
      ipcMain.handle('local-engine-status', async () => {
        return inferenceService.getLocalEngine().getStatus();
      });
  
      ipcMain.handle('local-engine-start', async (event, { modelPath, options }) => {
        try {
          await inferenceService.getLocalEngine().ignite(modelPath, options);
          return { success: true };
        } catch (e: any) {
          return { success: false, error: e.message };
        }
      });
  
        }
      });



      ipcMain.handle('local-engine-stop', async () => {
        inferenceService.getLocalEngine().extinguish();
        return true;
      });
  
      ipcMain.handle('local-engine-download-binary', async () => {
        try {
          const binPath = await inferenceService.getLocalEngine().downloadBinary((progress) => {
            mainWindow?.webContents.send('local-engine-download-progress', { type: 'binary', progress });
          });
  
          // Update Settings
          const s = loadSettings(SETTINGS_PATH);
          if (!s.inference) s.inference = {};
          if (!s.inference.localEngine) s.inference.localEngine = {};
          s.inference.localEngine.binaryPath = binPath;
          saveSettings(SETTINGS_PATH, s);
  
          return { success: true, path: binPath };
        } catch (e: any) {
          return { success: false, error: e.message };
        }
      });
  
      ipcMain.handle('local-engine-download-model', async () => {
        try {
          const modelPath = await inferenceService.getLocalEngine().downloadModel((progress) => {
            mainWindow?.webContents.send('local-engine-download-progress', { type: 'model', progress });
          });
  
          // Update Settings -> Enable Engine
          const s = loadSettings(SETTINGS_PATH);
          if (!s.inference) s.inference = {};
          if (!s.inference.localEngine) s.inference.localEngine = {};
  
          s.inference.localEngine.modelPath = modelPath;
          s.inference.localEngine.enabled = true; // Auto-enable
          s.inference.mode = 'local-only'; // Auto-switch mode
          s.inference.activeLocalId = 'builtin-llamacpp'; // Auto-select
  
          saveSettings(SETTINGS_PATH, s);
  
          // Reload agent to pick up changes
          await agent.reloadConfig();
  
          return { success: true, path: modelPath };
        } catch (e: any) {
          return { success: false, error: e.message };
        }
      });
  
      ipcMain.handle('local-engine-download-python', async () => {
        try {
          const pyPath = await inferenceService.getLocalEngine().downloadPython((progress) => {
            mainWindow?.webContents.send('local-engine-download-progress', { type: 'python', progress });
          });
          return { success: true, path: pyPath };
        } catch (e: any) {
          return { success: false, error: e.message };
        }
      });
  });
  
        */
      const reqUrl = url.parse(req.url, true);

      if (reqUrl.pathname === '/callback') {
        const code = reqUrl.query.code;
        const addr = server.address();
        const port = addr && typeof addr !== 'string' ? addr.port : 0;
        const redirectUri = `http://localhost:${port}/callback`;

        if (!code) {
          res.end('Auth failed: No code received. Check your provider settings.');
          server.close();
          const err = reqUrl.query.error || 'No authorization code returned';
          return reject(new Error(`OAuth Error: ${err}`));
        }

        console.log(`[AuthService] Exchanging code for ${provider} token...`);

        // Perform Token Exchange
        try {
          let postData = '';
          if (provider === 'github') {
            postData = querystring.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri });
          } else {
            postData = querystring.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
          }

          const options = {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json',
              'Content-Length': Buffer.byteLength(postData)
            }
          };

          const tokenReq = https.request(tokenUrl, options, (tokenRes: any) => {
            let body = '';
            tokenRes.on('data', (d: any) => body += d);
            tokenRes.on('end', async () => {
              try {
                const data = JSON.parse(body);
                if (data.error) {
                  throw new Error(data.error_description || data.error);
                }

                console.log(`[AuthService] ${provider} token received successfully.`);

                // Fetch User Info (Optional but helpful for Profile)
                let name = `Authenticated ${provider} User`;
                let email = `user@${provider}.com`;
                let avatar = `https://ui-avatars.com/api/?name=${provider}&background=random`;

                // Success Response to browser
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<h1>Authentication Successful</h1><p>You may close this window and return to Tala.</p><script>window.close()</script>');
                server.close();

                resolve({
                  success: true,
                  provider,
                  token: data.access_token,
                  refreshToken: data.refresh_token,
                  email,
                  name,
                  avatar
                });
              } catch (e: any) {
                res.end(`Token Exchange Error: ${e.message}`);
                server.close();
                reject(new Error(`Token Exchange Failed: ${e.message}`));
              }
            });
          });

          tokenReq.on('error', (e: any) => {
            res.end(`Request Error: ${e.message}`);
            server.close();
            reject(new Error(`Network Error during token exchange: ${e.message}`));
          });

          tokenReq.write(postData);
          tokenReq.end();

        } catch (e: any) {
          res.end(`Critical Error: ${e.message}`);
          server.close();
          reject(new Error(`Critical Error: ${e.message}`));
        }
      }
    });

    server.on('error', (err: any) => {
      console.error('[AuthService] Server Error:', err);
      reject(new Error('Failed to start local callback server: ' + err.message));
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = addr && typeof addr !== 'string' ? addr.port : 0;
      const redirectUri = `http://localhost:${port}/callback`;

      // Update authUrl with real redirectUri
      const finalAuthUrl = `${authUrl}&redirect_uri=${encodeURIComponent(redirectUri)}`;
      console.log(`[AuthService] Opening Authorization URL: ${finalAuthUrl}`);

      // Dual-launch: Open in system browser AND internal browser
      shell.openExternal(finalAuthUrl);
      if (mainWindow) {
        mainWindow.webContents.send('agent-event', {
          type: 'browser-navigate',
          data: { url: finalAuthUrl }
        });
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — INFERENCE
// ═══════════════════════════════════════════════════════════════════════

/** Scans for locally-available inference providers (Ollama, LlamaCPP, vLLM). */
ipcMain.handle('scan-local-providers', async () => {
  console.log('[Inference] Scanning for local providers...');
  return await inferenceService.scanLocal();
});

/** Downloads and installs a local inference engine binary. */
ipcMain.handle('install-local-engine', async (event, engineId) => {
  return await inferenceService.installEngine(engineId, event.sender);
});

ipcMain.handle('local-engine-start', async (event, { modelPath, options }) => {
  return await inferenceService.getLocalEngine().ignite(modelPath, options);
});

ipcMain.handle('local-engine-stop', async () => {
  return await inferenceService.getLocalEngine().extinguish();
});

ipcMain.handle('local-engine-status', async () => {
  return await inferenceService.getLocalEngine().getStatus();
});

ipcMain.handle('local-engine-download-binary', async (event) => {
  const engine = inferenceService.getLocalEngine();
  return await engine.downloadBinary((progress) => {
    event.sender.send('local-engine-download-progress', { type: 'binary', progress });
  });
});

ipcMain.handle('local-engine-download-model', async (event) => {
  const engine = inferenceService.getLocalEngine();
  return await engine.downloadModel((progress) => {
    event.sender.send('local-engine-download-progress', { type: 'model', progress });
  });
});

ipcMain.handle('local-engine-download-python', async (event) => {
  const engine = inferenceService.getLocalEngine();
  return await engine.downloadPython((progress) => {
    event.sender.send('local-engine-download-progress', { type: 'python', progress });
  });
});

/** Scans for local LLM models (Ollama, LM Studio). */
ipcMain.handle('scan-local-models', async () => {
  return await agent.scanLocalModels();
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — FILE SYSTEM
// ═══════════════════════════════════════════════════════════════════════

/** Lists the contents of a directory (delegates to FileService). */
ipcMain.handle('list-directory', async (event, dirPath) => {
  return await fileService.listDirectory(dirPath);
});

/** Reads and returns a file's content as a UTF-8 string. */
ipcMain.handle('read-file', async (event, filePath) => {
  return await fileService.readFile(filePath);
});

/** Creates a new directory (recursive). */
ipcMain.handle('create-directory', async (event, dirPath) => {
  return await fileService.createDirectory(dirPath);
});

/** Deletes a file or directory (recursive). */
ipcMain.handle('delete-path', async (event, targetPath) => {
  return await fileService.deletePath(targetPath);
});

/** Creates a new file with the given string content. */
ipcMain.handle('create-file', async (event, filePath, content) => {
  return await fileService.createFile(filePath, content);
});

/** Copies a file or directory from src to dest. */
ipcMain.handle('copy-path', async (event, src, dest) => {
  return await fileService.copyPath(src, dest);
});

/** Moves/renames a file or directory from src to dest. */
ipcMain.handle('move-path', async (event, src, dest) => {
  return await fileService.movePath(src, dest);
});

// Initialize agent and terminal workspace roots
agent.setWorkspaceRoot(fileService.getRoot());
terminalService.setRoot(fileService.getRoot());

/**
 * Opens a native folder-picker dialog.
 * On selection, updates FileService, AgentService, TerminalService, GitService,
 * persists the new root to settings, and re-detects the system environment.
 */
ipcMain.handle('select-file', async (event, filters) => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: filters || [{ name: 'All Files', extensions: ['*'] }]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

/**
 * Opens a native folder-picker dialog.
 * On selection, updates FileService, AgentService, TerminalService, GitService,
 * persists the new root to settings, and re-detects the system environment.
 */
ipcMain.handle('open-folder-dialog', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const newRoot = result.filePaths[0];
    fileService.setRoot(newRoot);
    agent.setWorkspaceRoot(newRoot);
    terminalService.setRoot(newRoot);

    // Persist to settings file so it's a visible variable
    if (fs.existsSync(SETTINGS_PATH)) {
      try {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
        if (!settings.storage) settings.storage = {};
        settings.storage.localPath = newRoot;
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
      } catch (e) {
        console.error("Failed to update settings with new root:", e);
      }
    }

    // Re-detect environment for new root
    systemService.detectEnv(newRoot).then(info => {
      agent.setSystemInfo(info);
      fs.writeFileSync(TEMP_SYSTEM_PATH, JSON.stringify(info, null, 2));
    });

    return newRoot;
  }
  return null;
});

/** Returns the current workspace root path. */
ipcMain.handle('get-root', () => fileService.getRoot());

/** Resolves the full disk path for a bundled asset file. */
ipcMain.handle('get-asset-path', (event, filename) => {
  const fullPath = path.join(__dirname, filename);
  console.log(`[Main] Resolving Asset Path: '${filename}' -> '${fullPath}'`);
  console.log(`[Main] Asset Exists? ${fs.existsSync(fullPath)}`);
  return fullPath;
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — TERMINAL
// ═══════════════════════════════════════════════════════════════════════

/** Forwards raw keyboard/text input to the terminal's stdin. */
ipcMain.on('terminal-input', (event, { id, data }) => terminalService.write(id, data));
/** Spawns a new PTY terminal process and returns its ID. */
ipcMain.handle('terminal-init', (event, id) => terminalService.createTerminal(id));
/** Terminal resize. */
ipcMain.handle('terminal-resize', (event, { id, cols, rows }) => terminalService.resize(id, cols, rows));
/** Kills a terminal process. */
ipcMain.handle('terminal-kill', (event, id) => terminalService.kill(id));

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — CHAT (Main AI Loop)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Handles an incoming chat message from the renderer.
 *
 * Calls `AgentService.chat()` with:
 * - A token callback that streams each generated token to the renderer.
 * - An event callback that relays agent events (tool use, browser navigation).
 *
 * On completion, sends `chat-done`. On error, sends `chat-error`.
 * Also mirrors the cleaned response to Discord if a mirror channel is configured.
 */
ipcMain.on('chat-message', async (event, payload) => {
  try {
    let fullResponse = '';
    let text = "";
    let images: string[] = [];

    if (typeof payload === 'object' && payload !== null) {
      text = payload.text || "";
      images = payload.images || [];
    } else {
      text = String(payload);
    }

    await agent.chat(text, (token) => {
      fullResponse += token;
      event.sender.send('chat-token', token);
    }, (type, data) => {
      // Relay custom events to renderer
      event.sender.send('agent-event', { type, data });
    }, images);
    event.sender.send('chat-done');

  } catch (e: any) {
    event.sender.send('chat-error', e.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — CHAT CONTROL & SESSIONS
// ═══════════════════════════════════════════════════════════════════════

/** Lists all saved chat sessions (newest first). */
ipcMain.handle('list-sessions', async () => agent.listSessions());

/** Loads a session by ID and returns its messages. */
ipcMain.handle('load-session', async (_e, id: string) => agent.loadSession(id));

/** Deletes a session by ID. */
ipcMain.handle('delete-session', async (_e, id: string) => {
  agent.deleteSession(id);
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('sessions-update'));
  return true;
});

/** Creates a new empty session and returns its ID. */
ipcMain.handle('new-session', async () => {
  const id = agent.newSession();
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('sessions-update'));
  return id;
});

/** Forks an existing session at a message index. */
ipcMain.handle('branch-session', async (_e, { sourceId, messageIndex }: { sourceId: string, messageIndex: number }) => {
  const newId = agent.branchSession(sourceId, messageIndex);
  if (newId) {
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('sessions-update'));
  }
  return newId;
});

/** Cancels the currently streaming response. */
ipcMain.on('chat-cancel', () => {
  agent.cancelChat();
});

/** Returns the persisted chat history for UI restoration on reload. */
ipcMain.handle('get-chat-history', () => {
  return agent.getChatHistory();
});

/** Clears the persisted chat history. */
ipcMain.handle('clear-chat-history', () => {
  agent.clearChatHistory();
  return true;
});

/** Rewinds chat history to an index. */
ipcMain.handle('rewind-chat', async (event, index) => {
  return await agent.rewindChat(index);
});

/** Exports chat history to a file. */
ipcMain.handle('export-chat', async (event, format: 'json' | 'md' | 'txt') => {
  const history = agent.getChatHistory();
  let content = "";
  let ext = "";

  if (format === 'json') {
    content = JSON.stringify(history, null, 2);
    ext = 'json';
  } else if (format === 'md') {
    ext = 'md';
    content = history.map((m: any) => `**${m.role.toUpperCase()}**: ${m.content}`).join('\n\n---\n\n');
  } else {
    ext = 'txt';
    content = history.map((m: any) => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n');
  }

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export Chat History',
    defaultPath: path.join(app.getPath('downloads'), `tala-chat-export-${new Date().toISOString().slice(0, 10)}.${ext}`),
    filters: [{ name: format.toUpperCase(), extensions: [ext] }]
  });

  if (!canceled && filePath) {
    fs.writeFileSync(filePath, content);
    return true;
  }
  return false;
});

/** Prunes memory items. */
ipcMain.handle('memory-prune', async (event, ttlDays, maxItems) => {
  return await agent.pruneMemory(ttlDays || 30, maxItems || 1000);
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — RAG & SEARCH
// ═══════════════════════════════════════════════════════════════════════

/** Ingests a file into the RAG vector database via AgentService. */
ipcMain.handle('rag-ingest', async (event, filePath) => {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(fileService.getRoot(), filePath);
  return await agent.ingestFile(fullPath);
});

/** Removes a file from the RAG index via AgentService. */
ipcMain.handle('rag-delete', async (event, filePath) => {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(fileService.getRoot(), filePath);
  return await agent.deleteFile(fullPath);
});

/**
 * Lists all files currently indexed in the RAG vector database.
 * Converts absolute paths to workspace-relative paths for UI display.
 */
ipcMain.handle('rag-list', async () => {
  try {
    const root = fileService.getRoot();
    const absolutePaths = await agent.listIndexedFiles();

    console.log(`[IPC-RAG] Root: ${root}`);
    console.log(`[IPC-RAG] Indexed Paths Count: ${absolutePaths.length}`);

    const normRoot = path.normalize(root).toLowerCase().replace(/\\/g, '/');

    const result = absolutePaths.map(p => {
      const normP = path.normalize(p).toLowerCase().replace(/\\/g, '/');
      if (normP.startsWith(normRoot)) {
        let rel = normP.substring(normRoot.length);
        if (rel.startsWith('/')) rel = rel.substring(1);
        return rel;
      }
      return p;
    });

    if (result.length > 0) console.log(`[IPC-RAG] First Result: ${result[0]}`);
    return result;
  } catch (e: any) {
    console.error(`[IPC-RAG] Failed to list files: ${e.message}`);
    return [];
  }
});

/** Searches local files by query string (file name/content matching). */
ipcMain.handle('search-local', async (event, query) => {
  return await fileService.searchFiles(query);
});

/**
 * Performs a web search via DuckDuckGo Lite and returns structured results.
 *
 * Uses the Lite version (`lite.duckduckgo.com`) which is more resilient
 * to bot detection than the full site. Parses results via regex.
 * Returns up to 30 results with title, snippet, and URL.
 */
ipcMain.handle('search-remote', async (event, query) => {
  const https = require('https');
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  return new Promise((resolve) => {
    // Lite version is much more resilient to bot detection
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;

    const options = {
      headers: {
        'User-Agent': userAgent,
        'Referer': 'https://lite.duckduckgo.com/'
      }
    };

    https.get(url, options, (res: any) => {
      let data = '';
      res.on('data', (chunk: any) => { data += chunk; });
      res.on('end', () => {
        try {
          const results: any[] = [];
          // REGEX-based parsing is more robust than splitting by tags which might vary
          const linkRegex = /class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
          const snippetRegex = /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/;

          let match;
          while ((match = linkRegex.exec(data)) !== null) {
            const rawLink = match[1];
            const rawTitle = match[2];

            // Extract URL
            let link = rawLink;
            if (link.includes('uddg=')) {
              const parts = link.split('uddg=');
              if (parts.length > 1) {
                link = decodeURIComponent(parts[1].split('&')[0]);
              }
            }
            link = link.startsWith('http') ? link : `https:${link}`;

            // Extract Title
            const title = rawTitle.replace(/<[^>]*>/g, '').trim();

            // Attempt to find a snippet after this match
            // We look at the substring starting from where the link ended
            const restOfData = data.substring(linkRegex.lastIndex);
            // We only look a short distance ahead to avoid finding the wrong snippet
            const snippetMatch = restOfData.substring(0, 1000).match(snippetRegex);
            const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : 'No description available.';

            if (title && link) {
              results.push({ title, snippet, url: link });
            }

            if (results.length >= 30) break; // Limit results
          }

          if (results.length === 0) {
            if (data.includes('robot') || data.includes('captcha')) {
              resolve([{ title: 'Search Blocked', snippet: 'Access restricted by search provider. This usually resets after a few minutes.', url: '' }]);
            } else {
              resolve([{ title: 'No Results', snippet: 'Try a different search term or check your connection.', url: '' }]);
            }
          } else {
            resolve(results);
          }
        } catch (e) {
          resolve([{ title: 'Error', snippet: 'Failed to process web results.', url: '' }]);
        }
      });
    }).on('error', (err: any) => {
      resolve([{ title: 'Error', snippet: err.message, url: '' }]);
    });
  });
});

/**
 * Scrapes a URL, converts HTML to clean text, saves as a Markdown file
 * in the `memory/` directory, and auto-ingests it into the RAG database.
 *
 * Handles HTTP redirects (3xx). Strips `<script>` and `<style>` tags,
 * then extracts text from semantic HTML tags (p, h1-h6, li, article, section).
 */
ipcMain.handle('search-scrape', async (event, { url, title }) => {
  console.log(`[SCRAPE] Starting scrape for: ${url}`);
  const https = require('https');
  const http = require('http');
  const fs = require('fs');
  const path = require('path');

  const fetchUrl = (targetUrl: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const client = targetUrl.startsWith('https') ? https : http;
      try {
        client.get(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        }, (res: any) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextUrl = new URL(res.headers.location, targetUrl).href;
            console.log(`[SCRAPE] Redirecting to: ${nextUrl}`);
            resolve(fetchUrl(nextUrl));
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`Failed to fetch: ${res.statusCode}`));
            return;
          }

          let data = '';
          res.on('data', (chunk: any) => { data += chunk; });
          res.on('end', () => resolve(data));
        }).on('error', reject);
      } catch (e) {
        reject(e);
      }
    });
  };

  try {
    const data = await fetchUrl(url);
    console.log(`[SCRAPE] Downloaded ${data.length} bytes`);

    // Basic cleaning
    let html = data.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

    // Extract content tags
    const tags = html.match(/<(p|h1|h2|h3|h4|h5|h6|li|article|section)[^>]*>([\s\S]*?)<\/\1>/gi);
    let content = `# Source: ${title || url}\nURL: ${url}\n\n`;

    if (tags && tags.length > 5) {
      tags.forEach(tag => {
        const text = tag.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (text.length > 30) content += text + '\n\n';
      });
    } else {
      const stripped = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      content += stripped;
    }

    const fileName = `scraped_${Date.now()}.md`;
    const filePath = `memory/${fileName}`;
    const fullPath = path.join(fileService.getRoot(), filePath);

    fs.writeFileSync(fullPath, content);
    console.log(`[SCRAPE] Saved to ${fullPath}`);

    await agent.ingestFile(fullPath);
    console.log(`[SCRAPE] Ingestion complete for ${fileName}`);

    return { success: true, path: filePath };
  } catch (e: any) {
    console.error(`[SCRAPE] Failed: ${e.message}`);
    return { success: false, error: e.message };
  }
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — BROWSER DATA RELAY
// ═══════════════════════════════════════════════════════════════════════

/** Relays browser data (DOM or screenshot) from the renderer to AgentService. */
ipcMain.on('browser-data-reply', (event, { type, data }) => {
  console.log(`[Main] Received browser-data-reply: type='${type}', data length=${data ? data.length : 'null'}`);
  agent.provideBrowserData(type, data);
});

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — GIT
// ═══════════════════════════════════════════════════════════════════════

/** Checks if Git is available and the workspace is a valid repository. */
ipcMain.handle('git-check', async () => await gitService.checkOk());
/** Returns the working tree status (staged, modified, untracked). */
ipcMain.handle('git-status', async () => await gitService.getStatus());
/** Stages a file for the next commit. */
ipcMain.handle('git-stage', async (ev, file) => await gitService.stage(file));
/** Unstages a previously staged file. */
ipcMain.handle('git-unstage', async (ev, file) => await gitService.unstage(file));
/** Creates a commit with the given message. */
ipcMain.handle('git-commit', async (ev, msg) => await gitService.commit(msg));
/** Push/pull sync with the configured remote using provided credentials. */
ipcMain.handle('git-sync', async (ev, { token, username }) => await gitService.sync(token, username));
/** Scans for configured remote repositories. */
ipcMain.handle('git-remotes', async () => await gitService.scanRemotes());
/** Fetches the user's GitHub repositories via the API. */
ipcMain.handle('git-fetch-repos', async (e, creds) => {
  return gitService.fetchGithubRepos(creds.username, creds.token);
});

ipcMain.handle('git-get-slug', async () => {
  return gitService.getRemoteSlug();
});

ipcMain.handle('git-fetch-issues', async (e, { owner, repo, token }) => {
  return gitService.fetchGithubIssues(owner, repo, token);
});

ipcMain.handle('git-fetch-prs', async (e, { owner, repo, token }) => {
  return gitService.fetchGithubPRs(owner, repo, token);
});
/** Initializes a new Git repository in the workspace. */
ipcMain.handle('git-init', async () => await gitService.init());

// ─── Advanced Git ─────────────────────────────────────────────────────
/** Lists all local and remote branches. */
ipcMain.handle('git-branches', async () => await gitService.getBranches());
/** Returns the name of the currently checked-out branch. */
ipcMain.handle('git-current-branch', async () => await gitService.getCurrentBranch());
/** Checks out an existing branch. */
ipcMain.handle('git-checkout', async (ev, branch) => await gitService.checkout(branch));
/** Creates a new branch from the current HEAD. */
ipcMain.handle('git-create-branch', async (ev, name) => await gitService.createBranch(name));
/** Deletes a local branch. */
ipcMain.handle('git-delete-branch', async (ev, name) => await gitService.deleteBranch(name));
/** Returns the commit log (default last 50 entries). */
ipcMain.handle('git-log', async (ev, limit) => await gitService.getLog(limit));
/** Returns the diff for a specific file, or the entire working tree. */
ipcMain.handle('git-diff', async (ev, file) => await gitService.getDiff(file));
/** Stashes all uncommitted changes. */
ipcMain.handle('git-stash-push', async () => await gitService.stashPush());
/** Pops the most recent stash entry. */
ipcMain.handle('git-stash-pop', async () => await gitService.stashPop());

// ═══════════════════════════════════════════════════════════════════════
// IPC HANDLERS — SYSTEM DIALOGS
// ═══════════════════════════════════════════════════════════════════════

/** Opens a native file/folder picker dialog with configurable properties. */
ipcMain.handle('select-path', async (event, { properties }: { properties: ('openFile' | 'openDirectory')[] }) => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    properties: properties || ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ═══════════════════════════════════════════════════════════════════════
// APP LIFECYCLE — SHUTDOWN & ACTIVATE
// ═══════════════════════════════════════════════════════════════════════

/** On all windows closed: shut down the agent and quit (non-macOS). */
app.on('window-all-closed', () => {
  agent.shutdown();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/** On before-quit: ensure agent resources are cleaned up. */
app.on('before-quit', () => {
  agent.shutdown();
});

/** On activate (macOS dock click): recreate the window if none exist. */
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
