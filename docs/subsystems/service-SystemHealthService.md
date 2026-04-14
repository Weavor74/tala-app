# Service: SystemHealthService.ts

**Source**: [electron\services\SystemHealthService.ts](../../electron/services/SystemHealthService.ts)

## Class: `SystemHealthService`

## Overview
Deterministic system-health reduction service.

 Invariant: the same normalized inputs always produce the same health/status snapshot.

### Methods

#### `buildSnapshot`
**Arguments**: `input: BuildSystemHealthSnapshotInput`
**Returns**: `SystemHealthSnapshot`

---
#### `getOperatorModeOverride`
**Arguments**: ``
**Returns**: ``

---
#### `reduceOverallStatus`
**Arguments**: `entries: SystemHealthSubsystemSnapshot[]`
**Returns**: `SystemHealthOverallStatus`

---
#### `computeTrustModel`
**Arguments**: `nowIso: string, inference: InferenceDiagnosticsState, mcp: McpInventoryDiagnostics, dbObserved: boolean, telemetryStreamObserved: boolean, subsystemEntries: SystemHealthSubsystemSnapshot[],`
**Returns**: `TrustModel`

---
#### `buildCapabilityMatrix`
**Arguments**: `subsystemEntries: SystemHealthSubsystemSnapshot[], modeContract: SystemModeContract,`
**Returns**: `SystemCapabilityAvailability[]`

---
#### `buildIncidentEntries`
**Arguments**: `subsystemEntries: SystemHealthSubsystemSnapshot[]`
**Returns**: `SystemHealthIncidentEntry[]`

---
