# Service: TelemetryService.ts

**Source**: [electron/services/TelemetryService.ts](../../electron/services/TelemetryService.ts)

## Class: `TelemetryService`

## Overview
TelemetryService — Canonical Event Emission Utility

 Phase 2 Trustworthiness Hardening — Objective 6

 Provides a single, normalized API for emitting structured telemetry events
 across all TALA subsystems. All services should use this service rather than
 directly calling AuditLogger with ad hoc payloads.

 Design principles:
 - Every event carries a full canonical envelope (see shared/telemetry.ts).
 - Sensitive content is never written to the payload (redaction is enforced).
 - Events are emitted synchronously via the existing AuditLogger JSONL pipeline.
 - Turn reconstruction is supported via TurnReconstructionBuilder.
 - Developer debug events are silenced in production (NODE_ENV=production).
/

import { v4 as uuidv4 } from 'uuid';
import { auditLogger } from './AuditLogger';
import { redact } from './log_redact';
import type {
    CanonicalTelemetryEvent,
    TelemetrySubsystem,
    TelemetryEventType,
    TelemetrySeverity,
    TelemetryStatus,
    TelemetryChannel,
    TurnReconstruction,
} from '../../shared/telemetry';

// ─── Emission options ─────────────────────────────────────────────────────────

export interface EmitOptions {
    turnId?: string;
    correlationId?: string;
    sessionId?: string;
    mode?: string;
    payload?: Record<string, unknown>;
}

// ─── TelemetryService ─────────────────────────────────────────────────────────

/**
 Singleton telemetry service used by all electron-side subsystems.

 Usage:
   import { telemetry } from './TelemetryService';
   telemetry.emit('inference', 'inference_started', 'info', 'InferenceService', 'Inference started', { turnId, ... });

### Methods

#### `reconstructTurn`
Assembles a TurnReconstruction from a set of telemetry events.
 Supports human diagnosis of a complete agent turn.
/

**Arguments**: `events: CanonicalTelemetryEvent[]`
**Returns**: `TurnReconstruction | null`

---
#### `buildEvent`
**Arguments**: `subsystem: TelemetrySubsystem, eventType: TelemetryEventType, severity: TelemetrySeverity, actor: string, summary: string, status: TelemetryStatus, channel: TelemetryChannel, options: EmitOptions`
**Returns**: `CanonicalTelemetryEvent`

---
#### `resolveChannel`
**Arguments**: `eventType: TelemetryEventType, severity: TelemetrySeverity`
**Returns**: `TelemetryChannel`

---
