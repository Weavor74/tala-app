# Tala Self-Maintenance Orchestrator

Tala is equipped with a local-first **Self-Maintenance Orchestrator** to assert control over documentation, code hygiene, and memory graph cleanliness without relying purely on cloud CI checks (e.g., GitHub Actions). 

This approach positions Tala as the primary maintenance intelligence, running deterministic, local sweeps that automatically align derived artifacts.

## Execution Modes
The orchestrator operates in three descending modes of caution:
1. **`audit`**: Validates integrity only. Reports discrepancies but takes no action.
2. **`propose`**: Audits and generates specific proposals for automatic fixes (currently limited in the code hygiene lane).
3. **`apply-safe`**: Executes safe, deterministic auto-repairs, such as regenerating documentation indices or flushing derived memory summaries.

## Maintenance Lanes

### 1. Documentation Lane (`--docs-only`)
**Responsibilities**: Rebuild architecture docs, extract service contracts, regenerate the TDP Index, and validate for drift.
- **Allowed Actions**: `apply-safe` (fully recreates `docs/*`), `audit` (verifies drift).
- **Autoheal**: Yes. Use `npm run docs:heal-and-validate` as the canonical enforcement command. `npm run docs:selfheal` remains a compatibility alias that runs `docs:regen` first, then `docs:heal-and-validate`.

### 2. Code Hygiene Lane (`--code-only`)
**Responsibilities**: Ensure repo structural integrity and subsystem boundaries are maintained.
- **Allowed Actions**: `audit`, `propose`, `apply-safe` (narrow autofixes only).
- **Autoheal Boundaries**: Autonomous codebase refactoring is **expressly forbidden**. Safe fixes are restricted to: 
  - Syncing known import path registries.
  - Normalizing barrel exports.
  - Repairing statically declared shared contract paths.

### 3. Memory Lane (`--memory-only`)
**Responsibilities**: Audit derived memory graph nodes, rebuild relational summaries, refresh secondary indices.
- **Allowed Actions**: `audit`, `apply-safe`.
- **Protected Memory Rules**: Tala strictly **cannot** auto-rewrite the following core truth domains under *any* automatic circumstance:
  - `long_term_memory`
  - `explicit_user_facts`
  - `identity_rules`
  - `canonical_preferences`

## Local Usage Examples

### Full Sweep (Check Only)
```powershell
npm run self:maintain --mode=audit
```

### Heal Documentation Only
```powershell
npm run self:maintain --mode=apply-safe --docs-only
```

### Propose Code Fixes without Applying
```powershell
npm run self:maintain --mode=propose --code-only
```

## Watch Mode
For continuous local development, especially when rapidly iterating on shared contracts or services, you can run the maintenance orchestrator in watch mode:

```powershell
npm run self:watch
```

**Watch Behavior**: 
- Utilizes `chokidar` with a built-in debounce (1500ms).
- Explicitly ignores output directories (`docs/**`, `dist/**`) to prevent infinite looping when `docs_maintenance` rewrites the documentation payload.
- Injects `--mode=apply-safe` on triggered file events (e.g., changes to `electron/**`, `src/**`, or `memory/**`).

## Documentation Enforcement Lifecycle

### What this means
Documentation is part of the product, not a post-task cleanup step. For qualifying code changes, the task is only complete when code and docs agree.

### What to run
Run this command before finishing qualifying work:

```powershell
npm run docs:heal-and-validate
```

### What the workflow does
- `docs:scan-impact` maps changed files to owned docs.
- `docs:heal` refreshes deterministic doc outputs (including generated sections and bounded updates).
- `docs:validate` checks for remaining drift (`docs:verify`, naming contract, and doclock validation).

### Types of docs
- Generated docs: regenerate deterministically; do not freeform rewrite generated content.
- Hybrid docs: keep bounded generated blocks up to date using the existing markers.
- Manual docs: when safe deterministic generation is not appropriate, use a bounded `REVIEW_REQUIRED` section instead of speculative prose.

### What CI checks
- CI reruns healing and fails if healing introduces uncommitted diffs that were not included.
- CI then runs documentation validation and naming/doclock gates.

### Definition of done
A qualifying task is not done until `npm run docs:heal-and-validate` passes and no unresolved `REVIEW_REQUIRED` checklist items remain.
