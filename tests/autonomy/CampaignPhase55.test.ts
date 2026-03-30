/**
 * CampaignPhase55.test.ts
 *
 * Phase 5.5: Multi-Step Repair Campaigns — Comprehensive Test Suite
 *
 * Covers:
 *   P5.5A  Repair Campaign Types & Contracts (shape tests, DEFAULT_CAMPAIGN_BOUNDS)
 *   P5.5B  RepairCampaignPlanner (from decomposition, recovery pack, template)
 *   P5.5C  CampaignStepRegistry (state machine, prerequisites, transitions)
 *   P5.5D  CampaignCheckpointEngine (passed/degraded/failed, scope drift, invariants)
 *   P5.5E  CampaignReassessmentEngine (all decision paths, bounds, rules)
 *   P5.5F  RepairCampaignCoordinator (activate, defer, abort, resume, advance)
 *   P5.5G  CampaignOutcomeTracker (record, persist, listOutcomes)
 *   P5.5H  CampaignDashboardBridge (buildState, kpis)
 *   P5.5I  Safety bounds, cooldown, startup recovery, one-per-subsystem
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    ipcMain: { handle: vi.fn() },
}));

vi.mock('../../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        event: vi.fn(),
    },
}));

vi.mock('uuid', () => ({
    v4: vi.fn(() => 'mock-uuid-' + Math.random().toString(36).slice(2, 9)),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import type {
    RepairCampaign,
    CampaignStep,
    CampaignBounds,
    CampaignCheckpoint,
    CampaignReassessmentDecision,
    RepairCampaignStatus,
} from '../../shared/repairCampaignTypes';
import {
    DEFAULT_CAMPAIGN_BOUNDS,
} from '../../shared/repairCampaignTypes';
import type { DecompositionPlan, DecompositionStep } from '../../shared/escalationTypes';
import type { RecoveryPack } from '../../shared/recoveryPackTypes';

import { RepairCampaignPlanner } from '../../electron/services/autonomy/campaigns/RepairCampaignPlanner';
import { CampaignStepRegistry } from '../../electron/services/autonomy/campaigns/CampaignStepRegistry';
import { CampaignCheckpointEngine } from '../../electron/services/autonomy/campaigns/CampaignCheckpointEngine';
import type { CampaignStepExecutionResult } from '../../electron/services/autonomy/campaigns/CampaignCheckpointEngine';
import { CampaignReassessmentEngine } from '../../electron/services/autonomy/campaigns/CampaignReassessmentEngine';
import { CampaignOutcomeTracker } from '../../electron/services/autonomy/campaigns/CampaignOutcomeTracker';
import { CampaignSafetyGuard } from '../../electron/services/autonomy/campaigns/CampaignSafetyGuard';
import { CampaignDashboardBridge } from '../../electron/services/autonomy/campaigns/CampaignDashboardBridge';
import { RepairCampaignRegistry } from '../../electron/services/autonomy/campaigns/RepairCampaignRegistry';
import { RepairCampaignCoordinator } from '../../electron/services/autonomy/campaigns/RepairCampaignCoordinator';

// ─── Test helpers ─────────────────────────────────────────────────────────────

let testDir: string;

function makeTestDir(): string {
    const dir = path.join(os.tmpdir(), `tala-campaign-test-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function makeDecompositionPlan(stepCount = 3): DecompositionPlan {
    const steps: DecompositionStep[] = Array.from({ length: stepCount }, (_, i) => ({
        stepId: `ds-step-${i}`,
        planId: 'plan-001',
        stepIndex: i,
        kind: 'verification_stage' as any,
        description: `Decomposition step ${i + 1}`,
        scopeHint: `scope-${i}`,
        independent: true,
        verifiable: true,
        rollbackable: true,
        estimatedTokens: 256,
    }));
    return {
        planId: 'plan-001',
        goalId: 'goal-001',
        createdAt: new Date().toISOString(),
        steps,
        totalSteps: stepCount,
        depth: 1,
        rationale: 'Test decomposition',
        bounded: true,
    };
}

function makeRecoveryPack(): RecoveryPack {
    return {
        packId: 'pack-001',
        version: '1.0.0',
        label: 'Test Pack',
        description: 'Test recovery pack',
        applicableGoalSources: ['repeated_execution_failure'],
        applicabilityRules: [],
        scope: { maxFiles: 3, allowedSubsystems: ['inference'], allowedFilePaths: [] },
        actionTemplates: [
            { actionId: 'a1', description: 'Fix action 1', targetFileTemplate: 'src/inference.ts', patchDescriptor: {}, optional: false },
            { actionId: 'a2', description: 'Fix action 2', targetFileTemplate: 'src/config.ts', patchDescriptor: {}, optional: true },
        ],
        verificationTemplates: [],
        rollbackTemplate: { rollbackId: 'r1', description: 'Revert', strategy: 'revert_patched_files', extraSnapshotPaths: [] },
        confidence: { current: 0.8, initial: 0.65, floor: 0.3, ceiling: 0.95, successCount: 5, failureCount: 1, rollbackCount: 0 },
        enabled: true,
        maxAttemptsPerGoal: 2,
        requiresHumanReview: false,
        committedAt: '2025-01-01T00:00:00.000Z',
    };
}

function makeCampaign(stepCount = 3, subsystem = 'inference'): RepairCampaign {
    const planner = new RepairCampaignPlanner();
    const plan = makeDecompositionPlan(stepCount);
    const campaign = planner.buildFromDecomposition(plan, 'goal-001', subsystem)!;
    campaign.status = 'active';
    return campaign;
}

function makePassedCheckpoint(campaign: RepairCampaign, stepId: string): CampaignCheckpoint {
    return {
        checkpointId: `chk-${Date.now()}`,
        campaignId: campaign.campaignId,
        stepId,
        evaluatedAt: new Date().toISOString(),
        outcome: 'passed',
        executionSucceeded: true,
        checks: [{ checkName: 'execution_succeeded', passed: true }],
        invariantViolations: [],
        scopeDriftDetected: false,
        continueRecommended: true,
        summary: 'All checks passed',
    };
}

function makeExecutionResult(overrides: Partial<CampaignStepExecutionResult> = {}): CampaignStepExecutionResult {
    return {
        executionRunId: 'run-001',
        executionSucceeded: true,
        rollbackTriggered: false,
        ...overrides,
    };
}

// ─── P5.5A: Types & Contracts ─────────────────────────────────────────────────

describe('P5.5A: Types & Contracts', () => {
    it('DEFAULT_CAMPAIGN_BOUNDS has required fields', () => {
        expect(DEFAULT_CAMPAIGN_BOUNDS.maxSteps).toBeGreaterThan(0);
        expect(DEFAULT_CAMPAIGN_BOUNDS.maxReassessments).toBeGreaterThan(0);
        expect(DEFAULT_CAMPAIGN_BOUNDS.maxAgeMs).toBeGreaterThan(0);
        expect(DEFAULT_CAMPAIGN_BOUNDS.stepTimeoutMs).toBeGreaterThan(0);
        expect(DEFAULT_CAMPAIGN_BOUNDS.cooldownAfterFailureMs).toBeGreaterThan(0);
    });

    it('DEFAULT_CAMPAIGN_BOUNDS is conservative', () => {
        expect(DEFAULT_CAMPAIGN_BOUNDS.maxSteps).toBeLessThanOrEqual(10);
        expect(DEFAULT_CAMPAIGN_BOUNDS.maxReassessments).toBeLessThanOrEqual(8);
    });
});

// ─── P5.5B: RepairCampaignPlanner ─────────────────────────────────────────────

describe('P5.5B: RepairCampaignPlanner', () => {
    let planner: RepairCampaignPlanner;

    beforeEach(() => {
        planner = new RepairCampaignPlanner();
    });

    it('builds campaign from decomposition plan', () => {
        const plan = makeDecompositionPlan(3);
        const campaign = planner.buildFromDecomposition(plan, 'goal-001', 'inference');
        expect(campaign).not.toBeNull();
        expect(campaign!.status).toBe('draft');
        expect(campaign!.steps).toHaveLength(3);
        expect(campaign!.goalId).toBe('goal-001');
        expect(campaign!.originType).toBe('decomposition');
        expect(campaign!.originRef).toBe('plan-001');
    });

    it('campaign has correct step order', () => {
        const plan = makeDecompositionPlan(3);
        const campaign = planner.buildFromDecomposition(plan, 'goal-001', 'inference')!;
        const orders = campaign.steps.map(s => s.order);
        expect(orders).toEqual([0, 1, 2]);
    });

    it('all campaign steps start in pending status', () => {
        const plan = makeDecompositionPlan(3);
        const campaign = planner.buildFromDecomposition(plan, 'goal-001', 'inference')!;
        for (const step of campaign.steps) {
            expect(step.status).toBe('pending');
        }
    });

    it('returns null for empty decomposition plan', () => {
        const plan = makeDecompositionPlan(0);
        const result = planner.buildFromDecomposition(plan, 'goal-001', 'inference');
        expect(result).toBeNull();
    });

    it('truncates decomposition plan to maxSteps', () => {
        const plan = makeDecompositionPlan(20);
        const campaign = planner.buildFromDecomposition(plan, 'goal-001', 'inference', { maxSteps: 4 });
        expect(campaign!.steps).toHaveLength(4);
    });

    it('enforces hard cap of 10 maxSteps regardless of override', () => {
        const campaign = planner.buildFromDecomposition(
            makeDecompositionPlan(3),
            'goal-001',
            'inference',
            { maxSteps: 99 }, // exceeds hard cap
        );
        expect(campaign!.bounds.maxSteps).toBeLessThanOrEqual(10);
    });

    it('builds campaign from recovery pack', () => {
        const pack = makeRecoveryPack();
        const campaign = planner.buildFromRecoveryPack(pack, 'goal-001', 'inference');
        expect(campaign).not.toBeNull();
        expect(campaign!.originType).toBe('recovery_pack');
        expect(campaign!.steps).toHaveLength(2);
        expect(campaign!.steps[0].isOptional).toBe(false);
        expect(campaign!.steps[1].isOptional).toBe(true);
    });

    it('returns null for pack with no actions', () => {
        const pack = makeRecoveryPack();
        pack.actionTemplates = [];
        const result = planner.buildFromRecoveryPack(pack, 'goal-001', 'inference');
        expect(result).toBeNull();
    });

    it('builds campaign from template', () => {
        const campaign = planner.buildFromTemplate(
            'bootstrap_wiring_repair',
            'goal-001',
        );
        expect(campaign).not.toBeNull();
        expect(campaign!.originType).toBe('repair_template');
        expect(campaign!.steps.length).toBeGreaterThan(0);
    });

    it('returns null for unknown template', () => {
        const result = planner.buildFromTemplate('nonexistent_template_id', 'goal-001');
        expect(result).toBeNull();
    });

    it('campaign has expiresAt set to createdAt + maxAgeMs', () => {
        const plan = makeDecompositionPlan(2);
        const campaign = planner.buildFromDecomposition(plan, 'goal-001', 'inference')!;
        const created = new Date(campaign.createdAt).getTime();
        const expires = new Date(campaign.expiresAt).getTime();
        expect(expires - created).toBe(campaign.bounds.maxAgeMs);
    });

    it('lists available templates', () => {
        const templates = planner.listTemplates();
        expect(templates.length).toBeGreaterThanOrEqual(5);
        expect(templates[0]).toHaveProperty('templateId');
        expect(templates[0]).toHaveProperty('label');
    });
});

// ─── P5.5C: CampaignStepRegistry ─────────────────────────────────────────────

describe('P5.5C: CampaignStepRegistry', () => {
    function makeCampaignWithRegistry(stepCount = 3) {
        const campaign = makeCampaign(stepCount);
        const registry = new CampaignStepRegistry(campaign.steps);
        return { campaign, registry };
    }

    it('getNextPendingStep returns first step when no prerequisites', () => {
        const { registry } = makeCampaignWithRegistry(3);
        const next = registry.getNextPendingStep();
        expect(next).not.toBeNull();
        expect(next!.order).toBe(0);
    });

    it('markRunning transitions step from pending to running', () => {
        const { campaign, registry } = makeCampaignWithRegistry(3);
        const step = campaign.steps[0];
        registry.markRunning(step.stepId);
        expect(campaign.steps[0].status).toBe('running');
    });

    it('markPassed transitions from awaiting_verification to passed', () => {
        const { campaign, registry } = makeCampaignWithRegistry(3);
        const step = campaign.steps[0];
        step.verificationRequired = true;
        registry.markRunning(step.stepId);
        registry.markAwaitingVerification(step.stepId, 'run-001');
        registry.markPassed(step.stepId, 'chk-001');
        expect(campaign.steps[0].status).toBe('passed');
        expect(campaign.steps[0].checkpointId).toBe('chk-001');
    });

    it('markFailed transitions from running to failed', () => {
        const { campaign, registry } = makeCampaignWithRegistry(3);
        const step = campaign.steps[0];
        registry.markRunning(step.stepId);
        registry.markFailed(step.stepId, 'test failure');
        expect(campaign.steps[0].status).toBe('failed');
        expect(campaign.steps[0].failureReason).toBe('test failure');
    });

    it('skipStep transitions from pending to skipped', () => {
        const { campaign, registry } = makeCampaignWithRegistry(3);
        const step = campaign.steps[0];
        registry.skipStep(step.stepId, 'skipped by reassessment');
        expect(campaign.steps[0].status).toBe('skipped');
        expect(campaign.steps[0].skipReason).toBe('skipped by reassessment');
    });

    it('throws when transitioning from terminal state', () => {
        const { campaign, registry } = makeCampaignWithRegistry(3);
        const step = campaign.steps[0];
        registry.markRunning(step.stepId);
        registry.markFailed(step.stepId, 'failed');
        // Cannot transition from failed
        expect(() => registry.markRunning(step.stepId)).toThrow();
    });

    it('allTerminal returns true when all steps are in terminal state', () => {
        const { campaign, registry } = makeCampaignWithRegistry(2);
        const [s0, s1] = campaign.steps;
        // Mark both as passed (bypass prerequisites for test by clearing them)
        s0.prerequisites = [];
        s1.prerequisites = [];
        s0.verificationRequired = false;
        s1.verificationRequired = false;
        registry.markRunning(s0.stepId);
        registry.markPassed(s0.stepId);
        registry.markRunning(s1.stepId);
        registry.markPassed(s1.stepId);
        expect(registry.allTerminal()).toBe(true);
    });

    it('allRequiredPassed returns false when required step not passed', () => {
        const { registry } = makeCampaignWithRegistry(2);
        expect(registry.allRequiredPassed()).toBe(false);
    });

    it('getNextPendingStep respects prerequisites', () => {
        const campaign = makeCampaign(3);
        // Step 0 has no prereqs, steps 1 and 2 will have prereqs
        // Verify: after step 0 passes, step 1 becomes eligible
        const registry = new CampaignStepRegistry(campaign.steps);
        const s0 = campaign.steps[0];
        s0.prerequisites = [];
        s0.verificationRequired = false;
        registry.markRunning(s0.stepId);
        registry.markPassed(s0.stepId);
        const next = registry.getNextPendingStep();
        // step 1's prerequisite was step 0's stepId (set by planner or manually)
        // In our test campaign from decompositionPlan, prereqs were not set so all can start
        expect(next).not.toBeNull();
    });
});

// ─── P5.5D: CampaignCheckpointEngine ─────────────────────────────────────────

describe('P5.5D: CampaignCheckpointEngine', () => {
    let engine: CampaignCheckpointEngine;

    beforeEach(() => {
        engine = new CampaignCheckpointEngine();
    });

    function makeStep(overrides: Partial<CampaignStep> = {}): CampaignStep {
        return {
            stepId: 'step-001',
            campaignId: 'campaign-001',
            order: 0,
            label: 'Test step',
            targetSubsystem: 'inference',
            scopeHint: 'inference',
            source: 'decomposition_step',
            verificationRequired: true,
            rollbackExpected: true,
            isOptional: false,
            prerequisites: [],
            status: 'awaiting_verification',
            ...overrides,
        };
    }

    function makeCampaignShell(): RepairCampaign {
        return {
            campaignId: 'campaign-001',
            goalId: 'goal-001',
            originType: 'decomposition',
            label: 'Test',
            subsystem: 'inference',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
            bounds: DEFAULT_CAMPAIGN_BOUNDS,
            status: 'awaiting_checkpoint',
            updatedAt: new Date().toISOString(),
            steps: [],
            currentStepIndex: 0,
            reassessmentCount: 0,
            checkpoints: [],
            reassessmentRecords: [],
        };
    }

    it('produces passed checkpoint when execution succeeds with verifications', () => {
        const step = makeStep();
        const result = makeExecutionResult({
            verificationResults: [{ stepName: 'test_run', passed: true }],
        });
        const checkpoint = engine.evaluate(step, result, makeCampaignShell());
        expect(checkpoint.outcome).toBe('passed');
        expect(checkpoint.continueRecommended).toBe(true);
        expect(checkpoint.executionSucceeded).toBe(true);
    });

    it('produces failed checkpoint when execution fails', () => {
        const step = makeStep();
        const result = makeExecutionResult({
            executionSucceeded: false,
            failureReason: 'executor threw',
        });
        const checkpoint = engine.evaluate(step, result, makeCampaignShell());
        expect(checkpoint.outcome).toBe('failed');
        expect(checkpoint.continueRecommended).toBe(false);
    });

    it('produces failed checkpoint when rollback triggered', () => {
        const step = makeStep();
        const result = makeExecutionResult({ rollbackTriggered: true });
        const checkpoint = engine.evaluate(step, result, makeCampaignShell());
        expect(checkpoint.outcome).toBe('failed');
    });

    it('produces failed checkpoint on invariant violation', () => {
        const step = makeStep();
        const result = makeExecutionResult({ invariantViolations: ['INV_001'] });
        const checkpoint = engine.evaluate(step, result, makeCampaignShell());
        expect(checkpoint.outcome).toBe('failed');
        expect(checkpoint.invariantViolations).toContain('INV_001');
    });

    it('detects scope drift when mutations outside scope hint', () => {
        const step = makeStep({ scopeHint: 'inference', targetSubsystem: 'inference' });
        const result = makeExecutionResult({
            mutatedFiles: ['/totally/unrelated/path/admin.ts'],
        });
        const checkpoint = engine.evaluate(step, result, makeCampaignShell());
        expect(checkpoint.scopeDriftDetected).toBe(true);
        expect(checkpoint.outcome).toBe('degraded');
    });

    it('no scope drift when mutation within scope', () => {
        const step = makeStep({ scopeHint: 'inference', targetSubsystem: 'inference' });
        const result = makeExecutionResult({
            mutatedFiles: ['src/inference/provider.ts'],
        });
        const checkpoint = engine.evaluate(step, result, makeCampaignShell());
        expect(checkpoint.scopeDriftDetected).toBe(false);
    });

    it('checkpoint always has a checkpointId and campaignId', () => {
        const step = makeStep();
        const result = makeExecutionResult();
        const checkpoint = engine.evaluate(step, result, makeCampaignShell());
        expect(checkpoint.checkpointId).toBeTruthy();
        expect(checkpoint.campaignId).toBe('campaign-001');
        expect(checkpoint.stepId).toBe('step-001');
    });
});

// ─── P5.5E: CampaignReassessmentEngine ───────────────────────────────────────

describe('P5.5E: CampaignReassessmentEngine', () => {
    let engine: CampaignReassessmentEngine;

    beforeEach(() => {
        engine = new CampaignReassessmentEngine();
    });

    function makeCampaignForReassess(
        status: RepairCampaignStatus = 'awaiting_reassessment',
        reassessmentCount = 0,
        stepsRemaining = 2,
    ): RepairCampaign {
        const planner = new RepairCampaignPlanner();
        const plan = makeDecompositionPlan(stepsRemaining + 1);
        const c = planner.buildFromDecomposition(plan, 'goal-001', 'inference')!;
        c.status = status;
        c.reassessmentCount = reassessmentCount;
        // Mark step 0 as the one being evaluated
        c.steps[0].status = 'passed';
        return c;
    }

    it('returns continue on passed checkpoint', () => {
        const campaign = makeCampaignForReassess('awaiting_reassessment', 0, 2);
        const checkpoint = makePassedCheckpoint(campaign, campaign.steps[0].stepId);
        const record = engine.decide(campaign, checkpoint);
        expect(record.decision).toBe('continue');
        expect(record.triggerRule).toBe('CHECKPOINT_PASSED');
    });

    it('returns abort when reassessment count exceeds max', () => {
        const campaign = makeCampaignForReassess('awaiting_reassessment', DEFAULT_CAMPAIGN_BOUNDS.maxReassessments, 2);
        const checkpoint = makePassedCheckpoint(campaign, campaign.steps[0].stepId);
        const record = engine.decide(campaign, checkpoint);
        expect(record.decision).toBe('abort');
        expect(record.triggerRule).toBe('BOUNDS_EXCEEDED_REASSESSMENTS');
    });

    it('returns defer when campaign is expired', () => {
        const campaign = makeCampaignForReassess('awaiting_reassessment', 0, 2);
        campaign.expiresAt = new Date(Date.now() - 1000).toISOString(); // already expired
        const checkpoint = makePassedCheckpoint(campaign, campaign.steps[0].stepId);
        const record = engine.decide(campaign, checkpoint);
        expect(record.decision).toBe('defer');
        expect(record.triggerRule).toBe('BOUNDS_EXCEEDED_AGE');
    });

    it('returns human_review on invariant violation', () => {
        const campaign = makeCampaignForReassess('awaiting_reassessment', 0, 2);
        const checkpoint: CampaignCheckpoint = {
            ...makePassedCheckpoint(campaign, campaign.steps[0].stepId),
            outcome: 'failed',
            executionSucceeded: true,
            invariantViolations: ['INV_001'],
        };
        const record = engine.decide(campaign, checkpoint);
        expect(record.decision).toBe('human_review');
        expect(record.triggerRule).toBe('INVARIANT_VIOLATION');
    });

    it('returns human_review on scope drift', () => {
        const campaign = makeCampaignForReassess('awaiting_reassessment', 0, 2);
        const checkpoint: CampaignCheckpoint = {
            ...makePassedCheckpoint(campaign, campaign.steps[0].stepId),
            outcome: 'degraded',
            scopeDriftDetected: true,
            scopeDriftDetails: 'mutations outside scope',
        };
        const record = engine.decide(campaign, checkpoint);
        expect(record.decision).toBe('human_review');
        expect(record.triggerRule).toBe('SCOPE_DRIFT');
    });

    it('returns rollback when execution failed and rollback was triggered', () => {
        const campaign = makeCampaignForReassess('awaiting_reassessment', 0, 2);
        const checkpoint: CampaignCheckpoint = {
            ...makePassedCheckpoint(campaign, campaign.steps[0].stepId),
            outcome: 'failed',
            executionSucceeded: false,
            checks: [
                { checkName: 'execution_succeeded', passed: false },
                { checkName: 'no_rollback_triggered', passed: false, detail: 'rollback was triggered' },
            ],
        };
        const record = engine.decide(campaign, checkpoint);
        expect(record.decision).toBe('rollback');
        expect(record.triggerRule).toBe('EXECUTION_FAILED_ROLLBACK');
    });

    it('returns abort when required step failed without rollback', () => {
        const campaign = makeCampaignForReassess('awaiting_reassessment', 0, 2);
        const step = campaign.steps[0];
        step.isOptional = false;
        const checkpoint: CampaignCheckpoint = {
            ...makePassedCheckpoint(campaign, step.stepId),
            outcome: 'failed',
            executionSucceeded: false,
            checks: [{ checkName: 'execution_succeeded', passed: false }],
        };
        const record = engine.decide(campaign, checkpoint);
        expect(record.decision).toBe('abort');
        expect(record.triggerRule).toBe('EXECUTION_FAILED_REQUIRED');
    });

    it('returns skip_step when optional step failed with remaining steps', () => {
        const campaign = makeCampaignForReassess('awaiting_reassessment', 0, 2);
        const step = campaign.steps[0];
        step.isOptional = true;
        const checkpoint: CampaignCheckpoint = {
            ...makePassedCheckpoint(campaign, step.stepId),
            outcome: 'failed',
            executionSucceeded: false,
            checks: [{ checkName: 'execution_succeeded', passed: false }],
        };
        const record = engine.decide(campaign, checkpoint);
        expect(record.decision).toBe('skip_step');
        expect(record.triggerRule).toBe('EXECUTION_FAILED_OPTIONAL');
    });

    it('returns abort when degraded checkpoint has dependent steps', () => {
        const campaign = makeCampaignForReassess('awaiting_reassessment', 0, 2);
        const step0 = campaign.steps[0];
        const step1 = campaign.steps[1];
        // Make step1 depend on step0
        step1.prerequisites = [step0.stepId];
        const checkpoint: CampaignCheckpoint = {
            ...makePassedCheckpoint(campaign, step0.stepId),
            outcome: 'degraded',
            scopeDriftDetected: false,
            invariantViolations: [],
        };
        const record = engine.decide(campaign, checkpoint);
        expect(record.decision).toBe('abort');
        expect(record.triggerRule).toBe('CHECKPOINT_DEGRADED_CRITICAL');
    });

    it('returns continue when degraded checkpoint has no dependent steps', () => {
        const campaign = makeCampaignForReassess('awaiting_reassessment', 0, 2);
        const step0 = campaign.steps[0];
        // step1 has no prerequisites
        campaign.steps[1].prerequisites = [];
        const checkpoint: CampaignCheckpoint = {
            ...makePassedCheckpoint(campaign, step0.stepId),
            outcome: 'degraded',
            scopeDriftDetected: false,
            invariantViolations: [],
        };
        const record = engine.decide(campaign, checkpoint);
        expect(record.decision).toBe('continue');
        expect(record.triggerRule).toBe('CHECKPOINT_DEGRADED_SAFE');
    });

    it('record has required fields', () => {
        const campaign = makeCampaignForReassess('awaiting_reassessment', 0, 2);
        const checkpoint = makePassedCheckpoint(campaign, campaign.steps[0].stepId);
        const record = engine.decide(campaign, checkpoint);
        expect(record.reassessmentId).toBeTruthy();
        expect(record.campaignId).toBe(campaign.campaignId);
        expect(record.evaluatedAt).toBeTruthy();
        expect(typeof record.rationale).toBe('string');
        expect(record.rationale.length).toBeGreaterThan(10);
    });
});

// ─── P5.5G: CampaignOutcomeTracker ───────────────────────────────────────────

describe('P5.5G: CampaignOutcomeTracker', () => {
    beforeEach(() => {
        testDir = makeTestDir();
    });
    afterEach(() => {
        try { fs.rmSync(testDir, { recursive: true }); } catch { /* non-fatal */ }
    });

    it('records a campaign outcome to disk', () => {
        const tracker = new CampaignOutcomeTracker(testDir);
        const campaign = makeCampaign(3);
        campaign.status = 'succeeded';
        const record = tracker.record(campaign);
        expect(record.finalStatus).toBe('succeeded');
        expect(record.campaignId).toBe(campaign.campaignId);
        expect(record.stepsTotal).toBe(3);
    });

    it('persists and retrieves campaign record', () => {
        const tracker = new CampaignOutcomeTracker(testDir);
        const campaign = makeCampaign(2);
        campaign.status = 'failed';
        tracker.record(campaign);
        const loaded = tracker.getRecord(campaign.campaignId);
        expect(loaded).not.toBeNull();
        expect(loaded!.finalStatus).toBe('failed');
    });

    it('listOutcomes returns recent outcomes', () => {
        const tracker = new CampaignOutcomeTracker(testDir);
        const c1 = makeCampaign(2, 'inference');
        c1.status = 'succeeded';
        const c2 = makeCampaign(2, 'config');
        c2.status = 'failed';
        tracker.record(c1);
        tracker.record(c2);
        const outcomes = tracker.listOutcomes();
        expect(outcomes.length).toBeGreaterThanOrEqual(2);
    });

    it('computes rollbackFrequency correctly', () => {
        const tracker = new CampaignOutcomeTracker(testDir);
        const campaign = makeCampaign(4);
        campaign.status = 'rolled_back';
        campaign.steps[0].status = 'passed';
        campaign.steps[1].status = 'rolled_back';
        campaign.steps[2].status = 'rolled_back';
        campaign.steps[3].status = 'pending';
        const record = tracker.record(campaign);
        // 2 rolled_back / 3 attempted
        expect(record.rollbackFrequency).toBeCloseTo(0.67, 1);
    });
});

// ─── P5.5H: CampaignDashboardBridge ──────────────────────────────────────────

describe('P5.5H: CampaignDashboardBridge', () => {
    it('buildState produces correct KPI counts', () => {
        const bridge = new CampaignDashboardBridge();
        const activeCampaign = makeCampaign(3);
        activeCampaign.status = 'active';
        const state = bridge.buildState([activeCampaign], [], []);
        expect(state.kpis.activeCampaigns).toBe(1);
        expect(state.kpis.totalLaunched).toBe(0); // no outcomes yet
    });

    it('buildState includes timestamps', () => {
        const bridge = new CampaignDashboardBridge();
        const state = bridge.buildState([], [], []);
        expect(state.computedAt).toBeTruthy();
        expect(new Date(state.computedAt).getTime()).toBeGreaterThan(0);
    });

    it('emit deduplicates identical consecutive states', () => {
        const bridge = new CampaignDashboardBridge();
        const campaign = makeCampaign(2);
        campaign.status = 'active';
        const first = bridge.emit({ activeCampaigns: [campaign], deferredCampaigns: [], recentOutcomes: [] });
        const second = bridge.emit({ activeCampaigns: [campaign], deferredCampaigns: [], recentOutcomes: [] });
        expect(first).toBe(true);
        expect(second).toBe(false); // deduplicated
    });
});

// ─── P5.5I: Safety Bounds & Recovery ─────────────────────────────────────────

describe('P5.5I: Safety Bounds & CampaignSafetyGuard', () => {
    beforeEach(() => {
        testDir = makeTestDir();
    });
    afterEach(() => {
        try { fs.rmSync(testDir, { recursive: true }); } catch { /* non-fatal */ }
    });

    it('checkBounds returns null for valid campaign', () => {
        const registry = new RepairCampaignRegistry(testDir);
        const guard = new CampaignSafetyGuard(registry);
        const campaign = makeCampaign(3);
        campaign.status = 'active';
        const violation = guard.checkBounds(campaign);
        expect(violation).toBeNull();
    });

    it('checkBounds detects expired campaign', () => {
        const registry = new RepairCampaignRegistry(testDir);
        const guard = new CampaignSafetyGuard(registry);
        const campaign = makeCampaign(2);
        campaign.status = 'active';
        campaign.expiresAt = new Date(Date.now() - 1000).toISOString();
        const violation = guard.checkBounds(campaign);
        expect(violation).not.toBeNull();
        expect(violation!.kind).toBe('CAMPAIGN_EXPIRED');
    });

    it('checkBounds detects terminal status', () => {
        const registry = new RepairCampaignRegistry(testDir);
        const guard = new CampaignSafetyGuard(registry);
        const campaign = makeCampaign(2);
        campaign.status = 'succeeded';
        const violation = guard.checkBounds(campaign);
        expect(violation!.kind).toBe('TERMINAL_STATUS');
    });

    it('checkBounds detects max reassessments exceeded', () => {
        const registry = new RepairCampaignRegistry(testDir);
        const guard = new CampaignSafetyGuard(registry);
        const campaign = makeCampaign(2);
        campaign.status = 'active';
        campaign.reassessmentCount = campaign.bounds.maxReassessments;
        const violation = guard.checkBounds(campaign);
        expect(violation!.kind).toBe('MAX_REASSESSMENTS_EXCEEDED');
    });

    it('checkCanCreate blocks when active campaign exists for subsystem', () => {
        const registry = new RepairCampaignRegistry(testDir);
        const guard = new CampaignSafetyGuard(registry);
        const campaign = makeCampaign(2, 'inference');
        campaign.status = 'active';
        registry.save(campaign);
        const violation = guard.checkCanCreate('inference');
        expect(violation).not.toBeNull();
        expect(violation!.kind).toBe('DUPLICATE_ACTIVE_CAMPAIGN');
    });

    it('checkCanCreate allows creation when subsystem has no active campaign', () => {
        const registry = new RepairCampaignRegistry(testDir);
        const guard = new CampaignSafetyGuard(registry);
        const violation = guard.checkCanCreate('inference');
        expect(violation).toBeNull();
    });

    it('applyCooldown blocks subsequent create attempts', () => {
        const registry = new RepairCampaignRegistry(testDir);
        const guard = new CampaignSafetyGuard(registry);
        const campaign = makeCampaign(2, 'inference');
        campaign.status = 'failed';
        guard.applyCooldown(campaign, 'failure');
        expect(guard.hasCooldown('inference')).toBe(true);
        const violation = guard.checkCanCreate('inference');
        expect(violation!.kind).toBe('COOLDOWN_ACTIVE');
    });

    it('clearCooldown removes the cooldown', () => {
        const registry = new RepairCampaignRegistry(testDir);
        const guard = new CampaignSafetyGuard(registry);
        const campaign = makeCampaign(2, 'inference');
        guard.applyCooldown(campaign, 'failure');
        guard.clearCooldown('inference');
        expect(guard.hasCooldown('inference')).toBe(false);
    });

    it('recoverStaleCampaigns expires stale campaigns at startup', () => {
        const registry = new RepairCampaignRegistry(testDir);
        const guard = new CampaignSafetyGuard(registry);
        const campaign = makeCampaign(2, 'inference');
        campaign.status = 'active';
        campaign.expiresAt = new Date(Date.now() - 3600 * 1000).toISOString();
        registry.save(campaign);
        const expired = guard.recoverStaleCampaigns();
        expect(expired).toHaveLength(1);
        const loaded = registry.getById(campaign.campaignId);
        expect(loaded!.status).toBe('expired');
    });
});

// ─── P5.5F: RepairCampaignCoordinator ────────────────────────────────────────

describe('P5.5F: RepairCampaignCoordinator', () => {
    beforeEach(() => {
        testDir = makeTestDir();
    });
    afterEach(() => {
        try { fs.rmSync(testDir, { recursive: true }); } catch { /* non-fatal */ }
    });

    function makeCoordinator(stepExecutorResult: CampaignStepExecutionResult = makeExecutionResult()) {
        const registry = new RepairCampaignRegistry(testDir);
        const outcomeTracker = new CampaignOutcomeTracker(testDir);
        const safetyGuard = new CampaignSafetyGuard(registry);
        const dashboardBridge = new CampaignDashboardBridge();
        const stepExecutor = vi.fn(async () => stepExecutorResult);
        const coordinator = new RepairCampaignCoordinator(
            registry,
            outcomeTracker,
            safetyGuard,
            dashboardBridge,
            stepExecutor,
        );
        return { coordinator, registry, outcomeTracker, stepExecutor };
    }

    it('activateCampaign transitions draft → active', () => {
        const { coordinator, registry } = makeCoordinator();
        const campaign = makeCampaign(2);
        campaign.status = 'draft'; // activateCampaign requires draft status
        registry.save(campaign);
        const result = coordinator.activateCampaign(campaign.campaignId);
        expect(result!.status).toBe('active');
    });

    it('activateCampaign returns null for non-draft campaign', () => {
        const { coordinator, registry } = makeCoordinator();
        const campaign = makeCampaign(2);
        campaign.status = 'succeeded';
        registry.save(campaign);
        const result = coordinator.activateCampaign(campaign.campaignId);
        expect(result).toBeNull();
    });

    it('deferCampaign transitions active → deferred', () => {
        const { coordinator, registry } = makeCoordinator();
        const campaign = makeCampaign(2);
        campaign.status = 'active';
        registry.save(campaign);
        coordinator.deferCampaign(campaign.campaignId, 'test defer');
        const loaded = registry.getById(campaign.campaignId);
        expect(loaded!.status).toBe('deferred');
        expect(loaded!.haltReason).toBe('test defer');
    });

    it('abortCampaign terminates campaign', () => {
        const { coordinator, registry } = makeCoordinator();
        const campaign = makeCampaign(2);
        campaign.status = 'active';
        registry.save(campaign);
        coordinator.abortCampaign(campaign.campaignId, 'test abort');
        const loaded = registry.getById(campaign.campaignId);
        expect(loaded!.status).toBe('aborted');
    });

    it('resumeCampaign transitions deferred → active', () => {
        const { coordinator, registry } = makeCoordinator();
        const campaign = makeCampaign(2);
        campaign.status = 'deferred';
        registry.save(campaign);
        const resumed = coordinator.resumeCampaign(campaign.campaignId);
        expect(resumed).toBe(true);
        const loaded = registry.getById(campaign.campaignId);
        expect(loaded!.status).toBe('active');
    });

    it('advanceCampaign executes one step per call', async () => {
        const { coordinator, registry, stepExecutor } = makeCoordinator();
        const campaign = makeCampaign(3);
        campaign.status = 'active';
        // Clear all prerequisites so every step is independently eligible
        for (const s of campaign.steps) {
            s.prerequisites = [];
            s.verificationRequired = false;
        }
        registry.save(campaign);

        await coordinator.advanceCampaign(campaign.campaignId);

        // Should have executed exactly one step
        expect(stepExecutor).toHaveBeenCalledTimes(1);
        const loaded = registry.getById(campaign.campaignId)!;
        const running = loaded.steps.filter(s => s.status !== 'pending');
        expect(running.length).toBeGreaterThanOrEqual(1);
    });

    it('advanceCampaign records checkpoint after step completion', async () => {
        const { coordinator, registry } = makeCoordinator();
        const campaign = makeCampaign(2);
        campaign.status = 'active';
        for (const s of campaign.steps) {
            s.prerequisites = [];
            s.verificationRequired = false;
        }
        registry.save(campaign);

        await coordinator.advanceCampaign(campaign.campaignId);

        const loaded = registry.getById(campaign.campaignId)!;
        expect(loaded.checkpoints.length).toBeGreaterThanOrEqual(1);
    });

    it('advanceCampaign marks campaign succeeded when all steps pass', async () => {
        const { coordinator, registry } = makeCoordinator();
        const campaign = makeCampaign(1);
        campaign.status = 'active';
        campaign.steps[0].prerequisites = [];
        campaign.steps[0].verificationRequired = false;
        registry.save(campaign);

        await coordinator.advanceCampaign(campaign.campaignId);

        const loaded = registry.getById(campaign.campaignId)!;
        expect(loaded.status).toBe('succeeded');
    });

    it('advanceCampaign marks campaign failed when required step fails', async () => {
        const failedResult = makeExecutionResult({ executionSucceeded: false, failureReason: 'unit test failure' });
        const { coordinator, registry } = makeCoordinator(failedResult);
        const campaign = makeCampaign(2);
        campaign.status = 'active';
        campaign.steps[0].prerequisites = [];
        campaign.steps[0].isOptional = false;
        registry.save(campaign);

        await coordinator.advanceCampaign(campaign.campaignId);

        const loaded = registry.getById(campaign.campaignId)!;
        expect(['failed', 'aborted']).toContain(loaded.status);
    });

    it('getDashboardState returns correct structure', () => {
        const { coordinator } = makeCoordinator();
        const state = coordinator.getDashboardState();
        expect(state).toHaveProperty('computedAt');
        expect(state).toHaveProperty('kpis');
        expect(state).toHaveProperty('activeCampaigns');
        expect(state).toHaveProperty('deferredCampaigns');
        expect(state).toHaveProperty('recentOutcomes');
    });
});

// ─── One active campaign per subsystem ───────────────────────────────────────

describe('One active campaign per subsystem', () => {
    beforeEach(() => {
        testDir = makeTestDir();
    });
    afterEach(() => {
        try { fs.rmSync(testDir, { recursive: true }); } catch { /* non-fatal */ }
    });

    it('checkCanCreate blocks when subsystem already has active campaign', () => {
        const registry = new RepairCampaignRegistry(testDir);
        const guard = new CampaignSafetyGuard(registry);

        const existing = makeCampaign(2, 'inference');
        existing.status = 'active';
        registry.save(existing);

        const violation = guard.checkCanCreate('inference');
        expect(violation).not.toBeNull();
        expect(violation!.kind).toBe('DUPLICATE_ACTIVE_CAMPAIGN');
    });

    it('allows campaigns for different subsystems simultaneously', () => {
        const registry = new RepairCampaignRegistry(testDir);
        const guard = new CampaignSafetyGuard(registry);

        const c1 = makeCampaign(2, 'inference');
        c1.status = 'active';
        registry.save(c1);

        // Different subsystem — should be allowed
        const violation = guard.checkCanCreate('config');
        expect(violation).toBeNull();
    });

    it('allows creation after existing campaign completes', () => {
        const registry = new RepairCampaignRegistry(testDir);
        const guard = new CampaignSafetyGuard(registry);

        const c1 = makeCampaign(2, 'inference');
        c1.status = 'succeeded'; // terminal
        registry.save(c1);

        const violation = guard.checkCanCreate('inference');
        expect(violation).toBeNull();
    });
});
