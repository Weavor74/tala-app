# TALA Repo Agent Workflow

## Purpose

This file defines how AI coding agents and contributors must maintain code and documentation together in the TALA repository.

The goal is simple:

* code, documentation, and operational behavior must stay aligned
* architecture knowledge must live in the repo, not only in chat history
* any meaningful code change must either update documentation or explicitly justify why no documentation change was needed
* generated documentation must be concrete, implementation-aware, and tied to real files and flows

This document is intended for:

* GitHub Copilot coding agent
* Copilot Chat / agent mode
* future MCP-compatible coding agents
* human contributors working in the same repo discipline

---

## Core Policy

When changing code, the agent must also evaluate documentation impact.

Documentation impact includes changes to:

* behavior
* architecture
* interfaces
* data flow
* memory flow
* tool invocation
* logging
* telemetry
* configuration
* startup / boot flow
* UI routing
* mode handling
* operational constraints
* failure modes
* testing behavior
* deployment behavior

If any of those changed, the relevant documentation must be updated in the same task.

If none of those changed, the agent must state explicitly in its summary that no documentation changes were needed and why.

---

## Definition of Done

A code task is not complete until all of the following are true:

1. The code compiles or is syntactically valid for the files changed.
2. Any impacted tests are updated or the lack of tests is explicitly noted.
3. Any impacted documentation is updated.
4. The documentation reflects the final implementation, not the planned implementation.
5. The change summary lists:

   * files changed
   * docs changed
   * behavior impact
   * risks / follow-up items

---

## Documentation Quality Standard

Generated or updated documentation must:

* be specific to the real implementation
* name actual files, services, modules, routes, and data objects when known
* describe what changed and why it matters
* describe runtime behavior, not just static intent
* avoid vague filler language
* avoid marketing language
* avoid placeholder sections unless explicitly requested
* avoid saying a thing is complete if the implementation is partial
* distinguish current behavior from future planned behavior
* preserve historical context only if it helps future maintainers

Documentation must not:

* invent features not present in code
* claim end-to-end integration unless the integration is real
* describe planned architecture as though it already exists
* silently remove important operational caveats
* overwrite user-authored design intent unless the code clearly supersedes it

---

## Required Documentation Review Pass

For every non-trivial code change, the agent must perform this review:

### Step 1: Classify the change

Determine whether the change affects any of the following:

* feature behavior
* architecture / subsystem boundaries
* interfaces / contracts
* state or memory flow
* UI behavior
* logging / observability
* configuration / environment
* operational workflows
* error handling
* developer workflow

### Step 2: Map to docs

Determine which documentation files are impacted.

### Step 3: Update docs in the same task

Make the docs reflect the implemented reality.

### Step 4: Summarize doc impact

In the completion summary, state which docs were updated and why.

---

## Documentation Map For TALA

The agent must use this routing table when deciding which docs to update.

### 1. Architecture docs

Update when subsystem boundaries, responsibilities, orchestration, lifecycle, or major control flow changes.

**Likely locations**

* `docs/architecture/`
* `docs/architecture/component_model.md`
* `docs/architecture/system_overview.md`
* `docs/architecture/runtime_flow.md`

**Examples**

* AgentService responsibility changes
* Context assembly changes
* Router pipeline changes
* workspace/artifact routing changes
* new subsystem added
* backend/frontend bridge behavior changes

### 2. Interface docs

Update when function contracts, IPC, API routes, payload shapes, MCP tool contracts, or event formats change.

**Likely locations**

* `docs/interfaces/`
* `docs/interfaces/interface_matrix.md`
* `docs/interfaces/ipc_contracts.md`
* `docs/interfaces/mcp_tools.md`

**Examples**

* new IPC event
* changed tool input/output shape
* revised service contract
* renamed event or payload fields

### 3. Feature docs

Update when a user-visible feature changes behavior, scope, rules, or workflow.

**Likely locations**

* `docs/features/`
* `docs/features/system_features.md`
* `docs/features/<feature-name>.md`

**Examples**

* hybrid / assistant / RP mode behavior
* artifact-first output behavior
* reflection dashboard behavior
* logging panel behavior
* documentation intelligence behavior

### 4. Traceability docs

Update when requirements, implementation mapping, or test mapping changes.

**Likely locations**

* `docs/traceability/requirements_trace_matrix.md`
* `docs/traceability/test_trace_matrix.md`

**Examples**

* new requirement implemented
* requirement behavior materially changed
* new feature introduced that should be traced

### 5. Security / operational docs

Update when permissions, write controls, audit behavior, archive behavior, safety rules, or tool restrictions change.

**Likely locations**

* `docs/security/`
* `docs/operations/`
* `docs/runbooks/`

**Examples**

* archive behavior changed
* file write policy changed
* audit logging changed
* tool capability gating changed

### 6. Developer workflow docs

Update when build, boot, scripts, local setup, dependency requirements, or repo conventions change.

**Likely locations**

* `README.md`
* `docs/development/`
* `docs/setup/`

**Examples**

* changed startup sequence
* changed required services
* changed script names
* changed folder conventions

---

## TALA-Specific High-Priority Change Triggers

The following areas are considered high-impact. Any code change affecting them should almost always result in documentation review and usually documentation updates.

### Mode system

Includes:

* RP mode
* Assistant mode
* Hybrid mode
* mode selection UI
* mode routing logic
* mode persistence
* capability gating by mode

**Docs to review**

* feature docs for user-facing mode behavior
* architecture docs for router / context assembly
* interface docs if payloads or settings contracts changed

### Memory system

Includes:

* chat memory
* short-term memory
* long-term memory
* habit / reinforced behavior
* memory scoring
* retrieval ranking
* association expansion
* contradiction handling
* telemetry around memory actions

**Docs to review**

* architecture docs
* feature docs
* traceability docs
* operations docs if storage or sync behavior changed

### Astro / emotional modulation

Includes:

* emotional state retrieval
* bias modulation
* runtime prompt injection
* MCP integration for astro tools

**Docs to review**

* architecture docs
* interface docs
* feature docs

### Artifact-first workflow

Includes:

* artifact routing
* browser tab opening
* file editor opening
* raw content override
* tab deduplication
* diff viewer behavior

**Docs to review**

* feature docs
* architecture docs
* interface docs

### Logging / telemetry / reflection

Includes:

* audit logger
* reflection dashboard telemetry
* log viewer channels
* archive manifest generation
* event bridge wiring
* backend/frontend telemetry flow

**Docs to review**

* architecture docs
* operations docs
* feature docs

### MCP / tools / external integrations

Includes:

* tool registry
* capability gating
* tool invocation flow
* server contracts
* Open WebUI / MCP compatibility behavior

**Docs to review**

* interface docs
* architecture docs
* setup / development docs

---

## Agent Behavior Rules

When acting on a task, the agent must follow this sequence.

### Rule 1: Inspect impacted files first

Before editing docs, inspect the actual changed files and infer the real implementation behavior.

### Rule 2: Update the narrowest correct docs

Do not rewrite the entire docs tree if only one feature doc changed.

### Rule 3: Update summary docs when local docs materially change

If a feature-specific or interface-specific doc changes in a way that affects a higher-level summary doc, update the summary doc too.

Example:

* change `docs/features/mode_system.md`
* also update `docs/features/system_features.md` if the user-visible feature catalog changed

### Rule 4: Preserve intentional design notes

If a document contains intentional design direction or future planned work, preserve it unless it directly conflicts with current implementation. If it conflicts, separate the sections into:

* Current implementation
* Planned follow-up

### Rule 5: Prefer concrete implementation notes over generic summaries

Bad:

* "Improved routing behavior for better reliability."

Good:

* "Moved mode capability gating into `TalaContextRouter.process()` so the returned `TurnContext` becomes the single source of truth for blocked and allowed capabilities."

### Rule 6: Do not silently remove unresolved caveats

If the implementation still has a gap, document the gap.

### Rule 7: Documentation should match the final code after edits

Do not document intermediate refactor steps that are no longer true after the patch is complete.

---

## Required Completion Summary Format

For any substantial code task, the agent should end with a summary in this shape:

```md
## Change Summary

### Code Updated
- path/to/fileA.ts — reason
- path/to/fileB.ts — reason

### Documentation Updated
- docs/architecture/component_model.md — updated subsystem responsibility and runtime flow
- docs/features/mode_system.md — updated mode rules and UI behavior

### Behavior Impact
- what changed at runtime
- what users or developers will notice

### Risks / Follow-up
- remaining gap
- deferred item
- test still needed
```

If no documentation changes were needed:

```md
## Documentation Impact
No documentation files were changed.
Reason: the edit was limited to internal refactoring with no change to runtime behavior, interfaces, configuration, developer workflow, or observable feature behavior.
```

---

## Pull Request Policy

Every PR should satisfy one of these:

### Option A: Docs updated

The PR includes updated documentation.

### Option B: No docs needed, explicitly justified

The PR description includes a section:

```md
## Documentation Impact
No documentation changes required.
Reason: <specific reason>
```

This justification should be specific, not generic.

---

## Suggested PR Template Section

```md
## Documentation Impact
- [ ] Documentation updated
- [ ] No documentation changes required

### Docs Changed
- list files here

### Why
- explain what changed or why docs were not needed
```

---

## Suggested Copilot / Agent Instruction Block

Use the following as a repo instruction for coding agents:

```md
When making code changes in this repository:

1. Determine whether the change affects behavior, architecture, interfaces, memory flow, UI flow, logging, telemetry, configuration, or developer workflow.
2. If yes, update the relevant documentation in `docs/` during the same task.
3. Prefer updating the narrowest correct document, but also update any affected summary document.
4. Documentation must be implementation-aware and reference real files, services, flows, and constraints where possible.
5. Do not use vague summaries, placeholders, or aspirational language.
6. If no documentation update is needed, explicitly state why in the completion summary.
7. A task is not complete until code impact and documentation impact have both been reviewed.
```

---

## Suggested Review Checklist For Agents

Before finishing, the agent should check:

* Did I change user-visible behavior?
* Did I change any contract, payload, or interface?
* Did I change startup, configuration, or required services?
* Did I change subsystem responsibilities or control flow?
* Did I change logging, telemetry, archive, audit, or reflection behavior?
* Did I change mode logic, memory logic, or tool gating?
* Did I update the relevant docs?
* If not, did I explicitly justify why not?

---

## Optional File-Level Trigger Hints

These are practical mapping hints for automation or agent reasoning.

### If files under these paths change, review architecture docs

* `electron/services/**`
* `electron/core/**`
* `electron/router/**`
* `src/services/**`
* `src/core/**`

### If files under these paths change, review interface docs

* `electron/ipc/**`
* `electron/mcp/**`
* `src/types/**`
* `src/contracts/**`
* `src/shared/**`

### If files under these paths change, review feature docs

* `src/components/**`
* `src/features/**`
* `src/pages/**`
* `electron/features/**`

### If files under these paths change, review setup / workflow docs

* `package.json`
* `requirements.txt`
* `docker-compose.yml`
* `scripts/**`
* `README.md`

---

## Optional Commit / Task Prompt Examples

### Example 1

"Implement Hybrid mode selection in the UI and runtime router. Update all impacted docs."

### Example 2

"Refactor memory scoring to include salience and access_count. Update architecture and feature docs to match actual retrieval behavior."

### Example 3

"Fix reflection telemetry bridge between frontend and backend. Update operational and architecture docs with the real event flow."

### Example 4

"Add artifact tab deduplication using stable IDs. Update feature docs and architecture notes for workspace routing."

---

## Optional Future Automation

This repo can later add enforcement by:

* PR templates that require documentation impact disclosure
* CI checks that flag code-only changes in high-impact directories
* docs linting for required frontmatter or sections
* a documentation indexer that maps code areas to docs
* a repository audit script that suggests which docs should change based on touched files

That enforcement is optional, but the policy in this file should already guide human and agent behavior.

---

## Documentation Regeneration Rules

Documentation in this repository is generated from the live codebase.

**Maintenance Orchestrator Rules:**
- Tala is the primary maintenance executor for documentation, code hygiene, and derived memory artifacts.
- GitHub Actions is optional secondary enforcement, not the primary maintenance brain.
- If a change affects docs, contracts, subsystem mappings, or shared types, Tala should run self-maintenance locally (`npm run self:maintain --mode=apply-safe`).
- Protected memory must never be auto-rewritten.

When modifying manually:
- shared contracts
- subsystem structure
- Electron services
- MCP tools
- architecture mappings

Run:

```bash
npm run docs:regen
```

Generated files include:

- TDP_INDEX.md
- docs/architecture/*
- docs/contracts/*
- docs/subsystems/*

Do not manually edit generated documentation unless the generator scripts are updated accordingly.

If generated docs appear incorrect, fix the generator or the source contracts rather than editing generated files.

---

## Final Rule

For TALA, code and documentation are part of the same system.

If the implementation changed, the knowledge of the implementation must change with it.
