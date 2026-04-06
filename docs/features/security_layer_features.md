# Feature Specification — Security Layer Features

> This file is generated from:
> - docs/traceability/requirements_trace_matrix.md
> - docs/traceability/test_trace_matrix.md
> - docs/audit/file_inventory_full.json
> - active source-file docblocks
>
> Do not edit manually. Update the source docs/code comments and regenerate.

## Feature Summary

**Feature Name:** Security Layer Features
**Capability:** Not explicitly specified
**Requirement Count:** 3
**Component Count:** 3
**Implementation File Count:** 3

## Requirement Basis


## Subsystems

- Security Layer

## Components

- Guardrail Service
- Audit Logger
- Policy Engine

## Source Files

- ``electron/services/GuardrailService.ts``
- ``electron/services/LoggingService.ts``
- ``electron/security/CodeAccessPolicy.ts``

## Implementation Behavior

_No implementation docblock summaries were matched to this feature._

## Primary Methods / Functions

_No docblock entries available._

## Interfaces

_No direct interface references matched from the interface docs._

## Security Notes

- The primary defense against the most critical threats (**TH-001**, **TH-002**) is the **Isolation Kernel** pattern, where reasoning is decoupled from execution, and all execution is governed by a non-bypassable policy engine (`CodeAccessPolicy`).
- **PolicyGate** (`electron/services/policy/PolicyGate.ts`) is a cross-cutting enforcement seam that evaluates every side-effecting action before it executes. In RP mode the following rules block execution unconditionally:
  - `POLICY_FILE_WRITE_RP_BLOCK` — blocks direct file-system writes (`file_write` action kind)
  - `POLICY_AUTONOMY_RP_BLOCK` — blocks autonomous goal-pipeline execution (`autonomy_action` kind)
  - `POLICY_WORKFLOW_RP_BLOCK` — blocks every workflow node execution (`workflow_action` kind); `executionMode` is now threaded from the IPC caller through `WorkflowEngine.executeWorkflow()` to each `assertSideEffect()` call so the rule fires correctly
  - `POLICY_MEMORY_WRITE_RP_BLOCK` — blocks canonical memory mutation (`memory_write` kind with `mutationIntent='write'`); applies to `updateCanonicalMemory()` and `tombstoneMemory()` in `MemoryAuthorityService`
- Blocked actions throw `PolicyDeniedError` which propagates cleanly to the caller; no partial writes occur.

## Architecture References

_No direct architecture references matched from the architecture docs._

## Verification

**Methods**
- _No verification methods documented._

**Test Locations**
- _No test locations documented._

