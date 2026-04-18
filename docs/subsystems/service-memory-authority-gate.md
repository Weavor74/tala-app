# Service: MemoryAuthorityGate

## Purpose
- Enforces runtime memory write eligibility for turn-originated flows.
- Validates `MemoryWriteRequest` against kernel-propagated `MemoryAuthorityContext`.
- Emits deterministic telemetry for allow/deny decisions.

## Authority Boundary
- `AgentKernel` is the only source of turn mode and `memoryWriteMode`.
- `MemoryAuthorityGate` enforces that downstream writers cannot upgrade memory authority.
- Canonical truth persistence remains owned by `MemoryAuthorityService`/Postgres.

## Inputs
- `MemoryWriteRequest`
- `MemoryAuthorityContext`

## Outputs
- `MemoryAuthorityDecision`
- Throws `MemoryAuthorityViolationError` on `assertAllowed(...)` deny path.

## Key Rules
- `conversation_only`: conversation categories only.
- `episodic`: conversation + episodic categories.
- `goal_episode`: all supported categories, with durable/goal linkage checks.
- Durable categories require full durable-state authority.
- Goal-linked categories require goal linkage.
- System writes require explicit `systemAuthority` and cannot include turn context.

## Telemetry
- `memory.authority_check_requested`
- `memory.authority_check_allowed`
- `memory.authority_check_denied`
- `memory.write_allowed`
- `memory.write_blocked`
