# Service: A2UIWorkspaceRouter.ts

**Source**: [electron/services/A2UIWorkspaceRouter.ts](../../electron/services/A2UIWorkspaceRouter.ts)

## Class: `A2UIWorkspaceRouter`

## Overview
A2UIWorkspaceRouter — Phase 4C: A2UI Workspace Surfaces

 Routes A2UI surface payloads to the document/editor pane workspace tabs.
 Assembles surface content from existing diagnostic/read models and emits
 normalized payloads to the renderer via the 'agent-event' channel.

 Architecture rules:
 - Surfaces always target the document/editor pane (never chat inline).
 - Stable tab IDs prevent duplicate tab creation on re-open.
 - Lightweight chat notices are emitted separately, not surface content.
 - All surface assembly is done main-side; the renderer is a host only.
 - Failures degrade gracefully to textual summaries.

 Data sources:
 - Cognition  → RuntimeDiagnosticsAggregator.getSnapshot().cognitive
 - World      → WorldModelAssembler.getCachedModel()
 - Maintenance → MaintenanceLoopService.getDiagnosticsSummary()
/

import type { BrowserWindow } from 'electron';
import type { A2UISurfaceId, A2UISurfacePayload, A2UISurfaceRegistryEntry, A2UIDiagnosticsSummary } from '../../shared/a2uiTypes';
import type { RuntimeDiagnosticsAggregator } from './RuntimeDiagnosticsAggregator';
import type { WorldModelAssembler } from './world/WorldModelAssembler';
import type { MaintenanceLoopService } from './maintenance/MaintenanceLoopService';
import { mapCognitionSurface } from './cognitive/CognitionSurfaceMapper';
import { mapWorldSurface } from './world/WorldSurfaceMapper';
import { mapMaintenanceSurface } from './maintenance/MaintenanceSurfaceMapper';
import { telemetry } from './TelemetryService';

/**
 Dependencies injected at construction time.
/
export interface A2UIWorkspaceRouterDeps {
    getMainWindow: () => BrowserWindow | null;
    diagnosticsAggregator: RuntimeDiagnosticsAggregator;
    worldModelAssembler?: WorldModelAssembler;
    maintenanceLoopService?: MaintenanceLoopService;
}

/**
 A2UIWorkspaceRouter

 Singleton-friendly router that assembles and delivers A2UI surface payloads
 to the renderer's document/editor pane. Maintains a bounded registry of
 open surfaces for diagnostics visibility.

### Methods

#### `getDiagnosticsSummary`
Returns the current diagnostics summary for all A2UI surfaces.
/

**Arguments**: ``
**Returns**: `A2UIDiagnosticsSummary`

---
#### `isSurfaceOpen`
Checks whether a surface is currently registered as open.
/

**Arguments**: `surfaceId: A2UISurfaceId`
**Returns**: `boolean`

---
#### `_assemblePayload`
Assembles the A2UI surface payload for the given surface ID.
/

**Arguments**: `surfaceId: A2UISurfaceId, focus: boolean`
**Returns**: `Promise<A2UISurfacePayload>`

---
