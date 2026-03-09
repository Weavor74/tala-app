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
