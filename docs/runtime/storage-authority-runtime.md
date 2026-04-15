# Storage Authority Runtime

## Purpose
This document describes the implemented storage authority runtime model used by Tala settings, diagnostics, and storage services.

## Canonical Vocabulary
- Storage Registry: authoritative configuration model
- Provider: storage backend definition
- Role: assigned responsibility
- Canonical: source-of-truth authority class
- Derived: non-authoritative projection/retrieval class
- Bootstrap: one-time legacy import
- Hydration: registry population from explicit/detected/bootstrap sources
- Validation: layered checks with typed outcomes
- Recovery: deterministic repair path with explicit operator actions

## Runtime Model
- Storage Registry snapshot is loaded from settings and normalized.
- Providers are authoritative records for connection/auth/health/capabilities.
- Roles are explicit assignments to Provider IDs.
- Canonical authority is represented by the Provider assigned to `canonical_memory`.
- Derived Providers are all non-canonical Providers.

## Canonical Runtime Note
- Postgres is canonical runtime when configured/assigned and healthy.
- If canonical Provider becomes degraded/unreachable/unauthorized, assignment is preserved and authority is marked degraded.
- No silent reassignment is performed.

## Assignment Policy (Deterministic)
Precedence:
1. explicit registry assignment wins
2. explicit Providers override bootstrap inputs
3. bootstrap fills missing Role gaps only
4. bootstrap never overwrites explicit assignments
5. capability mismatch blocks assignment
6. policy conflict blocks assignment
7. canonical conflicts are surfaced, not auto-resolved

Stable reason codes:
- `explicit_assignment_preserved`
- `filled_missing_role_from_bootstrap`
- `blocked_capability_mismatch`
- `blocked_auth_invalid`
- `blocked_policy_conflict`
- `blocked_canonical_conflict`
- `provider_unreachable`
- `provider_not_registered`
- `legacy_import_skipped_existing_registry`
- `recovery_suggestion_only`

## Validation (Layered)
Validation dimensions:
- `config_schema`
- `authentication`
- `reachability`
- `capability_compatibility`
- `role_eligibility`
- `policy_compliance`
- `authority_conflicts`
- `bootstrap_migration_consistency`
- `recoverability`

Each dimension reports:
- status: `pass` / `warn` / `fail`
- reason code
- optional remediation hint

Classification flags:
- valid but not eligible
- reachable but unauthorized
- configured but policy blocked
- canonical conflict state

## Bootstrap and Migration Behavior
- First-run legacy input produces deterministic Provider IDs and hydrates Storage Registry.
- Bootstrap fills missing Role gaps only.
- Invalid legacy entries are imported as blocked Providers and are not assigned.
- Bootstrap is idempotent and records completion/outcome/run count.
- Post-bootstrap, legacy config does not silently override Storage Registry.
- Re-import is explicit only (`storage:reimportLegacy`).

## Recovery and Troubleshooting
When authority is degraded/conflicted:
1. Inspect Storage Authority Summary and assignment decision log.
2. Run Provider Validation and inspect failed dimensions.
3. For auth failures, update credentials from Settings Authentication panel and revalidate.
4. For capability mismatch, explicitly reassign Role or fix Provider capability.
5. For canonical conflict, resolve explicit assignments manually.
