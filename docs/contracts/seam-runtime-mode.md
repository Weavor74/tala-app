# Seam Contract: Runtime Mode Control

## Purpose
- Keep runtime mode control explicit, singular, and governance-preserving across operator actions.

## Authority Boundary
- Backend runtime control services are authoritative for mode and action availability.
- Renderer-side mode inference is non-authoritative and must not replace backend authority.

## Invariants
- Runtime mode authority source is singular and explicit.
- Critical action availability is explicit and reasoned, never implied.
- Mode transitions preserve governance and guardrail semantics.
- Critical operator/runtime actions disallow best-effort ambiguity.

## Explicitly Forbidden Behavior
- Renderer-side authority inference where backend authority exists.
- Ambiguous action availability for critical runtime controls.
- Mode transitions that bypass or weaken governance/guardrail policy semantics.

## Degraded-State Doctrine
- Invalid, blocked, unavailable, and degraded runtime actions must be explicit and reason-coded.
- Mode/control uncertainty must fail closed for critical actions.

## Required Diagnostics / Reason Semantics
- Runtime mode control responses must include machine-usable reason code semantics for blocked/degraded actions.
- Action availability reason must be present for unavailable critical controls.
- Mode authority source must be visible in diagnostics contracts.

## Test Enforcement References
- `electron/__tests__/diagnostics/RuntimeControl.test.ts`
- `electron/__tests__/diagnostics/SystemModeGovernanceMatrix.test.ts`
- `electron/__tests__/contracts/SeamContractGovernance.test.ts`
- `scripts/diagnostics/check-seam-governance.ts`

## Change Control Note
- Runtime mode seam is strict-governed.
- Protected seam modifications require contract metadata/doc update or explicit justification through seam governance gate.
