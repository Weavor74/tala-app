# Logging and Audit — Tala System

**Document ID**: TALA-SEC-006  
**Version**: 2.0.0  
**Status**: Formal  
**Owner**: Engineering / Forensic Review  

## 1. Overview
Tala implements a comprehensive, safety-first logging architecture designed to provide full forensic accountability for AI reasoning and tool execution while strictly preventing data leakage.

Phase 2 Trustworthiness Hardening added a canonical telemetry schema and a unified emission utility (`TelemetryService`) that normalizes event emission across all subsystems.

## 2. Audit Subsystems

### 2.1. Canonical Telemetry (TelemetryService) — Phase 2
**Source**: `electron/services/TelemetryService.ts`  
**Schema**: `shared/telemetry.ts`  
**Output**: Written through `AuditLogger` to `<app-root>/data/logs/audit-log.jsonl`

Every significant runtime action emits a `CanonicalTelemetryEvent` with:
- `timestamp`, `eventId`, `turnId`, `sessionId`, `correlationId`
- `subsystem`, `eventType`, `severity`, `mode`, `actor`
- `summary` (human-readable, no sensitive content)
- `payload` (structured, redacted)
- `status` (success / failure / partial / suppressed / unknown)
- `channel` (audit / operational / debug)

Telemetry channels:
- **audit**: Immutable turn lifecycle, memory writes, inference outcomes, reflection triggers
- **operational**: Service health, state changes, MCP status
- **debug**: Verbose developer context (silenced in production)

Turn reconstruction is supported via `TelemetryService.reconstructTurn()`, which
assembles a `TurnReconstruction` from a sequence of events.

### 2.2. System Audit (AuditLogger)
**Path**: `<app-root>/data/logs/audit-log.jsonl`  
Records high-level application events:
- Service initialization and lifecycle status.
- Tool registration and execution success/fail.
- IPC channel requests.
- All canonical telemetry events (via `TelemetryService` integration).
- **Security Control**: All log entries are scrubbed by `log_redact.ts`.

### 2.3. Prompt Audit (PromptAuditService)
**Path**: `<app-root>/data/logs/prompt-audit.jsonl`  
Records the full conversation flow for every inference turn:
- **Input**: Full system prompt, context windows, and user message.
- **Output**: Raw LLM response before UI rendering.
- **Purpose**: Debugging "Hallucinations" and auditing "Prompt Injection" attempts.

### 2.4. Tool Execution Log
Records specific arguments and return values of tools:
- **Logic**: Implemented within `ToolService.ts` and `AgentService.ts`.
- **Constraint**: Arguments >2KB are truncated for performance and to minimize PII concentration.

## 3. Review Considerations

### 3.1. Log Integrity
Logs are stored as plain text or JSONL on the local filesystem. While they are protected by standard user-level OS permissions, they are not currently cryptographically signed (Log Tampering is a documented residual risk).

### 3.2. Sensitivity Gating
The following data must **NEVER** be logged:
- Unredacted API Keys.
- Plain-text passwords from `desktop_input` tools.
- Full un-redacted Bearer tokens.
- Raw user message content or model prompt text (must be summarized or hashed).

Enforced via `log_redact.ts` applied to all `AuditLogger` writes, including those
from `TelemetryService`.

## 4. Archive and Cleanup
- **Storage root**: Tala-owned logs are managed under `<app-root>/data/logs/`.
- **Rotation**: Size-based rotation is centralized in `electron/services/LogLifecycleService.ts` (default 100MB active file threshold).
- **Retention**: Rotated files are pruned automatically (default keep newest 5 rotated files per base log).
- **Bounded inspection**: Reflection log inspection uses tail-window reads (default last 5MB / bounded line count) and does not load full log files into memory.

## 5. Phase 2 Event Categories
See `docs/architecture/phase2_trustworthiness_hardening.md` for the full list of
canonical event types and their intended usage.

---
*Updated for Phase 2 Trustworthiness Hardening*

