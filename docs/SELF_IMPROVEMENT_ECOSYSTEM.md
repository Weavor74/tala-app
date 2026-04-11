# Tala Self-Improvement & Reflection Ecosystem

This document describes the architecture of the Tala Self-Improvement Ecosystem defined within `electron/services/reflection/`. It establishes an autonomous, safe, and verifiable loop allowing Tala to self-monitor, propose patches, validate code changes, and securely integrate them.

## 1. Capabilities and Mode Isolation
The `CapabilityGating` layer securely bridges user personas (Assistant, Hybrid) against Engineering tools.
- `Assistant`: Minimal diagnostic probing.
- `Hybrid`: Expanded diagnostic probing, allowed to write tests & docs.
- `Engineering`: Core system capability providing the ability to read all source code, write candidate patches, validate them in staging, and propose promotions.

## 2. Immutable Identity and Protected Files
Tala protects her core routines by evaluating every file write against two internal registries:
1. `ImmutableIdentityRegistry`: Files like mode states, settings overrides, and self-checks cannot be overwritten via auto-promotions.
2. `ProtectedFileRegistry`: Categorizes code (routing, prompts, tool bounds) requiring explicit validation checks (e.g., `tests`, `smoke`) before code is injected live.

## 3. The 6-Phase Engineering Pipeline
`ReflectionService.ts` replaces the prior prototypal logic and acts as the orchestrator of all phases:

### Phase 1: OBSERVE (`SelfImprovementService`)
Listens to `LogInspectionService` error logs and heartbeat triggers to construct an initial `ReflectionIssue`.
### Phase 2: REFLECT (`ReflectionEngine`)
Formulates root cause hypotheses based on Codebase and Audit context.
### Phase 3: PATCH (`PatchStagingService`)
Creates isolated subdirectories mapping intended file changes without ever altering live files. Creates diffs.
### Phase 4: VALIDATE (`ValidationService`)
Syntactical checks (`tsc`, `lint`, and test suites) executed securely via `SafeCommandService`.
### Phase 5: PROMOTE (`PromotionService`)
Before rewriting live, copies original files into `data/archives/pre_patch/` alongside a generated rollback manifest.
### Phase 6: JOURNAL (`ReflectionJournalService`)
All major status changes append highly structured `jsonl` entries ensuring all algorithmic reasoning leading to a self-edit remains auditable.

## 4. Reversal and Safety
Any change promoted via this ecosystem generates an Archive Manifest. The `RollbackService` consumes these manifests to revert live states securely without relying on external Git workflows.

## 5. Reflection Trace Observability (Debug)
For local verification, the reflection path now emits structured stage logs from the live orchestration path in `electron/services/reflection/ReflectionService.ts`:
- Prefix: `[ReflectionTrace]`
- Core fields: `runId`, `stage`, `timestamp`, plus stage-specific counts/reasons/errors
- Stages include: `trigger_received`, `preconditions_check`, `candidate_collection`, `candidate_screening`, `reflection_context_build`, `proposal_generation`, `proposal_validation`, `proposal_persistence`, `proposal_promotion`, `ready_state`, `cycle_complete`, `cycle_abort`, `cycle_error`

Scheduler decisions are also explicit in `electron/services/reflection/ReflectionScheduler.ts`:
- Prefix: `[ReflectionScheduler] tick`
- Includes whether a tick launched work or stayed idle and why (`reason`)

## 5.1 Candidate Quality: Clustering + Frequency Escalation
`electron/services/reflection/LogInspectionService.ts` now normalizes bounded recent log windows into deterministic issue families, then aggregates repeated events into cluster candidates before `SelfImprovementService` emits a `ReflectionIssue`.

Key behavior:
- Stable clustering key (`clusterKey`) from normalized source + issue family + component + error code
- Volatile identifier normalization (timestamps/UUIDs/paths/high-cardinality numbers) to avoid over-splitting
- Bounded representative evidence (sample cap) instead of raw full-line dumps
- Deterministic severity escalation by repetition + persistence:
  - repeated occurrences in short window
  - high-frequency short-window bursts
  - consecutive-run persistence via `data/reflection/issue-cluster-history.jsonl`
  - multi-source breadth
- Escalation reasons are preserved in issue metadata and trace logs (`[IssueCluster]`, `[SeverityEscalation]`, `[CandidateScreening]`)

## 5.2 Runtime Error Capture Wiring
Runtime failures now feed reflection from one canonical JSONL sink:
- Path: `data/logs/runtime-errors.jsonl` (resolved via `PathResolver.resolveLogsPath('runtime-errors.jsonl')`)
- Writer: `electron/services/logging/RuntimeErrorLogger.ts`

Capture points:
- IPC invoke handler failures: `electron/services/IpcRouter.ts` wraps `ipcMain.handle(...)` registrations and logs on catch before rethrow.
- Filesystem read failures: `electron/services/FileService.ts` logs `read-file` errors (including `FILE_NOT_FOUND`) with path metadata.
- Process-level failures: `electron/main.ts` logs `uncaughtException` and `unhandledRejection`.

Logging format is one JSON object per line with stable fields:
`timestamp`, `level`, `source`, `component`, `event`, optional `code`, `message`, `stack`, and `metadata`.

## 6. Manual Single-Run Trigger (Debug)
`ReflectionAppService` now exposes `reflection:runNow` (wired in `electron/preload.ts` as `window.api.reflection.runReflectionNow`) for forcing one immediate reflection cycle using the same queue/scheduler/service pipeline used in normal operation.

Behavior:
- Returns `{ accepted, runId, reason?, message }`
- Rejects when reflection is disabled or another run is active
- Dev-safe gate: disabled in production unless `TALA_REFLECTION_MANUAL=1`
- If no candidates exist, expected outcome is an explicit traced abort (`reason=no_candidates`)

## 7. Bounded Auto-Fix Engine (Safe First Wave)
`electron/services/reflection/AutoFixEngine.ts` extends reflection outputs into a policy-bounded self-maintenance loop:

`Reflection -> Structured Proposal -> AutoFixGate -> Execution Plan -> Apply -> Verify -> Persist/Rollback`

Safety model:
- Only low-risk allowlisted categories/actions can auto-apply (`policy`, `config`, `runtime_state`, `storage_maintenance`, `provider_suppression`)
- Code edits are never auto-applied in this wave (`code_patch_plan` is gated to approval and stored as a patch-plan artifact)
- App-root containment is enforced for path targets
- Rollback + verification are required unless action is explicitly marked as irreversible maintenance

Proposal hygiene controls:
- Deterministic deduplication fingerprints (`dedupeKey`) are generated from stable proposal intent fields (category/issue/action/normalized target/value).
- Repeated equivalent proposals are merged into existing records (incremented `duplicateCount`/`observationCount`, updated `lastSeenAt`) instead of multiplying.
- Material-change bypass is supported for severity/confidence/evidence/value shifts so genuinely changed conditions can re-surface.
- Cooldown metadata (`cooldownUntil`) is persisted per proposal/outcome to suppress noisy re-proposals after success/failure/block/approval states.
- Target-scoped in-process locks (`targetLockKey`) are acquired before execution so overlapping runs on the same logical target are blocked and logged without globally serializing unrelated targets.

Persistence:
- Proposals and outcomes are stored under `data/reflection/artifacts/auto_fix/` via `ArtifactStore`
- IPC/manual controls in `ReflectionAppService`:
  - `reflection:autoFixEvaluate`
  - `reflection:autoFixDryRun`
  - `reflection:autoFixRun`
  - `reflection:listAutoFixProposals`
  - `reflection:listAutoFixOutcomes`
