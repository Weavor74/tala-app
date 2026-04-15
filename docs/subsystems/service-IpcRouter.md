# Service: IpcRouter.ts

**Source**: [electron\services\IpcRouter.ts](../../electron/services/IpcRouter.ts)

## Class: `IpcRouter`

## Overview
⚠️ TALA INVARIANT — IPC REGISTRATION - Each ipcMain.handle channel must be registered EXACTLY ONCE - Duplicate handlers WILL crash the app and break persistence - Always use removeHandler(channel) before re-registering - Do NOT register the same channel in multiple locations/
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
import { UserProfileService } from './UserProfileService';
import { CodeControlService } from './CodeControlService';
import { LogViewerService } from './LogViewerService';
import { RuntimeDiagnosticsAggregator } from './RuntimeDiagnosticsAggregator';
import { RuntimeControlService } from './RuntimeControlService';
import type { OperatorActionService } from './OperatorActionService';
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
import { TelemetryBus } from './telemetry/TelemetryBus';
import type { RetrievalRequest } from '../../shared/retrieval/retrievalTypes';
import { ContextAssemblyService } from './context/ContextAssemblyService';
import { MemoryPolicyService } from './policy/MemoryPolicyService';
import { GraphTraversalService } from './graph/GraphTraversalService';
import { AffectiveGraphService } from './graph/AffectiveGraphService';
import type { ContextAssemblyRequest } from '../../shared/policy/memoryPolicyTypes';
import { AgentKernel } from './kernel/AgentKernel';
import type { RuntimeExecutionMode } from '../../shared/runtime/executionTypes';
import { RuntimeErrorLogger } from './logging/RuntimeErrorLogger';
import type { OperatorActionRequest } from '../../shared/runtimeDiagnosticsTypes';
import { localGuardrailsRuntimeHealth } from './guardrails/LocalGuardrailsRuntimeHealth';
import { localGuardrailsBindingProbeService } from './guardrails/LocalGuardrailsBindingProbeService';
import { localGuardrailsRuntimeSmokeService } from './guardrails/LocalGuardrailsRuntimeSmokeService';
import { localGuardrailsProfilePreflightService } from './guardrails/LocalGuardrailsProfilePreflightService';
import { guardrailActivationDiagnosticsService } from './guardrails/GuardrailActivationDiagnosticsService';
import type { SystemCapability } from '../../shared/system-health-types';
import { SystemModeManager } from './SystemModeManager';
import { StorageConfigPersistenceService } from './storage/storageConfigPersistence';
import { StorageProviderRegistryService } from './storage/StorageProviderRegistryService';
import { StorageDetectionService } from './storage/StorageDetectionService';
import { StorageValidationService } from './storage/StorageValidationService';
import type {
  StorageAddProviderRequest,
  StorageAddProviderResponse,
  StorageAssignRoleRequest,
  StorageAssignRoleResponse,
  StorageDetectProvidersResponse,
  StorageGetSnapshotResponse,
  StorageMutationFailure,
  StorageRemoveProviderRequest,
  StorageRemoveProviderResponse,
  StorageSetProviderEnabledRequest,
  StorageSetProviderEnabledResponse,
  StorageUnassignRoleRequest,
  StorageUnassignRoleResponse,
  StorageUpdateProviderRequest,
  StorageUpdateProviderResponse,
  StorageValidateProviderRequest,
  StorageValidateProviderResponse,
} from './storage/storageTypes';
import { checkStorageOperationError, StorageOperationErrorCode } from './storage/storageTypes';
import {
  buildDefaultGuardrailPolicyConfig,
  normalizeGuardrailPolicyConfig,
} from '../../shared/guardrails/guardrailPolicyTypes';

/** Agent modes that map directly to RuntimeExecutionMode values. */
const VALID_EXECUTION_MODES = new Set<string>(['assistant', 'hybrid', 'rp']);

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
  /** Unified operator action service — central policy-gated dashboard actions. */
  operatorActionService?: OperatorActionService;
  /** World model assembler — Phase 4A canonical world-model builder. */
  worldModelAssembler?: WorldModelAssembler;
  /** Maintenance loop service — Phase 4B self-maintenance foundation. */
  maintenanceLoopService?: import('./maintenance/MaintenanceLoopService').MaintenanceLoopService;
  storageProviderRegistry?: StorageProviderRegistryService;
  storageDetectionService?: StorageDetectionService;
  storageValidationService?: StorageValidationService;
  getSettingsPath: () => string;
  setSettingsPath: (p: string) => void;
  USER_DATA_DIR: string;
  USER_DATA_PATH: string;
  APP_DIR: string;
  PORTABLE_SETTINGS_PATH: string;
  SYSTEM_SETTINGS_PATH: string;
  TEMP_SYSTEM_PATH: string;
}

/** Central API Registry for the Electron shell.  The `IpcRouter` orchestrates all communication between the React renderer and the  backend services. It manages: - Application lifecycle and settings migration. - AI agent orchestration and streaming chat responses. - File system operations and workspace sandboxing. - Integration with peripheral services (Git, MCP, Guardrails, Backup). - System-level interactions (Terminal PTYs, OAuth, Native Dialogs).

### Methods

