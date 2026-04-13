# Tala Naming Conventions (Locked Architecture Contract)

## 1. Purpose And Scope

This document defines mandatory naming laws for Tala code and artifacts. It is an architectural contract, not style guidance.

Scope includes:

- source files and modules
- classes, interfaces, types, and schemas
- functions and methods
- variables and properties
- events, IPC channels, and API routes
- tools, workflows, automation artifacts, and generated contracts

Out of scope:

- formatter preferences
- whitespace, import ordering, and lint-only conventions not tied to identity

## 2. Why Naming Is A Safety And Self-Modification Boundary

In Tala, names are machine-consumable identity markers. A name must be sufficient for humans, admins, Codex, and Tala self-maintenance to infer likely behavior before execution.

Naming quality directly supports:

- self-correction: drift detection can compare role names against actual behavior
- self-modification: generated code can select safe insertion points by role
- auditability: admins can read logs/artifacts and infer mutation and exposure risk
- API and automation readiness: contracts can be generated from predictable naming
- architectural clarity: boundaries are visible without opening every file

A vague name is treated as an architecture risk.

## 3. Artifact Identity Model

Every artifact name must encode at least these dimensions:

- `subsystem`: memory, reflection, inference, telemetry, governance, execution, ipc, tools, path, workflow, autonomy
- `layer`: ui, application, domain, infrastructure, integration, contract
- `role`: service type such as `Service`, `Repository`, `Router`, `Validator`
- `mutability`: read-only evaluator vs write-capable actor (implied by role and verb)
- `exposure`: `internal`, `edge` (IPC/API/tool boundary), or `contract-facing`

Canonical identity expression:

`<Subsystem><Capability><Role>` for type/module names, with file path providing layer context.

Examples:

- `MemoryAuthorityService` -> memory subsystem, application/domain layer service, write-governing
- `TelemetryBus` -> telemetry subsystem, signaling role, cross-boundary event carrier
- `PathResolver` -> path subsystem, deterministic read/resolve role
- `runtimeEventTypes` -> contract-facing shared schema surface

## 4. File Naming Conventions

### 4.1 TypeScript and TSX

- Classes and primary role modules: `PascalCase.ts` or `PascalCase.tsx`
- Multi-export type-only contract modules: `camelCaseTypes.ts` or `<domain>Types.ts`
- Avoid generic file buckets.

Required examples:

- `MemoryRepairExecutionService.ts`
- `ReflectionScheduler.ts`
- `ProviderSelectionService.ts`
- `runtimeEventTypes.ts`

Prohibited examples:

- `utils.ts`
- `helpers.ts`
- `common.ts`
- `misc.ts`

### 4.2 Scripts

- Use `kebab-case` with explicit action nouns.
- Pattern: `<domain>-<action>.{ts,js,py,sh,ps1}`.

Examples:

- `docs-regen.ts`
- `memory-repair-scan.py`
- `workflow-rebuild-index.ps1`

### 4.3 Tests

- Unit/integration: `<artifact>.test.ts`
- Behavior/regression: `<artifact>.spec.ts`
- Avoid `test1.ts`, `tmp-test.ts`.

### 4.4 Contracts, Schemas, Config

- JSON Schema: `<domain>.<entity>.schema.json`
- Contract: `<domain>.<entity>.contract.json`
- Config: `<domain>.<scope>.config.json`

Examples:

- `naming.contract.json`
- `memory.record.schema.json`
- `telemetry.pipeline.config.json`

### 4.5 Docs

- Architecture and operational docs: `kebab-case.md`
- Contracts index docs may mirror code contract name.

Examples:

- `naming-conventions.md`
- `ipc_interface_control.md` (legacy retained)

## 5. Class, Type, And Module Suffix Contract

Every role suffix below is mandatory-semantic, not decorative.

### `Service`

- Responsibility: application-level operation boundary coordinating one capability
- Usually allowed: orchestrate reads/writes via repositories/providers, enforce policy gates, emit telemetry
- Usually NOT allowed: direct UI rendering logic, unconstrained cross-subsystem mutation

### `Repository`

- Responsibility: persistence access and query abstraction
- Usually allowed: CRUD, filtering, pagination, persistence translation
- Usually NOT allowed: business orchestration, policy decisions, external side effects beyond persistence

### `Provider`

- Responsibility: implementation source for a capability (local/remote/embedded)
- Usually allowed: adapter-like calls to an engine or backend
- Usually NOT allowed: top-level workflow coordination or policy ownership

### `Resolver`

- Responsibility: deterministic selection or lookup result from known inputs
- Usually allowed: map/choose/resolve
- Usually NOT allowed: mutate durable state as primary effect

### `Registry`

- Responsibility: authoritative in-memory index of known items and metadata
- Usually allowed: register/list/get/contains operations, deterministic lookup
- Usually NOT allowed: execute workflows or perform broad orchestration

### `Validator`

- Responsibility: validate shape, invariants, policy preconditions
- Usually allowed: reject/accept with diagnostics
- Usually NOT allowed: write durable state or execute side effects

### `Policy`

- Responsibility: codified decision rules for allow/deny/priority
- Usually allowed: pure or bounded policy evaluation
- Usually NOT allowed: direct execution, persistence writes

### `Coordinator`

- Responsibility: coordinate multiple collaborators within a bounded flow
- Usually allowed: ordered calls across services with explicit boundaries
- Usually NOT allowed: become long-lived process scheduler or global singleton state owner

### `Orchestrator`

- Responsibility: multi-stage runtime lifecycle across subsystems
- Usually allowed: stage transitions, bounded retries, lifecycle telemetry
- Usually NOT allowed: collapse subsystem boundaries into monolithic logic

### `Scheduler`

- Responsibility: determine when work runs and with what cadence/queue policy
- Usually allowed: enqueue/dequeue/tick cadence control
- Usually NOT allowed: business decision ownership for work payload semantics

### `Adapter`

- Responsibility: translate one interface/protocol/model into another
- Usually allowed: data mapping and protocol translation
- Usually NOT allowed: policy authority or durable state strategy

### `Gateway`

- Responsibility: guarded edge boundary to external or privileged capability
- Usually allowed: boundary checks, auth/allowlist, transport invocation
- Usually NOT allowed: deep domain orchestration or UI policy

### `Client`

- Responsibility: typed caller for remote/network/API system
- Usually allowed: request/response marshalling, retries/timeouts
- Usually NOT allowed: persistence authority or orchestration ownership

### `Router`

- Responsibility: deterministic routing of requests/events/output channels
- Usually allowed: classify-and-route decisions
- Usually NOT allowed: heavy business logic execution or persistence workflows

### `Bus`

- Responsibility: event transport abstraction
- Usually allowed: publish/subscribe and delivery metadata
- Usually NOT allowed: policy interpretation or business mutation

### `Store`

- Responsibility: state holder with explicit read/write API and lifecycle semantics
- Usually allowed: set/get/snapshot state transitions
- Usually NOT allowed: remote I/O orchestration as primary role

### `Schema`

- Responsibility: structural data model and validation shape
- Usually allowed: fields, constraints, type definitions
- Usually NOT allowed: runtime behavior execution

### `Contract`

- Responsibility: boundary agreement for payloads, channels, or artifacts
- Usually allowed: canonical interface/rule declaration
- Usually NOT allowed: runtime branching logic

## 6. Function Naming Conventions

### 6.1 Mandatory Rules

- Functions must be verb-first.
- Verb must reveal operation category.
- Name must communicate side-effect profile where possible.

### 6.2 Preferred Verbs By Operation Type

Read:

- `get`, `list`, `find`, `read`, `fetch`, `resolve`, `load`, `select`

Write:

- `set`, `update`, `write`, `save`, `create`, `upsert`, `delete`, `remove`, `emit`

Transform:

- `map`, `build`, `compose`, `normalize`, `convert`, `project`, `derive`

Validate:

- `validate`, `assert`, `check`, `verify`

Execute:

- `execute`, `run`, `apply`, `dispatch`, `invoke`

Schedule:

- `schedule`, `enqueue`, `dequeue`, `tick`, `reschedule`

Route/registration/signaling:

- `route`, `register`, `unregister`, `publish`, `subscribe`

### 6.3 Restricted Vague Verbs

`handle`, `process`, `manage`, and `do` are restricted.

Allowed only when:

- the surrounding type already encodes strict context, and
- a specific verb is semantically incorrect.

Disallowed examples:

- `processData()`
- `handleStuff()`
- `doThing()`

Preferred replacements:

- `normalizeTelemetryPayload()`
- `routeArtifactOutput()`
- `executeRepairCampaign()`

## 7. Variable And Property Naming Conventions

Mandatory suffix rules:

- identifiers end with `Id` (example: `executionId`, `proposalId`)
- timestamps end with `At` (example: `startedAt`, `updatedAt`)
- durations end with `Ms` (example: `durationMs`, `timeoutMs`)
- file-system locations end with `Path` (example: `portableRootPath`)
- URLs end with `Url` (example: `providerBaseUrl`)
- payload objects end with `Payload` (example: `telemetryPayload`)
- runtime configuration objects end with `Config` (example: `memoryConfig`)
- schema descriptors end with `Schema` (example: `proposalSchema`)

Collection readability rules:

- maps include `By<Key>` or `Map` (example: `proposalById`, `policyBySubsystem`)
- sets include `Set` (example: `allowedToolSet`)
- arrays use plural noun (example: `campaigns`, `repairActions`)

## 8. Event Naming Conventions

Canonical format (dot-separated):

`<subsystem>.<entity_or_flow>.<past_tense_outcome>`

Rules:

- event names describe something that happened, not a command
- use lower-case tokens separated by dots
- prefer past-tense terminal token (`created`, `accepted`, `failed`, `completed`, `updated`)

Good examples:

- `execution.created`
- `execution.completed`
- `memory.repair_triggered`
- `a2ui.surface_opened`
- `telemetry.flush_failed`

Bad examples:

- `do.execution`
- `runReflection`
- `memoryRepairNow`

## 9. IPC Channel Naming Conventions

Canonical format:

`<subsystem>:<actionVerbNoun>`

Rules:

- one namespace prefix per subsystem (`reflection`, `autonomy`, `governance`, `execution`, `selfModel`)
- action token is camelCase and verb-first
- channels represent requests/responses, not historical outcomes

Good examples (existing Tala style):

- `reflection:listProposals`
- `autonomy:getDashboardState`
- `execution:startRun`
- `governance:approve`

Bad examples:

- `reflection:stuff`
- `do:thing`
- `randomChannel`

## 10. API Route Naming Conventions

Canonical format:

- path segments are lower-case kebab-case
- use resource nouns in paths
- express action via HTTP method first; only use action subpaths when command semantics are unavoidable

Examples:

- `GET /api/v1/memory/records`
- `POST /api/v1/reflection/proposals/{proposalId}/approve`
- `POST /api/v1/execution/runs`

Avoid:

- `/api/doThing`
- `/api/misc/data`

## 11. Schema, Contract, And Config Naming

- Type-level names: suffix with `Schema` or `Contract`
- File names: include `.schema.json` or `.contract.json`
- contract identifiers should include version fields (`version`) and scope labels (`scope`)

Examples:

- `NamingContractSchema`
- `TelemetryEventContract`
- `naming.contract.json`

## 12. Tool, Workflow, And Automation Naming

### Tool Names

Canonical format:

`<subsystem>_<verb>_<target>` in `snake_case`

Examples:

- `memory_search_records`
- `reflection_list_proposals`
- `path_resolve_portable_root`

### Workflow Names

Canonical format:

`<domain>_<intent>` in `snake_case`

Examples:

- `repo_audit`
- `docs_selfheal`
- `memory_repair_cycle`

### Automation Artifact Names

Canonical format:

`<domain>-<cadence>-<intent>` in `kebab-case`

Examples:

- `reflection-daily-health-check`
- `memory-hourly-repair-scan`

## 13. Banned Vague Names And Anti-Patterns

Banned as primary artifact names unless explicitly whitelisted with justification:

- `Helper`
- `Manager`
- `Utils`
- `Util`
- `Misc`
- `Common`
- `Thing`
- `Stuff`
- `Data`
- `Temp`
- `Obj`

Banned function names:

- `processData`
- `handleStuff`
- `doThing`

Additional discouraged terms:

- `generic`
- `base` (without domain qualifier)
- `newData`
- `oldData`

## 14. Good Vs Bad Examples

### Services and boundaries

Good:

- `MemoryAuthorityService`
- `ReflectionScheduler`
- `TelemetryBus`
- `TalaContextRouter`

Bad:

- `MemoryManager`
- `ReflectionHelper`
- `TelemetryUtils`

### Functions

Good:

- `resolveProviderSelection()`
- `validateExecutionRequest()`
- `scheduleRepairTick()`
- `routeArtifactOutput()`

Bad:

- `processData()`
- `handleEverything()`
- `manageStuff()`

### Variables

Good:

- `executionId`
- `startedAt`
- `timeoutMs`
- `portableRootPath`
- `proposalPayload`

Bad:

- `id`
- `time`
- `timeout`
- `pathValue`
- `obj`

## 15. CI And Validator Expectations (Rules Level)

A future naming validator must enforce at least:

- banned term detection in file/type/function names
- required suffix-to-responsibility checks for role classes/modules
- function verb category enforcement with restricted vague verbs
- variable suffix enforcement (`Id`, `At`, `Ms`, `Path`, `Url`, `Payload`, `Config`, `Schema`)
- event format and tense checks
- IPC channel format checks
- API route format checks
- contract/schema filename checks

Severity model:

- `error`: violates locked contract, blocks merge
- `warn`: legacy tolerated but must not expand
- `info`: migration suggestion for non-critical legacy names

## 16. Tala And Codex Self-Generation Guidance

Before generating any new artifact, Tala/Codex must:

1. classify artifact identity (`subsystem`, `layer`, `role`, `mutability`, `exposure`)
2. choose an approved role/suffix from this contract
3. choose a verb-first operation name from approved verb categories
4. reject vague/banned names before writing files
5. ensure the final name reveals boundary intent and likely connection point
6. emit contract-compliant file names for schemas/contracts/automation metadata

Generation gate rule:

- if no compliant name can be produced, generation must fail with a naming error instead of creating a vague artifact.

## 17. Locked Contract Status

This document is a locked architecture contract. Deviations require explicit contract update in `docs/contracts/naming.contract.json` and accompanying architecture review.
