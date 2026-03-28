/**
 * ReflectionTriggerAndRunControl.test.ts
 *
 * Tests for Phase 2 P2A/P2B/P2B.5:
 *   - shared/reflectionTypes.ts (P2A canonical types + helpers)
 *   - ReflectionTriggerService.ts (P2B trigger intake)
 *   - ReflectionRunController.ts (P2B.5 budget + run control)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    ipcMain: { handle: vi.fn() },
}));

vi.mock('../electron/services/TelemetryService', () => ({
    telemetry: { operational: vi.fn(), event: vi.fn() },
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import {
    toProposalRiskLevel,
    toChangeProposal,
    expandVerificationRequirements,
} from '../shared/reflectionTypes';
import type {
    ChangeProposal,
    ReflectionRun,
    ReflectionBudget,
    Snapshot,
    ProposalStatus,
    ProposalRiskLevel,
    ProposalOrigin,
    PromotionDecision,
    VerificationRequirement,
    RollbackPlan,
    PipelineStateSnapshot,
    TelemetryEvent,
    TriggerIntakeResult,
} from '../shared/reflectionTypes';
import { PlanRunRegistry } from '../electron/services/reflection/PlanRunRegistry';
import { ReflectionBudgetManager } from '../electron/services/reflection/ReflectionBudgetManager';
import { ReflectionTriggerService } from '../electron/services/reflection/ReflectionTriggerService';
import type { RawTriggerInput } from '../electron/services/reflection/ReflectionTriggerService';
import { ReflectionRunController } from '../electron/services/reflection/ReflectionRunController';
import type { PlanRun, PlanTriggerInput, BlastRadiusResult, SafeChangeProposal } from '../shared/reflectionPlanTypes';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRaw(overrides: Partial<RawTriggerInput> = {}): RawTriggerInput {
    return {
        subsystemId: 'inference',
        issueType: 'repeated_timeout',
        normalizedTarget: 'electron/services/InferenceService.ts',
        severity: 'medium',
        description: 'Test trigger',
        planningMode: 'light',
        ...overrides,
    };
}

function makeSafeProp(overrides: Partial<SafeChangeProposal> = {}): SafeChangeProposal {
    const blast: BlastRadiusResult = {
        affectedSubsystems: ['inference'],
        affectedFiles: ['InferenceService.ts'],
        threatenedInvariantIds: [],
        invariantRisk: 'low',
        estimatedImpactScore: 20,
        blockedBy: [],
    };
    return {
        proposalId: 'prop-1',
        runId: 'run-1',
        createdAt: new Date().toISOString(),
        title: 'Fix inference timeout',
        description: 'Increase timeout limits',
        planningMode: 'light',
        targetSubsystem: 'inference',
        targetFiles: ['InferenceService.ts'],
        changes: [{ type: 'patch', path: 'InferenceService.ts' }],
        blastRadius: blast,
        verificationRequirements: {
            requiresBuild: false,
            requiresTypecheck: false,
            requiresLint: true,
            requiredTests: ['tests/inference.test.ts'],
            smokeChecks: [],
            manualReviewRequired: false,
            estimatedDurationMs: 15_000,
        },
        rollbackClassification: {
            strategy: 'file_restore',
            safetyClass: 'safe_with_review',
            rollbackSteps: ['Stop service', 'Restore file', 'Restart'],
            requiresApproval: true,
            estimatedRollbackMs: 30_000,
            classificationReasoning: 'Safe with review — low blast radius',
        },
        status: 'classified',
        riskScore: 25,
        promotionEligible: false,
        reasoning: 'Deterministic analysis found timeout pattern',
        modelAssisted: false,
        ...overrides,
    };
}

/** Build a minimal SafeChangePlanner mock. */
function makePlannerMock(response?: Partial<import('../shared/reflectionPlanTypes').PlanningTriggerResponse>) {
    return {
        plan: vi.fn(async (trigger: PlanTriggerInput) => ({
            runId: 'mocked-run-id',
            status: 'completed' as const,
            message: 'Mocked completion',
            ...response,
        })),
        getRunStatus: vi.fn(),
        listRecentRuns: vi.fn(() => []),
        listProposals: vi.fn(() => []),
        getRunTelemetry: vi.fn(() => []),
        pruneOldRuns: vi.fn(),
        shutdown: vi.fn(),
    } as any;
}

// ─── P2A: shared/reflectionTypes.ts ──────────────────────────────────────────

describe('P2A: shared/reflectionTypes.ts', () => {
    describe('type exports', () => {
        it('module exports toProposalRiskLevel function', () => {
            expect(typeof toProposalRiskLevel).toBe('function');
        });

        it('module exports toChangeProposal function', () => {
            expect(typeof toChangeProposal).toBe('function');
        });

        it('module exports expandVerificationRequirements function', () => {
            expect(typeof expandVerificationRequirements).toBe('function');
        });
    });

    describe('toProposalRiskLevel', () => {
        it('returns critical for blocked safety class', () => {
            expect(toProposalRiskLevel('none', 'blocked')).toBe('critical');
        });

        it('returns high for high_risk safety class', () => {
            expect(toProposalRiskLevel('none', 'high_risk')).toBe('high');
        });

        it('returns high when invariant risk is high', () => {
            expect(toProposalRiskLevel('high', 'safe_with_review')).toBe('high');
        });

        it('returns high when invariant risk is critical', () => {
            expect(toProposalRiskLevel('critical', 'safe_with_review')).toBe('high');
        });

        it('returns medium for safe_with_review with medium invariant risk', () => {
            expect(toProposalRiskLevel('medium', 'safe_with_review')).toBe('medium');
        });

        it('returns medium when safetyClass is safe_with_review and risk is none', () => {
            expect(toProposalRiskLevel('none', 'safe_with_review')).toBe('medium');
        });

        it('returns low when invariant risk is low and class is safe_auto', () => {
            expect(toProposalRiskLevel('low', 'safe_auto')).toBe('low');
        });

        it('returns safe when everything is clean', () => {
            expect(toProposalRiskLevel('none', 'safe_auto')).toBe('safe');
        });
    });

    describe('toChangeProposal', () => {
        it('converts SafeChangeProposal to ChangeProposal', () => {
            const internal = makeSafeProp();
            const result = toChangeProposal(internal, 'manual');
            expect(result.proposalId).toBe(internal.proposalId);
            expect(result.runId).toBe(internal.runId);
            expect(result.origin).toBe('manual');
            expect(result.riskLevel).toBeDefined();
        });

        it('uses auto origin by default', () => {
            const result = toChangeProposal(makeSafeProp());
            expect(result.origin).toBe('auto');
        });

        it('copies rollback classification into RollbackPlan shape', () => {
            const result = toChangeProposal(makeSafeProp());
            expect(result.rollbackPlan.strategy).toBe('file_restore');
            expect(result.rollbackPlan.safetyClass).toBe('safe_with_review');
            expect(Array.isArray(result.rollbackPlan.steps)).toBe(true);
            expect(result.rollbackPlan.steps.length).toBeGreaterThan(0);
            expect(result.rollbackPlan.requiresApproval).toBe(true);
        });

        it('maps safe_with_review + low blast radius to medium risk level', () => {
            const result = toChangeProposal(makeSafeProp());
            expect(result.riskLevel).toBe('medium');
        });

        it('maps safe_auto + none blast radius to safe risk level', () => {
            const proposal = makeSafeProp({
                blastRadius: {
                    affectedSubsystems: [],
                    affectedFiles: [],
                    threatenedInvariantIds: [],
                    invariantRisk: 'none',
                    estimatedImpactScore: 0,
                    blockedBy: [],
                },
                rollbackClassification: {
                    strategy: 'no_rollback_needed',
                    safetyClass: 'safe_auto',
                    rollbackSteps: ['No rollback needed'],
                    requiresApproval: false,
                    estimatedRollbackMs: 0,
                    classificationReasoning: 'Safe auto',
                },
            });
            const result = toChangeProposal(proposal);
            expect(result.riskLevel).toBe('safe');
        });

        it('preserves modelAssisted flag', () => {
            const modelAssisted = toChangeProposal(makeSafeProp({ modelAssisted: true }));
            expect(modelAssisted.modelAssisted).toBe(true);
            const det = toChangeProposal(makeSafeProp({ modelAssisted: false }));
            expect(det.modelAssisted).toBe(false);
        });

        it('maps status from internal to ProposalStatus', () => {
            const result = toChangeProposal(makeSafeProp({ status: 'classified' }));
            expect(result.status).toBe('classified');
        });
    });

    describe('expandVerificationRequirements', () => {
        it('returns empty array when all requirements disabled', () => {
            const items = expandVerificationRequirements(
                { requiresBuild: false, requiresTypecheck: false, requiresLint: false, requiredTests: [], smokeChecks: [], manualReviewRequired: false, estimatedDurationMs: 0 },
                'run-1',
            );
            expect(items).toHaveLength(0);
        });

        it('includes build requirement when requiresBuild is true', () => {
            const items = expandVerificationRequirements(
                { requiresBuild: true, requiresTypecheck: false, requiresLint: false, requiredTests: [], smokeChecks: [], manualReviewRequired: false, estimatedDurationMs: 60_000 },
                'run-1',
            );
            expect(items.some(i => i.kind === 'build')).toBe(true);
        });

        it('includes lint requirement when requiresLint is true', () => {
            const items = expandVerificationRequirements(
                { requiresBuild: false, requiresTypecheck: false, requiresLint: true, requiredTests: [], smokeChecks: [], manualReviewRequired: false, estimatedDurationMs: 10_000 },
                'run-1',
            );
            expect(items.some(i => i.kind === 'lint')).toBe(true);
        });

        it('creates one test requirement per requiredTest', () => {
            const items = expandVerificationRequirements(
                { requiresBuild: false, requiresTypecheck: false, requiresLint: false, requiredTests: ['tests/a.test.ts', 'tests/b.test.ts'], smokeChecks: [], manualReviewRequired: false, estimatedDurationMs: 20_000 },
                'run-1',
            );
            const testItems = items.filter(i => i.kind === 'test');
            expect(testItems).toHaveLength(2);
        });

        it('creates one smoke requirement per smokeCheck', () => {
            const items = expandVerificationRequirements(
                { requiresBuild: false, requiresTypecheck: false, requiresLint: false, requiredTests: [], smokeChecks: ['npm run test -- SystemVerification'], manualReviewRequired: false, estimatedDurationMs: 15_000 },
                'run-1',
            );
            expect(items.some(i => i.kind === 'smoke')).toBe(true);
        });

        it('assigns unique requirementIds within a run', () => {
            const items = expandVerificationRequirements(
                { requiresBuild: true, requiresTypecheck: true, requiresLint: true, requiredTests: ['t.ts'], smokeChecks: ['s'], manualReviewRequired: false, estimatedDurationMs: 0 },
                'run-unique',
            );
            const ids = items.map(i => i.requirementId);
            const unique = new Set(ids);
            expect(unique.size).toBe(ids.length);
        });

        it('marks build and typecheck as blocking', () => {
            const items = expandVerificationRequirements(
                { requiresBuild: true, requiresTypecheck: true, requiresLint: true, requiredTests: [], smokeChecks: [], manualReviewRequired: false, estimatedDurationMs: 0 },
                'run-block',
            );
            expect(items.find(i => i.kind === 'build')!.isBlocking).toBe(true);
            expect(items.find(i => i.kind === 'typecheck')!.isBlocking).toBe(true);
        });

        it('marks lint as non-blocking', () => {
            const items = expandVerificationRequirements(
                { requiresBuild: false, requiresTypecheck: false, requiresLint: true, requiredTests: [], smokeChecks: [], manualReviewRequired: false, estimatedDurationMs: 0 },
                'run-lint',
            );
            expect(items.find(i => i.kind === 'lint')!.isBlocking).toBe(false);
        });
    });

    describe('canonical type shapes', () => {
        it('ProposalStatus covers all expected values', () => {
            const statuses: ProposalStatus[] = [
                'draft', 'classified', 'approved', 'rejected', 'promoted', 'rolled_back', 'deferred',
            ];
            expect(statuses).toHaveLength(7);
        });

        it('ProposalRiskLevel covers safe through critical', () => {
            const levels: ProposalRiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];
            expect(levels).toHaveLength(5);
        });

        it('ProposalOrigin covers all expected values', () => {
            const origins: ProposalOrigin[] = ['auto', 'scheduled', 'manual', 'goal'];
            expect(origins).toHaveLength(4);
        });

        it('ChangeProposal shape is structurally complete', () => {
            const result = toChangeProposal(makeSafeProp());
            expect(result).toHaveProperty('proposalId');
            expect(result).toHaveProperty('runId');
            expect(result).toHaveProperty('origin');
            expect(result).toHaveProperty('riskLevel');
            expect(result).toHaveProperty('status');
            expect(result).toHaveProperty('rollbackPlan');
            expect(result).toHaveProperty('blastRadius');
            expect(result).toHaveProperty('verificationRequirements');
        });
    });
});

// ─── P2B: ReflectionTriggerService ───────────────────────────────────────────

describe('P2B: ReflectionTriggerService', () => {
    let registry: PlanRunRegistry;
    let service: ReflectionTriggerService;

    beforeEach(() => {
        registry = new PlanRunRegistry();
        service = new ReflectionTriggerService(registry, makePlannerMock());
    });

    describe('normalizeTrigger', () => {
        it('returns valid:true for a complete raw trigger', () => {
            const result = service.normalizeTrigger(makeRaw());
            expect(result.valid).toBe(true);
            if (result.valid) {
                expect(result.trigger.subsystemId).toBe('inference');
                expect(result.trigger.issueType).toBe('repeated_timeout');
            }
        });

        it('returns valid:false when subsystemId is missing', () => {
            const result = service.normalizeTrigger(makeRaw({ subsystemId: undefined }));
            expect(result.valid).toBe(false);
        });

        it('returns valid:false when subsystemId is empty string', () => {
            const result = service.normalizeTrigger(makeRaw({ subsystemId: '' }));
            expect(result.valid).toBe(false);
        });

        it('returns valid:false when issueType is missing', () => {
            const result = service.normalizeTrigger(makeRaw({ issueType: undefined }));
            expect(result.valid).toBe(false);
        });

        it('normalizes severity to medium when invalid value provided', () => {
            const result = service.normalizeTrigger(makeRaw({ severity: 'banana' }));
            expect(result.valid).toBe(true);
            if (result.valid) expect(result.trigger.severity).toBe('medium');
        });

        it('normalizes planningMode to standard when invalid value provided', () => {
            const result = service.normalizeTrigger(makeRaw({ planningMode: 'ultra' }));
            expect(result.valid).toBe(true);
            if (result.valid) expect(result.trigger.planningMode).toBe('standard');
        });

        it('defaults isManual to false when not provided', () => {
            const result = service.normalizeTrigger(makeRaw({ isManual: undefined }));
            expect(result.valid).toBe(true);
            if (result.valid) expect(result.trigger.isManual).toBe(false);
        });

        it('defaults severity to medium when not provided', () => {
            const result = service.normalizeTrigger(makeRaw({ severity: undefined }));
            expect(result.valid).toBe(true);
            if (result.valid) expect(result.trigger.severity).toBe('medium');
        });

        it('lowercases normalizedTarget', () => {
            const result = service.normalizeTrigger(makeRaw({ normalizedTarget: 'UPPER/PATH.TS' }));
            expect(result.valid).toBe(true);
            if (result.valid) expect(result.trigger.normalizedTarget).toBe('upper/path.ts');
        });

        it('accepts all valid severities', () => {
            for (const sev of ['low', 'medium', 'high', 'critical'] as const) {
                const result = service.normalizeTrigger(makeRaw({ severity: sev }));
                expect(result.valid).toBe(true);
                if (result.valid) expect(result.trigger.severity).toBe(sev);
            }
        });

        it('accepts all valid planning modes', () => {
            for (const mode of ['light', 'standard', 'deep'] as const) {
                const result = service.normalizeTrigger(makeRaw({ planningMode: mode }));
                expect(result.valid).toBe(true);
                if (result.valid) expect(result.trigger.planningMode).toBe(mode);
            }
        });
    });

    describe('fingerprintTrigger', () => {
        it('returns a fingerprint for a valid trigger', () => {
            const fp = service.fingerprintTrigger(makeRaw());
            expect(fp).not.toBeNull();
            expect(fp!.hash).toBeTruthy();
            expect(fp!.subsystemId).toBe('inference');
        });

        it('returns null for an invalid trigger', () => {
            expect(service.fingerprintTrigger(makeRaw({ subsystemId: '' }))).toBeNull();
        });

        it('produces consistent fingerprints for same input', () => {
            const raw = makeRaw();
            const fp1 = service.fingerprintTrigger(raw);
            const fp2 = service.fingerprintTrigger(raw);
            expect(fp1!.hash).toBe(fp2!.hash);
        });
    });

    describe('precheck', () => {
        it('returns would_accept for a clean trigger', () => {
            const result = service.precheck(makeRaw());
            expect(result.reason).toBe('would_accept');
            expect(result.wouldAccept).toBe(true);
        });

        it('returns invalid_trigger for bad input', () => {
            const result = service.precheck(makeRaw({ subsystemId: '' }));
            expect(result.reason).toBe('invalid_trigger');
            expect(result.wouldAccept).toBe(false);
        });

        it('returns cooldown_blocked when subsystem is cooling down', () => {
            registry.setCooldown('inference', 'medium', 'test cooldown');
            const result = service.precheck(makeRaw());
            expect(result.reason).toBe('cooldown_blocked');
            expect(result.wouldAccept).toBe(false);
        });

        it('returns active_run_locked when subsystem is locked', () => {
            // Lock the subsystem with a mock run
            const fp = registry.computeFingerprint({
                subsystemId: 'inference',
                issueType: 'timeout',
                normalizedTarget: '',
                severity: 'medium',
                isManual: false,
            });
            const run: PlanRun = {
                runId: 'lock-run',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                subsystemId: 'inference',
                trigger: fp,
                status: 'running',
                planningMode: 'light',
                budget: { maxModelCalls: 1, maxSelfModelQueries: 6, maxAnalysisPasses: 1, maxRetriesPerStage: 1, maxDashboardUpdates: 5 },
                usage: { modelCallsUsed: 0, selfModelQueriesUsed: 0, analysisPassesUsed: 0, retriesUsed: 0, dashboardUpdatesUsed: 0 },
                proposals: [],
                milestones: [],
            };
            registry.registerRun(run);
            registry.lockSubsystem('inference', 'lock-run');

            const result = service.precheck(makeRaw());
            expect(result.reason).toBe('active_run_locked');
            expect(result.wouldAccept).toBe(false);
        });

        it('bypasses cooldown for critical severity', () => {
            registry.setCooldown('inference', 'medium', 'test cooldown');
            const result = service.precheck(makeRaw({ severity: 'critical' }));
            // Critical bypasses cooldown — should say would_accept
            expect(result.reason).toBe('would_accept');
        });

        it('bypasses cooldown for manual triggers', () => {
            registry.setCooldown('inference', 'medium', 'test cooldown');
            const result = service.precheck(makeRaw({ isManual: true }));
            expect(result.reason).toBe('would_accept');
        });
    });

    describe('intake', () => {
        it('returns accepted=true for a clean trigger', async () => {
            const result = await service.intake(makeRaw());
            expect(result.accepted).toBe(true);
            expect(result.runId).toBe('mocked-run-id');
        });

        it('returns accepted=false with status=failed for invalid trigger', async () => {
            const result = await service.intake(makeRaw({ subsystemId: '' }));
            expect(result.accepted).toBe(false);
            expect(result.status).toBe('failed');
        });

        it('returns cooldown_blocked when subsystem is cooling down', async () => {
            registry.setCooldown('inference', 'medium', 'test cooldown');
            const result = await service.intake(makeRaw());
            expect(result.accepted).toBe(false);
            expect(result.status).toBe('cooldown_blocked');
        });

        it('planner.plan() is NOT called when trigger is invalid', async () => {
            const planner = makePlannerMock();
            const svc = new ReflectionTriggerService(registry, planner);
            await svc.intake(makeRaw({ subsystemId: '' }));
            expect(planner.plan).not.toHaveBeenCalled();
        });

        it('planner.plan() is NOT called when cooldown blocks', async () => {
            registry.setCooldown('inference', 'medium', 'test cooldown');
            const planner = makePlannerMock();
            const svc = new ReflectionTriggerService(registry, planner);
            await svc.intake(makeRaw());
            expect(planner.plan).not.toHaveBeenCalled();
        });

        it('planner.plan() IS called for a valid, unblocked trigger', async () => {
            const planner = makePlannerMock();
            const svc = new ReflectionTriggerService(registry, planner);
            await svc.intake(makeRaw());
            expect(planner.plan).toHaveBeenCalledTimes(1);
        });

        it('passes normalized trigger to planner (not raw)', async () => {
            const planner = makePlannerMock();
            const svc = new ReflectionTriggerService(registry, planner);
            await svc.intake(makeRaw({ severity: 'INVALID', normalizedTarget: 'UPPER/FILE.TS' }));
            const passedTrigger = (planner.plan as any).mock.calls[0][0] as PlanTriggerInput;
            expect(passedTrigger.severity).toBe('medium'); // normalized
            expect(passedTrigger.normalizedTarget).toBe('upper/file.ts'); // normalized
        });

        it('returns deduped status when planner returns deduped', async () => {
            const planner = makePlannerMock({ status: 'deduped', runId: 'existing-run', attachedToRunId: 'existing-run' });
            const svc = new ReflectionTriggerService(registry, planner);
            const result = await svc.intake(makeRaw());
            expect(result.accepted).toBe(false);
            expect(result.attachedToRunId).toBe('existing-run');
        });

        it('returns accepted for completed status from planner', async () => {
            const planner = makePlannerMock({ status: 'completed', runId: 'new-run' });
            const svc = new ReflectionTriggerService(registry, planner);
            const result = await svc.intake(makeRaw());
            expect(result.accepted).toBe(true);
            expect(result.status).toBe('accepted');
        });
    });
});

// ─── P2B.5: ReflectionRunController ──────────────────────────────────────────

describe('P2B.5: ReflectionRunController', () => {
    let registry: PlanRunRegistry;
    let budgetManager: ReflectionBudgetManager;
    let controller: ReflectionRunController;

    const makeTrigger = (overrides: Partial<PlanTriggerInput> = {}): PlanTriggerInput => ({
        subsystemId: 'inference',
        issueType: 'repeated_timeout',
        normalizedTarget: 'InferenceService.ts',
        severity: 'medium',
        planningMode: 'light',
        isManual: false,
        ...overrides,
    });

    beforeEach(() => {
        registry = new PlanRunRegistry();
        budgetManager = new ReflectionBudgetManager();
        controller = new ReflectionRunController(registry, budgetManager);
    });

    describe('canStart', () => {
        it('allows a clean trigger', () => {
            const result = controller.canStart(makeTrigger());
            expect(result.allowed).toBe(true);
        });

        it('blocks when subsystem is in cooldown', () => {
            registry.setCooldown('inference', 'medium', 'test');
            const result = controller.canStart(makeTrigger());
            expect(result.allowed).toBe(false);
            expect(result.blockedBy).toBe('cooldown');
        });

        it('blocks when subsystem is locked', () => {
            const startResult = controller.start(makeTrigger());
            expect(startResult).not.toBeNull();
            // Now try a second start while first is active
            const result = controller.canStart(makeTrigger());
            expect(result.allowed).toBe(false);
            expect(result.blockedBy).toBe('active_run');
        });

        it('bypasses cooldown for critical severity', () => {
            registry.setCooldown('inference', 'medium', 'test');
            const result = controller.canStart(makeTrigger({ severity: 'critical' }));
            expect(result.allowed).toBe(true);
        });

        it('bypasses lock for manual trigger', () => {
            controller.start(makeTrigger()); // lock it
            const result = controller.canStart(makeTrigger({ isManual: true }));
            expect(result.allowed).toBe(true);
        });
    });

    describe('start', () => {
        it('returns a run + budget for a valid trigger', () => {
            const result = controller.start(makeTrigger());
            expect(result).not.toBeNull();
            expect(result!.run.runId).toBeTruthy();
            expect(result!.run.status).toBe('pending');
            expect(result!.budget.maxModelCalls).toBeDefined();
        });

        it('returns null when gates are blocked', () => {
            registry.setCooldown('inference', 'medium', 'test');
            const result = controller.start(makeTrigger());
            expect(result).toBeNull();
        });

        it('locks the subsystem after start', () => {
            controller.start(makeTrigger());
            expect(registry.isSubsystemLocked('inference')).toBe(true);
        });

        it('uses provided mode instead of trigger default', () => {
            const result = controller.start(makeTrigger({ planningMode: 'light' }), 'deep');
            expect(result!.run.planningMode).toBe('deep');
        });

        it('initialises budget with zero usage', () => {
            const result = controller.start(makeTrigger());
            const usage = controller.getUsage(result!.run.runId);
            expect(usage.modelCallsUsed).toBe(0);
            expect(usage.selfModelQueriesUsed).toBe(0);
        });
    });

    describe('markRunning / recordMilestone', () => {
        it('sets status to running after markRunning', () => {
            const { run } = controller.start(makeTrigger())!;
            controller.markRunning(run.runId);
            const state = controller.getRunState(run.runId);
            expect(state?.status).toBe('running');
        });

        it('adds run_started milestone after markRunning', () => {
            const { run } = controller.start(makeTrigger())!;
            controller.markRunning(run.runId);
            const state = controller.getRunState(run.runId);
            expect(state?.milestones.some(m => m.name === 'run_started')).toBe(true);
        });

        it('recordMilestone adds the named milestone', () => {
            const { run } = controller.start(makeTrigger())!;
            controller.recordMilestone(run.runId, 'snapshot_ready', 'snapshot ok');
            const state = controller.getRunState(run.runId);
            expect(state?.milestones.some(m => m.name === 'snapshot_ready')).toBe(true);
        });
    });

    describe('complete', () => {
        it('transitions run to completed', () => {
            const { run } = controller.start(makeTrigger())!;
            controller.markRunning(run.runId);
            const final = controller.complete(run.runId);
            expect(final?.status).toBe('completed');
        });

        it('releases the subsystem lock on complete', () => {
            const { run } = controller.start(makeTrigger())!;
            controller.complete(run.runId);
            expect(registry.isSubsystemLocked('inference')).toBe(false);
        });

        it('adds run_complete milestone', () => {
            const { run } = controller.start(makeTrigger())!;
            const final = controller.complete(run.runId);
            expect(final?.milestones.some(m => m.name === 'run_complete')).toBe(true);
        });

        it('returns null for unknown runId', () => {
            expect(controller.complete('not-a-real-id')).toBeNull();
        });
    });

    describe('fail', () => {
        it('transitions run to failed with reason', () => {
            const { run } = controller.start(makeTrigger())!;
            const final = controller.fail(run.runId, 'something went wrong');
            expect(final?.status).toBe('failed');
            expect(final?.failureReason).toBe('something went wrong');
        });

        it('releases the subsystem lock on fail', () => {
            const { run } = controller.start(makeTrigger())!;
            controller.fail(run.runId, 'error');
            expect(registry.isSubsystemLocked('inference')).toBe(false);
        });

        it('adds run_failed milestone', () => {
            const { run } = controller.start(makeTrigger())!;
            const final = controller.fail(run.runId, 'error');
            expect(final?.milestones.some(m => m.name === 'run_failed')).toBe(true);
        });
    });

    describe('exhaustBudget', () => {
        it('transitions run to budget_exhausted', () => {
            const { run } = controller.start(makeTrigger())!;
            const final = controller.exhaustBudget(run.runId);
            expect(final?.status).toBe('budget_exhausted');
        });

        it('releases subsystem lock after budget exhaustion', () => {
            const { run } = controller.start(makeTrigger())!;
            controller.exhaustBudget(run.runId);
            expect(registry.isSubsystemLocked('inference')).toBe(false);
        });
    });

    describe('consumeBudget', () => {
        it('allows consumption within budget', () => {
            const { run, budget } = controller.start(makeTrigger())!;
            const result = controller.consumeBudget(run.runId, 'selfModelQueriesUsed');
            expect(result.allowed).toBe(true);
        });

        it('blocks after budget exhausted for that dimension', () => {
            const trigger = makeTrigger({ planningMode: 'light' });
            const { run } = controller.start(trigger)!;
            // light mode: maxSelfModelQueries = 4
            for (let i = 0; i < 4; i++) {
                controller.consumeBudget(run.runId, 'selfModelQueriesUsed');
            }
            const result = controller.consumeBudget(run.runId, 'selfModelQueriesUsed');
            expect(result.allowed).toBe(false);
        });

        it('returns blocked result for unknown runId', () => {
            const result = controller.consumeBudget('unknown', 'modelCallsUsed');
            expect(result.allowed).toBe(false);
        });
    });

    describe('isBudgetExhausted', () => {
        it('returns false for a fresh run', () => {
            const { run } = controller.start(makeTrigger())!;
            expect(controller.isBudgetExhausted(run.runId)).toBe(false);
        });

        it('returns true after exhausting analysis passes', () => {
            const { run } = controller.start(makeTrigger({ planningMode: 'light' }))!;
            // light mode: maxAnalysisPasses = 1
            controller.consumeBudget(run.runId, 'analysisPassesUsed');
            expect(controller.isBudgetExhausted(run.runId)).toBe(true);
        });

        it('returns true for unknown runId', () => {
            expect(controller.isBudgetExhausted('nobody')).toBe(true);
        });
    });

    describe('getRunState / listRecentRuns / getActiveRun', () => {
        it('getRunState returns the run after start', () => {
            const { run } = controller.start(makeTrigger())!;
            const state = controller.getRunState(run.runId);
            expect(state).not.toBeNull();
            expect(state!.runId).toBe(run.runId);
        });

        it('getRunState returns null for unknown id', () => {
            expect(controller.getRunState('x')).toBeNull();
        });

        it('listRecentRuns includes newly started run', () => {
            const { run } = controller.start(makeTrigger())!;
            const list = controller.listRecentRuns();
            expect(list.some(r => r.runId === run.runId)).toBe(true);
        });

        it('getActiveRun returns current active run for subsystem', () => {
            const { run } = controller.start(makeTrigger())!;
            const active = controller.getActiveRun('inference');
            expect(active?.runId).toBe(run.runId);
        });

        it('getActiveRun returns null after run completes', () => {
            const { run } = controller.start(makeTrigger())!;
            controller.complete(run.runId);
            expect(controller.getActiveRun('inference')).toBeNull();
        });
    });

    describe('pruneOldRuns', () => {
        it('prunes runs outside retention window', () => {
            // Manually register an old run in the registry
            const fp = registry.computeFingerprint(makeTrigger());
            const oldRun: PlanRun = {
                runId: 'old-r',
                createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
                updatedAt: new Date().toISOString(),
                subsystemId: 'inference',
                trigger: fp,
                status: 'completed',
                planningMode: 'light',
                budget: { maxModelCalls: 1, maxSelfModelQueries: 6, maxAnalysisPasses: 1, maxRetriesPerStage: 1, maxDashboardUpdates: 5 },
                usage: { modelCallsUsed: 0, selfModelQueriesUsed: 0, analysisPassesUsed: 0, retriesUsed: 0, dashboardUpdatesUsed: 0 },
                proposals: [],
                milestones: [],
            };
            registry.registerRun(oldRun);
            const pruned = controller.pruneOldRuns(4 * 60 * 60 * 1000); // 4h retention
            expect(pruned).toBeGreaterThanOrEqual(1);
        });
    });
});
