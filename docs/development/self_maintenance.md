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
- **Autoheal**: Yes. Run `npm run docs:selfheal` to trigger `apply-safe`.

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
