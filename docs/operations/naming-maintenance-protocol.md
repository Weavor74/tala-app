# Tala Naming Maintenance Protocol (Post-Rollout)

## 1. Purpose
This protocol defines mandatory post-rollout operation of Tala naming governance. It converts naming from migration work to ongoing maintenance law.

## 2. Scope
This protocol applies to all repository artifacts governed by [naming.contract.json](/D:/src/client1/tala-app/docs/contracts/naming.contract.json), including code, events, IPC channels, API routes, contracts, schemas, tools, workflows, and automation artifacts.

## 3. Maintenance Mode Definition
Naming governance is in maintenance mode:
- No broad naming passes.
- No mass cosmetic renames.
- Enforcement plus opportunistic cleanup only.
- Cleanup is performed when touching files for real work.

## 4. Core Maintenance Rules
- No new naming drift is allowed.
- Touched-file cleanup is required when safe and local.
- Exceptions are debt tracking, not policy.
- Stale exceptions must be removed immediately.
- Architectural clarity by name overrides convenience naming.

## 5. PR Review Policy
Reviewers must verify:
- New/changed names satisfy the naming contract.
- Touched boundary files do not introduce vague or ambiguous naming.
- `docs/contracts/naming.exceptions.json` does not grow silently.
- Any baseline expansion includes explicit justification and reviewer acknowledgment.

Touched-file cleanup policy:
- If a touched file has obvious, low-risk naming debt, clean it in the same PR.
- If cleanup is risky, document deferment explicitly in PR notes.

Baseline policy:
- Baseline edits are allowed only for explicit debt accounting.
- Mass baseline refresh is forbidden.

## 6. Release Policy
Before release:
- Run `npm run docs:validate:naming`.
- Run `npm run docs:gatekeeper:naming`.
- Confirm `NEW=0` and `STALE=0`.
- If generated artifacts are part of the release, validate generated naming before artifact write and before merge.

## 6A. Documentation Enforcement Lifecycle (Plain Language)
- Treat documentation drift as a repository failure, not a suggestion.
- Regenerate deterministic docs with `npm run docs:regen` when code-backed docs (architecture/contracts/indexes) need refresh.
- Run `npm run docs:heal` to update deterministic doclock impact blocks.
- Run `npm run docs:heal-and-validate` before merge for qualifying changes. This is the canonical completion gate.
- `docs:heal-and-validate` enforces:
  - drift validation (`docs:verify`)
  - naming contract validation (`docs:validate:naming`)
  - doclock validation (`docs:validate:doclock`)
- `docs-lock` CI reruns healing and fails if healed output is not committed, then reruns validation and naming gatekeeper checks.
- `docs:selfheal` is a compatibility alias for operational workflows; it runs `docs:regen` and then `docs:heal-and-validate`.
- Do not merge when `docs/review/doclock-impact.md` or other generated doc outputs still differ from the enforced command results.

## 7. Exception Burn-Down Model
Exception classes:
- High priority:
  - memory authority
  - IPC/API boundaries
  - telemetry events
  - workflow/tool execution
  - reflection/self-improvement
  - inference/provider resolution
  - path/portable-root enforcement
- Medium priority:
  - subsystem integration surfaces not externally exposed
- Low priority:
  - isolated legacy internal files with low blast radius

Burn-down rule:
- Prioritize high-risk boundary exceptions first.
- Remove exceptions immediately when violations are fixed.

## 8. Recurring Maintenance Cadence
- Weekly:
  - review changed-file naming drift and stale exceptions from active PRs
- Monthly:
  - review exception concentration in critical subsystems and schedule targeted cleanup tickets
- Quarterly:
  - review naming contract fit, exception trend, and Gatekeeper policy outcomes

## 9. Canonical Examples Policy
- Canonical examples are stable reference models, not churn targets.
- Update examples only when:
  - architectural boundary naming evolves intentionally, or
  - examples no longer reflect real production naming patterns.
- Do not update canonical examples for cosmetic preference.

## 10. Operational Guidance for Tala/Codex/Admin Workflows
- On artifact creation:
  - classify artifact
  - generate/choose name
  - validate name
  - reject invalid names before writing code
- On artifact modification:
  - validate changed names
  - apply touched-area cleanup when safe
  - keep exceptions explicit and minimal
- On PR completion:
  - no new drift
  - no stale exceptions
  - baseline growth explicitly governed

## Enforcement Reference
- Contract: [naming.contract.json](/D:/src/client1/tala-app/docs/contracts/naming.contract.json)
- Baseline: [naming.exceptions.json](/D:/src/client1/tala-app/docs/contracts/naming.exceptions.json)
- Canonical examples: [naming.canonical-examples.json](/D:/src/client1/tala-app/docs/contracts/naming.canonical-examples.json)
- Gatekeeper pass: `npm run docs:gatekeeper:naming`
