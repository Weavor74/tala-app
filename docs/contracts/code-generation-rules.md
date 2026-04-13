# Tala Code Generation Rules (Naming Contract Enforcement)

## Purpose

This document defines mandatory pre-write naming enforcement for all newly generated artifacts in Tala.

It applies to:

- Tala self-modification workflows
- Codex-assisted development workflows
- admin-assisted and manual generation scripts

The source of truth is `docs/contracts/naming.contract.json`.

## Mandatory Generation Flow

No new artifact may be written before this sequence completes:

1. Classify artifact (`subsystem`, `layer`, `role`, `mutability`, `exposure`, `artifactKind`)
2. Choose naming role/suffix from approved contract suffixes
3. Generate or propose artifact name
4. Validate proposed name against naming contract
5. Only write code/file when validation returns valid

If classification or naming validation fails, generation must stop.

## Classification Contract

Classification is required for all new artifacts.

Required dimensions:

- `subsystem`: e.g. `memory`, `inference`, `reflection`, `telemetry`, `ipc`, `tools`, `workflow`, `path`
- `layer`: architecture/role layer (e.g. `service`, `repository`, `provider`, `validator`, `policy`, `scheduler`)
- `role`: focused purpose (`repair-execution`, `provider-selection`, `event-routing`)
- `mutability`: `read`, `write`, `transform`, `validate`, `execute`, `schedule`, `route`, `register`
- `exposure`: `internal`, `ipc`, `api`, `external`, `contract_facing`
- `artifactKind`: `class`, `function`, `event`, `ipc`, `api-route`, `tool`, `workflow`, `automation`, `file`, `module`, `variable`

CLI:

```bash
npx tsx tools/doclock/classify-artifact.ts \
  --subsystem memory \
  --layer service \
  --role repair-execution \
  --mutability execute \
  --exposure internal \
  --artifact-kind class
```

## Naming Decision Tree

### Step 1: Pick role suffix for class/module artifacts

Use approved suffixes only:

- `Service`, `Repository`, `Provider`, `Resolver`, `Registry`, `Validator`, `Policy`, `Coordinator`, `Orchestrator`, `Scheduler`, `Adapter`, `Gateway`, `Client`, `Router`, `Bus`, `Store`, `Schema`, `Contract`

### Step 2: Pick verb for function artifacts

Verb-first is required. Preferred verbs by operation type:

- read: `get`, `list`, `find`, `read`, `fetch`, `resolve`, `load`, `select`
- write: `set`, `update`, `write`, `save`, `create`, `upsert`, `delete`, `remove`, `emit`
- transform: `map`, `build`, `compose`, `normalize`, `convert`, `project`, `derive`
- validate: `validate`, `assert`, `check`, `verify`
- execute/schedule/route: `execute`, `run`, `apply`, `dispatch`, `invoke`, `schedule`, `enqueue`, `route`, `register`

### Step 3: Encode subsystem and intent

Names must expose subsystem + role intent clearly.

Examples:

- class/module: `MemoryRepairSchedulerService`, `InferenceProviderResolver`
- function: `validatePortableRootPath`, `resolveProviderSelection`
- event: `execution.created`
- IPC: `reflection:listProposals`

## Rejection Rules

Reject artifact names when any of these are true:

- banned vague names or terms (`Helper`, `Manager`, `Utils`, `Thing`, `Temp`, `Obj`, etc.)
- banned function names (`processData`, `handleStuff`, `doThing`)
- function not verb-first when required
- class/module suffix mismatch with role/layer
- event name fails event regex or is command-form
- IPC channel fails pattern
- API route fails pattern
- tool/workflow/automation name fails pattern

## Good Vs Bad Examples

GOOD:

- `MemoryRepairSchedulerService`
- `InferenceProviderResolver`
- `validatePortableRootPath`
- `execution.created`

BAD:

- `Helper`
- `Manager`
- `processData`
- `doThing`

## Tala Self-Modification Instructions

Tala self-modification must obey all of the following:

- NEVER create unnamed or ambiguously named artifacts
- ALWAYS infer subsystem + role before naming
- ALWAYS run naming validation before writing files
- NEVER bypass `tools/doclock/validate-artifact-name.ts` or shared pre-write guards

## Integration Hooks

Use the shared guard module in generation workflows:

- `tools/doclock/shared/generation-guard.ts`

Programmatic usage:

```ts
import { validateArtifactPreWriteOrThrow } from '../../tools/doclock/shared/generation-guard';

validateArtifactPreWriteOrThrow({
  classification: {
    subsystem: 'memory',
    layer: 'service',
    role: 'repair-execution',
    mutability: 'execute',
    exposure: 'internal',
    artifactKind: 'class'
  },
  name: 'MemoryRepairExecutionService'
});
```

If this throws, do not write the artifact.

## CLI Interfaces

Validate proposed name:

```bash
npx tsx tools/doclock/validate-artifact-name.ts \
  --name MemoryRepairExecutionService \
  --subsystem memory \
  --layer service \
  --role repair-execution \
  --mutability execute \
  --exposure internal \
  --artifact-kind class
```

Suggest compliant name:

```bash
npx tsx tools/doclock/suggest-name.ts \
  --subsystem reflection \
  --layer scheduler \
  --role health-check \
  --mutability schedule \
  --exposure internal \
  --artifact-kind class
```

## Relation To Run 2 Validator

Generation-prevention tooling and repository-drift validator both load:

- `docs/contracts/naming.contract.json`

Rule IDs and patterns are shared and must remain aligned.

## Enforcement Intent

This system prevents:

- semantic sprawl
- duplicate ambiguous systems
- vague glue code
- untraceable automation artifacts
- unsafe self-generated scripts

Names are required to encode intent, responsibility, and boundary.
