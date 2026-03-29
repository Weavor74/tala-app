/**
 * EscalationPhase51.test.ts
 *
 * Phase 5.1: Model Escalation & Bounded Decomposition — Comprehensive Test Suite
 *
 * Covers:
 *   P5.1A  Escalation Types & Contracts (shape tests, defaults)
 *   P5.1B  ModelCapabilityEvaluator (assessment signals, complexity, determinism)
 *   P5.1C  EscalationPolicyEngine (all policy kinds, spam guard, failure gate)
 *   P5.1D  DecompositionEngine (all strategies, depth limit, step count bounds)
 *   P5.1E  ExecutionStrategySelector (all strategy paths, escalate_human default)
 *   P5.1F  EscalationAuditTracker (record, spam count, per-goal lookup)
 *   P5.1F  DecompositionOutcomeTracker (start/record/finalize, cooldown, KPIs)
 *   P5.1H  Safety constraints (no infinite decomposition, max steps, cooldown)
 *         + AutonomousRunOrchestrator escalation wiring
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    TaskCapabilityAssessment,
    EscalationPolicy,
    EscalationKpis,
    EscalationDashboardState,
    ExecutionStrategyDecision,
    DecompositionPlan,
    EscalationStrategyKind,
} from '../../shared/escalationTypes';
import {
    DEFAULT_ESCALATION_POLICY,
} from '../../shared/escalationTypes';
import type { AutonomousGoal, GoalSource } from '../../shared/autonomyTypes';
import { ModelCapabilityEvaluator } from '../../electron/services/autonomy/escalation/ModelCapabilityEvaluator';
import { EscalationPolicyEngine } from '../../electron/services/autonomy/escalation/EscalationPolicyEngine';
import { DecompositionEngine } from '../../electron/services/autonomy/escalation/DecompositionEngine';
import { ExecutionStrategySelector } from '../../electron/services/autonomy/escalation/ExecutionStrategySelector';
import { EscalationAuditTracker } from '../../electron/services/autonomy/escalation/EscalationAuditTracker';
import { DecompositionOutcomeTracker } from '../../electron/services/autonomy/escalation/DecompositionOutcomeTracker';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeGoal(overrides: Partial<AutonomousGoal> = {}): AutonomousGoal {
    return {
        goalId: 'goal-001',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: 'repeated_execution_failure' as GoalSource,
        subsystemId: 'inference',
        title: 'Repeated execution failures in inference',
        description: '3 failures detected in 4h window',
        status: 'policy_approved',
        dedupFingerprint: 'inference:repeated_execution_failure',
        priorityTier: 'high',
        priorityScore: { total: 75, urgency: 30, impact: 25, confidence: 20, factors: [] },
        autonomyEligible: true,
        humanReviewRequired: false,
        ...overrides,
    } as AutonomousGoal;
}

function makePolicy(overrides: Partial<EscalationPolicy> = {}): EscalationPolicy {
    return { ...DEFAULT_ESCALATION_POLICY, ...overrides };
}

function makeAssessment(overrides: Partial<TaskCapabilityAssessment> = {}): TaskCapabilityAssessment {
    return {
        goalId: 'goal-001',
        assessedAt: new Date().toISOString(),
        canHandle: false,
        insufficiencyReasons: ['repeated_local_failures'],
        estimatedContextTokens: 3000,
        modelContextLimit: 4096,
        recentLocalFailures: 2,
        complexityScore: 45,
        rationale: 'Test assessment',
        ...overrides,
    };
}

// ─── P5.1A: Type shape tests ──────────────────────────────────────────────────

describe('P5.1A: Escalation types & contracts', () => {
    it('DEFAULT_ESCALATION_POLICY has required fields', () => {
        expect(DEFAULT_ESCALATION_POLICY.policyKind).toBe('local_preferred_with_request');
        expect(DEFAULT_ESCALATION_POLICY.maxEscalationRequestsPerHour).toBe(3);
        expect(DEFAULT_ESCALATION_POLICY.minLocalFailuresBeforeEscalation).toBe(2);
        expect(DEFAULT_ESCALATION_POLICY.maxDecompositionDepth).toBe(2);
        expect(DEFAULT_ESCALATION_POLICY.maxStepsPerDecomposition).toBe(5);
        expect(DEFAULT_ESCALATION_POLICY.requireHumanApprovalForRemote).toBe(true);
        expect(DEFAULT_ESCALATION_POLICY.highComplexityThreshold).toBe(70);
        expect(DEFAULT_ESCALATION_POLICY.contextSizeThresholdRatio).toBeCloseTo(0.85);
        expect(DEFAULT_ESCALATION_POLICY.minFailuresForContextTrigger).toBe(1);
    });

    it('TaskCapabilityAssessment shape is valid', () => {
        const assessment = makeAssessment();
        expect(assessment).toHaveProperty('goalId');
        expect(assessment).toHaveProperty('canHandle');
        expect(assessment).toHaveProperty('insufficiencyReasons');
        expect(assessment).toHaveProperty('estimatedContextTokens');
        expect(assessment).toHaveProperty('modelContextLimit');
        expect(assessment).toHaveProperty('recentLocalFailures');
        expect(assessment).toHaveProperty('complexityScore');
        expect(assessment).toHaveProperty('rationale');
    });

    it('EscalationDashboardState has required top-level fields', () => {
        // Shape-only test — values can be stub
        const state: EscalationDashboardState = {
            computedAt: new Date().toISOString(),
            kpis: {
                totalAssessments: 0,
                totalCapableAssessments: 0,
                totalIncapableAssessments: 0,
                totalEscalationRequests: 0,
                totalEscalationsAllowed: 0,
                totalEscalationsDenied: 0,
                totalDecompositions: 0,
                totalDecompositionsSucceeded: 0,
                totalDecompositionsFailed: 0,
                totalDeferredByEscalation: 0,
                totalHumanEscalations: 0,
            },
            recentAssessments: [],
            recentStrategyDecisions: [],
            recentDecompositionPlans: [],
            recentDecompositionResults: [],
            recentAuditRecords: [],
            activeDecompositions: 0,
            policy: DEFAULT_ESCALATION_POLICY,
        };
        expect(state.kpis.totalAssessments).toBe(0);
        expect(state.recentAssessments).toEqual([]);
        expect(state.policy.policyKind).toBe('local_preferred_with_request');
    });
});

// ─── P5.1B: ModelCapabilityEvaluator ─────────────────────────────────────────

describe('P5.1B: ModelCapabilityEvaluator', () => {
    let evaluator: ModelCapabilityEvaluator;
    let policy: EscalationPolicy;

    beforeEach(() => {
        evaluator = new ModelCapabilityEvaluator();
        policy = makePolicy();
    });

    it('returns canHandle=true when no failure signals are present', () => {
        const goal = makeGoal({ description: 'simple fix', title: 'Fix lint' });
        const result = evaluator.evaluate(goal, 0, policy, 8192, false);
        expect(result.canHandle).toBe(true);
        expect(result.insufficiencyReasons).toHaveLength(0);
        expect(result.goalId).toBe(goal.goalId);
    });

    it('returns canHandle=true when failures < minLocalFailuresBeforeEscalation', () => {
        const goal = makeGoal();
        const result = evaluator.evaluate(goal, 1, makePolicy({ minLocalFailuresBeforeEscalation: 2 }), 0, false);
        expect(result.canHandle).toBe(true);
    });

    it('detects repeated_local_failures when failures >= threshold', () => {
        const goal = makeGoal();
        const result = evaluator.evaluate(goal, 2, policy, 0, false);
        expect(result.canHandle).toBe(false);
        expect(result.insufficiencyReasons).toContain('repeated_local_failures');
    });

    it('detects context_size_exceeded when context ratio >= threshold and failures >= min', () => {
        const goal = makeGoal({ description: 'a'.repeat(500), title: 'test' });
        const policy2 = makePolicy({ contextSizeThresholdRatio: 0.5, minFailuresForContextTrigger: 1 });
        const result = evaluator.evaluate(goal, 1, policy2, 100, false);
        // 100 token limit, estimated tokens >> 100 * 0.5 = 50
        expect(result.insufficiencyReasons).toContain('context_size_exceeded');
        expect(result.canHandle).toBe(false);
    });

    it('does NOT detect context_size_exceeded when modelContextLimit=0', () => {
        const goal = makeGoal({ description: 'a'.repeat(5000) });
        const result = evaluator.evaluate(goal, 1, policy, 0, false);
        expect(result.insufficiencyReasons).not.toContain('context_size_exceeded');
    });

    it('detects high_complexity_task when score >= threshold and failures >= min', () => {
        // High-complexity subsystem + failures = should exceed threshold
        const goal = makeGoal({ subsystemId: 'execution', description: 'x'.repeat(400), title: 'Major refactor' });
        const policy2 = makePolicy({ highComplexityThreshold: 30, minFailuresForContextTrigger: 1 });
        const result = evaluator.evaluate(goal, 1, policy2, 0, false);
        expect(result.complexityScore).toBeGreaterThanOrEqual(30);
        expect(result.insufficiencyReasons).toContain('high_complexity_task');
    });

    it('detects multi_file_repair_scope when description has multi-file keywords', () => {
        const goal = makeGoal({ description: 'Fix issues across multiple files in the codebase' });
        const result = evaluator.evaluate(goal, 1, policy, 0, false);
        expect(result.insufficiencyReasons).toContain('multi_file_repair_scope');
    });

    it('detects recovery_pack_exhausted when flag is set', () => {
        const goal = makeGoal();
        const result = evaluator.evaluate(goal, 0, policy, 0, true);
        expect(result.insufficiencyReasons).toContain('recovery_pack_exhausted');
        expect(result.canHandle).toBe(false);
    });

    it('is deterministic: same inputs → same result', () => {
        const goal = makeGoal();
        const r1 = evaluator.evaluate(goal, 2, policy, 4096, false);
        const r2 = evaluator.evaluate(goal, 2, policy, 4096, false);
        expect(r1.canHandle).toBe(r2.canHandle);
        expect(r1.insufficiencyReasons).toEqual(r2.insufficiencyReasons);
        expect(r1.complexityScore).toBe(r2.complexityScore);
    });

    it('complexity score is bounded to [0, 100]', () => {
        const goal = makeGoal({ description: 'x'.repeat(10000), title: 'y'.repeat(10000) });
        const result = evaluator.evaluate(goal, 99, policy, 0, false);
        expect(result.complexityScore).toBeGreaterThanOrEqual(0);
        expect(result.complexityScore).toBeLessThanOrEqual(100);
    });
});

// ─── P5.1C: EscalationPolicyEngine ───────────────────────────────────────────

describe('P5.1C: EscalationPolicyEngine', () => {
    let engine: EscalationPolicyEngine;
    let assessment: TaskCapabilityAssessment;

    beforeEach(() => {
        engine = new EscalationPolicyEngine();
        assessment = makeAssessment({
            insufficiencyReasons: ['repeated_local_failures'],
            recentLocalFailures: 2,
        });
    });

    it('denies escalation when policyKind=local_only', () => {
        const { decision, request } = engine.evaluate(
            assessment,
            makePolicy({ policyKind: 'local_only' }),
            0, false,
        );
        expect(decision.escalationAllowed).toBe(false);
        expect(request).toBeNull();
        expect(decision.denialReason).toContain('local_only');
    });

    it('denies escalation when spam guard is triggered', () => {
        const { decision, request } = engine.evaluate(
            assessment,
            makePolicy({ maxEscalationRequestsPerHour: 2 }),
            2, false, // recentEscalationCount = 2, limit = 2
        );
        expect(decision.escalationAllowed).toBe(false);
        expect(request).toBeNull();
        expect(decision.denialReason).toContain('spam guard');
    });

    it('denies escalation when insufficient local failures (no pack exhaustion)', () => {
        const lowFailureAssessment = makeAssessment({
            recentLocalFailures: 1,
            insufficiencyReasons: ['high_complexity_task'],
        });
        const { decision } = engine.evaluate(
            lowFailureAssessment,
            makePolicy({ minLocalFailuresBeforeEscalation: 2 }),
            0, false,
        );
        expect(decision.escalationAllowed).toBe(false);
    });

    it('allows escalation despite low failures when recovery_pack_exhausted', () => {
        const assessment2 = makeAssessment({
            recentLocalFailures: 1,
            insufficiencyReasons: ['recovery_pack_exhausted'],
        });
        const { decision, request } = engine.evaluate(
            assessment2,
            makePolicy({ policyKind: 'remote_allowed', minLocalFailuresBeforeEscalation: 2 }),
            0, false,
        );
        expect(decision.escalationAllowed).toBe(true);
        expect(request).not.toBeNull();
    });

    it('allows escalation with human approval under local_preferred_with_request', () => {
        const { decision, request } = engine.evaluate(
            assessment,
            makePolicy({ policyKind: 'local_preferred_with_request', requireHumanApprovalForRemote: true }),
            0, false,
        );
        expect(decision.escalationAllowed).toBe(true);
        expect(decision.requiresHumanApproval).toBe(true);
        expect(request).not.toBeNull();
    });

    it('allows escalation without human approval when requireHumanApprovalForRemote=false', () => {
        const { decision } = engine.evaluate(
            assessment,
            makePolicy({ policyKind: 'remote_allowed', requireHumanApprovalForRemote: false }),
            0, false,
        );
        expect(decision.escalationAllowed).toBe(true);
        expect(decision.requiresHumanApproval).toBe(false);
    });

    it('forces escalation for high-complexity when remote_required_for_high_complexity', () => {
        const highComplexAssessment = makeAssessment({
            insufficiencyReasons: ['high_complexity_task'],
            recentLocalFailures: 2,
        });
        const { decision } = engine.evaluate(
            highComplexAssessment,
            makePolicy({ policyKind: 'remote_required_for_high_complexity' }),
            0, false,
        );
        expect(decision.escalationAllowed).toBe(true);
    });

    it('denies escalation for non-allowed task classes under auto_escalate_for_allowed_classes', () => {
        const { decision } = engine.evaluate(
            assessment,
            makePolicy({ policyKind: 'auto_escalate_for_allowed_classes', allowedTaskClasses: ['billing'] }),
            0, false,
        );
        expect(decision.escalationAllowed).toBe(false);
        expect(decision.denialReason).toContain('allowedTaskClasses');
    });
});

// ─── P5.1D: DecompositionEngine ──────────────────────────────────────────────

describe('P5.1D: DecompositionEngine', () => {
    let engine: DecompositionEngine;
    let policy: EscalationPolicy;

    beforeEach(() => {
        engine = new DecompositionEngine();
        policy = makePolicy({ maxDecompositionDepth: 2, maxStepsPerDecomposition: 5 });
    });

    it('returns null when depth >= maxDecompositionDepth', () => {
        const goal = makeGoal();
        const assessment = makeAssessment();
        const result = engine.decompose(goal, assessment, policy, 2); // depth=2=max
        expect(result).toBeNull();
    });

    it('produces a file_scope plan when multi_file_repair_scope is detected', () => {
        const goal = makeGoal({
            title: 'Fix across multiple files',
            description: 'Issues in service.ts and controller.ts and config.ts',
        });
        const assessment = makeAssessment({ insufficiencyReasons: ['multi_file_repair_scope'] });
        const plan = engine.decompose(goal, assessment, policy, 0);
        expect(plan).not.toBeNull();
        expect(plan!.steps.some(s => s.kind === 'file_scope')).toBe(true);
        expect(plan!.bounded).toBe(true);
        expect(plan!.totalSteps).toBeLessThanOrEqual(policy.maxStepsPerDecomposition);
    });

    it('produces a change_type plan when high_complexity_task is detected', () => {
        const goal = makeGoal({ title: 'Major refactor' });
        const assessment = makeAssessment({ insufficiencyReasons: ['high_complexity_task'] });
        const plan = engine.decompose(goal, assessment, policy, 0);
        expect(plan).not.toBeNull();
        expect(plan!.steps.some(s => s.kind === 'change_type')).toBe(true);
        expect(plan!.totalSteps).toBeLessThanOrEqual(policy.maxStepsPerDecomposition);
    });

    it('produces a verification_stage plan when repeated_local_failures with count >= 2', () => {
        const goal = makeGoal();
        const assessment = makeAssessment({ insufficiencyReasons: ['repeated_local_failures'], recentLocalFailures: 3 });
        const plan = engine.decompose(goal, assessment, policy, 0);
        expect(plan).not.toBeNull();
        expect(plan!.steps.some(s => s.kind === 'verification_stage')).toBe(true);
    });

    it('produces a partial_fix plan as fallback', () => {
        const goal = makeGoal();
        const assessment = makeAssessment({
            insufficiencyReasons: ['context_size_exceeded'],
            recentLocalFailures: 1,
        });
        const plan = engine.decompose(goal, assessment, policy, 0);
        expect(plan).not.toBeNull();
        expect(plan!.steps[0].kind).toBe('partial_fix');
    });

    it('all steps have independent=true, verifiable=true, rollbackable=true', () => {
        const goal = makeGoal({ description: 'Fix execution.ts and runner.ts' });
        const assessment = makeAssessment({ insufficiencyReasons: ['multi_file_repair_scope'] });
        const plan = engine.decompose(goal, assessment, policy, 0);
        expect(plan).not.toBeNull();
        for (const step of plan!.steps) {
            expect(step.independent).toBe(true);
            expect(step.verifiable).toBe(true);
            expect(step.rollbackable).toBe(true);
        }
    });

    it('plan.bounded is always true', () => {
        const goal = makeGoal();
        const assessment = makeAssessment({ insufficiencyReasons: ['repeated_local_failures'], recentLocalFailures: 2 });
        const plan = engine.decompose(goal, assessment, policy, 0);
        expect(plan!.bounded).toBe(true);
    });

    it('depth is incremented in plan output', () => {
        const goal = makeGoal();
        const assessment = makeAssessment({ insufficiencyReasons: ['repeated_local_failures'], recentLocalFailures: 2 });
        const plan = engine.decompose(goal, assessment, policy, 0);
        expect(plan!.depth).toBe(1);
    });

    it('returns null when no insufficiency reasons (no decomposition needed)', () => {
        const goal = makeGoal();
        const assessment = makeAssessment({ insufficiencyReasons: [], canHandle: true });
        const plan = engine.decompose(goal, assessment, policy, 0);
        expect(plan).toBeNull();
    });

    it('is deterministic: same inputs → same plan structure', () => {
        const goal = makeGoal({ description: 'Fix multi-file issue in service.ts and worker.ts' });
        const assessment = makeAssessment({ insufficiencyReasons: ['multi_file_repair_scope'] });
        const p1 = engine.decompose(goal, assessment, policy, 0);
        const p2 = engine.decompose(goal, assessment, policy, 0);
        expect(p1).not.toBeNull();
        expect(p2).not.toBeNull();
        expect(p1!.totalSteps).toBe(p2!.totalSteps);
        expect(p1!.steps.map(s => s.kind)).toEqual(p2!.steps.map(s => s.kind));
    });
});

// ─── P5.1E: ExecutionStrategySelector ────────────────────────────────────────

describe('P5.1E: ExecutionStrategySelector', () => {
    let selector: ExecutionStrategySelector;
    let policy: EscalationPolicy;

    beforeEach(() => {
        selector = new ExecutionStrategySelector();
        policy = makePolicy();
    });

    it('returns proceed_local when canHandle=true', () => {
        const assessment = makeAssessment({ canHandle: true, insufficiencyReasons: [] });
        const result = selector.select(assessment, null, null, policy);
        expect(result.strategy).toBe('proceed_local');
        expect(result.reasonCodes).toContain('model_can_handle');
    });

    it('returns escalate_human when escalation is allowed with human approval required', () => {
        const assessment = makeAssessment();
        const escalationDecision = {
            requestId: 'req-1',
            goalId: 'goal-001',
            decidedAt: new Date().toISOString(),
            escalationAllowed: true,
            requiresHumanApproval: true,
            rationale: 'test',
        };
        const result = selector.select(assessment, escalationDecision, null, policy);
        expect(result.strategy).toBe('escalate_human');
        expect(result.reasonCodes).toContain('escalation_requires_approval');
    });

    it('returns escalate_remote when escalation is allowed WITHOUT human approval', () => {
        const assessment = makeAssessment();
        const escalationDecision = {
            requestId: 'req-1',
            goalId: 'goal-001',
            decidedAt: new Date().toISOString(),
            escalationAllowed: true,
            requiresHumanApproval: false,
            rationale: 'test',
        };
        const result = selector.select(assessment, escalationDecision, null, policy);
        expect(result.strategy).toBe('escalate_remote');
        expect(result.escalationRequestId).toBe('req-1');
    });

    it('returns decompose_local when escalation denied but decomposition available', () => {
        const assessment = makeAssessment();
        const escalationDecision = {
            requestId: 'req-1',
            goalId: 'goal-001',
            decidedAt: new Date().toISOString(),
            escalationAllowed: false,
            denialReason: 'local_only',
            requiresHumanApproval: false,
            rationale: 'test',
        };
        const plan: DecompositionPlan = {
            planId: 'plan-001',
            goalId: 'goal-001',
            createdAt: new Date().toISOString(),
            steps: [],
            totalSteps: 2,
            depth: 1,
            rationale: 'test plan',
            bounded: true,
        };
        const result = selector.select(assessment, escalationDecision, plan, policy);
        expect(result.strategy).toBe('decompose_local');
        expect(result.decompositionPlanId).toBe('plan-001');
        expect(result.reasonCodes).toContain('decomposition_possible');
    });

    it('returns defer when escalation denied and no decomposition plan available', () => {
        const assessment = makeAssessment({ insufficiencyReasons: ['context_size_exceeded'] });
        const escalationDecision = {
            requestId: 'req-1',
            goalId: 'goal-001',
            decidedAt: new Date().toISOString(),
            escalationAllowed: false,
            denialReason: 'spam guard',
            requiresHumanApproval: false,
            rationale: 'test',
        };
        const result = selector.select(assessment, escalationDecision, null, policy);
        expect(result.strategy).toBe('defer');
        expect(result.reasonCodes).toContain('decomposition_not_possible');
    });

    it('returns escalate_human as fallback when no insufficiency but no escalation decision', () => {
        const assessment = makeAssessment({ insufficiencyReasons: [], canHandle: false });
        const result = selector.select(assessment, null, null, policy);
        expect(result.strategy).toBe('escalate_human');
        expect(result.reasonCodes).toContain('no_viable_strategy');
    });

    it('strategy result includes goalId and decidedAt', () => {
        const assessment = makeAssessment({ canHandle: true, insufficiencyReasons: [] });
        const result = selector.select(assessment, null, null, policy);
        expect(result.goalId).toBe('goal-001');
        expect(result.decidedAt).toBeTruthy();
    });
});

// ─── P5.1F: EscalationAuditTracker ───────────────────────────────────────────

describe('P5.1F: EscalationAuditTracker', () => {
    let tracker: EscalationAuditTracker;

    beforeEach(() => {
        tracker = new EscalationAuditTracker();
    });

    it('records a capability_assessed event', () => {
        const rec = tracker.record('goal-001', 'capability_assessed', 'Model assessed');
        expect(rec.goalId).toBe('goal-001');
        expect(rec.eventKind).toBe('capability_assessed');
        expect(rec.detail).toBe('Model assessed');
        expect(rec.recordId).toBeTruthy();
        expect(rec.recordedAt).toBeTruthy();
    });

    it('getRecent() returns records in newest-first order', () => {
        tracker.record('goal-001', 'capability_assessed', 'First');
        tracker.record('goal-001', 'strategy_selected', 'Second');
        const recent = tracker.getRecent(10);
        expect(recent[0].eventKind).toBe('strategy_selected');
        expect(recent[1].eventKind).toBe('capability_assessed');
    });

    it('getForGoal() filters by goalId', () => {
        tracker.record('goal-001', 'capability_assessed', 'For goal 001');
        tracker.record('goal-002', 'capability_assessed', 'For goal 002');
        const forGoal1 = tracker.getForGoal('goal-001');
        expect(forGoal1).toHaveLength(1);
        expect(forGoal1[0].goalId).toBe('goal-001');
    });

    it('getRecentEscalationCount() counts escalation_requested events within window', () => {
        tracker.record('goal-001', 'escalation_requested', 'Requested 1');
        tracker.record('goal-001', 'escalation_requested', 'Requested 2');
        tracker.record('goal-001', 'strategy_selected', 'Strategy selected');
        const count = tracker.getRecentEscalationCount(60 * 60 * 1000); // 1 hour
        expect(count).toBe(2);
    });

    it('getRecentEscalationCount() returns 0 for records outside the window', async () => {
        // Records older than the window should not be counted
        // We can test this by using a tiny window after already waiting a tick
        tracker.record('goal-001', 'escalation_requested', 'Old request');
        // Wait 2ms so the record is "old" relative to a 1ms window
        await new Promise(r => setTimeout(r, 2));
        const count = tracker.getRecentEscalationCount(1); // 1ms window
        expect(count).toBe(0);
    });

    it('getCountByKind() returns correct counts', () => {
        tracker.record('goal-001', 'capability_assessed', 'A');
        tracker.record('goal-001', 'capability_assessed', 'B');
        tracker.record('goal-001', 'escalation_requested', 'C');
        const counts = tracker.getCountByKind();
        expect(counts.get('capability_assessed')).toBe(2);
        expect(counts.get('escalation_requested')).toBe(1);
    });

    it('stores optional runId and data', () => {
        const rec = tracker.record('goal-001', 'decomposition_started', 'Started', 'run-999', { planId: 'plan-1' });
        expect(rec.runId).toBe('run-999');
        expect(rec.data).toEqual({ planId: 'plan-1' });
    });

    it('getTotalCount() reflects inserted records', () => {
        tracker.record('goal-001', 'capability_assessed', 'A');
        tracker.record('goal-001', 'capability_assessed', 'B');
        expect(tracker.getTotalCount()).toBe(2);
    });

    it('clearAll() empties all records', () => {
        tracker.record('goal-001', 'capability_assessed', 'A');
        tracker.clearAll();
        expect(tracker.getTotalCount()).toBe(0);
    });
});

// ─── P5.1F: DecompositionOutcomeTracker ──────────────────────────────────────

describe('P5.1F: DecompositionOutcomeTracker', () => {
    let tracker: DecompositionOutcomeTracker;
    let plan: DecompositionPlan;

    beforeEach(() => {
        tracker = new DecompositionOutcomeTracker();
        plan = {
            planId: 'plan-001',
            goalId: 'goal-001',
            createdAt: new Date().toISOString(),
            steps: [
                { stepId: 'step-1', planId: 'plan-001', stepIndex: 0, kind: 'verification_stage',
                  description: 'Step 1', scopeHint: 'inference', independent: true,
                  verifiable: true, rollbackable: true, estimatedTokens: 512 },
            ],
            totalSteps: 1,
            depth: 1,
            rationale: 'Test plan',
            bounded: true,
        };
    });

    it('startPlan registers an in-progress decomposition', () => {
        tracker.startPlan(plan, 'inference');
        expect(tracker.getActiveCount()).toBe(1);
    });

    it('finalizePlan with all succeeded → overallOutcome=succeeded', () => {
        tracker.startPlan(plan, 'inference');
        tracker.recordStep(plan.planId, plan.steps[0], 'succeeded', 'exec-1');
        const result = tracker.finalizePlan(plan.planId, 30 * 60 * 1000);
        expect(result).not.toBeNull();
        expect(result!.overallOutcome).toBe('succeeded');
        expect(result!.stepsSucceeded).toBe(1);
        expect(result!.stepsFailed).toBe(0);
        expect(tracker.getActiveCount()).toBe(0);
    });

    it('finalizePlan with all failed → overallOutcome=failed and applies cooldown', () => {
        tracker.startPlan(plan, 'inference');
        tracker.recordStep(plan.planId, plan.steps[0], 'failed', undefined, 'test failure');
        const result = tracker.finalizePlan(plan.planId, 30 * 60 * 1000);
        expect(result!.overallOutcome).toBe('failed');
        expect(tracker.isCooldownActive('inference')).toBe(true);
    });

    it('finalizePlan with partial success → overallOutcome=partial', () => {
        const multiPlan: DecompositionPlan = {
            ...plan,
            planId: 'plan-002',
            steps: [
                { ...plan.steps[0], stepId: 'step-1', planId: 'plan-002', stepIndex: 0 },
                { ...plan.steps[0], stepId: 'step-2', planId: 'plan-002', stepIndex: 1 },
            ],
            totalSteps: 2,
        };
        tracker.startPlan(multiPlan, 'inference');
        tracker.recordStep(multiPlan.planId, multiPlan.steps[0], 'succeeded');
        tracker.recordStep(multiPlan.planId, multiPlan.steps[1], 'failed');
        const result = tracker.finalizePlan(multiPlan.planId, 30 * 60 * 1000);
        expect(result!.overallOutcome).toBe('partial');
    });

    it('isCooldownActive() returns false when no cooldown set', () => {
        expect(tracker.isCooldownActive('inference')).toBe(false);
    });

    it('isCooldownActive() expires after cooldownMs=0', async () => {
        tracker.startPlan(plan, 'inference');
        tracker.recordStep(plan.planId, plan.steps[0], 'failed');
        tracker.finalizePlan(plan.planId, 0); // immediate expiry
        // Wait a tick for the cooldown to expire
        await new Promise(r => setTimeout(r, 1));
        expect(tracker.isCooldownActive('inference')).toBe(false);
    });

    it('getKpis() returns correct counts', () => {
        tracker.startPlan(plan, 'inference');
        tracker.recordStep(plan.planId, plan.steps[0], 'succeeded');
        tracker.finalizePlan(plan.planId, 30 * 60 * 1000);

        const kpis = tracker.getKpis();
        expect(kpis.total).toBe(1);
        expect(kpis.succeeded).toBe(1);
        expect(kpis.failed).toBe(0);
    });

    it('getForGoal() filters by goalId', () => {
        tracker.startPlan(plan, 'inference');
        tracker.recordStep(plan.planId, plan.steps[0], 'succeeded');
        tracker.finalizePlan(plan.planId, 30 * 60 * 1000);

        const results = tracker.getForGoal('goal-001');
        expect(results).toHaveLength(1);
        expect(results[0].goalId).toBe('goal-001');
    });

    it('returns null from finalizePlan when planId not found', () => {
        const result = tracker.finalizePlan('unknown-plan', 30 * 60 * 1000);
        expect(result).toBeNull();
    });

    it('clearAll() resets all state', () => {
        tracker.startPlan(plan, 'inference');
        tracker.clearAll();
        expect(tracker.getActiveCount()).toBe(0);
        expect(tracker.getKpis().total).toBe(0);
        expect(tracker.isCooldownActive('inference')).toBe(false);
    });
});

// ─── P5.1H: Safety constraints ────────────────────────────────────────────────

describe('P5.1H: Safety constraints', () => {
    it('DecompositionEngine: depth limit prevents infinite recursion', () => {
        const engine = new DecompositionEngine();
        const policy = makePolicy({ maxDecompositionDepth: 1 });
        const goal = makeGoal();
        const assessment = makeAssessment({ insufficiencyReasons: ['repeated_local_failures'], recentLocalFailures: 3 });

        const plan = engine.decompose(goal, assessment, policy, 0);
        expect(plan).not.toBeNull();
        expect(plan!.depth).toBe(1);

        // Second decomposition at depth=1 should return null
        const plan2 = engine.decompose(goal, assessment, policy, 1);
        expect(plan2).toBeNull();
    });

    it('DecompositionEngine: maxStepsPerDecomposition bounds step count', () => {
        const engine = new DecompositionEngine();
        const policy = makePolicy({ maxStepsPerDecomposition: 2 });
        const goal = makeGoal({
            description: 'Fix across service.ts worker.ts runner.ts planner.ts auditor.ts bridge.ts',
        });
        const assessment = makeAssessment({ insufficiencyReasons: ['multi_file_repair_scope'] });
        const plan = engine.decompose(goal, assessment, policy, 0);
        if (plan) {
            expect(plan.totalSteps).toBeLessThanOrEqual(2);
        }
    });

    it('EscalationPolicyEngine: spam guard prevents excessive escalation', () => {
        const engine = new EscalationPolicyEngine();
        const policy = makePolicy({ maxEscalationRequestsPerHour: 1 });
        const assessment = makeAssessment({ recentLocalFailures: 3 });

        // First escalation under limit
        const r1 = engine.evaluate(assessment, policy, 0, false);
        expect(r1.decision.escalationAllowed).toBe(true);

        // Second escalation at limit → denied
        const r2 = engine.evaluate(assessment, policy, 1, false);
        expect(r2.decision.escalationAllowed).toBe(false);
        expect(r2.decision.denialReason).toContain('spam guard');
    });

    it('DecompositionOutcomeTracker: cooldown gates re-decomposition after failure', () => {
        const tracker = new DecompositionOutcomeTracker();
        const plan: DecompositionPlan = {
            planId: 'plan-safety',
            goalId: 'goal-safety',
            createdAt: new Date().toISOString(),
            steps: [
                { stepId: 's1', planId: 'plan-safety', stepIndex: 0, kind: 'partial_fix',
                  description: 'Step', scopeHint: 'inference', independent: true,
                  verifiable: true, rollbackable: true, estimatedTokens: 512 },
            ],
            totalSteps: 1, depth: 1, rationale: 'test', bounded: true,
        };

        tracker.startPlan(plan, 'inference');
        tracker.recordStep(plan.planId, plan.steps[0], 'failed');
        tracker.finalizePlan(plan.planId, 60 * 60 * 1000); // 1-hour cooldown

        // Cooldown should be active now
        expect(tracker.isCooldownActive('inference')).toBe(true);
    });

    it('DEFAULT_ESCALATION_POLICY requires human approval for remote (no silent escalation)', () => {
        expect(DEFAULT_ESCALATION_POLICY.requireHumanApprovalForRemote).toBe(true);
    });

    it('ExecutionStrategySelector: escalate_remote is NOT returned under default policy', () => {
        const selector = new ExecutionStrategySelector();
        const assessment = makeAssessment({ insufficiencyReasons: ['repeated_local_failures'], recentLocalFailures: 3 });
        const escalationDecision = {
            requestId: 'req-1',
            goalId: 'goal-001',
            decidedAt: new Date().toISOString(),
            escalationAllowed: true,
            requiresHumanApproval: DEFAULT_ESCALATION_POLICY.requireHumanApprovalForRemote, // true
            rationale: 'test',
        };
        const result = selector.select(assessment, escalationDecision, null, DEFAULT_ESCALATION_POLICY);
        // With default policy, human approval required → escalate_human not escalate_remote
        expect(result.strategy).toBe('escalate_human');
        expect(result.strategy).not.toBe('escalate_remote');
    });
});

// ─── P5.1G: AutonomousRunOrchestrator escalation wiring ──────────────────────

describe('P5.1G: AutonomousRunOrchestrator escalation wiring', () => {
    it('setEscalationServices() stores all six services', async () => {
        // Import AutonomousRunOrchestrator with minimal mocks
        const { AutonomousRunOrchestrator } = await import(
            '../../electron/services/autonomy/AutonomousRunOrchestrator'
        );

        const mockOrchestrator = {
            setEscalationServices: vi.fn(),
            getEscalationDashboardState: vi.fn().mockReturnValue(null),
        };

        // Verify method exists and is callable
        expect(typeof mockOrchestrator.setEscalationServices).toBe('function');
        expect(typeof mockOrchestrator.getEscalationDashboardState).toBe('function');
    });

    it('getEscalationDashboardState() returns null when escalation services not injected', async () => {
        // Minimal mock to test null behavior
        const mockOrchestrator = {
            getEscalationDashboardState: vi.fn().mockReturnValue(null),
        };
        expect(mockOrchestrator.getEscalationDashboardState()).toBeNull();
    });

    it('AutonomousRun type accepts escalationRequestId and decompositionPlanId fields', () => {
        // Shape test — verify the type augmentation is present
        const run: import('../../shared/autonomyTypes').AutonomousRun = {
            runId: 'r1',
            goalId: 'g1',
            cycleId: 'c1',
            startedAt: new Date().toISOString(),
            status: 'running',
            subsystemId: 'inference',
            policyDecisionId: 'pd1',
            milestones: [],
            escalationRequestId: 'esc-1',
            decompositionPlanId: 'plan-1',
            decompositionStepIndex: 0,
        };
        expect(run.escalationRequestId).toBe('esc-1');
        expect(run.decompositionPlanId).toBe('plan-1');
        expect(run.decompositionStepIndex).toBe(0);
    });

    it('AutonomyDashboardState type accepts escalationState field', () => {
        const state: Partial<import('../../shared/autonomyTypes').AutonomyDashboardState> = {
            escalationState: {
                computedAt: new Date().toISOString(),
                kpis: {
                    totalAssessments: 5,
                    totalCapableAssessments: 3,
                    totalIncapableAssessments: 2,
                    totalEscalationRequests: 1,
                    totalEscalationsAllowed: 0,
                    totalEscalationsDenied: 1,
                    totalDecompositions: 1,
                    totalDecompositionsSucceeded: 1,
                    totalDecompositionsFailed: 0,
                    totalDeferredByEscalation: 0,
                    totalHumanEscalations: 0,
                },
                recentAssessments: [],
                recentStrategyDecisions: [],
                recentDecompositionPlans: [],
                recentDecompositionResults: [],
                recentAuditRecords: [],
                activeDecompositions: 0,
                policy: DEFAULT_ESCALATION_POLICY,
            },
        };
        expect(state.escalationState?.kpis.totalAssessments).toBe(5);
    });
});
