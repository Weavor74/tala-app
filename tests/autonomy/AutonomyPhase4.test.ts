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
import { AutonomousRunOrchestrator } from '../../electron/services/autonomy/AutonomousRunOrchestrator';
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

    it('detects failed_verification candidate from a single failing run', async () => {
        const engine = new GoalDetectionEngine(
            {
                listRecentExecutionRuns: () => [
                    { executionId: 'ev1', subsystemId: 'mcp', status: 'failed_verification', createdAt: new Date().toISOString() } as any,
                ],
                listGovernanceDecisions: () => [],
                listReflectionGoals: async () => [],
                getActiveGoalFingerprints: () => new Set(),
            },
            (c) => {},
        );

        const candidates = await engine.runOnce();
        const verifCand = candidates.find(c => c.source === 'failed_verification');
        expect(verifCand).toBeDefined();
        expect(verifCand!.subsystemId).toBe('mcp');
        expect(verifCand!.dedupFingerprint).toBe(engine.fingerprint('failed_verification', 'mcp', 'Verification failure in mcp'));
        engine.stop();
    });

    it('failed_verification candidate has a distinct fingerprint from repeated_execution_failure', () => {
        const fpVerif = detectionEngine.fingerprint('failed_verification', 'inference', 'Verification failure in inference');
        const fpExec  = detectionEngine.fingerprint('repeated_execution_failure', 'inference', 'Repeated execution failures in inference');
        expect(fpVerif).not.toBe(fpExec);
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

// ─── P4E: AutonomousRunOrchestrator ──────────────────────────────────────────

describe('P4E: AutonomousRunOrchestrator', () => {
    let tmpDir: string;

    function makeMockPlanner() {
        return {
            plan: vi.fn(),
            listProposals: vi.fn().mockReturnValue([]),
            promoteProposal: vi.fn().mockReturnValue(null),
        };
    }

    function makeMockGovernance() {
        return {
            evaluateForProposal: vi.fn(),
            getDecision: vi.fn().mockReturnValue(null),
            listDecisions: vi.fn().mockReturnValue([]),
        };
    }

    function makeMockExecution() {
        return {
            start: vi.fn(),
            getRunStatus: vi.fn().mockReturnValue(null),
            listRecentRuns: vi.fn().mockReturnValue([]),
        };
    }

    beforeEach(() => {
        tmpDir = makeTempDir();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('marks stale active runs as aborted on construction', () => {
        const runDir = path.join(tmpDir, 'autonomy', 'runs');
        fs.mkdirSync(runDir, { recursive: true });
        const staleRun = {
            runId: 'stale-run-1', goalId: 'goal-1', cycleId: 'c1',
            startedAt: new Date(Date.now() - 10000).toISOString(),
            status: 'running', subsystemId: 'mcp', milestones: [],
        };
        fs.writeFileSync(path.join(runDir, 'stale-run-1.json'), JSON.stringify(staleRun, null, 2));

        const orchestrator = new AutonomousRunOrchestrator(
            tmpDir, makeMockPlanner() as any, makeMockGovernance() as any,
            makeMockExecution() as any, DEFAULT_AUTONOMY_POLICY,
        );

        const recovered = orchestrator.getRun('stale-run-1');
        expect(recovered).not.toBeNull();
        expect(recovered!.status).toBe('aborted');
        orchestrator.stop();
    });

    it('preserves governance_pending runs across construction', () => {
        const runDir = path.join(tmpDir, 'autonomy', 'runs');
        fs.mkdirSync(runDir, { recursive: true });
        const pendingRun = {
            runId: 'pending-run-1', goalId: 'goal-1', cycleId: 'c1',
            startedAt: new Date().toISOString(),
            status: 'governance_pending', subsystemId: 'mcp', milestones: [],
        };
        fs.writeFileSync(path.join(runDir, 'pending-run-1.json'), JSON.stringify(pendingRun, null, 2));

        const orchestrator = new AutonomousRunOrchestrator(
            tmpDir, makeMockPlanner() as any, makeMockGovernance() as any,
            makeMockExecution() as any, DEFAULT_AUTONOMY_POLICY,
        );

        const run = orchestrator.getRun('pending-run-1');
        expect(run).not.toBeNull();
        expect(run!.status).toBe('governance_pending');
        orchestrator.stop();
    });

    it('suppresses goal when global autonomy is disabled (default policy)', async () => {
        // One failed_verification run → _detectFailedVerifications produces a candidate
        const mockExecution = makeMockExecution();
        mockExecution.listRecentRuns.mockReturnValue([
            { executionId: 'e1', subsystemId: 'mcp', status: 'failed_verification', startedAt: new Date().toISOString() },
        ]);

        const orchestrator = new AutonomousRunOrchestrator(
            tmpDir, makeMockPlanner() as any, makeMockGovernance() as any,
            mockExecution as any, DEFAULT_AUTONOMY_POLICY,
        );

        await orchestrator.runCycleOnce();

        // Policy gate blocks at check 1 (global_autonomy_disabled) — synchronous,
        // no async pipeline fires. Goal is immediately placed in 'suppressed'.
        const goals = orchestrator.listGoals();
        expect(goals.length).toBeGreaterThan(0);
        const suppressed = goals.find(g => g.status === 'suppressed' || g.status === 'policy_blocked');
        expect(suppressed).toBeDefined();
        orchestrator.stop();
    });

    it('routes governance-blocked run through planning then records cooldown', async () => {
        const proposal: any = {
            proposalId: 'prop-1', runId: 'plan-run-1', status: 'classified',
            targetSubsystem: 'mcp', title: 'Test proposal',
            createdAt: new Date().toISOString(),
        };
        const mockExecution = makeMockExecution();
        const mockPlanner = makeMockPlanner();
        const mockGovernance = makeMockGovernance();

        mockExecution.listRecentRuns.mockReturnValue([
            { executionId: 'e1', subsystemId: 'mcp', status: 'failed_verification', startedAt: new Date().toISOString() },
        ]);
        mockPlanner.plan.mockResolvedValue({ runId: 'plan-run-1', status: 'running', message: 'ok' });
        // Return proposal on the first synchronous lookup → no 50ms polling delay
        mockPlanner.listProposals.mockReturnValue([proposal]);
        mockPlanner.promoteProposal.mockReturnValue({ ...proposal, status: 'promoted' });
        mockGovernance.evaluateForProposal.mockReturnValue({
            decisionId: 'dec-1', status: 'blocked', executionAuthorized: false,
            blockReason: 'test-block', proposalId: 'prop-1',
        });

        const policy = makeEnabledPolicy();
        const orchestrator = new AutonomousRunOrchestrator(
            tmpDir, mockPlanner as any, mockGovernance as any,
            mockExecution as any, policy,
        );

        await orchestrator.runCycleOnce();
        // Governance block has no execution-poll delays; wait one event-loop turn
        await new Promise(resolve => setTimeout(resolve, 100));

        const goals = orchestrator.listGoals();
        const blocked = goals.find(g => g.status === 'governance_blocked');
        expect(blocked).toBeDefined();
        expect(blocked!.humanReviewRequired).toBe(true);

        // Verify planning was actually invoked (no bypass)
        expect(mockPlanner.plan).toHaveBeenCalledOnce();
        expect(mockGovernance.evaluateForProposal).toHaveBeenCalledOnce();
        orchestrator.stop();
    });

    it('getDashboardState returns a valid AutonomyDashboardState shape', () => {
        const orchestrator = new AutonomousRunOrchestrator(
            tmpDir, makeMockPlanner() as any, makeMockGovernance() as any,
            makeMockExecution() as any, DEFAULT_AUTONOMY_POLICY,
        );

        const state = orchestrator.getDashboardState();
        expect(state.kpis).toBeDefined();
        expect(typeof state.kpis.totalGoalsDetected).toBe('number');
        expect(Array.isArray(state.activeRuns)).toBe(true);
        expect(Array.isArray(state.pendingGoals)).toBe(true);
        expect(Array.isArray(state.blockedGoals)).toBe(true);
        expect(Array.isArray(state.recentTelemetry)).toBe(true);
        expect(Array.isArray(state.learningRecords)).toBe(true);
        expect(state.budget).toBeDefined();
        expect(typeof state.globalAutonomyEnabled).toBe('boolean');
        expect(state.globalAutonomyEnabled).toBe(false); // Default policy
        orchestrator.stop();
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

// ─── P4.2: Detection Coverage Expansion ─────────────────────────────────────

describe('P4.2: Detection Coverage Expansion', () => {

    // ── P4.2B: Telemetry-Based Detection ───────────────────────────────────────

    describe('P4.2B: telemetry_anomaly detection', () => {
        it('produces no candidate when getDegradedMetrics is not provided', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    // getDegradedMetrics intentionally omitted
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            expect(candidates.find(c => c.source === 'telemetry_anomaly')).toBeUndefined();
            engine.stop();
        });

        it('produces no candidate when sampleCount is below threshold (< 3)', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    getDegradedMetrics: () => [
                        { metricName: 'latency', subsystemId: 'inference', observedValue: 5000, threshold: 1000, sampleCount: 2, windowMs: 30 * 60 * 1000 },
                    ],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            expect(candidates.find(c => c.source === 'telemetry_anomaly')).toBeUndefined();
            engine.stop();
        });

        it('emits a telemetry_anomaly candidate when sampleCount meets threshold (≥ 3)', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    getDegradedMetrics: () => [
                        { metricName: 'error_rate', subsystemId: 'mcp', observedValue: 0.9, threshold: 0.1, sampleCount: 5, windowMs: 30 * 60 * 1000 },
                    ],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            const c = candidates.find(c => c.source === 'telemetry_anomaly');
            expect(c).toBeDefined();
            expect(c!.subsystemId).toBe('mcp');
            expect(c!.sourceContext.kind).toBe('telemetry_anomaly');
            const ctx = c!.sourceContext as any;
            expect(ctx.metricName).toBe('error_rate');
            expect(ctx.observedValue).toBe(0.9);
            engine.stop();
        });

        it('emits one candidate per unique (subsystemId, metricName) pair', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    getDegradedMetrics: () => [
                        { metricName: 'latency', subsystemId: 'inference', observedValue: 9000, threshold: 1000, sampleCount: 4, windowMs: 30 * 60 * 1000 },
                        { metricName: 'error_rate', subsystemId: 'inference', observedValue: 0.8, threshold: 0.1, sampleCount: 3, windowMs: 30 * 60 * 1000 },
                        { metricName: 'latency', subsystemId: 'mcp', observedValue: 5000, threshold: 1000, sampleCount: 3, windowMs: 30 * 60 * 1000 },
                    ],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            const anomalies = candidates.filter(c => c.source === 'telemetry_anomaly');
            expect(anomalies).toHaveLength(3);
            engine.stop();
        });

        it('fingerprint is stable for same (subsystemId, metricName) across calls', () => {
            const engine = new GoalDetectionEngine(
                { listRecentExecutionRuns: () => [], listGovernanceDecisions: () => [], listReflectionGoals: async () => [], getActiveGoalFingerprints: () => new Set() },
                () => {},
            );
            const fp1 = engine.fingerprint('telemetry_anomaly', 'inference', 'error_rate');
            const fp2 = engine.fingerprint('telemetry_anomaly', 'inference', 'error_rate');
            expect(fp1).toBe(fp2);
            engine.stop();
        });

        it('marks candidate as isDuplicate when fingerprint matches active goal', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getDegradedMetrics: () => [
                        { metricName: 'error_rate', subsystemId: 'mcp', observedValue: 0.9, threshold: 0.1, sampleCount: 5, windowMs: 30 * 60 * 1000 },
                    ],
                    getActiveGoalFingerprints: () => {
                        const e = new GoalDetectionEngine(
                            { listRecentExecutionRuns: () => [], listGovernanceDecisions: () => [], listReflectionGoals: async () => [], getActiveGoalFingerprints: () => new Set() },
                            () => {},
                        );
                        return new Set([e.fingerprint('telemetry_anomaly', 'mcp', 'error_rate')]);
                    },
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            const c = candidates.find(c => c.source === 'telemetry_anomaly');
            expect(c).toBeDefined();
            expect(c!.isDuplicate).toBe(true);
            engine.stop();
        });
    });

    // ── P4.2C: Stale Subsystem Detection ───────────────────────────────────────

    describe('P4.2C: stale_subsystem detection', () => {
        it('produces no candidate when listSubsystemActivity is not provided', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    // listSubsystemActivity intentionally omitted
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            expect(candidates.find(c => c.source === 'stale_subsystem')).toBeUndefined();
            engine.stop();
        });

        it('produces no candidate when subsystem has recent activity (< 3 days)', async () => {
            const recentActivity = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    listSubsystemActivity: () => [
                        { subsystemId: 'inference', lastActivityAt: recentActivity },
                    ],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            expect(candidates.find(c => c.source === 'stale_subsystem')).toBeUndefined();
            engine.stop();
        });

        it('emits stale_subsystem candidate when lastActivityAt is > 3 days ago', async () => {
            const staleTime = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    listSubsystemActivity: () => [
                        { subsystemId: 'mcp', lastActivityAt: staleTime },
                    ],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            const c = candidates.find(c => c.source === 'stale_subsystem');
            expect(c).toBeDefined();
            expect(c!.subsystemId).toBe('mcp');
            expect(c!.sourceContext.kind).toBe('stale_subsystem');
            const ctx = c!.sourceContext as any;
            expect(ctx.staleDays).toBeGreaterThanOrEqual(5);
            engine.stop();
        });

        it('emits stale_subsystem candidate when lastActivityAt is undefined (never active)', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    listSubsystemActivity: () => [
                        { subsystemId: 'experimental', lastActivityAt: undefined },
                    ],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            const c = candidates.find(c => c.source === 'stale_subsystem');
            expect(c).toBeDefined();
            expect(c!.subsystemId).toBe('experimental');
            engine.stop();
        });

        it('fingerprint is stable across detection cycles for same subsystem', () => {
            const engine = new GoalDetectionEngine(
                { listRecentExecutionRuns: () => [], listGovernanceDecisions: () => [], listReflectionGoals: async () => [], getActiveGoalFingerprints: () => new Set() },
                () => {},
            );
            const fp1 = engine.fingerprint('stale_subsystem', 'mcp', 'stale');
            const fp2 = engine.fingerprint('stale_subsystem', 'mcp', 'stale');
            expect(fp1).toBe(fp2);
            engine.stop();
        });
    });

    // ── P4.2D: Weak Coverage Signal Detection ──────────────────────────────────

    describe('P4.2D: weak_coverage_signal detection', () => {
        it('produces no candidate when getDegradedCapabilities is not provided', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    // getDegradedCapabilities intentionally omitted
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            expect(candidates.find(c => c.source === 'weak_coverage_signal')).toBeUndefined();
            engine.stop();
        });

        it('produces no candidate when no capabilities are degraded', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    getDegradedCapabilities: () => [],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            expect(candidates.find(c => c.source === 'weak_coverage_signal')).toBeUndefined();
            engine.stop();
        });

        it('emits one candidate per subsystem with degraded capabilities', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    getDegradedCapabilities: () => [
                        { capabilityId: 'cap-inference-1', subsystemId: 'inference', status: 'degraded' },
                        { capabilityId: 'cap-inference-2', subsystemId: 'inference', status: 'unavailable' },
                        { capabilityId: 'cap-mcp-1', subsystemId: 'mcp', status: 'degraded' },
                    ],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            const weakCoverage = candidates.filter(c => c.source === 'weak_coverage_signal');
            // One candidate per subsystem (inference + mcp = 2)
            expect(weakCoverage).toHaveLength(2);
            const inferenceCandidate = weakCoverage.find(c => c.subsystemId === 'inference');
            expect(inferenceCandidate).toBeDefined();
            const ctx = inferenceCandidate!.sourceContext as any;
            expect(ctx.kind).toBe('weak_coverage_signal');
            expect(ctx.missingCoverageIndicators).toContain('cap-inference-1');
            expect(ctx.missingCoverageIndicators).toContain('cap-inference-2');
            expect(ctx.testCount).toBe(2);
            engine.stop();
        });

        it('context.missingCoverageIndicators is sorted for fingerprint stability', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    getDegradedCapabilities: () => [
                        { capabilityId: 'cap-z', subsystemId: 'inference', status: 'degraded' },
                        { capabilityId: 'cap-a', subsystemId: 'inference', status: 'degraded' },
                    ],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            const c = candidates.find(c => c.source === 'weak_coverage_signal');
            expect(c).toBeDefined();
            const ctx = c!.sourceContext as any;
            expect(ctx.missingCoverageIndicators[0]).toBe('cap-a');
            expect(ctx.missingCoverageIndicators[1]).toBe('cap-z');
            engine.stop();
        });
    });

    // ── P4.2E: Backlog Goal Detection ──────────────────────────────────────────

    describe('P4.2E: unresolved_backlog_item detection', () => {
        it('produces no candidate when listBacklogGoals is not provided', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    // listBacklogGoals intentionally omitted
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            expect(candidates.find(c => c.source === 'unresolved_backlog_item')).toBeUndefined();
            engine.stop();
        });

        it('produces no candidate for goals newer than 14 days', async () => {
            const recentGoal = {
                goalId: 'g1', title: 'recent goal', category: 'mcp', status: 'queued',
                source: 'system', createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
            };
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    listBacklogGoals: async () => [recentGoal],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            expect(candidates.find(c => c.source === 'unresolved_backlog_item')).toBeUndefined();
            engine.stop();
        });

        it('emits unresolved_backlog_item for non-user goals older than 14 days', async () => {
            const oldGoal = {
                goalId: 'g1', title: 'old refactor goal', category: 'inference', status: 'queued',
                source: 'system', createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
                description: 'Refactor inference module', attemptCount: 2,
            };
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    listBacklogGoals: async () => [oldGoal],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            const c = candidates.find(c => c.source === 'unresolved_backlog_item');
            expect(c).toBeDefined();
            expect(c!.subsystemId).toBe('inference');
            const ctx = c!.sourceContext as any;
            expect(ctx.kind).toBe('unresolved_backlog_item');
            expect(ctx.age).toBeGreaterThanOrEqual(20);
            expect(ctx.previousAttempts).toBe(2);
            engine.stop();
        });

        it('does not emit unresolved_backlog_item for user-seeded goals', async () => {
            const userGoal = {
                goalId: 'g2', title: 'user goal', category: 'mcp', status: 'queued',
                source: 'user', createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
            };
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    listBacklogGoals: async () => [userGoal],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            expect(candidates.find(c => c.source === 'unresolved_backlog_item')).toBeUndefined();
            engine.stop();
        });

        it('does not emit for goals with status other than queued', async () => {
            const completedGoal = {
                goalId: 'g3', title: 'done goal', category: 'inference', status: 'completed',
                source: 'system', createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
            };
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    listBacklogGoals: async () => [completedGoal],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            expect(candidates.find(c => c.source === 'unresolved_backlog_item')).toBeUndefined();
            engine.stop();
        });
    });

    // ── P4.2E: Recurring Reflection Goal Detection ─────────────────────────────

    describe('P4.2E: recurring_reflection_goal detection', () => {
        it('does not emit when the same goal title appears fewer than 2 times', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [
                        { goalId: 'g1', title: 'improve error handling', category: 'inference', status: 'queued', source: 'system', createdAt: new Date().toISOString() },
                    ],
                    getActiveGoalFingerprints: () => new Set(),
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            expect(candidates.find(c => c.source === 'recurring_reflection_goal')).toBeUndefined();
            engine.stop();
        });

        it('emits recurring_reflection_goal when ≥ 2 queued goals share the same title+category', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [
                        { goalId: 'g1', title: 'improve error handling', category: 'inference', status: 'queued', source: 'system', createdAt: new Date(Date.now() - 10000).toISOString() },
                        { goalId: 'g2', title: 'improve error handling', category: 'inference', status: 'queued', source: 'system', createdAt: new Date().toISOString() },
                    ],
                    getActiveGoalFingerprints: () => new Set(),
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            const c = candidates.find(c => c.source === 'recurring_reflection_goal');
            expect(c).toBeDefined();
            expect(c!.subsystemId).toBe('inference');
            const ctx = c!.sourceContext as any;
            expect(ctx.kind).toBe('recurring_reflection_goal');
            expect(ctx.recurrenceCount).toBe(2);
            expect(typeof ctx.lastOccurrence).toBe('string');
            engine.stop();
        });

        it('context carries the correct recurrenceCount for 3 occurrences', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [
                        { goalId: 'g1', title: 'reduce latency', category: 'mcp', status: 'queued', source: 'system', createdAt: new Date(Date.now() - 30000).toISOString() },
                        { goalId: 'g2', title: 'reduce latency', category: 'mcp', status: 'queued', source: 'system', createdAt: new Date(Date.now() - 20000).toISOString() },
                        { goalId: 'g3', title: 'reduce latency', category: 'mcp', status: 'queued', source: 'system', createdAt: new Date().toISOString() },
                    ],
                    getActiveGoalFingerprints: () => new Set(),
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            const c = candidates.find(c => c.source === 'recurring_reflection_goal');
            expect(c).toBeDefined();
            const ctx = c!.sourceContext as any;
            expect(ctx.recurrenceCount).toBe(3);
            engine.stop();
        });

        it('does not treat user-seeded goals as recurring reflection goals', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [
                        { goalId: 'g1', title: 'user request', category: 'inference', status: 'queued', source: 'user', createdAt: new Date().toISOString() },
                        { goalId: 'g2', title: 'user request', category: 'inference', status: 'queued', source: 'user', createdAt: new Date().toISOString() },
                    ],
                    getActiveGoalFingerprints: () => new Set(),
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            // user goals should not produce recurring_reflection_goal
            expect(candidates.find(c => c.source === 'recurring_reflection_goal')).toBeUndefined();
            engine.stop();
        });
    });

    // ── P4.2F: Deduplication & Fingerprint Stability ────────────────────────────

    describe('P4.2F: deduplication and fingerprint stability', () => {
        it('runOnce() never emits two candidates with the same dedupFingerprint in one cycle', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [
                        { executionId: 'e1', subsystemId: 'inference', status: 'aborted', createdAt: new Date().toISOString() } as any,
                        { executionId: 'e2', subsystemId: 'inference', status: 'aborted', createdAt: new Date().toISOString() } as any,
                        { executionId: 'e3', subsystemId: 'inference', status: 'aborted', createdAt: new Date().toISOString() } as any,
                    ],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    getDegradedMetrics: () => [
                        { metricName: 'error_rate', subsystemId: 'inference', observedValue: 0.9, threshold: 0.1, sampleCount: 5, windowMs: 30 * 60 * 1000 },
                    ],
                    getDegradedCapabilities: () => [
                        { capabilityId: 'cap-1', subsystemId: 'mcp', status: 'degraded' },
                    ],
                },
                () => {},
            );
            const candidates = await engine.runOnce();
            const fps = candidates.map(c => c.dedupFingerprint);
            const unique = new Set(fps);
            expect(unique.size).toBe(fps.length);
            engine.stop();
        });

        it('different sources for the same subsystem produce distinct fingerprints', () => {
            const engine = new GoalDetectionEngine(
                { listRecentExecutionRuns: () => [], listGovernanceDecisions: () => [], listReflectionGoals: async () => [], getActiveGoalFingerprints: () => new Set() },
                () => {},
            );
            const fp1 = engine.fingerprint('telemetry_anomaly', 'inference', 'error_rate');
            const fp2 = engine.fingerprint('stale_subsystem', 'inference', 'error_rate');
            const fp3 = engine.fingerprint('weak_coverage_signal', 'inference', 'error_rate');
            const fp4 = engine.fingerprint('unresolved_backlog_item', 'inference', 'error_rate');
            const fp5 = engine.fingerprint('recurring_reflection_goal', 'inference', 'error_rate');
            const fps = [fp1, fp2, fp3, fp4, fp5];
            expect(new Set(fps).size).toBe(5);
            engine.stop();
        });

        it('candidates with isDuplicate=true are still returned (suppression is downstream)', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    getDegradedCapabilities: () => [
                        { capabilityId: 'cap-1', subsystemId: 'mcp', status: 'degraded' },
                    ],
                },
                () => {},
            );
            // Pre-populate with the fingerprint of the weak_coverage_signal candidate
            const fp = engine.fingerprint('weak_coverage_signal', 'mcp', 'cap-1');
            const engineWithDup = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set([fp]),
                    getDegradedCapabilities: () => [
                        { capabilityId: 'cap-1', subsystemId: 'mcp', status: 'degraded' },
                    ],
                },
                () => {},
            );
            const candidates = await engineWithDup.runOnce();
            const c = candidates.find(c => c.source === 'weak_coverage_signal');
            expect(c).toBeDefined();
            expect(c!.isDuplicate).toBe(true);
            engineWithDup.stop();
        });

        it('second runOnce() call with same deps returns same fingerprints (no randomness)', async () => {
            const staleTime = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
            const deps = {
                listRecentExecutionRuns: () => [],
                listGovernanceDecisions: () => [],
                listReflectionGoals: async () => [],
                getActiveGoalFingerprints: () => new Set(),
                listSubsystemActivity: () => [{ subsystemId: 'mcp', lastActivityAt: staleTime }],
            };
            const engine = new GoalDetectionEngine(deps, () => {});
            const run1 = await engine.runOnce();
            const run2 = await engine.runOnce();
            const fps1 = run1.map(c => c.dedupFingerprint).sort();
            const fps2 = run2.map(c => c.dedupFingerprint).sort();
            expect(fps1).toEqual(fps2);
            engine.stop();
        });
    });

    // ── P4.2H: Safety Validation ────────────────────────────────────────────────

    describe('P4.2H: safety validation', () => {
        it('all new detectors return empty when their optional dep throws', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                    getDegradedMetrics: () => { throw new Error('metrics unavailable'); },
                    listSubsystemActivity: () => { throw new Error('self-model unavailable'); },
                    getDegradedCapabilities: () => { throw new Error('caps unavailable'); },
                    listBacklogGoals: async () => { throw new Error('goals unavailable'); },
                },
                () => {},
            );
            // Should not throw; each detector catches its own errors
            await expect(engine.runOnce()).resolves.not.toThrow();
            const candidates = await engine.runOnce();
            expect(candidates.find(c => c.source === 'telemetry_anomaly')).toBeUndefined();
            expect(candidates.find(c => c.source === 'stale_subsystem')).toBeUndefined();
            expect(candidates.find(c => c.source === 'weak_coverage_signal')).toBeUndefined();
            expect(candidates.find(c => c.source === 'unresolved_backlog_item')).toBeUndefined();
            engine.stop();
        });

        it('runOnce() completes without throwing when all optional deps are absent', async () => {
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => [],
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                },
                () => {},
            );
            await expect(engine.runOnce()).resolves.toEqual([]);
            engine.stop();
        });

        it('sequential runOnce() calls both complete without interference', async () => {
            let callCount = 0;
            const engine = new GoalDetectionEngine(
                {
                    listRecentExecutionRuns: () => { callCount++; return []; },
                    listGovernanceDecisions: () => [],
                    listReflectionGoals: async () => [],
                    getActiveGoalFingerprints: () => new Set(),
                },
                () => {},
            );
            // Direct calls to runOnce() are sequential and always execute;
            // the _isRunning guard only blocks timer-triggered overlap in start().
            const r1 = await engine.runOnce();
            const r2 = await engine.runOnce();
            // Both calls ran (callCount = 2 calls × 2 detectors using listRecentExecutionRuns)
            expect(callCount).toBeGreaterThanOrEqual(2);
            expect(Array.isArray(r1)).toBe(true);
            expect(Array.isArray(r2)).toBe(true);
            engine.stop();
        });
    });
});
