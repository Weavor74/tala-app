# Seam Contract: Workspace Surfaces

## Purpose
- Keep workspace surfaces deterministic, typed, and restorable through explicit contracts.

## Authority Boundary
- Surface rendering, controls, and persistence are separate responsibilities.
- Controls must be contract-registered, not ad hoc inferred.
- Surface state persistence must remain serializable and versioned.

## Invariants
- Surface rendering contract and controls contract remain distinct.
- Surface controls are registered through explicit contract surfaces.
- Surface state is serializable and versioned.
- Restore behavior is deterministic for valid state.
- Invalid/unsupported surface state degrades explicitly.

## Explicitly Forbidden Behavior
- Ad hoc inferred controls outside the registered controls contract.
- Persisting non-serializable surface state.
- Implicit or silent restore fallback that hides invalid/unsupported state.

## Degraded-State Doctrine
- Invalid, unsupported, or unregistered surface states degrade explicitly with stable reason semantics.
- Restore failures must return deterministic degraded outcomes.

## Required Diagnostics / Reason Semantics
- Surface restore and control resolution paths must expose machine-usable reason codes for degraded outcomes.
- Surface state payloads must include version indicators.
- Unsupported state rendering must be explicit and non-authoritative.

## Test Enforcement References
- `tests/WorkspaceSurfaceRouting.test.ts`
- `tests/A2UISurfaces.test.ts`
- `electron/__tests__/contracts/SeamContractGovernance.test.ts`
- `scripts/diagnostics/check-seam-governance.ts`

## Change Control Note
- Workspace surface seam is strict-governed.
- Protected seam modifications require contract metadata/doc update or explicit justification through seam governance gate.
