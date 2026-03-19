# Service: IpcRouter.ts

**Source**: [electron\services\IpcRouter.ts](../../electron/services/IpcRouter.ts)

## Class: `IpcRouter`

## Overview
Runtime diagnostics aggregator — provides normalized snapshot for IPC consumers. */
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

/** Central API Registry for the Electron shell.  The `IpcRouter` orchestrates all communication between the React renderer and the  backend services. It manages: - Application lifecycle and settings migration. - AI agent orchestration and streaming chat responses. - File system operations and workspace sandboxing. - Integration with peripheral services (Git, MCP, Guardrails, Backup). - System-level interactions (Terminal PTYs, OAuth, Native Dialogs).

### Methods

