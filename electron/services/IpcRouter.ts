/**
 * ⚠️ TALA INVARIANT — IPC REGISTRATION
 *
 * - Each ipcMain.handle channel must be registered EXACTLY ONCE
 * - Duplicate handlers WILL crash the app and break persistence
 * - Always use removeHandler(channel) before re-registering
 * - Do NOT register the same channel in multiple locations
 */
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { AgentService } from './AgentService';
import { FileService } from './FileService';
import { TerminalService } from './TerminalService';
import { SystemService } from './SystemService';
import { McpService } from './McpService';
import { FunctionService } from './FunctionService';
import { WorkflowService } from './WorkflowService';
import { WorkflowEngine } from './WorkflowEngine';
import { GuardrailService } from './GuardrailService';
import { GitService } from './GitService';
import { BackupService } from './BackupService';
import { InferenceService } from './InferenceService';
import { loadSettings, saveSettings, deepMerge, getActiveMode, setActiveMode } from './SettingsManager';
import { RuntimeFlags } from './RuntimeFlags';
import { UserProfileService } from './UserProfileService';
import { CodeControlService } from './CodeControlService';
import { LogViewerService } from './LogViewerService';
import { RuntimeDiagnosticsAggregator } from './RuntimeDiagnosticsAggregator';
import { RuntimeControlService } from './RuntimeControlService';
import type { WorldModelAssembler } from './world/WorldModelAssembler';
import { A2UIWorkspaceRouter } from './A2UIWorkspaceRouter';
import { A2UIActionBridge } from './A2UIActionBridge';
import type { A2UISurfaceId, A2UIActionDispatch } from '../../shared/a2uiTypes';
import { getResearchRepository, getContentRepository } from './db/initMemoryStore';
import { ContentIngestionService } from './ingestion/ContentIngestionService';
import { getRetrievalOrchestrator, refreshExternalProvider, getAvailableCuratedProviders } from './retrieval/RetrievalOrchestratorRegistry';
import { testProvider } from './retrieval/providers/ExternalApiSearchProvider';
import { getEmbeddingsRepository } from './db/initMemoryStore';
import { ChunkEmbeddingService } from './embedding/ChunkEmbeddingService';
import type { RetrievalRequest } from '../../shared/retrieval/retrievalTypes';
import { ContextAssemblyService } from './context/ContextAssemblyService';
import { MemoryPolicyService } from './policy/MemoryPolicyService';
import { GraphTraversalService } from './graph/GraphTraversalService';
import { AffectiveGraphService } from './graph/AffectiveGraphService';
import type { ContextAssemblyRequest } from '../../shared/policy/memoryPolicyTypes';

export interface IpcRouterContext {
  app: any;
  getMainWindow: () => BrowserWindow | null;
  agent: AgentService;
  fileService: FileService;
  terminalService: TerminalService;
  systemService: SystemService;
  mcpService: McpService;
  functionService: FunctionService;
  workflowService: WorkflowService;
  workflowEngine: WorkflowEngine;
  guardrailService: GuardrailService;
  gitService: GitService;
  backupService: BackupService;
  inferenceService: InferenceService;
  userProfileService: UserProfileService;
  codeControlService: CodeControlService;
  logViewerService: LogViewerService;
  /** Runtime diagnostics aggregator — provides normalized snapshot for IPC consumers. */
  diagnosticsAggregator: RuntimeDiagnosticsAggregator;
  /** Runtime control service — Phase 2B operational controls for providers and MCP. */
  runtimeControl: RuntimeControlService;
  /** World model assembler — Phase 4A canonical world-model builder. */
  worldModelAssembler?: WorldModelAssembler;
  /** Maintenance loop service — Phase 4B self-maintenance foundation. */
  maintenanceLoopService?: import('./maintenance/MaintenanceLoopService').MaintenanceLoopService;
  getSettingsPath: () => string;
  setSettingsPath: (p: string) => void;
  USER_DATA_DIR: string;
  USER_DATA_PATH: string;
  APP_DIR: string;
  PORTABLE_SETTINGS_PATH: string;
  SYSTEM_SETTINGS_PATH: string;
  TEMP_SYSTEM_PATH: string;
}

/**
 * Central API Registry for the Electron shell.
 * 
 * The `IpcRouter` orchestrates all communication between the React renderer and the 
 * backend services. It manages:
 * - Application lifecycle and settings migration.
 * - AI agent orchestration and streaming chat responses.
 * - File system operations and workspace sandboxing.
 * - Integration with peripheral services (Git, MCP, Guardrails, Backup).
 * - System-level interactions (Terminal PTYs, OAuth, Native Dialogs).
 */
export class IpcRouter {
  /**
   * Initializes the router with a dependency-injected context.
   * @param ctx - Service container containing all backend managers and paths.
   */
  constructor(private ctx: IpcRouterContext) { }

  /** Phase 4C: A2UI workspace router — lazy-initialized in registerAll(). */
  private _a2uiRouter: A2UIWorkspaceRouter | null = null;
  /** Phase 4C: A2UI action bridge — lazy-initialized in registerAll(). */
  private _a2uiActionBridge: A2UIActionBridge | null = null;

  /**
   * Registers all IPC handlers with `ipcMain`.
   * This method effectively defines the entire backend API surface.
   */
  public registerAll() {
    const { app, getMainWindow, agent, fileService, terminalService, systemService, mcpService, functionService, workflowService, workflowEngine, guardrailService, gitService, backupService, inferenceService, userProfileService, codeControlService, logViewerService, USER_DATA_DIR, USER_DATA_PATH, APP_DIR, PORTABLE_SETTINGS_PATH, SYSTEM_SETTINGS_PATH, TEMP_SYSTEM_PATH } = this.ctx;

    // Helper to simulate mutable let from main.ts
    const getSettingsPath = () => this.ctx.getSettingsPath();
    const setSettingsPath = (p: string) => this.ctx.setSettingsPath(p);

    // Phase 3A: Wire the diagnostics aggregator into AgentService so cognitive
    // contexts are recorded after each turn without exposing it in the constructor.
    agent.setDiagnosticsAggregator(this.ctx.diagnosticsAggregator);

    // Phase 4C: Initialize A2UI workspace router and action bridge.
    this._a2uiRouter = new A2UIWorkspaceRouter({
      getMainWindow,
      diagnosticsAggregator: this.ctx.diagnosticsAggregator,
      worldModelAssembler: this.ctx.worldModelAssembler,
      maintenanceLoopService: this.ctx.maintenanceLoopService,
    });
    this._a2uiActionBridge = new A2UIActionBridge({
      router: this._a2uiRouter,
      maintenanceLoopService: this.ctx.maintenanceLoopService,
      runtimeControlService: this.ctx.runtimeControl,
      diagnosticsAggregator: this.ctx.diagnosticsAggregator,
      worldModelAssembler: this.ctx.worldModelAssembler,
    });

    // Alias for the dynamic getter
    const mainWindowResolver = {
      get webContents() { return getMainWindow()?.webContents; }
    };

    // ═══════════════════════════════════════════════════════════════════════
    // IPC HANDLERS — PROFILE & SETTINGS
    // ═══════════════════════════════════════════════════════════════════════

    /** Triggers a clean shutdown of the application, invoking before-quit handlers. */
    ipcMain.handle('app:shutdown', () => {
      app.quit();
    });

    ipcMain.handle('ingest-scan', async () => {
      return await agent.scanAndIngest();
    });

    ipcMain.handle('ingest-file', async (event, path) => {
      return await agent.ingestFile(path);
    });

    /** Writes the user profile JSON to disk via UserProfileService. */
    ipcMain.handle('save-profile', async (event, data) => {
      userProfileService.save(data);
      return true;
    });

    /** Reads and returns the user profile via UserProfileService. */
    ipcMain.handle('get-profile', async () => {
      return userProfileService.getFullProfile();
    });

    /** Returns minimal identity context for the agent. */
    ipcMain.handle('get-user-identity-context', async () => {
      return userProfileService.getIdentityContext();
    });

    /**
     * Saves the full app settings object to disk.
     *
     * **Orchestration Logic:**
     * - **Path Migration**: Automatically detects and handles migration between 'usb' (portable) 
     *   and system data paths.
     * - **Merging**: Performs a deep merge with existing settings, while preserving backend 
     *   authority for critical values like `activeMode`.
     * - **Sub-service Sync**:
     *   - Updates `TerminalService` environment variables.
     *   - Triggers `McpService` synchronization and tool refresh.
     *   - Notifies `AgentService` to reload its brain configuration.
     * 
     * @param data - The partial or full settings object from the UI.
     */
    ipcMain.handle('save-settings', async (event, data) => {
      // If the user just switched to USB mode, we should migrate the file to the app dir
      let targetPath = getSettingsPath();
      if (data.deploymentMode === 'usb' && !getSettingsPath().startsWith(APP_DIR)) {
        targetPath = PORTABLE_SETTINGS_PATH;
        console.log(`[Main] Migrating settings to Portable Path: ${targetPath}`);
        // We update the local reference for subsequent saves in this session
        setSettingsPath(targetPath);
      } else if (data.deploymentMode !== 'usb' && getSettingsPath().startsWith(APP_DIR)) {
        targetPath = SYSTEM_SETTINGS_PATH;
        console.log(`[Main] Migrating settings to System Path: ${targetPath}`);
        setSettingsPath(targetPath);
      }

      const currentSettings = loadSettings(targetPath);
      // Merge but keep backend authoritative for agentModes if frontend is stale
      const newSettings = deepMerge(currentSettings, data);

      // If the incoming data doesn't have the current active mode, or if we want to force backend authority
      if (currentSettings.agentModes?.activeMode && newSettings.agentModes) {
        // We only update agentModes.activeMode via settings:setActiveMode, so preserve it here
        // unless we are specifically intending to overwrite it (which Settings UI doesn't do)
        newSettings.agentModes.activeMode = currentSettings.agentModes.activeMode;
      }

      saveSettings(targetPath, newSettings);

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

      // Refresh external search provider if search config changed
      if (data.search) {
        try {
          refreshExternalProvider(newSettings.search);
        } catch (e) {
          console.warn('[IpcRouter] save-settings: failed to refresh external provider:', e);
        }
      }

      return true;
    });




    const getWorkspaceSettingsPath = () => {
      const root = fileService.getRoot();
      if (!root) return null;
      return path.join(root, '.tala', 'settings.json');
    };

    /** Reads and returns the app settings (Global + Workspace) from disk. */
    ipcMain.handle('get-settings', async () => {
      const globalSettings = loadSettings(getSettingsPath());
      const wsPath = getWorkspaceSettingsPath();
      let workspaceSettings = {};
      if (wsPath) {
        workspaceSettings = loadSettings(wsPath); // Reuse safe loader for workspace too
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
      const win = getMainWindow();
      if (!win) return false;

      const { filePath } = await dialog.showSaveDialog(win, {
        title: 'Export Settings',
        defaultPath: 'tala-settings.json',
        filters: [{ name: 'JSON Files', extensions: ['json'] }]
      });

      if (!filePath) return false; // Canceled

      try {
        const content = fs.existsSync(getSettingsPath()) ? fs.readFileSync(getSettingsPath(), 'utf-8') : '{}';
        fs.writeFileSync(filePath, content, 'utf-8');
        return true;
      } catch (e) {
        console.error('Failed to export settings:', e);
        return false;
      }
    });

    /** Imports settings from a user-selected file, overwriting global settings. */
    ipcMain.handle('import-settings', async () => {
      const win = getMainWindow();
      if (!win) return { success: false };

      const { filePaths } = await dialog.showOpenDialog(win, {
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

        fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));

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

    // Session Export (Markdown/JSON)
    ipcMain.handle('session:export', async (_e, format: 'markdown' | 'json', sessionId?: string) => {
      try {
        return agent.exportSession(format, sessionId);
      } catch (e: any) {
        console.error('[Main] Session export failed:', e);
        return { error: e.message };
      }
    });

    // Session Export to File (with save dialog)
    ipcMain.handle('session:export-file', async (_e, format: 'markdown' | 'json', sessionId?: string) => {
      try {
        const content = agent.exportSession(format, sessionId);
        const ext = format === 'markdown' ? 'md' : 'json';
        const result = await dialog.showSaveDialog({
          title: 'Export Conversation',
          defaultPath: `conversation.${ext}`,
          filters: [
            { name: format === 'markdown' ? 'Markdown' : 'JSON', extensions: [ext] },
            { name: 'All Files', extensions: ['*'] }
          ]
        });

        if (!result.canceled && result.filePath) {
          fs.writeFileSync(result.filePath, content, 'utf-8');
          return { success: true, path: result.filePath };
        }
        return { success: false, canceled: true };
      } catch (e: any) {
        console.error('[Main] Session export to file failed:', e);
        return { error: e.message };
      }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // IPC HANDLERS — AGENT MODES (RP/Hybrid/Assistant)
    // ═══════════════════════════════════════════════════════════════════════

    /** Sets the active agent mode (rp, hybrid, assistant). */
    ipcMain.handle('settings:setActiveMode', async (_e, mode: any) => {
      console.log(`[Main] settings:setActiveMode received: ${mode}`);
      const success = setActiveMode(getSettingsPath(), mode);
      if (success) {
        agent.reloadConfig();
      }
      return success;
    });

    /** Returns the current active agent mode. */
    ipcMain.handle('settings:getActiveMode', async () => {
      return getActiveMode(getSettingsPath(), 'ipc.settings.getActiveMode');
    });

    /** Sets the active agent mode (rp, hybrid, assistant). Legacy - redirects to settings:setActiveMode */
    ipcMain.handle('agent:setMode', async (_e, mode: any) => {
      console.log(`[Main] settings:setActiveMode received: ${mode} (via legacy handler)`);
      const success = setActiveMode(getSettingsPath(), mode);
      if (success) {
        agent.reloadConfig();
      }
      return success;
    });

    /** Returns the current active agent mode. Legacy - redirects to settings:getActiveMode */
    ipcMain.handle('agent:getActiveMode', async () => {
      return getActiveMode(getSettingsPath(), 'ipc.agent.getActiveMode');
    });

    /** Gets the configuration for a specific agent mode. */
    ipcMain.handle('agent:getModeConfig', async (_e, mode: 'rp' | 'hybrid' | 'assistant') => {
      const s = loadSettings(getSettingsPath());
      return s.agentModes?.modes[mode];
    });

    /** Updates the configuration for a specific agent mode with a patch object. */
    ipcMain.handle('agent:updateModeConfig', async (_e, mode: 'rp' | 'hybrid' | 'assistant', patch: any) => {
      const s = loadSettings(getSettingsPath());
      if (!s.agentModes?.modes[mode]) return false;
      s.agentModes.modes[mode] = { ...s.agentModes.modes[mode], ...patch };
      saveSettings(getSettingsPath(), s);
      agent.reloadConfig();
      return true;
    });

    /** Returns all agent mode configurations. */
    ipcMain.handle('agent:getAllModeConfigs', async () => {
      const s = loadSettings(getSettingsPath());
      return s.agentModes?.modes;
    });

    /** Exports an agent profile as a standalone Python codeset. */
    ipcMain.handle('agent:export-to-python', async (_e, profileId: string) => {
      try {
        console.log(`[Main] Exporting agent ${profileId} to Python...`);
        const result = await dialog.showOpenDialog({
          title: 'Select Export Directory',
          properties: ['openDirectory', 'createDirectory']
        });

        if (!result.canceled && result.filePaths.length > 0) {
          const outputDir = result.filePaths[0];
          console.log(`[Main] User selected output directory: ${outputDir}`);
          await agent.exportAgentToPython(profileId, outputDir);
          return { success: true, path: outputDir };
        }
        console.log('[Main] Agent export canceled.');
        return { success: false, canceled: true };
      } catch (e: any) {
        console.error('[Main] Agent export failed:', e);
        return { error: e.message };
      }
    });

    /** Exports a workflow as a standalone Python codeset. */
    ipcMain.handle('workflow:export-to-python', async (_e, workflowId: string) => {
      try {
        console.log(`[Main] Exporting workflow ${workflowId} to Python...`);
        const result = await dialog.showOpenDialog({
          title: 'Select Export Directory',
          properties: ['openDirectory', 'createDirectory']
        });

        if (!result.canceled && result.filePaths.length > 0) {
          const outputDir = result.filePaths[0];
          console.log(`[Main] User selected output directory: ${outputDir}`);
          await workflowService.exportWorkflowToPython(workflowId, outputDir);
          return { success: true, path: outputDir };
        }
        console.log('[Main] Workflow export canceled.');
        return { success: false, canceled: true };
      } catch (e: any) {
        console.error('[Main] Workflow export failed:', e);
        return { error: e.message };
      }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // IPC HANDLERS — GUARDRAILS
    // ═══════════════════════════════════════════════════════════════════════

    /** Lists all saved guard definitions. */
    ipcMain.handle('guardrail:list', async () => {
      return guardrailService.listGuards();
    });

    /** Gets a single guard definition by ID. */
    ipcMain.handle('guardrail:get', async (_e, id: string) => {
      return guardrailService.getGuard(id);
    });

    /** Creates or updates a guard definition. */
    ipcMain.handle('guardrail:save', async (_e, definition: any) => {
      return guardrailService.saveGuard(definition);
    });

    /** Deletes a guard by ID. */
    ipcMain.handle('guardrail:delete', async (_e, id: string) => {
      return guardrailService.deleteGuard(id);
    });

    /** Runs a guard's validator stack against a text value. */
    ipcMain.handle('guardrail:validate', async (_e, { guardId, value, target }: { guardId: string, value: string, target: 'input' | 'output' }) => {
      try {
        return await guardrailService.validate(guardId, value, target);
      } catch (e: any) {
        return { passed: false, output: value, violations: [{ validatorType: 'unknown', message: e.message }], logs: [e.message] };
      }
    });

    /** Returns the VALIDATOR_REGISTRY (all known validator types + metadata). */
    ipcMain.handle('guardrail:get-validators', async () => {
      const { VALIDATOR_REGISTRY } = await import('./GuardrailService');
      return VALIDATOR_REGISTRY;
    });

    /** Exports a guard as a standalone guardrails-ai Python script and saves to a user-selected directory. */
    ipcMain.handle('guardrail:export-to-python', async (_e, guardId: string) => {
      try {
        const result = await dialog.showOpenDialog({
          title: 'Select Export Directory for Guard',
          properties: ['openDirectory', 'createDirectory']
        });
        if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };

        const outputDir = result.filePaths[0];
        const code = guardrailService.exportToPython(guardId);
        const guard = guardrailService.getGuard(guardId);
        const safeName = (guard?.name || guardId).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
        const outFile = path.join(outputDir, `guard_${safeName}.py`);
        fs.writeFileSync(outFile, code, 'utf-8');
        return { success: true, path: outFile };
      } catch (e: any) {
        return { error: e.message };
      }
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
      if (fs.existsSync(getSettingsPath())) {
        settings = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
      }
      settings.guardrails = guardrails;
      fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
      return true;
    });

    /** Detects and returns the system environment info (OS, Python, Node paths). */
    ipcMain.handle('get-system-info', async () => {
      return await systemService.detectEnv(fileService.getRoot());
    });

    // ═══════════════════════════════════════════════════════════════════════
    // IPC HANDLERS — LOG VIEWER
    // ═══════════════════════════════════════════════════════════════════════

    ipcMain.handle('logs:listSources', async () => {
      return await logViewerService.listSources();
    });

    ipcMain.handle('logs:readEntries', async (_e, { sourceId, limit, offset }) => {
      return await logViewerService.readEntries(sourceId, { limit, offset });
    });

    ipcMain.handle('logs:getEntryDetails', async (_e, { sourceId, entryId }) => {
      return await logViewerService.getEntryDetails(sourceId, entryId);
    });

    ipcMain.handle('logs:getHealthSnapshot', async () => {
      return await logViewerService.getHealthSnapshot();
    });

    ipcMain.handle('logs:getCorrelationEntries', async (_e, { sessionId, turnId }) => {
      return await logViewerService.getCorrelationEntries(sessionId, turnId);
    });

    ipcMain.handle('logs:getTimelineEntries', async (_e, { turnId }) => {
      return await logViewerService.getTimelineEntries(turnId);
    });

    ipcMain.handle('logs:getPerformanceSummary', async () => {
      return await logViewerService.getPerformanceSummary();
    });

    ipcMain.handle('logs:clearSource', async (_e, sourceId) => {
      return await logViewerService.clearSource(sourceId);
    });

    ipcMain.handle('logs:clearAll', async () => {
      return await logViewerService.clearAll();
    });

    ipcMain.handle('logs:archiveSource', async (_e, sourceId) => {
      return await logViewerService.archiveSource(sourceId);
    });

    ipcMain.handle('logs:archiveAll', async () => {
      return await logViewerService.archiveAll();
    });

    ipcMain.handle('logs:reportRendererError', async (_e, { error, context }) => {
      return await logViewerService.logRuntimeError(error, {
        ...context,
        source: 'runtime_error_renderer',
        processType: 'renderer'
      });
    });

    // --- Validation Hooks (Debug Only) ---
    ipcMain.handle('logs:testError', async () => {
      return await logViewerService.logRuntimeError(new Error('Diagnostic Test Error'), {
        source: 'diag_test',
        subsystem: 'validation',
        eventType: 'unknownRuntimeError'
      });
    });

    ipcMain.handle('logs:testMetric', async () => {
      return await logViewerService.logPerformanceMetric({
        source: 'diag_test',
        subsystem: 'validation',
        metricType: 'test',
        name: 'manual_validation_metric',
        value: Math.floor(Math.random() * 100),
        unit: 'count'
      });
    });

    ipcMain.handle('logs:testPromptAudit', async () => {
      const { promptAuditService } = await import('./PromptAuditService');
      const dummyRecord = promptAuditService.buildRecord({
        mode: 'test',
        intent: 'validation',
        isGreeting: false,
        hasMemories: false,
        memoryContext: '',
        systemPrompt: 'System test prompt',
        userMessage: 'User test message',
        astroState: '',
        hasAstro: false,
        hasImages: false,
        hasWorld: false,
        toolsIncluded: false
      });
      return await logViewerService.logPromptAudit(dummyRecord);
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
    // IPC HANDLERS — CODE MANIPULATION
    // ═══════════════════════════════════════════════════════════════════════

    ipcMain.handle('fs:read-text', async (_e, path) => codeControlService.readText(path));
    ipcMain.handle('fs:write-text', async (_e, { path, content }) => codeControlService.writeText(path, content));
    ipcMain.handle('fs:list', async (_e, path) => codeControlService.list(path));
    ipcMain.handle('fs:mkdir', async (_e, path) => codeControlService.mkdir(path));
    ipcMain.handle('fs:move', async (_e, { src, dst }) => codeControlService.move(src, dst));
    ipcMain.handle('fs:delete', async (_e, path) => codeControlService.delete(path));
    ipcMain.handle('fs:search', async (_e, query) => codeControlService.search(query));
    ipcMain.handle('shell:run', async (_e, { command, cwd }) => codeControlService.shellRun(command, cwd));

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
    // ═══════════════════════════════════════════════════════════════════════
    // IPC HANDLERS — INFERENCE (Local Engine)
    // ═══════════════════════════════════════════════════════════════════════

    ipcMain.handle('scan-local-providers', async () => {
      return await inferenceService.scanLocal();
    });

    ipcMain.handle('scan-local-models', async () => {
      return await agent.scanLocalModels();
    });

    // Provider registry IPC handlers

    ipcMain.handle('inference:listProviders', async () => {
      return inferenceService.getProviderInventory();
    });

    ipcMain.handle('inference:refreshProviders', async () => {
      return await inferenceService.refreshProviders();
    });

    ipcMain.handle('inference:selectProvider', async (_e, providerId: string | undefined) => {
      inferenceService.setSelectedProvider(providerId);
      return { success: true };
    });

    ipcMain.handle('inference:getSelectedProvider', async () => {
      const inventory = inferenceService.getProviderInventory();
      const selectedId = inventory.selectedProviderId;
      if (!selectedId) return null;
      return inventory.providers.find(p => p.providerId === selectedId) ?? null;
    });

    ipcMain.handle('install-local-engine', async (event, engineId) => {
      return await inferenceService.installEngine(engineId, getMainWindow()?.webContents);
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

    ipcMain.handle('local-engine-stop', async () => {
      inferenceService.getLocalEngine().extinguish();
      return true;
    });

    ipcMain.handle('local-engine-download-binary', async () => {
      try {
        const binPath = await inferenceService.getLocalEngine().downloadBinary((progress) => {
          getMainWindow()?.webContents.send('local-engine-download-progress', { type: 'binary', progress });
        });

        // Update Settings
        const s = loadSettings(getSettingsPath());
        if (!s.inference) s.inference = {};
        if (!s.inference.localEngine) s.inference.localEngine = {};
        s.inference.localEngine.binaryPath = binPath;
        saveSettings(getSettingsPath(), s);

        return { success: true, path: binPath };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('local-engine-download-model', async () => {
      try {
        const modelPath = await inferenceService.getLocalEngine().downloadModel((progress) => {
          getMainWindow()?.webContents.send('local-engine-download-progress', { type: 'model', progress });
        });

        // Update Settings -> Enable Engine
        const s = loadSettings(getSettingsPath());
        if (!s.inference) s.inference = {};
        if (!s.inference.localEngine) s.inference.localEngine = {};

        s.inference.localEngine.modelPath = modelPath;
        s.inference.localEngine.enabled = true; // Auto-enable
        s.inference.mode = 'local-only'; // Auto-switch mode
        s.inference.activeLocalId = 'builtin-llamacpp'; // Auto-select

        saveSettings(getSettingsPath(), s);

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
          getMainWindow()?.webContents.send('local-engine-download-progress', { type: 'python', progress });
        });
        return { success: true, path: pyPath };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

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
        if (fs.existsSync(getSettingsPath())) {
          try {
            settings = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
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

                    // Success Response to browser
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end('<h1>Authentication Successful</h1><p>You may close this window and return to Tala.</p><script>window.close()</script>');
                    server.close();

                    resolve({
                      success: true,
                      provider,
                      token: data.access_token,
                      refreshToken: data.refresh_token,
                      email: `user@${provider}.com`,
                      name: `Authenticated ${provider} User`,
                      avatar: `https://ui-avatars.com/api/?name=${provider}&background=random`
                    });
                  } catch (e: any) {
                    res.end(`Auth Exchange Failed: ${e.message}`);
                    server.close();
                    reject(e);
                  }
                });
              });

              tokenReq.on('error', (e: any) => {
                res.end(`Auth Request Failed: ${e.message}`);
                server.close();
                reject(e);
              });

              tokenReq.write(postData);
              tokenReq.end();
            } catch (e: any) {
              res.end(`Auth Error: ${e.message}`);
              server.close();
              reject(e);
            }
          } else {
            res.end('Waiting for authorization code...');
          }
        });

        server.listen(0, 'localhost', () => {
          const addr = server.address();
          const port = addr && typeof addr !== 'string' ? addr.port : 0;
          const redirectUri = `http://localhost:${port}/callback`;
          const finalAuthUrl = `${authUrl}&redirect_uri=${encodeURIComponent(redirectUri)}`;
          console.log(`[AuthService] Navigating Internal Browser for Auth: ${finalAuthUrl}`);

          const win = getMainWindow();
          if (win) {
            win.webContents.send('agent-event', {
              type: 'browser-navigate',
              data: { url: finalAuthUrl }
            });
          }
        });
      });
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
        if (fs.existsSync(getSettingsPath())) {
          try {
            const settings = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
            if (!settings.storage) settings.storage = {};
            settings.storage.localPath = newRoot;
            fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
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

    /** Resolves the full disk path for a bundled asset file.
     *
     * IpcRouter compiles to dist-electron/electron/services/, but top-level
     * electron assets (e.g. browser-preload.js) emit to dist-electron/electron/.
     * Use __dirname/../ to anchor resolution at the electron output root.
     */
    ipcMain.handle('get-asset-path', (event, filename) => {
      const electronRoot = path.join(__dirname, '..');
      const fullPath = path.join(electronRoot, filename);
      const exists = fs.existsSync(fullPath);
      console.log(`[Main] Resolving Asset Path: '${filename}' -> '${fullPath}' (exists: ${exists})`);
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
     * Main AI Interaction Entry Point.
     *
     * Processes an incoming message from the user and orchestrates the full agent lifecycle:
     * 1. **Context Assembly**: Concatenates chat history, system instructions, and RAG data.
     * 2. **Inference**: Streams tokens from the configured `IBrain` provider back to the UI.
     * 3. **Action Loop**: Executes agent-requested tools (File I/O, Browser, Terminal, etc.).
     * 4. **Event Relay**: Streams secondary updates (screenshot requests, nav events) to the UI.
     *
     * Sends `chat-token` (stream), `agent-event` (meta), `chat-done` (final), or `chat-error`.
     */
    ipcMain.on('chat-message', async (event, payload) => {
      try {
        console.log("[DEBUG] ipcMain 'chat-message' triggered with payload:", payload);
        let fullResponse = '';
        let text = "";
        let images: string[] = [];

        if (typeof payload === 'object' && payload !== null) {
          text = payload.text || "";
          images = payload.images || [];
        } else {
          text = String(payload);
        }

        console.log("[DEBUG] Calling agent.chat() with text length:", text.length, "and images:", images.length);
        const result = await (agent as any).chat(text, (token: string) => {
          fullResponse = fullResponse + token;
          event.sender.send('chat-token', token);
        }, (type: string, data: any) => {
          // Relay custom events to renderer
          event.sender.send('agent-event', { type, data });
        }, images, payload.capabilitiesOverride);

        // Finalize turn and send done event with sanitized content and metadata
        event.sender.send('chat-done', {
          message: result.message,
          artifact: result.artifact,
          suppressChatContent: result.suppressChatContent,
          messageHash: uuidv4().slice(0, 8),
          timestamp: Date.now()
        });

      } catch (e: any) {
        console.error("[IpcRouter] chat-message error:", e);
        if (e.stack) console.error(e.stack);
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

    /** Sets the active notebook context for the agent. */
    ipcMain.handle('set-active-notebook-context', async (event, { id, sourcePaths }) => {
      return agent.setActiveNotebookContext(id, sourcePaths);
    });

    // ─── Research Collections ──────────────────────────────────────────────────

    /** List all notebooks from PostgreSQL. */
    ipcMain.handle('research:listNotebooks', async () => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const notebooks = await repo.listNotebooks();
        return { ok: true, notebooks };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** Get a single notebook by id. */
    ipcMain.handle('research:getNotebook', async (_e, id: string) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const notebook = await repo.getNotebook(id);
        return { ok: true, notebook };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** Create a new notebook. */
    ipcMain.handle('research:createNotebook', async (_e, input: { name: string; description?: string }) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const notebook = await repo.createNotebook(input);
        return { ok: true, notebook };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** Update an existing notebook. */
    ipcMain.handle('research:updateNotebook', async (_e, id: string, input: Record<string, unknown>) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const notebook = await repo.updateNotebook(id, input);
        return { ok: true, notebook };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** Delete a notebook. */
    ipcMain.handle('research:deleteNotebook', async (_e, id: string) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const ok = await repo.deleteNotebook(id);
        return { ok };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** List items in a notebook. */
    ipcMain.handle('research:listNotebookItems', async (_e, notebookId: string) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const items = await repo.listNotebookItems(notebookId);
        return { ok: true, items };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** Add items to an existing notebook. */
    ipcMain.handle('research:addItemsToNotebook', async (_e, notebookId: string, items: unknown[], searchRunId?: string) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const added = await repo.addItemsToNotebook(notebookId, items as any, searchRunId);
        return { ok: true, added };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** Remove an item from a notebook. */
    ipcMain.handle('research:removeNotebookItem', async (_e, notebookId: string, itemKey: string) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const ok = await repo.removeNotebookItem(notebookId, itemKey);
        return { ok };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** Remove multiple items from a notebook in a single operation. */
    ipcMain.handle('research:removeNotebookItems', async (_e, notebookId: string, itemKeys: string[]) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const removedCount = await repo.removeNotebookItems(notebookId, itemKeys);
        return { ok: true, removedCount };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** Create a search run record and store its results. */
    ipcMain.handle('research:createSearchRun', async (_e, input: { query_text: string; notebook_id?: string }) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const searchRun = await repo.createSearchRun(input);
        return { ok: true, searchRun };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** Add results to an existing search run. */
    ipcMain.handle('research:addSearchRunResults', async (_e, searchRunId: string, results: unknown[]) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const added = await repo.addSearchRunResults(searchRunId, results as any);
        return { ok: true, added };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** Get results for a search run. */
    ipcMain.handle('research:getSearchRunResults', async (_e, searchRunId: string) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const results = await repo.getSearchRunResults(searchRunId);
        return { ok: true, results };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** Create a new notebook from all results in a search run. */
    ipcMain.handle('research:createNotebookFromSearchRun', async (_e, searchRunId: string, notebookName: string, description?: string, selectedItemKeys?: string[]) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const result = await repo.createNotebookFromSearchRun(searchRunId, notebookName, description, selectedItemKeys);
        return { ok: true, ...result };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** Copy all results from a search run into an existing notebook. */
    ipcMain.handle('research:addSearchRunResultsToNotebook', async (_e, searchRunId: string, notebookId: string, selectedItemKeys?: string[]) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const result = await repo.addSearchRunResultsToNotebook(searchRunId, notebookId, selectedItemKeys);
        return { ok: true, ...result };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** Resolve notebook scope (URIs and source paths) for retrieval scoping. */
    ipcMain.handle('research:resolveNotebookScope', async (_e, notebookId: string) => {
      const repo = getResearchRepository();
      if (!repo) return { ok: false, error: 'Research repository not initialized' };
      try {
        const scope = await repo.resolveNotebookScope(notebookId);
        return { ok: true, scope };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    // ─── Content Ingestion ──────────────────────────────────────────────────────

    /**
     * Ingest all notebook items in a notebook into source_documents and document_chunks.
     * Ingestion is always explicit — never triggered automatically.
     */
    ipcMain.handle('ingestion:ingestNotebook', async (_e, notebookId: string, options?: Record<string, unknown>, refetch?: boolean) => {
      const research = getResearchRepository();
      const content = getContentRepository();
      if (!research || !content) return { ok: false, error: 'Repositories not initialized' };
      try {
        const svc = new ContentIngestionService(research, content);
        const result = await svc.ingestNotebook(notebookId, options as any, refetch ?? false);
        return { ok: true, result };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /**
     * Ingest a list of notebook items by item_key into source_documents and document_chunks.
     * Ingestion is always explicit — never triggered automatically.
     */
    ipcMain.handle('ingestion:ingestItems', async (_e, itemKeys: string[], notebookId?: string, options?: Record<string, unknown>, refetch?: boolean) => {
      const research = getResearchRepository();
      const content = getContentRepository();
      if (!research || !content) return { ok: false, error: 'Repositories not initialized' };
      try {
        const svc = new ContentIngestionService(research, content);
        const result = await svc.ingestItems(itemKeys, notebookId, options as any, refetch ?? false);
        return { ok: true, result };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    // ─── Chunk Embeddings ────────────────────────────────────────────────────────

    /**
     * Embed all document_chunks for items in a notebook into chunk_embeddings.
     * Requires items to have been ingested first (source_documents + document_chunks).
     */
    ipcMain.handle('embeddings:embedNotebook', async (_e, notebookId: string, options?: { reembed?: boolean }) => {
      const research = getResearchRepository();
      const embeddingsRepo = getEmbeddingsRepository();
      if (!research || !embeddingsRepo) return { ok: false, error: 'Repositories not initialized' };
      try {
        const items = await research.listNotebookItems(notebookId);
        const itemKeys = items.map((i: { item_key: string }) => i.item_key);
        const svc = new ChunkEmbeddingService(embeddingsRepo);
        const result = await svc.embedNotebook(itemKeys, options);
        return { ok: true, result };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /**
     * Embed document_chunks for a list of item_keys into chunk_embeddings.
     */
    ipcMain.handle('embeddings:embedItems', async (_e, itemKeys: string[], options?: { reembed?: boolean }) => {
      const embeddingsRepo = getEmbeddingsRepository();
      if (!embeddingsRepo) return { ok: false, error: 'EmbeddingsRepository not initialized' };
      try {
        const svc = new ChunkEmbeddingService(embeddingsRepo);
        const result = await svc.embedItems(itemKeys, options);
        return { ok: true, result };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /**
     * Embed a list of document_chunks by their chunk IDs.
     */
    ipcMain.handle('embeddings:embedChunks', async (_e, chunkIds: string[], options?: { reembed?: boolean }) => {
      const embeddingsRepo = getEmbeddingsRepository();
      if (!embeddingsRepo) return { ok: false, error: 'EmbeddingsRepository not initialized' };
      try {
        const svc = new ChunkEmbeddingService(embeddingsRepo);
        const result = await svc.embedChunks(chunkIds, options);
        return { ok: true, result };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    // ─── Retrieval Orchestration ────────────────────────────────────────────────

    /**
     * Execute a canonical retrieval request via RetrievalOrchestrator.
     * Supports local and external providers; provider selection via providerIds.
     * Returns a RetrievalResponse with merged, deduplicated, sorted results.
     */
    ipcMain.handle('retrieval:retrieve', async (_e, request: RetrievalRequest) => {
      console.log(`[IPC] retrieval:retrieve received for query: "${request.query}"`);
      const orchestrator = getRetrievalOrchestrator();
      if (!orchestrator) {
        console.warn(`[IPC] RetrievalOrchestrator not initialized!`);
        return { ok: false, error: 'RetrievalOrchestrator not initialized' };
      }
      try {
        const response = await orchestrator.retrieve(request);
        return { ok: true, response };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /** List all currently registered retrieval providers. */
    ipcMain.handle('retrieval:listProviders', async () => {
      const orchestrator = getRetrievalOrchestrator();
      if (!orchestrator) {
        return { ok: false, error: 'RetrievalOrchestrator not initialized' };
      }
      const providers = orchestrator.listProviders().map(p => ({
        id: p.id,
        supportedModes: p.supportedModes,
      }));
      return { ok: true, providers };
    });

    /**
     * Refresh the external search provider registration from current settings.
     * Call after user applies settings changes in the Search tab.
     */
    ipcMain.handle('retrieval:refreshExternalProvider', async () => {
      if (!RuntimeFlags.ENABLE_EXTERNAL_PROVIDER_REFRESH_ON_SAVE) {
        console.log('[IpcRouter] External provider refresh is DISABLED via feature flag.');
        return { ok: true }; // Silent skip
      }
      try {
        refreshExternalProvider();
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // IPC HANDLERS — CONTEXT ASSEMBLY (Step 5B)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Assemble policy-governed, prompt-ready context from retrieval results.
     *
     * Resolves the active MemoryPolicy, retrieves candidate items, enforces
     * budget rules, classifies injected vs. latent items, and returns a
     * structured ContextAssemblyResult with full citation/provenance metadata.
     *
     * Returns: { ok: true, result: ContextAssemblyResult }
     *        | { ok: false, error: string }
     */
    ipcMain.handle('context:assemble', async (_e, request: ContextAssemblyRequest) => {
      const orchestrator = getRetrievalOrchestrator();
      if (!orchestrator) {
        return { ok: false, error: 'RetrievalOrchestrator not initialized' };
      }
      try {
        const policyService = new MemoryPolicyService();
        // Step 6E: wire AffectiveGraphService with AstroService from the AgentService
        // singleton. When the Astro runtime is unavailable or not yet ignited, context
        // assembly continues unchanged — affective items simply do not appear.
        let affectiveGraphService: AffectiveGraphService | null = null;
        try {
          const astroService = agent.getAstroService();
          if (astroService) {
            affectiveGraphService = new AffectiveGraphService(astroService);
          }
        } catch (astroErr: any) {
          console.warn('[IpcRouter] context:assemble — AstroService unavailable, affective modulation disabled:', astroErr?.message ?? String(astroErr));
        }
        const assembler = new ContextAssemblyService(
          orchestrator,
          policyService,
          new GraphTraversalService(),
          affectiveGraphService,
        );
        const result = await assembler.assemble(request);
        return { ok: true, result };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
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
    /**
     * Legacy remote search entrypoint.
     * Deprecated in Phase 3. Now shims to RetrievalOrchestrator with DuckDuckGo provider.
     * Returns up to 30 results with title, snippet, and URL.
     */
    ipcMain.handle('search-remote', async (event, query) => {
      console.log(`[IPC] legacy search-remote called for query: "${query}"`);
      const orchestrator = getRetrievalOrchestrator();
      if (!orchestrator) {
        console.warn('[IpcRouter] search-remote shim: Orchestrator not initialized');
        return [];
      }
      try {
        const response = await orchestrator.retrieve({
          query,
          mode: 'keyword',
          scope: 'global',
          providerIds: ['duckduckgo'],
          topK: 30,
        });

        // Map back to legacy shape: Array<{ title, snippet, url }>
        const results = response.results.map((r) => ({
          title: r.title,
          snippet: r.snippet ?? '',
          url: r.uri ?? '',
        }));

        if (results.length === 0) {
          return [
            {
              title: 'No Results',
              snippet: 'Try a different search term or check your connection.',
              url: '',
            },
          ];
        }

        return results;
      } catch (err: any) {
        console.error('[IpcRouter] search-remote shim failed:', err?.message ?? String(err));
        return [{ title: 'Error', snippet: 'Failed to process web results.', url: '' }];
      }
    });

    // ─── Retrieval: Curated Provider ─────────────────────────────────────────

    /**
     * Returns the available curated search providers for the Settings UI dropdown.
     * Includes availability status (configured, enabled, reasonUnavailable).
     * DuckDuckGo is always included as the zero-config fallback option.
     */
    ipcMain.handle('retrieval:getCuratedProviders', async () => {
      try {
        return getAvailableCuratedProviders(getSettingsPath());
      } catch (e: any) {
        console.error('[IpcRouter] retrieval:getCuratedProviders failed:', e);
        return [{ providerId: 'duckduckgo', displayName: 'DuckDuckGo (no API key)', configured: true, enabled: true }];
      }
    });

    /**
     * Refreshes the external search provider from current settings.
     * Called by the Settings UI after saving a new curated provider selection.
     */
    ipcMain.handle('retrieval:refreshExternalProvider', async () => {
      try {
        const s = loadSettings(getSettingsPath());
        refreshExternalProvider(s.search);
        return { success: true };
      } catch (e: any) {
        console.error('[IpcRouter] retrieval:refreshExternalProvider failed:', e);
        return { success: false, error: e.message };
      }
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
      (agent as any).provideBrowserData(type, data);
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
    // IPC HANDLERS — RUNTIME DIAGNOSTICS (Priority 2A)
    // ═══════════════════════════════════════════════════════════════════════

    const { diagnosticsAggregator, runtimeControl } = this.ctx;

    /**
     * Returns the unified runtime diagnostics snapshot.
     * Includes normalized inference provider state, active stream state,
     * MCP service inventory, degraded subsystems, and recent failure summary.
     *
     * The renderer must call this handler to retrieve diagnostics.
     * It must not perform its own probing or health interpretation.
     */
    ipcMain.handle('diagnostics:getRuntimeSnapshot', async () => {
      return diagnosticsAggregator.getSnapshot();
    });

    /**
     * Returns the normalized inference subsystem diagnostics state.
     * Includes selected provider, stream status, fallback state, and last failure.
     */
    ipcMain.handle('diagnostics:getInferenceStatus', async () => {
      return diagnosticsAggregator.getInferenceStatus();
    });

    /**
     * Returns the normalized MCP service inventory diagnostics.
     * Includes per-service lifecycle state, health, and failure metadata.
     */
    ipcMain.handle('diagnostics:getMcpStatus', async () => {
      return diagnosticsAggregator.getMcpStatus();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // IPC HANDLERS — RUNTIME CONTROL (Phase 2B)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Re-probes and refreshes a single inference provider.
     */
    ipcMain.handle('diagnostics:restartProvider', async (_e, providerId: string) => {
      return runtimeControl.restartProvider(providerId);
    });

    /**
     * Re-probes all inference providers (debounced).
     */
    ipcMain.handle('diagnostics:probeProviders', async () => {
      return runtimeControl.probeProviders();
    });

    /**
     * Suppresses a provider from auto-selection (session-scoped, reversible).
     */
    ipcMain.handle('diagnostics:disableProvider', async (_e, providerId: string, reason?: string) => {
      return runtimeControl.disableProvider(providerId, reason);
    });

    /**
     * Re-enables a previously suppressed provider.
     */
    ipcMain.handle('diagnostics:enableProvider', async (_e, providerId: string, reason?: string) => {
      return runtimeControl.enableProvider(providerId, reason);
    });

    /**
     * Forces a specific provider to be selected for the current session.
     */
    ipcMain.handle('diagnostics:forceProviderSelection', async (_e, providerId: string, reason?: string) => {
      return runtimeControl.forceProviderSelection(providerId, reason);
    });

    /**
     * Restarts an MCP service (disconnect + reconnect).
     */
    ipcMain.handle('diagnostics:restartMcpService', async (_e, serviceId: string) => {
      const s = loadSettings(getSettingsPath());
      const mcpConfigs = s.mcpServers ?? [];
      return runtimeControl.restartMcpService(serviceId, mcpConfigs);
    });

    /**
     * Disables an MCP service (disconnects it, prevents invocation).
     */
    ipcMain.handle('diagnostics:disableMcpService', async (_e, serviceId: string) => {
      return runtimeControl.disableMcpService(serviceId);
    });

    /**
     * Re-enables a previously disabled MCP service.
     */
    ipcMain.handle('diagnostics:enableMcpService', async (_e, serviceId: string) => {
      const s = loadSettings(getSettingsPath());
      const mcpConfigs = s.mcpServers ?? [];
      return runtimeControl.enableMcpService(serviceId, mcpConfigs);
    });

    /**
     * Triggers a health re-probe of all MCP services (debounced).
     */
    ipcMain.handle('diagnostics:probeMcpServices', async () => {
      return runtimeControl.probeMcpServices();
    });

    // ─── Phase 4A: World Model diagnostics ────────────────────────────────────

    /**
     * Returns the world model diagnostics summary.
     * Read-only — renderer never drives world-model assembly.
     * Returns null if no world model has been assembled yet.
     */
    ipcMain.handle('diagnostics:getWorldModel', async () => {
      const assembler = this.ctx.worldModelAssembler;
      if (!assembler) return null;
      const model = assembler.getCachedModel();
      if (!model) return null;
      return assembler.buildDiagnosticsSummary(model);
    });

    /**
     * Phase 4B — Self-maintenance diagnostics read model.
     * Returns the current MaintenanceDiagnosticsSummary or null if not initialized.
     * Read-only for the renderer; no policy evaluation is pushed to the UI.
     */
    ipcMain.handle('diagnostics:getMaintenanceState', async () => {
      const maintenance = this.ctx.maintenanceLoopService;
      if (!maintenance) return null;
      return maintenance.getDiagnosticsSummary();
    });

    /**
     * Phase 4B — Trigger a manual maintenance check cycle.
     * Respects current maintenance mode; never bypasses policy or safety gates.
     */
    ipcMain.handle('diagnostics:runMaintenanceCheck', async () => {
      const maintenance = this.ctx.maintenanceLoopService;
      if (!maintenance) return null;
      const aggregator = this.ctx.diagnosticsAggregator;
      const worldModel = this.ctx.worldModelAssembler?.getCachedModel() ?? undefined;
      const snapshot = aggregator.getSnapshot();
      return maintenance.runCycle(snapshot, worldModel);
    });

    /**
     * Phase 4B — Change the maintenance mode.
     * Allowed values: 'observation_only' | 'recommend_only' | 'safe_auto_recovery'
     */
    ipcMain.handle('diagnostics:setMaintenanceMode', async (_e, mode: string) => {
      const maintenance = this.ctx.maintenanceLoopService;
      if (!maintenance) return { success: false, error: 'Maintenance loop service not initialized.' };
      const allowed = ['observation_only', 'recommend_only', 'safe_auto_recovery'];
      if (!allowed.includes(mode)) {
        return { success: false, error: `Invalid maintenance mode '${mode}'.` };
      }
      maintenance.setMode(mode as any);
      return { success: true, mode };
    });

    // ═══════════════════════════════════════════════════════════════════════
    // IPC HANDLERS — PHASE 4C: A2UI WORKSPACE SURFACES
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Phase 4C — Open or refresh a named A2UI workspace surface.
     * Routes the assembled payload to the renderer's document/editor pane.
     * @param surfaceId 'cognition' | 'world' | 'maintenance'
     * @param options.focus Whether to focus the tab (default: true).
     */
    ipcMain.handle('a2ui:openSurface', async (_e, surfaceId: string, options?: { focus?: boolean }) => {
      if (!this._a2uiRouter) return { success: false, error: 'A2UI router not initialized.' };
      const allowed: A2UISurfaceId[] = ['cognition', 'world', 'maintenance'];
      if (!allowed.includes(surfaceId as A2UISurfaceId)) {
        return { success: false, error: `Unknown surface ID: '${surfaceId}'.` };
      }
      const payload = await this._a2uiRouter.openSurface(surfaceId as A2UISurfaceId, options);
      return payload
        ? { success: true, tabId: payload.tabId, title: payload.title }
        : { success: false, error: 'Surface assembly failed.' };
    });

    /**
     * Phase 4C — Dispatch a validated action from an A2UI surface.
     * Actions are allowlisted; invalid actions are rejected.
     */
    ipcMain.handle('a2ui:dispatchAction', async (_e, action: A2UIActionDispatch) => {
      if (!this._a2uiActionBridge) return { success: false, error: 'A2UI action bridge not initialized.' };
      return this._a2uiActionBridge.dispatch(action);
    });

    /**
     * Phase 4C — Retrieve the current cognitive diagnostics snapshot.
     * Used by the renderer to pre-populate the cognition surface before the
     * main process pushes the full surface payload.
     */
    ipcMain.handle('a2ui:getCognitiveSnapshot', async () => {
      return this.ctx.diagnosticsAggregator.getSnapshot().cognitive ?? null;
    });

    /**
     * Phase 4C — Retrieve current A2UI surface diagnostics.
     * Allows inspection of open surfaces and action counters.
     */
    ipcMain.handle('a2ui:getDiagnostics', async () => {
      if (!this._a2uiRouter) return null;
      const routerDiag = this._a2uiRouter.getDiagnosticsSummary();
      const actionCounts = this._a2uiActionBridge?.getActionCounts() ?? { dispatched: 0, failed: 0 };
      return {
        ...routerDiag,
        actionDispatchCount: actionCounts.dispatched,
        actionFailureCount: actionCounts.failed,
      };
    });

  }
}
