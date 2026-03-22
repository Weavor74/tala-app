# Service: A2UIActionBridge.ts

**Source**: [electron/services/A2UIActionBridge.ts](../../electron/services/A2UIActionBridge.ts)

## Class: `A2UIActionBridge`

## Overview
A2UIActionBridge — Phase 4C: A2UI Workspace Surfaces

 Validates and executes actions dispatched from A2UI renderer surfaces.
 Enforces an allowlist of safe actions and normalizes payloads before
 routing to runtime services.

 Safety model:
 - Only allowlisted action names are accepted.
 - Each action's payload schema is validated before execution.
 - No arbitrary code execution or untyped dispatch is possible.
 - All actions emit telemetry for full observability.
 - Destructive actions are not exposed in the allowlist.
/

import type { A2UIActionDispatch, A2UIActionName, A2UIActionResult } from '../../shared/a2uiTypes';
import type { A2UIWorkspaceRouter } from './A2UIWorkspaceRouter';
import type { MaintenanceLoopService } from './maintenance/MaintenanceLoopService';
import type { RuntimeControlService } from './RuntimeControlService';
import type { RuntimeDiagnosticsAggregator } from './RuntimeDiagnosticsAggregator';
import type { WorldModelAssembler } from './world/WorldModelAssembler';
import type { MaintenanceMode } from '../../shared/maintenance/maintenanceTypes';
import { telemetry } from './TelemetryService';

/**
 Set of allowlisted action names.
 Only these may be dispatched from the renderer.
/
const ALLOWED_ACTIONS: Set<A2UIActionName> = new Set([
    'open_cognition_surface',
    'open_world_surface',
    'open_maintenance_surface',
    'refresh_cognition',
    'refresh_world',
    'refresh_maintenance',
    'run_maintenance_check',
    'switch_maintenance_mode',
    'restart_provider',
    'restart_mcp_service',
]);

/**
 Valid maintenance mode values for the switch_maintenance_mode action.
/
const VALID_MAINTENANCE_MODES: Set<MaintenanceMode> = new Set([
    'observation_only',
    'recommend_only',
    'safe_auto_recovery',
]);

export interface A2UIActionBridgeDeps {
    router: A2UIWorkspaceRouter;
    maintenanceLoopService?: MaintenanceLoopService;
    runtimeControlService?: RuntimeControlService;
    diagnosticsAggregator?: RuntimeDiagnosticsAggregator;
    worldModelAssembler?: WorldModelAssembler;
}

/**
 A2UIActionBridge

 Validates and dispatches actions from the A2UI renderer to runtime services.
 Maintains counters for diagnostics visibility.

### Methods

#### `dispatch`
Dispatches an A2UI action after validation.
 Returns a result object indicating success or failure.
/

**Arguments**: `action: A2UIActionDispatch`
**Returns**: `Promise<A2UIActionResult>`

---
#### `getActionCounts`
**Arguments**: ``
**Returns**: ``

---
#### `_execute`
**Arguments**: `action: A2UIActionDispatch`
**Returns**: `Promise<A2UIActionResult>`

---
