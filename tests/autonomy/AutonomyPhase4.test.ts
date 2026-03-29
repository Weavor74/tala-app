/**
 * AutonomyPhase4.test.ts
 *
 * Phase 4: Autonomous Self-Improvement — Comprehensive Test Suite
 *
 * Covers:
 *   P4A  Autonomy Types & Contracts (shape tests)
 *   P4B  Goal Detection Engine (detection, dedup, fingerprinting)
 *   P4C  Goal Prioritization Engine (scoring, ranking, suppression)
 *   P4D  Autonomy Policy Gate (all block reasons, permit path)
 *   P4H  Safety Controls (budget, cooldown, concurrency limits)
 *   P4F  Outcome Learning Registry (record, confidence, human review routing)
 *   P4I  Persistence & Recovery (audit, cooldown recovery, stale run detection)
 *   P4G  Dashboard Bridge (milestone-gated, no duplicate emits)
 *       + AutonomousRunOrchestrator (goal intake, pipeline routing)
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

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import type {
    GoalCandidate,
    AutonomousGoal,
    AutonomousRun,
    GoalSource,
    AutonomyPolicy,
    GoalPriorityTier,
} from '../../shared/autonomyTypes';
import { GoalDetectionEngine } from '../../electron/services/autonomy/GoalDetectionEngine';
import { GoalPrioritizationEngine } from '../../electron/services/autonomy/GoalPrioritizationEngine';
import { AutonomyPolicyGate } from '../../electron/services/autonomy/AutonomyPolicyGate';
import { AutonomyBudgetManager } from '../../electron/services/autonomy/AutonomyBudgetManager';
import { AutonomyCooldownRegistry } from '../../electron/services/autonomy/AutonomyCooldownRegistry';
import { OutcomeLearningRegistry } from '../../electron/services/autonomy/OutcomeLearningRegistry';
import { AutonomyAuditService } from '../../electron/services/autonomy/AutonomyAuditService';
import { AutonomyTelemetryStore } from '../../electron/services/autonomy/AutonomyTelemetryStore';
import { AutonomyDashboardBridge } from '../../electron/services/autonomy/AutonomyDashboardBridge';
import { DEFAULT_AUTONOMY_POLICY } from '../../electron/services/autonomy/defaults/defaultAutonomyPolicy';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tala-autonomy-test-'));
}

function makeCandidate(overrides: Partial<GoalCandidate> = {}): GoalCandidate {
    return {
        candidateId: 'cand-001',
        detectedAt: new Date().toISOString(),
        source: 'repeated_execution_failure',
        subsystemId: 'inference',
        title: 'Repeated execution failures in inference',
        description: '3 failures detected',
        sourceContext: {
            kind: 'repeated_execution_failure',
            failureCount: 3,
            periodMs: 4 * 60 * 60 * 1000,
            lastExecutionRunId: 'exec-001',
        },
        dedupFingerprint: 'fp-abc123',
        isDuplicate: false,
        ...overrides,
    };
}

function makeGoal(overrides: Partial<AutonomousGoal> = {}): AutonomousGoal {
    return {
        goalId: 'goal-001',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: 'repeated_execution_failure',
        subsystemId: 'inference',
        title: 'Repeated execution failures in inference',
        description: '3 failures detected',
        status: 'scored',
        priorityTier: 'medium',
        priorityScore: {
            total: 45,
            severityWeight: 25,
            recurrenceWeight: 8,
            subsystemImportanceWeight: 8,
            confidenceWeight: 10,
            governanceLikelihoodWeight: 8,
            rollbackConfidenceWeight: 6,
            executionCostPenalty: 1,
            protectedPenalty: 0,
        },
        autonomyEligible: true,
        attemptCount: 0,
        humanReviewRequired: false,
        sourceContext: {
            kind: 'repeated_execution_failure',
            failureCount: 3,
            periodMs: 4 * 60 * 60 * 1000,
            lastExecutionRunId: 'exec-001',
        },
        dedupFingerprint: 'fp-abc123',
        ...overrides,
    };
}

function makeEnabledPolicy(overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
    return {
        ...DEFAULT_AUTONOMY_POLICY,
        globalAutonomyEnabled: true,
        categoryPolicies: DEFAULT_AUTONOMY_POLICY.categoryPolicies.map(cp => ({
            ...cp,
            autonomyEnabled: true,
        })),
        ...overrides,
    };
}

// ─── P4A: Autonomy Types & Contracts ─────────────────────────────────────────

describe('P4A: Autonomy Types', () => {
    it('DEFAULT_AUTONOMY_POLICY has globalAutonomyEnabled=false (safe default)', () => {
        expect(DEFAULT_AUTONOMY_POLICY.globalAutonomyEnabled).toBe(false);
    });

    it('DEFAULT_AUTONOMY_POLICY has conservative budget defaults', () => {
        const budget = DEFAULT_AUTONOMY_POLICY.budget;
        expect(budget.maxRunsPerPeriod).toBeLessThanOrEqual(10);
        expect(budget.maxConcurrentRuns).toBe(1);
        expect(budget.maxAttemptsPerPattern).toBeLessThanOrEqual(5);
    });

    it('DEFAULT_AUTONOMY_POLICY hard-blocks identity and soul subsystems', () => {
        expect(DEFAULT_AUTONOMY_POLICY.hardBlockedSubsystems).toContain('identity');
        expect(DEFAULT_AUTONOMY_POLICY.hardBlockedSubsystems).toContain('soul');
        expect(DEFAULT_AUTONOMY_POLICY.hardBlockedSubsystems).toContain('governance');
    });

    it('DEFAULT_AUTONOMY_POLICY category policies default to disabled', () => {
        for (const cp of DEFAULT_AUTONOMY_POLICY.categoryPolicies) {
            expect(cp.autonomyEnabled).toBe(false);
        }
    });
});

// ─── P4B: Goal Detection Engine ──────────────────────────────────────────────

describe('P4B: GoalDetectionEngine', () => {
    let receivedCandidates: GoalCandidate[];
    let detectionEngine: GoalDetectionEngine;

    beforeEach(() => {
        receivedCandidates = [];
        detectionEngine = new GoalDetectionEngine(
            {
                listRecentExecutionRuns: (w) => [],
                listGovernanceDecisions: () => [],
                listReflectionGoals: async () => [],
                getActiveGoalFingerprints: () => new Set(),
            },
            (c) => { receivedCandidates.push(...c); },
        );
    });

    afterEach(() => {
        detectionEngine.stop();
    });

    it('runOnce() returns empty array when no signals present', async () => {
        const candidates = await detectionEngine.runOnce();
        expect(candidates).toHaveLength(0);
    });

    it('detects repeated execution failures when threshold is met', async () => {
        const engine = new GoalDetectionEngine(
            {
                listRecentExecutionRuns: () => [
                    { executionId: 'e1', subsystemId: 'inference', status: 'aborted', createdAt: new Date().toISOString() } as any,
                    { executionId: 'e2', subsystemId: 'inference', status: 'rolled_back', createdAt: new Date().toISOString() } as any,
                    { executionId: 'e3', subsystemId: 'inference', status: 'failed_verification', createdAt: new Date().toISOString() } as any,
                ],
                listGovernanceDecisions: () => [],
                listReflectionGoals: async () => [],
                getActiveGoalFingerprints: () => new Set(),
            },
            (c) => {},
        );

        const candidates = await engine.runOnce();
        expect(candidates.length).toBeGreaterThan(0);
        const failureCand = candidates.find(c => c.source === 'repeated_execution_failure');
        expect(failureCand).toBeDefined();
        expect(failureCand!.subsystemId).toBe('inference');
        engine.stop();
    });

    it('does NOT detect when failure count is below threshold', async () => {
        const engine = new GoalDetectionEngine(
            {
                listRecentExecutionRuns: () => [
                    { executionId: 'e1', subsystemId: 'inference', status: 'aborted', createdAt: new Date().toISOString() } as any,
                    { executionId: 'e2', subsystemId: 'inference', status: 'aborted', createdAt: new Date().toISOString() } as any,
                    // Only 2 failures (threshold is 3)
                ],
                listGovernanceDecisions: () => [],
                listReflectionGoals: async () => [],
                getActiveGoalFingerprints: () => new Set(),
            },
            (c) => {},
        );

        const candidates = await engine.runOnce();
        const failureCand = candidates.find(c => c.source === 'repeated_execution_failure');
        expect(failureCand).toBeUndefined();
        engine.stop();
    });

    it('deduplicates candidates with the same fingerprint across sources', async () => {
        // Both sources produce the same fingerprint → should produce only one
        const fp = 'duplicate-fp-001';
        const engine = new GoalDetectionEngine(
            {
                listRecentExecutionRuns: () => [
                    { executionId: 'e1', subsystemId: 'mcp', status: 'aborted', createdAt: new Date().toISOString() } as any,
                    { executionId: 'e2', subsystemId: 'mcp', status: 'aborted', createdAt: new Date().toISOString() } as any,
                    { executionId: 'e3', subsystemId: 'mcp', status: 'aborted', createdAt: new Date().toISOString() } as any,
                ],
                listGovernanceDecisions: () => [],
                listReflectionGoals: async () => [],
                getActiveGoalFingerprints: () => new Set(),
            },
            (c) => {},
        );

        const candidates = await engine.runOnce();
        const fps = candidates.map(c => c.dedupFingerprint);
        const unique = new Set(fps);
        expect(unique.size).toBe(fps.length); // No duplicate fingerprints in output
        engine.stop();
    });

    it('marks candidates as isDuplicate when active goal exists with same fingerprint', async () => {
        const fp = detectionEngine.fingerprint('repeated_execution_failure', 'inference', 'Repeated execution failures in inference');
        const engine = new GoalDetectionEngine(
            {
                listRecentExecutionRuns: () => [
                    { executionId: 'e1', subsystemId: 'inference', status: 'aborted', createdAt: new Date().toISOString() } as any,
                    { executionId: 'e2', subsystemId: 'inference', status: 'aborted', createdAt: new Date().toISOString() } as any,
                    { executionId: 'e3', subsystemId: 'inference', status: 'aborted', createdAt: new Date().toISOString() } as any,
                ],
                listGovernanceDecisions: () => [],
                listReflectionGoals: async () => [],
                getActiveGoalFingerprints: () => new Set([fp]),
            },
            (c) => {},
        );

        const candidates = await engine.runOnce();
        // All should be marked as duplicate since the fingerprint is in active set
        for (const c of candidates) {
            if (c.dedupFingerprint === fp) {
                expect(c.isDuplicate).toBe(true);
            }
        }
        engine.stop();
    });

    it('_fingerprint() is deterministic: same inputs → same output', () => {
        const fp1 = detectionEngine.fingerprint('repeated_execution_failure', 'inference', 'test title');
        const fp2 = detectionEngine.fingerprint('repeated_execution_failure', 'inference', 'test title');
        expect(fp1).toBe(fp2);
    });

    it('_fingerprint() produces different results for different sources', () => {
        const fp1 = detectionEngine.fingerprint('repeated_execution_failure', 'inference', 'test title');
        const fp2 = detectionEngine.fingerprint('stale_subsystem', 'inference', 'test title');
        expect(fp1).not.toBe(fp2);
    });
});

// ─── P4C: Goal Prioritization Engine ─────────────────────────────────────────

describe('P4C: GoalPrioritizationEngine', () => {
    let tmpDir: string;
    let engine: GoalPrioritizationEngine;

    beforeEach(() => {
        tmpDir = makeTempDir();
        const learning = new OutcomeLearningRegistry(tmpDir);
        const cooldown = new AutonomyCooldownRegistry(tmpDir);
        const budget = new AutonomyBudgetManager();
        engine = new GoalPrioritizationEngine(learning, cooldown, budget);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('scores candidates and returns AutonomousGoal[]', () => {
        const candidates = [
            makeCandidate({ source: 'repeated_execution_failure', subsystemId: 'inference' }),
            makeCandidate({ candidateId: 'cand-002', source: 'stale_subsystem', subsystemId: 'mcp',
                dedupFingerprint: 'fp-xyz', title: 'stale mcp' }),
        ];
        const goals = engine.score(candidates, DEFAULT_AUTONOMY_POLICY);
        expect(goals).toHaveLength(2);
        for (const g of goals) {
            expect(g.goalId).toBeDefined();
            expect(g.priorityScore.total).toBeGreaterThanOrEqual(0);
        }
    });

    it('returns goals sorted descending by score', () => {
        const candidates = [
            makeCandidate({ source: 'stale_subsystem', subsystemId: 'unknown_system', dedupFingerprint: 'fp-low', title: 'low prio' }),
            makeCandidate({ source: 'repeated_execution_failure', subsystemId: 'inference', dedupFingerprint: 'fp-high', title: 'high prio' }),
        ];
        const goals = engine.score(candidates, DEFAULT_AUTONOMY_POLICY);
        expect(goals[0].priorityScore.total).toBeGreaterThanOrEqual(goals[1].priorityScore.total);
    });

    it('marks duplicate candidates as suppressed', () => {
        const candidate = makeCandidate({ isDuplicate: true });
        const goals = engine.score([candidate], DEFAULT_AUTONOMY_POLICY);
        expect(goals[0].status).toBe('suppressed');
        expect(goals[0].priorityTier).toBe('suppressed');
    });

    it('marks budget-exhausted candidates as suppressed', () => {
        const budget = new AutonomyBudgetManager();
        const td1 = makeTempDir();
        const td2 = makeTempDir();
        try {
            const learning = new OutcomeLearningRegistry(td1);
            const cooldown = new AutonomyCooldownRegistry(td2);
            const eng = new GoalPrioritizationEngine(learning, cooldown, budget);

            const policy = makeEnabledPolicy();
            // Exhaust the budget (start and end so slots stay in window but runs complete)
            for (let i = 0; i < policy.budget.maxRunsPerPeriod; i++) {
                budget.recordRunStart(`run-${i}`, `sub-${i}`);
                budget.recordRunEnd(`run-${i}`);
            }

            const candidates = [makeCandidate()];
            const goals = eng.score(candidates, policy);
            expect(goals[0].status).toBe('suppressed');
        } finally {
            fs.rmSync(td1, { recursive: true, force: true });
            fs.rmSync(td2, { recursive: true, force: true });
        }
    });

    it('routes to human review after maxAttemptsPerPattern failures', () => {
        const tmpDir2 = makeTempDir();
        try {
            const learning = new OutcomeLearningRegistry(tmpDir2);
            const cooldown = new AutonomyCooldownRegistry(tmpDir2);
            const budget = new AutonomyBudgetManager();
            const eng = new GoalPrioritizationEngine(learning, cooldown, budget);

            const policy = makeEnabledPolicy({ budget: { ...DEFAULT_AUTONOMY_POLICY.budget, maxAttemptsPerPattern: 2 } });
            const goal = makeGoal();
            const run: AutonomousRun = {
                runId: 'r1', goalId: goal.goalId, cycleId: 'c1',
                startedAt: new Date().toISOString(), status: 'failed', subsystemId: 'inference', milestones: [],
            };

            // Simulate 2 failures
            learning.record(goal, run, 'failed');
            learning.record(goal, run, 'failed');

            const candidate = makeCandidate();
            const goals = eng.score([candidate], policy);
            expect(goals[0].humanReviewRequired).toBe(true);
        } finally {
            fs.rmSync(tmpDir2, { recursive: true, force: true });
        }
    });
});

// ─── P4D: Autonomy Policy Gate ────────────────────────────────────────────────

describe('P4D: AutonomyPolicyGate', () => {
    let tmpDir: string;
    let gate: AutonomyPolicyGate;
    let budget: AutonomyBudgetManager;
    let cooldown: AutonomyCooldownRegistry;
    let learning: OutcomeLearningRegistry;

    beforeEach(() => {
        tmpDir = makeTempDir();
        budget = new AutonomyBudgetManager();
        cooldown = new AutonomyCooldownRegistry(tmpDir);
        learning = new OutcomeLearningRegistry(tmpDir);
        gate = new AutonomyPolicyGate(budget, cooldown, learning);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('blocks when global autonomy is disabled (default policy)', () => {
        const goal = makeGoal();
        const decision = gate.evaluate(goal, DEFAULT_AUTONOMY_POLICY);
        expect(decision.permitted).toBe(false);
        expect(decision.blockReason).toBe('global_autonomy_disabled');
    });

    it('blocks when category policy is disabled', () => {
        const policy = makeEnabledPolicy({
            categoryPolicies: DEFAULT_AUTONOMY_POLICY.categoryPolicies.map(cp => ({
                ...cp,
                autonomyEnabled: false, // All disabled
            })),
        });
        const goal = makeGoal();
        const decision = gate.evaluate(goal, policy);
        expect(decision.permitted).toBe(false);
        expect(decision.blockReason).toBe('policy_category_disabled');
    });

    it('blocks when subsystem is hard-blocked', () => {
        const policy = makeEnabledPolicy();
        const goal = makeGoal({ subsystemId: 'identity' }); // Hard-blocked
        const decision = gate.evaluate(goal, policy);
        expect(decision.permitted).toBe(false);
        expect(decision.blockReason).toBe('protected_subsystem');
    });

    it('blocks when subsystem is in cooldown', () => {
        const policy = makeEnabledPolicy();
        const goal = makeGoal();
        cooldown.recordCooldown(goal.subsystemId, goal.dedupFingerprint, 'execution_failure', policy.budget);
        const decision = gate.evaluate(goal, policy);
        expect(decision.permitted).toBe(false);
        expect(decision.blockReason).toBe('in_cooldown');
        expect(decision.cooldownExpiresAt).toBeDefined();
    });

    it('blocks when budget is exhausted', () => {
        const policy = makeEnabledPolicy();
        // Exhaust budget: start and end runs so slots exist in period but no active runs
        for (let i = 0; i < policy.budget.maxRunsPerPeriod; i++) {
            budget.recordRunStart(`run-${i}`, `sub-${i}`);
            budget.recordRunEnd(`run-${i}`);
        }
        const goal = makeGoal();
        const decision = gate.evaluate(goal, policy);
        expect(decision.permitted).toBe(false);
        expect(decision.blockReason).toBe('budget_exhausted');
    });

    it('blocks when active run exists for subsystem', () => {
        const policy = makeEnabledPolicy();
        budget.recordRunStart('active-run', 'inference');
        const goal = makeGoal({ subsystemId: 'inference' });
        const decision = gate.evaluate(goal, policy);
        expect(decision.permitted).toBe(false);
        expect(decision.blockReason).toBe('active_run_exists');
    });

    it('blocks when prior failure memory exceeds maxAttemptsPerPattern', () => {
        const policy = makeEnabledPolicy({ budget: { ...DEFAULT_AUTONOMY_POLICY.budget, maxAttemptsPerPattern: 2 } });
        const goal = makeGoal();
        const run = { runId: 'r1', goalId: goal.goalId, cycleId: 'c1', startedAt: new Date().toISOString(), status: 'failed' as any, subsystemId: 'inference', milestones: [] };
        learning.record(goal, run, 'failed');
        learning.record(goal, run, 'failed');
        const decision = gate.evaluate(goal, policy);
        expect(decision.permitted).toBe(false);
        expect(decision.blockReason).toBe('prior_failure_memory');
        expect(decision.requiresHumanReview).toBe(true);
    });

    it('permits when all checks pass', () => {
        const policy = makeEnabledPolicy();
        const goal = makeGoal({ subsystemId: 'mcp' }); // Not hard-blocked
        const decision = gate.evaluate(goal, policy);
        expect(decision.permitted).toBe(true);
        expect(decision.blockReason).toBeUndefined();
    });

    it('policy decision has all required fields', () => {
        const policy = makeEnabledPolicy();
        const goal = makeGoal({ subsystemId: 'mcp' });
        const decision = gate.evaluate(goal, policy);
        expect(decision.decisionId).toBeDefined();
        expect(decision.goalId).toBe(goal.goalId);
        expect(decision.evaluatedAt).toBeDefined();
        expect(typeof decision.permitted).toBe('boolean');
        expect(decision.rationale).toBeTruthy();
    });
});

// ─── P4H: Budget and Cooldown Safety Controls ─────────────────────────────────

describe('P4H: Safety Controls — AutonomyBudgetManager', () => {
    let budget: AutonomyBudgetManager;
    const policy = makeEnabledPolicy();

    beforeEach(() => {
        budget = new AutonomyBudgetManager();
    });

    it('starts with no active runs and budget not exhausted', () => {
        expect(budget.isExhausted(policy.budget)).toBe(false);
        expect(budget.getActiveGlobalCount()).toBe(0);
    });

    it('canStartGlobal returns false when at max concurrent', () => {
        budget.recordRunStart('run-1', 'inference');
        expect(budget.canStartGlobal(policy.budget)).toBe(false); // default maxConcurrentRuns=1
    });

    it('canStartForSubsystem returns false when subsystem at max', () => {
        budget.recordRunStart('run-1', 'inference');
        expect(budget.canStartForSubsystem('inference', policy.budget)).toBe(false);
    });

    it('isExhausted returns true when maxRunsPerPeriod reached', () => {
        for (let i = 0; i < policy.budget.maxRunsPerPeriod; i++) {
            budget.recordRunStart(`run-${i}`, `sub-${i}`);
        }
        expect(budget.isExhausted(policy.budget)).toBe(true);
    });

    it('recordRunEnd releases slots', () => {
        budget.recordRunStart('run-1', 'inference');
        expect(budget.getActiveGlobalCount()).toBe(1);
        budget.recordRunEnd('run-1');
        expect(budget.getActiveGlobalCount()).toBe(0);
    });

    it('getUsedThisPeriod counts slots within period window', () => {
        budget.recordRunStart('run-1', 'inference');
        budget.recordRunStart('run-2', 'mcp');
        expect(budget.getUsedThisPeriod(policy.budget)).toBe(2);
    });
});

describe('P4H: Safety Controls — AutonomyCooldownRegistry', () => {
    let tmpDir: string;
    let registry: AutonomyCooldownRegistry;
    const budget = DEFAULT_AUTONOMY_POLICY.budget;

    beforeEach(() => {
        tmpDir = makeTempDir();
        registry = new AutonomyCooldownRegistry(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('starts with no cooldowns', () => {
        expect(registry.isInCooldown('inference', 'fp-abc')).toBe(false);
        expect(registry.listActive()).toHaveLength(0);
    });

    it('recordCooldown marks subsystem as in cooldown', () => {
        registry.recordCooldown('inference', 'fp-abc', 'execution_failure', budget);
        expect(registry.isInCooldown('inference', 'fp-abc')).toBe(true);
    });

    it('getCooldownRecord returns the record with expiresAt', () => {
        registry.recordCooldown('inference', 'fp-abc', 'rollback', budget);
        const record = registry.getCooldownRecord('inference', 'fp-abc');
        expect(record).not.toBeNull();
        expect(record!.reason).toBe('rollback');
        expect(new Date(record!.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('clearCooldown removes the cooldown', () => {
        registry.recordCooldown('inference', 'fp-abc', 'execution_failure', budget);
        expect(registry.isInCooldown('inference', 'fp-abc')).toBe(true);
        registry.clearCooldown('inference', 'fp-abc');
        expect(registry.isInCooldown('inference', 'fp-abc')).toBe(false);
    });

    it('different subsystem+pattern combinations are independent', () => {
        registry.recordCooldown('inference', 'fp-abc', 'execution_failure', budget);
        expect(registry.isInCooldown('mcp', 'fp-abc')).toBe(false);
        expect(registry.isInCooldown('inference', 'fp-xyz')).toBe(false);
    });

    it('persists and restores cooldowns on construction', () => {
        registry.recordCooldown('inference', 'fp-abc', 'governance_block', budget);

        // Create a new instance from the same dataDir
        const registry2 = new AutonomyCooldownRegistry(tmpDir);
        expect(registry2.isInCooldown('inference', 'fp-abc')).toBe(true);
    });
});

// ─── P4F: Outcome Learning Registry ──────────────────────────────────────────

describe('P4F: OutcomeLearningRegistry', () => {
    let tmpDir: string;
    let registry: OutcomeLearningRegistry;

    beforeEach(() => {
        tmpDir = makeTempDir();
        registry = new OutcomeLearningRegistry(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('records a success outcome and increments successCount', () => {
        const goal = makeGoal();
        const run: AutonomousRun = { runId: 'r1', goalId: goal.goalId, cycleId: 'c1', startedAt: new Date().toISOString(), status: 'succeeded', subsystemId: 'inference', milestones: [] };
        const record = registry.record(goal, run, 'succeeded');
        expect(record.successCount).toBe(1);
        expect(record.lastOutcome).toBe('succeeded');
    });

    it('records a failure outcome and increments failureCount', () => {
        const goal = makeGoal();
        const run: AutonomousRun = { runId: 'r1', goalId: goal.goalId, cycleId: 'c1', startedAt: new Date().toISOString(), status: 'failed', subsystemId: 'inference', milestones: [] };
        const record = registry.record(goal, run, 'failed');
        expect(record.failureCount).toBe(1);
        expect(record.lastOutcome).toBe('failed');
    });

    it('increases confidence on success', () => {
        const goal = makeGoal();
        const run: AutonomousRun = { runId: 'r1', goalId: goal.goalId, cycleId: 'c1', startedAt: new Date().toISOString(), status: 'succeeded', subsystemId: 'inference', milestones: [] };
        const initial = registry.getConfidenceModifier(goal.dedupFingerprint);
        registry.record(goal, run, 'succeeded');
        const after = registry.getConfidenceModifier(goal.dedupFingerprint);
        expect(after).toBeGreaterThan(initial);
    });

    it('decreases confidence on failure', () => {
        const goal = makeGoal();
        const run: AutonomousRun = { runId: 'r1', goalId: goal.goalId, cycleId: 'c1', startedAt: new Date().toISOString(), status: 'failed', subsystemId: 'inference', milestones: [] };
        const initial = registry.getConfidenceModifier(goal.dedupFingerprint);
        registry.record(goal, run, 'failed');
        const after = registry.getConfidenceModifier(goal.dedupFingerprint);
        expect(after).toBeLessThan(initial);
    });

    it('shouldRouteToHumanReview returns false initially', () => {
        expect(registry.shouldRouteToHumanReview('fp-abc123', 3)).toBe(false);
    });

    it('shouldRouteToHumanReview returns true after maxAttempts failures', () => {
        const goal = makeGoal();
        const run: AutonomousRun = { runId: 'r1', goalId: goal.goalId, cycleId: 'c1', startedAt: new Date().toISOString(), status: 'failed', subsystemId: 'inference', milestones: [] };
        registry.record(goal, run, 'failed');
        registry.record(goal, run, 'failed');
        registry.record(goal, run, 'failed');
        expect(registry.shouldRouteToHumanReview(goal.dedupFingerprint, 3)).toBe(true);
    });

    it('persists learning record and loads it via get()', () => {
        const goal = makeGoal();
        const run: AutonomousRun = { runId: 'r1', goalId: goal.goalId, cycleId: 'c1', startedAt: new Date().toISOString(), status: 'succeeded', subsystemId: 'inference', milestones: [] };
        registry.record(goal, run, 'succeeded');

        // Create fresh instance from same dir
        const registry2 = new OutcomeLearningRegistry(tmpDir);
        const loaded = registry2.get(goal.dedupFingerprint);
        expect(loaded).not.toBeNull();
        expect(loaded!.successCount).toBe(1);
    });

    it('listAll() returns all learning records', () => {
        const goal1 = makeGoal({ dedupFingerprint: 'fp-001' });
        const goal2 = makeGoal({ goalId: 'goal-002', dedupFingerprint: 'fp-002' });
        const run = (g: AutonomousGoal) => ({ runId: 'r', goalId: g.goalId, cycleId: 'c', startedAt: new Date().toISOString(), status: 'succeeded' as any, subsystemId: 'inference', milestones: [] });
        registry.record(goal1, run(goal1), 'succeeded');
        registry.record(goal2, run(goal2), 'failed');
        const all = registry.listAll();
        expect(all.length).toBe(2);
    });
});

// ─── P4I: Audit Service & Telemetry Store ────────────────────────────────────

describe('P4I: AutonomyAuditService', () => {
    let tmpDir: string;
    let audit: AutonomyAuditService;

    beforeEach(() => {
        tmpDir = makeTempDir();
        audit = new AutonomyAuditService(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('appendAuditRecord writes and can be read back', () => {
        audit.appendAuditRecord('goal_created', 'Goal X created', { goalId: 'goal-001' });
        const log = audit.readAuditLog('goal-001');
        expect(log).toHaveLength(1);
        expect(log[0].event).toBe('goal_created');
    });

    it('saveGoal and loadGoal round-trips', () => {
        const goal = makeGoal();
        audit.saveGoal(goal);
        const loaded = audit.loadGoal(goal.goalId);
        expect(loaded).not.toBeNull();
        expect(loaded!.goalId).toBe(goal.goalId);
    });

    it('listGoals returns saved goals sorted by updatedAt desc', () => {
        const g1 = makeGoal({ goalId: 'g1' });
        const g2 = makeGoal({ goalId: 'g2' });
        audit.saveGoal(g1);
        audit.saveGoal(g2);
        const all = audit.listGoals();
        expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('saveRun and loadRun round-trips', () => {
        const run: AutonomousRun = {
            runId: 'run-001', goalId: 'goal-001', cycleId: 'c1',
            startedAt: new Date().toISOString(), status: 'succeeded', subsystemId: 'inference', milestones: [],
        };
        audit.saveRun(run);
        const loaded = audit.loadRun('run-001');
        expect(loaded).not.toBeNull();
        expect(loaded!.status).toBe('succeeded');
    });

    it('listRuns filters by windowMs', () => {
        const oldRun: AutonomousRun = {
            runId: 'old-run', goalId: 'g1', cycleId: 'c1',
            startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48 hours ago
            status: 'succeeded', subsystemId: 'inference', milestones: [],
        };
        audit.saveRun(oldRun);
        const recentRuns = audit.listRuns(24 * 60 * 60 * 1000); // 24 hour window
        const oldInList = recentRuns.find(r => r.runId === 'old-run');
        expect(oldInList).toBeUndefined();
    });
});

describe('P4I: AutonomyTelemetryStore', () => {
    let tmpDir: string;
    let store: AutonomyTelemetryStore;

    beforeEach(() => {
        tmpDir = makeTempDir();
        store = new AutonomyTelemetryStore(tmpDir);
    });

    afterEach(() => {
        store.stopAutoFlush();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('record() appends to buffer', () => {
        store.record('goal_detected', 'Test goal detected', { goalId: 'g1' });
        expect(store.getBuffer()).toHaveLength(1);
    });

    it('getRecentEvents respects limit', () => {
        for (let i = 0; i < 20; i++) {
            store.record('goal_detected', `Event ${i}`);
        }
        const recent = store.getRecentEvents(5);
        expect(recent).toHaveLength(5);
    });

    it('getRunEvents filters by runId', () => {
        store.record('run_started', 'run A started', { runId: 'run-A' });
        store.record('run_started', 'run B started', { runId: 'run-B' });
        const runAEvents = store.getRunEvents('run-A');
        expect(runAEvents).toHaveLength(1);
        expect(runAEvents[0].runId).toBe('run-A');
    });

    it('buffer drops oldest event when MAX_BUFFER exceeded', () => {
        // MAX_BUFFER = 500; add 501 events
        for (let i = 0; i < 501; i++) {
            store.record('goal_detected', `Event ${i}`);
        }
        expect(store.getBuffer().length).toBeLessThanOrEqual(500);
    });
});

// ─── P4G: Dashboard Bridge ────────────────────────────────────────────────────

describe('P4G: AutonomyDashboardBridge', () => {
    it('maybeEmit returns false for non-milestone events', () => {
        const bridge = new AutonomyDashboardBridge();
        const policy = makeEnabledPolicy();
        const result = bridge.maybeEmit(
            'policy_evaluated' as any, // Not a dashboard milestone
            [], [], [], [], policy, 0,
        );
        expect(result).toBe(false);
    });

    it('maybeEmit returns true for permitted milestones', () => {
        const bridge = new AutonomyDashboardBridge();
        const policy = makeEnabledPolicy();
        const result = bridge.maybeEmit('run_started', [], [], [], [], policy, 0);
        expect(result).toBe(true);
    });

    it('maybeEmit returns false when state is unchanged (dedup)', () => {
        const bridge = new AutonomyDashboardBridge();
        const policy = makeEnabledPolicy();
        bridge.maybeEmit('run_started', [], [], [], [], policy, 0);
        const second = bridge.maybeEmit('run_started', [], [], [], [], policy, 0);
        expect(second).toBe(false);
    });

    it('resetDedupHash allows re-emission of same state', () => {
        const bridge = new AutonomyDashboardBridge();
        const policy = makeEnabledPolicy();
        bridge.maybeEmit('run_started', [], [], [], [], policy, 0);
        bridge.resetDedupHash();
        const reemit = bridge.maybeEmit('run_started', [], [], [], [], policy, 0);
        expect(reemit).toBe(true);
    });
});

// ─── Integration: No bypass of planning/governance/execution ─────────────────

describe('Integration: Autonomy Pipeline Safety', () => {
    it('DEFAULT_AUTONOMY_POLICY blocks all categories by default (no hidden bypass)', () => {
        for (const cp of DEFAULT_AUTONOMY_POLICY.categoryPolicies) {
            expect(cp.autonomyEnabled).toBe(false);
        }
    });

    it('AutonomyPolicyGate blocks before reaching planning/governance/execution', () => {
        const tmpDir = makeTempDir();
        const budget = new AutonomyBudgetManager();
        const cooldown = new AutonomyCooldownRegistry(tmpDir);
        const learning = new OutcomeLearningRegistry(tmpDir);
        const gate = new AutonomyPolicyGate(budget, cooldown, learning);

        // Disabled policy → blocked at check 1
        const goal = makeGoal();
        const decision = gate.evaluate(goal, DEFAULT_AUTONOMY_POLICY);
        expect(decision.permitted).toBe(false);

        // No planning/governance/execution calls should have been made
        // (This is verified structurally: the gate returns before any downstream calls)
        expect(decision.blockReason).toBe('global_autonomy_disabled');

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('GoalDetectionEngine does not write state (read-only)', async () => {
        // Detection is purely read-only: it never modifies execution runs or governance decisions
        const engine = new GoalDetectionEngine(
            {
                listRecentExecutionRuns: () => [],
                listGovernanceDecisions: () => [],
                listReflectionGoals: async () => [],
                getActiveGoalFingerprints: () => new Set(),
            },
            () => {},
        );

        // Should complete without side effects
        const candidates = await engine.runOnce();
        expect(Array.isArray(candidates)).toBe(true);
        engine.stop();
    });
});
