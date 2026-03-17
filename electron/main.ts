/**
 * Main Process Entry Point
 * 
 * This file is the "Central Nervous System" of the Electron application.
 * It coordinates the application lifecycle (ready, window-all-closed),
 * window management, and service orchestration.
 * 
 * **Initialization Flow:**
 * 1. Calls `bootstrap()` to setup local data paths.
 * 2. Instantiates all core services (Agent, Git, Rag, Memory, etc.).
 * 3. Initializes the IPC router to bridge renderer calls to services.
 * 4. Spawns the main UI window.
 * 5. Starts background schedulers (Workflows, Backups).
 */
import './bootstrap';
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
import { GuardrailService } from './services/GuardrailService';
import { GitService } from './services/GitService';
import { BackupService } from './services/BackupService';
import { InferenceService } from './services/InferenceService';
import { loadSettings, saveSettings } from './services/SettingsManager';
import { IpcRouter } from './services/IpcRouter';
import { ReflectionService } from './services/reflection/ReflectionService';
import { ReflectionAppService } from './services/reflection/ReflectionAppService';
import { VoiceService } from './services/VoiceService';
import { SoulService } from './services/soul/SoulService';
import { UserProfileService } from './services/UserProfileService';
import { CodeAccessPolicy } from './services/CodeAccessPolicy';
import { CodeControlService } from './services/CodeControlService';
import { LogViewerService } from './services/LogViewerService';
import { McpLifecycleManager } from './services/McpLifecycleManager';
import { RuntimeDiagnosticsAggregator } from './services/RuntimeDiagnosticsAggregator';
import { RuntimeControlService } from './services/RuntimeControlService';
import { inferenceDiagnostics } from './services/InferenceDiagnosticsService';
import { WorldModelAssembler } from './services/world/WorldModelAssembler';

// ═══════════════════════════════════════════════════════════════════════
// PATH CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

// Paths derived after bootstrap redirection
const USER_DATA_DIR = app.getPath('userData');
const SYSTEM_SETTINGS_PATH = path.join(USER_DATA_DIR, 'app_settings.json');
const EXE_DIR = path.dirname(app.getPath('exe'));

// Deployment Mode: Force local tracking for maximum autonomy
let deploymentMode: 'usb' | 'local' | 'remote' = 'local';
let SETTINGS_PATH = SYSTEM_SETTINGS_PATH;

if (fs.existsSync(SETTINGS_PATH)) {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    deploymentMode = s.deploymentMode || deploymentMode;
  } catch (e) { }
}

const USER_DATA_PATH = path.join(USER_DATA_DIR, 'user_profile.json');
// Determine effective workspace: defaults to local /workspace if not in dev
const EFFECTIVE_WORKSPACE_ROOT = (process.env.VITE_DEV_SERVER_URL || !app.isPackaged)
  ? process.cwd()
  : path.join(USER_DATA_DIR, 'workspace');

// Ensure workspace exists
if (!fs.existsSync(EFFECTIVE_WORKSPACE_ROOT)) {
  fs.mkdirSync(EFFECTIVE_WORKSPACE_ROOT, { recursive: true });
}

const terminalService = new TerminalService();
terminalService.setSettingsPath(SYSTEM_SETTINGS_PATH);
const mcpService = new McpService();
const systemService = new SystemService();
const fileService = new FileService(EFFECTIVE_WORKSPACE_ROOT);
const functionService = new FunctionService(systemService, fileService.getRoot());

const userProfileService = new UserProfileService(USER_DATA_DIR);
const inferenceService = new InferenceService();
const workflowService = new WorkflowService(fileService.getRoot());
const agent = new AgentService(terminalService, functionService, mcpService, inferenceService, userProfileService);
const reflectionService = new ReflectionService(USER_DATA_DIR, SYSTEM_SETTINGS_PATH);
const reflectionAppService = new ReflectionAppService(reflectionService);
const soulService = new SoulService(USER_DATA_DIR);
const voiceService = new VoiceService();
const workflowEngine = new WorkflowEngine(functionService, agent);
const guardrailService = new GuardrailService();
const gitService = new GitService(fileService.getRoot());
const backupService = new BackupService();
const logViewerService = new LogViewerService();

// ─── Runtime Diagnostics (Priority 2A) ───────────────────────────────────────
const mcpLifecycleManager = new McpLifecycleManager(mcpService);
const runtimeControl = new RuntimeControlService(inferenceService, mcpLifecycleManager, mcpService);
const diagnosticsAggregator = new RuntimeDiagnosticsAggregator(inferenceDiagnostics, mcpLifecycleManager, runtimeControl);

// ─── World Model Assembler (Phase 4A) ─────────────────────────────────────────
const worldModelAssembler = new WorldModelAssembler({ includeRepoState: true });

// Initialize Code Access Policy and Control Service
const codePolicy = new CodeAccessPolicy({
  workspaceRoot: EFFECTIVE_WORKSPACE_ROOT,
  mode: 'auto' // Default to auto, can be updated via settings later
});
const codeControlService = new CodeControlService(fileService, terminalService, codePolicy);

// Register Handlers
soulService.registerIpcHandlers();
reflectionService.start();

// ═══════════════════════════════════════════════════════════════════════
// GLOBAL ERROR LOGGING
// ═══════════════════════════════════════════════════════════════════════

process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught Exception:', error);
  logViewerService.logRuntimeError(error, {
    source: 'runtime_error_main',
    subsystem: 'app',
    eventType: 'uncaughtException',
    processType: 'main'
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Main] Unhandled Rejection at:', promise, 'reason:', reason);
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logViewerService.logRuntimeError(error, {
    source: 'runtime_error_main',
    subsystem: 'app',
    eventType: 'unhandledRejection',
    processType: 'main',
    metadata: { reason: String(reason) }
  });
});

ipcMain.handle('voice:transcribe', async (_e, audioPath: string) => voiceService.transcribe(audioPath));
ipcMain.handle('voice:synthesize', async (_e, text: string) => voiceService.synthesize(text));
ipcMain.handle('voice:transcribe-buffer', async (_e, audioBuffer: Buffer, format: string) => voiceService.transcribeBuffer(audioBuffer, format));
ipcMain.handle('voice:status', async () => voiceService.getStatus());

// Wire Dependencies
agent.setLogViewerService(logViewerService);
agent.setMcpService(mcpService);
agent.setGitService(gitService);
agent.setReflectionService(reflectionService);
agent.setCodeControl(codeControlService);

// Initialize MCP Status (inferred as online if service exists)
logViewerService.setSubsystemStatus('mcp', 'online');

guardrailService.setInferenceFn((prompt: string) => agent.headlessInference(prompt));

// Initialize Workflow Scheduler
workflowService.initScheduler(async (workflowId) => {
  try {
    const workflows = workflowService.listWorkflows();
    const wf = workflows.find((w: any) => w.id === workflowId);
    if (!wf) return;
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
  agent.setSystemInfo(info);
  agent.setWorkspaceRoot(fileService.getRoot());
  gitService.setRoot(fileService.getRoot());
  fs.writeFileSync(TEMP_SYSTEM_PATH, JSON.stringify(info, null, 2));
});

if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let isQuitting = false;

/**
 * createWindow
 * 
 * Orchestrates the creation of the application windows (Splash and Main).
 * It configures the main window with the context bridge preload script
 * and enables essential features like webviewTag for external tool integration.
 */
const createWindow = () => {
  // 1. Create and show Splash Screen
  splashWindow = new BrowserWindow({
    width: 520, height: 380, transparent: true, frame: false, alwaysOnTop: true, resizable: false, center: true, skipTaskbar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    splashWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}splash.html`);
  } else {
    splashWindow.loadFile(path.join(__dirname, '../dist/splash.html'));
  }

  // 2. Create and configure Main Window
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, webviewTag: true, backgroundThrottling: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow?.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow?.webContents.openDevTools();
  } else {
    mainWindow?.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Auto-close splash after a delay
  const closeSplash = () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
  };
  setTimeout(closeSplash, 3000);

  // Link services to the main window for UI updates
  terminalService.setWindow(mainWindow);
  agent.setMainWindow(mainWindow);
};

app.on('ready', async () => {
  createWindow();
  const info = await systemService.detectEnv(fileService.getRoot());
  const agentPythonPath = info.pythonEnvPath || info.pythonPath;
  agent.setSystemInfo(info);
  agent.igniteSoul(agentPythonPath);
  mcpService.setPythonPath(info.pythonPath); // Use canonical bundled python for MCP servers
  mcpService.startHealthLoop();
  if (mainWindow) fileService.watchWorkspace(mainWindow);
  backupService.init();

  ipcMain.handle('get-startup-status', async () => agent.getStartupStatus());

  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      if (settings.system?.env) terminalService.setCustomEnv(settings.system.env);
    } catch (e) { }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event: any) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  try {
    await agent.shutdown();
    await mcpService.shutdown();
  } catch (e) {
  } finally {
    app.exit(0);
  }
});

const ipcRouter = new IpcRouter({
  app,
  getMainWindow: () => mainWindow,
  agent,
  fileService,
  terminalService,
  systemService,
  mcpService,
  functionService,
  workflowService,
  workflowEngine,
  guardrailService,
  gitService,
  backupService,
  inferenceService,
  userProfileService,
  diagnosticsAggregator,
  runtimeControl,
  getSettingsPath: () => SETTINGS_PATH,
  setSettingsPath: (p) => { SETTINGS_PATH = p; },
  USER_DATA_DIR,
  USER_DATA_PATH,
  APP_DIR: app.getAppPath(),
  PORTABLE_SETTINGS_PATH: path.join(app.getAppPath(), 'app_settings.json'),
  SYSTEM_SETTINGS_PATH,
  TEMP_SYSTEM_PATH,
  codeControlService,
  logViewerService,
  worldModelAssembler,
});
ipcRouter.registerAll();

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
