# Seam Contract: Diagnostics Truth Contracts

## Purpose
- Keep diagnostics as truthful backend-grounded contracts, not optimistic presentation heuristics.

## Authority Boundary
- Backend runtime/services are authoritative for diagnostics truth.
- Renderer/UI may render, summarize, and link evidence but may not invent or override backend truth.

## Invariants
- No healthy-looking state may be emitted when required evidence is missing.
- Material degraded/unavailable states require machine-usable reason codes.
- Evidence links/artifacts are present when available, otherwise explicitly marked unavailable.
- Diagnostics summaries track backend state, not optimistic inference.

## Explicitly Forbidden Behavior
- Renderer-side fabrication of backend health truth.
- Emitting healthy/ready summary states without evidence.
- Degraded/unavailable states without deterministic reason semantics.

## Degraded-State Doctrine
- Unknown, degraded, unavailable, and failed states must be explicit and reason-coded.
- Missing evidence must degrade explicitly and not collapse to healthy defaults.

## Required Diagnostics / Reason Semantics
- Diagnostics payloads must include machine-usable reason code fields for material faults.
- Evidence status must be explicit (`present` vs `unavailable`) rather than implied.
- Subsystem summary states must align with backend-reported conditions.

## Test Enforcement References
- `electron/__tests__/diagnostics/RuntimeDiagnosticsModel.test.ts`
- `electron/__tests__/contracts/SeamContractGovernance.test.ts`
- `scripts/diagnostics/check-seam-governance.ts`

## Change Control Note
- Diagnostics truth seam is strict-governed.
- Protected seam modifications require contract metadata/doc update or explicit justification through seam governance gate.
