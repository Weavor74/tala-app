# Feature Specification — Inference Engine Features

> This file is generated from:
> - docs/traceability/requirements_trace_matrix.md
> - docs/traceability/test_trace_matrix.md
> - docs/audit/file_inventory_full.json
> - active source-file docblocks
>
> Do not edit manually. Update the source docs/code comments and regenerate.

## Feature Summary

**Feature Name:** Inference Engine Features
**Capability:** Not explicitly specified
**Requirement Count:** 2
**Component Count:** 2
**Implementation File Count:** 2

## Requirement Basis


## Subsystems

- Inference Engine

## Components

- Brain Drivers
- Brain Interface

## Source Files

- ``electron/brains/OllamaBrain.ts``
- ``electron/brains/IBrain.ts``

## Implementation Behavior

_No implementation docblock summaries were matched to this feature._

## Primary Methods / Functions

_No docblock entries available._

## Interfaces

_No direct interface references matched from the interface docs._

## Security Notes

_No direct security references matched from the threat/security docs._

## Architecture References

_No direct architecture references matched from the architecture docs._

## Verification

**Methods**
- _No verification methods documented._

**Test Locations**
- _No test locations documented._

---

## Phase 2 — Local Inference Hardening

**Source**: `electron/services/LocalInferenceManager.ts`

Phase 2 added `LocalInferenceManager` as a hardened lifecycle wrapper around
`LocalEngineService`. It provides:

### Lifecycle States

| State | Meaning |
|-------|---------|
| `disabled` | Not started |
| `starting` | Server start in progress |
| `ready` | Accepting requests |
| `busy` | Request in progress |
| `degraded` | Request failed, may recover |
| `unavailable` | Recovery probe failed |
| `failed` | Server failed to start or crashed |

### Behavior

- Requests to a non-`ready` server return `{ success: false, errorCode: 'unavailable' }` immediately.
- Startup timeout: 60s (configurable via `LocalInferenceConfig.startupTimeoutMs`).
- Request timeout: 30s (configurable via `LocalInferenceConfig.requestTimeoutMs`).
- Retry attempts: 2 maximum with linear backoff (configurable).
- After retry exhaustion: state transitions to `degraded`, emits `degraded_fallback` telemetry.
- `recover()` probes `/health` endpoint; on success transitions to `ready`.

### Telemetry

Every state transition and request outcome emits a `CanonicalTelemetryEvent` via `TelemetryService`.
See `docs/architecture/phase2_trustworthiness_hardening.md` for the full event list.

### Test Coverage

`electron/__tests__/inference/LocalInferenceHardening.test.ts` covers:
- State machine transitions
- Readiness enforcement
- Timeout behavior
- Retry bounds
- Recovery from degraded/failed
- Telemetry emission

