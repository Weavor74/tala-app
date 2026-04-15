# Seam Contract: Storage Authority

## Purpose
- Keep durable storage truth fixed to canonical PostgreSQL authority.
- Prevent authority churn during capability, readiness, or health instability.

## Authority Boundary
- Canonical durable memory/storage authority is PostgreSQL.
- `pgvector` is an installed capability layer within PostgreSQL when present.
- Capability does not confer authority.
- Assignment does not imply readiness.

## Invariants
- Postgres authority remains canonical across healthy, degraded, unavailable, and auth-invalid runtime states.
- Derived layers (vector indexes, retrieval projections, summaries, caches) are non-authoritative.
- Canonical memory truth surfaced to Tala resolves to PostgreSQL-backed identifiers.
- Degraded state does not silently reassign canonical authority.

## Explicitly Forbidden Behavior
- Silent reassignment of canonical memory authority when canonical provider is degraded, unreachable, or auth-invalid.
- Treating vector capability presence/absence as authority reassignment.
- Durable memory writes that bypass the authority path.

## Degraded-State Doctrine
- Canonical provider degraded/unreachable/auth-invalid must remain explicitly assigned unless an explicit operator authority action changes assignment.
- Unsupported runtime states must surface as degraded authority, not implicit fallback authority.

## Required Diagnostics / Reason Semantics
- Must emit machine-usable reason codes for:
- `unavailable`
- `authentication_not_ready` (or explicit equivalent auth-invalid reason)
- `capability_missing`
- `degraded_authority`
- Diagnostics must preserve distinction between assignment and runtime readiness.

## Test Enforcement References
- `electron/__tests__/storage/StorageAuthorityDoctrineGovernance.test.ts`
- `electron/__tests__/contracts/SeamContractGovernance.test.ts`
- `scripts/diagnostics/check-seam-governance.ts`

## Change Control Note
- Storage authority seam changes are strict-governed.
- Protected seam modifications require contract metadata/doc update or explicit justification through seam governance gate.
