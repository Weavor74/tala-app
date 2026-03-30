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
import 'dotenv/config'
import './bootstrap';
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { APP_ROOT, LOCAL_DATA_DIR, resolveDataPath } from './services/PathResolver';
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
import { SafeChangePlanner } from './services/reflection/SafeChangePlanner';
import { ExecutionOrchestrator } from './services/execution/ExecutionOrchestrator';
import { ExecutionAppService } from './services/execution/ExecutionAppService';
import { GovernanceAppService } from './services/governance/GovernanceAppService';
import { InvariantRegistry } from './services/selfModel/InvariantRegistry';
import { CapabilityRegistry } from './services/selfModel/CapabilityRegistry';
import { OwnershipMapper } from './services/selfModel/OwnershipMapper';
import { SelfModelScanner } from './services/selfModel/SelfModelScanner';
import { SelfModelBuilder } from './services/selfModel/SelfModelBuilder';
import { SelfModelQueryService } from './services/selfModel/SelfModelQueryService';
import { SelfModelRefreshService } from './services/selfModel/SelfModelRefreshService';
import { SelfModelAppService } from './services/selfModel/SelfModelAppService';
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
import { initCanonicalMemory, shutdownCanonicalMemory, getResearchRepository, getEmbeddingsRepository } from './services/db/initMemoryStore';
import { initRetrievalOrchestrator } from './services/retrieval/RetrievalOrchestratorRegistry';
import { AutonomousRunOrchestrator } from './services/autonomy/AutonomousRunOrchestrator';
import { AutonomyAppService } from './services/autonomy/AutonomyAppService';
import { DEFAULT_AUTONOMY_POLICY } from './services/autonomy/defaults/defaultAutonomyPolicy';
// ── Phase 4.3: Recovery Pack services ─────────────────────────────────────────
import { RecoveryPackRegistry } from './services/autonomy/recovery/RecoveryPackRegistry';
import { RecoveryPackMatcher } from './services/autonomy/recovery/RecoveryPackMatcher';
import { RecoveryPackPlannerAdapter } from './services/autonomy/recovery/RecoveryPackPlannerAdapter';
import { RecoveryPackOutcomeTracker } from './services/autonomy/recovery/RecoveryPackOutcomeTracker';
// ── Phase 5: Adaptive Intelligence Layer ──────────────────────────────────────
import { SubsystemProfileRegistry } from './services/autonomy/adaptive/SubsystemProfileRegistry';
import { GoalValueScoringEngine } from './services/autonomy/adaptive/GoalValueScoringEngine';
import { StrategySelectionEngine } from './services/autonomy/adaptive/StrategySelectionEngine';
import { AdaptivePolicyGate } from './services/autonomy/adaptive/AdaptivePolicyGate';
// ── Phase 5.1: Model Escalation & Bounded Decomposition ───────────────────────
import { ModelCapabilityEvaluator } from './services/autonomy/escalation/ModelCapabilityEvaluator';
import { EscalationPolicyEngine } from './services/autonomy/escalation/EscalationPolicyEngine';
import { DecompositionEngine } from './services/autonomy/escalation/DecompositionEngine';
import { ExecutionStrategySelector } from './services/autonomy/escalation/ExecutionStrategySelector';
import { EscalationAuditTracker } from './services/autonomy/escalation/EscalationAuditTracker';
import { DecompositionOutcomeTracker } from './services/autonomy/escalation/DecompositionOutcomeTracker';

// ═══════════════════════════════════════════════════════════════════════
// PATH CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

// Paths derived after bootstrap redirection
const USER_DATA_DIR = LOCAL_DATA_DIR;
const SYSTEM_SETTINGS_PATH = resolveDataPath('app_settings.json');

// Deployment Mode: Force local tracking for maximum autonomy
let deploymentMode: 'usb' | 'local' | 'remote' = 'local';
let SETTINGS_PATH = SYSTEM_SETTINGS_PATH;

if (fs.existsSync(SETTINGS_PATH)) {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    deploymentMode = s.deploymentMode || deploymentMode;
  } catch (e) { }
}

const USER_DATA_PATH = resolveDataPath('user_profile.json');
// Determine effective workspace: defaults to local /workspace if not in dev
const EFFECTIVE_WORKSPACE_ROOT = (process.env.VITE_DEV_SERVER_URL || !app.isPackaged)
  ? APP_ROOT
  : path.join(LOCAL_DATA_DIR, 'workspace');

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

const invariantRegistry = new InvariantRegistry();
const capabilityRegistry = new CapabilityRegistry();
const ownershipMapper = new OwnershipMapper();
const selfModelScanner = new SelfModelScanner();
const selfModelBuilder = new SelfModelBuilder();
const selfModelQueryService = new SelfModelQueryService(invariantRegistry, capabilityRegistry, ownershipMapper, selfModelScanner, selfModelBuilder);
const selfModelRefreshService = new SelfModelRefreshService(invariantRegistry, capabilityRegistry, selfModelQueryService, USER_DATA_DIR);
const selfModelAppService = new SelfModelAppService(selfModelRefreshService, selfModelQueryService);

// SafeChangePlanner requires selfModelQueryService — must come after it
const safePlanner = new SafeChangePlanner(selfModelQueryService, USER_DATA_DIR);

// ─── Governance Layer (Phase 3.5) — must come before ReflectionAppService and ExecutionOrchestrator ────
// Instantiated here so the evaluateForProposal callback can be passed to ReflectionAppService.
const governanceAppService = new GovernanceAppService(
    USER_DATA_DIR,
    (proposalId: string) => safePlanner.listProposals().find(p => p.proposalId === proposalId) ?? null,
);

// Pass the governance evaluation callback so planning:promoteProposal auto-creates a GovernanceDecision.
const reflectionAppService = new ReflectionAppService(
    reflectionService,
    safePlanner,
    (proposal) => governanceAppService.evaluateForProposal(proposal),
);

// ─── Controlled Execution Layer (Phase 3) ─────────────────────────────────────
const executionOrchestrator = new ExecutionOrchestrator(
    USER_DATA_DIR,
    EFFECTIVE_WORKSPACE_ROOT,
    () => invariantRegistry.getAll().map(i => i.id),
    (proposalId: string) => safePlanner.listProposals().find(p => p.proposalId === proposalId) ?? null,
    governanceAppService.getAuthorizationGate(),
);
new ExecutionAppService(executionOrchestrator);

// ─── Phase 4: Autonomous Self-Improvement ─────────────────────────────────────
// Instantiated after governance + execution to provide correct service references.
// globalAutonomyEnabled defaults to false in DEFAULT_AUTONOMY_POLICY (operator must enable).
const autonomousRunOrchestrator = new AutonomousRunOrchestrator(
    USER_DATA_DIR,
    safePlanner,
    governanceAppService,
    executionOrchestrator,
    DEFAULT_AUTONOMY_POLICY,
);

// ─── Phase 4.3: Recovery Pack services ────────────────────────────────────────
// Injected as optional services — orchestrator falls back to standard planning when absent.
const recoveryPackRegistry = new RecoveryPackRegistry(USER_DATA_DIR);
const recoveryPackMatcher = new RecoveryPackMatcher(recoveryPackRegistry);
const recoveryPackPlannerAdapter = new RecoveryPackPlannerAdapter();
const recoveryPackOutcomeTracker = new RecoveryPackOutcomeTracker(USER_DATA_DIR, recoveryPackRegistry);
autonomousRunOrchestrator.setRecoveryPackServices(
    recoveryPackRegistry,
    recoveryPackMatcher,
    recoveryPackPlannerAdapter,
    recoveryPackOutcomeTracker,
);

// ─── Phase 5: Adaptive Intelligence Layer ─────────────────────────────────────
// Injected as optional services — orchestrator falls back to Phase 4 behavior when absent.
// Must be wired after setRecoveryPackServices() so GoalValueScoringEngine can reference
// the already-instantiated recoveryPackRegistry for pack confidence scoring.
try {
    const subsystemProfileRegistry = new SubsystemProfileRegistry(USER_DATA_DIR);
    const goalValueScoringEngine = new GoalValueScoringEngine(
        autonomousRunOrchestrator.learningRegistry,
        recoveryPackRegistry,
    );
    const strategySelectionEngine = new StrategySelectionEngine();
    const adaptivePolicyGate = new AdaptivePolicyGate();
    autonomousRunOrchestrator.setAdaptiveServices(
        subsystemProfileRegistry,
        goalValueScoringEngine,
        strategySelectionEngine,
        adaptivePolicyGate,
    );
} catch (err) {
    console.warn('[Main] Phase 5 adaptive services failed to initialize — autonomy falls back to Phase 4 behavior:', err);
}

// ─── Phase 5.1: Model Escalation & Bounded Decomposition ──────────────────────
// Injected as optional services — orchestrator skips capability evaluation when absent.
// Must be wired after setAdaptiveServices() (Phase 5) per initialization order.
// Conservative defaults (local_preferred_with_request, requireHumanApprovalForRemote=true)
// are preserved via DEFAULT_ESCALATION_POLICY already set in AutonomousRunOrchestrator.
try {
    const modelCapabilityEvaluator = new ModelCapabilityEvaluator();
    const escalationPolicyEngine = new EscalationPolicyEngine();
    const decompositionEngine = new DecompositionEngine();
    const executionStrategySelector = new ExecutionStrategySelector();
    const escalationAuditTracker = new EscalationAuditTracker();
    const decompositionOutcomeTracker = new DecompositionOutcomeTracker();
    autonomousRunOrchestrator.setEscalationServices(
        modelCapabilityEvaluator,
        escalationPolicyEngine,
        decompositionEngine,
        executionStrategySelector,
        escalationAuditTracker,
        decompositionOutcomeTracker,
    );
} catch (err) {
    console.warn('[Main] Phase 5.1 escalation services failed to initialize — autonomy skips capability evaluation:', err);
}

new AutonomyAppService(autonomousRunOrchestrator);
// Start periodic goal detection (5 min cycle, will run if/when autonomy is enabled)
autonomousRunOrchestrator.start();

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
selfModelRefreshService.init().catch(e => console.error('[SelfModel] init failed:', e));

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

const TEMP_SYSTEM_PATH = resolveDataPath('temp_system_info.json');

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

  // ─── Canonical Memory Store (Phase A) ───────────────────────────────────────
  // Initialize PostgreSQL-backed canonical memory. Failures are non-fatal;
  // the app continues without canonical memory until the DB is available.
  try {
    await initCanonicalMemory();
  } catch (err) {
    console.warn('[Main] Canonical memory store unavailable — continuing without it:', err);
  }

  // ─── Retrieval Orchestrator ──────────────────────────────────────────────────
  // Wire LocalSearchProvider and ExternalApiSearchProvider (from Settings).
  // Non-fatal: if settings are unavailable the local provider still works.
  try {
    initRetrievalOrchestrator({
      fileService,
      researchRepo: getResearchRepository() ?? undefined,
      embeddingsRepo: getEmbeddingsRepository() ?? undefined,
      settingsPath: SETTINGS_PATH,
    });
  } catch (err) {
    console.warn('[Main] RetrievalOrchestrator init failed — retrieval degraded:', err);
  }

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
    await shutdownCanonicalMemory();
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
