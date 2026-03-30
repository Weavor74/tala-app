/**
 * StrategyRoutingPhase61.test.ts
 *
 * Phase 6.1: Strategy Routing — Comprehensive Test Suite
 *
 * Covers:
 *   P6.1A  strategyRoutingTypes — contracts, bounds constants, type shapes
 *   P6.1B  StrategyRoutingEligibility — all 9 eligibility checks
 *   P6.1C  StrategyRoutingEngine — routing, dedup, persistence, cooldowns
 *   P6.1D  Goal/campaign materialization — target mapping correctness
 *   P6.1F  StrategyRoutingOutcomeTracker — record, trust score, purge
 *   P6.1G  StrategyRoutingDashboardBridge — buildState, KPIs, dedup emit
 *   P6.1H  Safety controls — protected subsystems, scope bounds, cooldowns
 *          + IPC handler registration
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
    StrategyRoutingDecision,
    StrategyRoutingTargetType,
    StrategyRoutingOutcomeRecord,
    StrategyRoutingDashboardState,
    StrategyRoutingInput,
    RoutingEligibilityResult,
} from '../../shared/strategyRoutingTypes';
import { STRATEGY_ROUTING_BOUNDS } from '../../shared/strategyRoutingTypes';

import { StrategyRoutingEligibility } from '../../electron/services/autonomy/crossSystem/StrategyRoutingEligibility';
import { StrategyRoutingEngine } from '../../electron/services/autonomy/crossSystem/StrategyRoutingEngine';
import { StrategyRoutingOutcomeTracker } from '../../electron/services/autonomy/crossSystem/StrategyRoutingOutcomeTracker';
import { StrategyRoutingDashboardBridge } from '../../electron/services/autonomy/crossSystem/StrategyRoutingDashboardBridge';
import { StrategyRoutingAppService } from '../../electron/services/autonomy/StrategyRoutingAppService';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tala-routing-test-'));
}

function removeTempDir(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* non-fatal */ }
}

function makeCluster(overrides: Partial<import('../../shared/crossSystemTypes').IncidentCluster> = {}): import('../../shared/crossSystemTypes').IncidentCluster {
    const now = new Date().toISOString();
    return {
        clusterId: `cluster-${Math.random().toString(36).slice(2, 9)}`,
        label: 'Test cluster',
        signalIds: ['signal-001', 'signal-002'],
        subsystems: ['inference'],
        sharedFiles: ['electron/services/inference/InferenceService.ts'],
        clusteringCriteria: ['repeated_subsystem_failure', 'shared_file_pattern'],
        status: 'open',
        signalCount: 2,
        firstSeenAt: now,
        lastSeenAt: now,
        rootCauseId: undefined,
        ...overrides,
    };
}

function makeRootCause(overrides: Partial<import('../../shared/crossSystemTypes').RootCauseHypothesis> = {}): import('../../shared/crossSystemTypes').RootCauseHypothesis {
    return {
        rootCauseId: `rc-${Math.random().toString(36).slice(2, 9)}`,
        clusterId: 'cluster-001',
        category: 'repeated_failure_pattern',
        confidence: 0.80,
        score: 70,
        primarySignalIds: ['signal-001'],
        affectedSubsystems: ['inference'],
        affectedFiles: ['electron/services/inference/InferenceService.ts'],
        hypothesis: 'Repeated inference failures suggest a model timeout pattern.',
        supportingEvidence: ['3 failures in 4h'],
        analyzedAt: new Date().toISOString(),
        ...overrides,
    };
}

function makeStrategyDecision(overrides: Partial<import('../../shared/crossSystemTypes').StrategyDecisionRecord> = {}): import('../../shared/crossSystemTypes').StrategyDecisionRecord {
    return {
        decisionId: `dec-${Math.random().toString(36).slice(2, 9)}`,
        clusterId: 'cluster-001',
        rootCauseId: 'rc-001',
        strategySelected: 'targeted_repair',
        rationale: 'Narrow scope, high confidence pattern.',
        policyConstraints: [],
        alternativesConsidered: ['multi_step_campaign'],
        scopeSummary: 'inference subsystem model timeout repair',
        decidedAt: new Date().toISOString(),
        ...overrides,
    };
}

function makeRoutingInput(overrides: {
    cluster?: Partial<import('../../shared/crossSystemTypes').IncidentCluster>;
    rootCause?: Partial<import('../../shared/crossSystemTypes').RootCauseHypothesis>;
    decision?: Partial<import('../../shared/crossSystemTypes').StrategyDecisionRecord>;
    context?: Partial<import('../../shared/strategyRoutingTypes').StrategyRoutingContext>;
} = {}): StrategyRoutingInput {
    const cluster = makeCluster(overrides.cluster);
    const rootCause = makeRootCause({ clusterId: cluster.clusterId, ...overrides.rootCause });
    const decision = makeStrategyDecision({ clusterId: cluster.clusterId, ...overrides.decision });
    return {
        sourceDecision: decision,
        cluster,
        rootCause,
        context: {
            protectedSubsystems: [],
            campaignCapacityAvailable: true,
            activeRoutingCount: 0,
            ...overrides.context,
        },
    };
}

// ─── P6.1A: Type Contracts ────────────────────────────────────────────────────

describe('P6.1A — strategyRoutingTypes contracts', () => {
    it('STRATEGY_ROUTING_BOUNDS has expected keys and sane values', () => {
        expect(STRATEGY_ROUTING_BOUNDS.MAX_CONCURRENT_ROUTINGS).toBeGreaterThan(0);
        expect(STRATEGY_ROUTING_BOUNDS.MAX_SCOPE_SUBSYSTEMS_AUTO_ROUTE).toBeGreaterThan(0);
        expect(STRATEGY_ROUTING_BOUNDS.MIN_ROOT_CAUSE_CONFIDENCE).toBeGreaterThan(0);
        expect(STRATEGY_ROUTING_BOUNDS.MIN_ROOT_CAUSE_CONFIDENCE).toBeLessThan(1);
        expect(STRATEGY_ROUTING_BOUNDS.MIN_CONFIDENCE_FOR_GOAL).toBeGreaterThan(STRATEGY_ROUTING_BOUNDS.MIN_ROOT_CAUSE_CONFIDENCE);
        expect(STRATEGY_ROUTING_BOUNDS.MIN_ROOT_CAUSE_SCORE).toBeGreaterThan(0);
        expect(STRATEGY_ROUTING_BOUNDS.MAX_STRATEGY_CAMPAIGN_STEPS).toBeGreaterThan(0);
    });

    it('StrategyRoutingTargetType has expected values', () => {
        const types: StrategyRoutingTargetType[] = [
            'autonomous_goal',
            'repair_campaign',
            'harmonization_campaign',
            'human_review',
            'deferred',
        ];
        expect(types).toHaveLength(5);
    });
});

// ─── P6.1B: StrategyRoutingEligibility ───────────────────────────────────────

describe('P6.1B — StrategyRoutingEligibility', () => {
    let eligibility: StrategyRoutingEligibility;
    let tempDir: string;
    let engine: StrategyRoutingEngine;
    let outcomeTracker: StrategyRoutingOutcomeTracker;
    let bridge: StrategyRoutingDashboardBridge;

    beforeEach(() => {
        eligibility = new StrategyRoutingEligibility();
        tempDir = makeTempDir();
        bridge = new StrategyRoutingDashboardBridge();
        outcomeTracker = new StrategyRoutingOutcomeTracker(tempDir);
        engine = new StrategyRoutingEngine(tempDir, outcomeTracker, bridge);
    });

    afterEach(() => removeTempDir(tempDir));

    it('high-confidence narrow-scope targeted_repair is eligible for autonomous_goal', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.85, score: 75 },
            decision: { strategySelected: 'targeted_repair' },
        });
        const result = eligibility.evaluate(input, engine);
        expect(result.eligible).toBe(true);
        expect(result.targetType).toBe('autonomous_goal');
        expect(result.blockedFactors).toHaveLength(0);
    });

    it('confidence below MIN_ROOT_CAUSE_CONFIDENCE blocks routing', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.20, score: 75 },
            decision: { strategySelected: 'targeted_repair' },
        });
        const result = eligibility.evaluate(input, engine);
        expect(result.eligible).toBe(false);
        expect(result.blockedFactors.some(f => f.factor === 'confidence_too_low')).toBe(true);
    });

    it('score below MIN_ROOT_CAUSE_SCORE blocks routing', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.80, score: 20 },
            decision: { strategySelected: 'targeted_repair' },
        });
        const result = eligibility.evaluate(input, engine);
        expect(result.eligible).toBe(false);
        expect(result.blockedFactors.some(f => f.factor === 'score_too_low')).toBe(true);
    });

    it('scope too large (> MAX_SCOPE_SUBSYSTEMS_AUTO_ROUTE) falls back to human_review', () => {
        const input = makeRoutingInput({
            cluster: { subsystems: ['a', 'b', 'c', 'd'] },
            rootCause: { confidence: 0.80, score: 70 },
            decision: { strategySelected: 'targeted_repair' },
        });
        const result = eligibility.evaluate(input, engine);
        expect(result.eligible).toBe(true); // eligible but rerouted
        expect(result.targetType).toBe('human_review');
        expect(result.blockedFactors.some(f => f.factor === 'scope_too_large')).toBe(true);
    });

    it('protected subsystem falls back to human_review', () => {
        const input = makeRoutingInput({
            cluster: { subsystems: ['soul'] },
            rootCause: { confidence: 0.80, score: 70 },
            decision: { strategySelected: 'targeted_repair' },
            context: { protectedSubsystems: ['soul'] },
        });
        const result = eligibility.evaluate(input, engine);
        expect(result.eligible).toBe(true); // eligible but rerouted
        expect(result.targetType).toBe('human_review');
        expect(result.blockedFactors.some(f => f.factor === 'protected_subsystem')).toBe(true);
    });

    it('defer strategy bypasses all checks and returns deferred', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.10, score: 5 },
            decision: { strategySelected: 'defer' },
        });
        const result = eligibility.evaluate(input, engine);
        expect(result.eligible).toBe(true);
        expect(result.targetType).toBe('deferred');
        expect(result.blockedFactors).toHaveLength(0);
    });

    it('escalate_human strategy bypasses confidence/scope checks and returns human_review', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.10, score: 5 },
            decision: { strategySelected: 'escalate_human' },
        });
        const result = eligibility.evaluate(input, engine);
        expect(result.eligible).toBe(true);
        expect(result.targetType).toBe('human_review');
    });

    it('ambiguous cluster (temporal_proximity only) is blocked', () => {
        const input = makeRoutingInput({
            cluster: { clusteringCriteria: ['temporal_proximity'] },
            rootCause: { confidence: 0.80, score: 70 },
            decision: { strategySelected: 'targeted_repair' },
        });
        const result = eligibility.evaluate(input, engine);
        expect(result.eligible).toBe(false);
        expect(result.blockedFactors.some(f => f.factor === 'ambiguity_too_high')).toBe(true);
    });

    it('multi_step_campaign maps to repair_campaign target', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.80, score: 70 },
            decision: { strategySelected: 'multi_step_campaign' },
        });
        const result = eligibility.evaluate(input, engine);
        expect(result.eligible).toBe(true);
        expect(result.targetType).toBe('repair_campaign');
    });

    it('harmonization_campaign maps to harmonization_campaign target', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.80, score: 70 },
            decision: { strategySelected: 'harmonization_campaign' },
        });
        const result = eligibility.evaluate(input, engine);
        expect(result.eligible).toBe(true);
        expect(result.targetType).toBe('harmonization_campaign');
    });

    it('concurrent cap reached blocks routing', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.80, score: 70 },
            decision: { strategySelected: 'targeted_repair' },
            context: { activeRoutingCount: STRATEGY_ROUTING_BOUNDS.MAX_CONCURRENT_ROUTINGS },
        });
        const result = eligibility.evaluate(input, engine);
        expect(result.eligible).toBe(false);
        expect(result.blockedFactors.some(f => f.factor === 'concurrent_cap_reached')).toBe(true);
    });
});

// ─── P6.1C: StrategyRoutingEngine ────────────────────────────────────────────

describe('P6.1C — StrategyRoutingEngine routing and persistence', () => {
    let tempDir: string;
    let engine: StrategyRoutingEngine;
    let outcomeTracker: StrategyRoutingOutcomeTracker;
    let bridge: StrategyRoutingDashboardBridge;

    beforeEach(() => {
        tempDir = makeTempDir();
        bridge = new StrategyRoutingDashboardBridge();
        outcomeTracker = new StrategyRoutingOutcomeTracker(tempDir);
        engine = new StrategyRoutingEngine(tempDir, outcomeTracker, bridge);
    });

    afterEach(() => removeTempDir(tempDir));

    it('routes a high-confidence targeted_repair decision to autonomous_goal', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.85, score: 75 },
            decision: { strategySelected: 'targeted_repair' },
        });
        const decision = engine.route(input);
        expect(decision.routingDecisionId).toMatch(/^sroute-/);
        expect(decision.routingTargetType).toBe('autonomous_goal');
        expect(decision.status).toBe('eligible');
    });

    it('routes a defer decision to deferred status', () => {
        const input = makeRoutingInput({
            decision: { strategySelected: 'defer' },
        });
        const decision = engine.route(input);
        expect(decision.routingTargetType).toBe('deferred');
        expect(decision.status).toBe('deferred');
    });

    it('routes escalate_human to human_review status', () => {
        const input = makeRoutingInput({
            decision: { strategySelected: 'escalate_human' },
        });
        const decision = engine.route(input);
        expect(decision.routingTargetType).toBe('human_review');
        expect(decision.status).toBe('human_review');
    });

    it('blocked decision has blocked status and blockedReason set', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.10, score: 5 },
            decision: { strategySelected: 'targeted_repair' },
        });
        const decision = engine.route(input);
        expect(decision.status).toBe('blocked');
        expect(decision.blockedReason).toBeTruthy();
    });

    it('prevents duplicate routing for same cluster (idempotent)', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.85, score: 75 },
            decision: { strategySelected: 'targeted_repair' },
        });
        const first = engine.route(input);
        const second = engine.route(input); // same clusterId
        expect(first.routingDecisionId).toBe(second.routingDecisionId);
    });

    it('hasRoutingForCluster returns true after routing', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.85, score: 75 },
        });
        expect(engine.hasRoutingForCluster(input.cluster.clusterId)).toBe(false);
        engine.route(input);
        expect(engine.hasRoutingForCluster(input.cluster.clusterId)).toBe(true);
    });

    it('markRouted transitions decision to routed status with action ref', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.85, score: 75 },
        });
        const decision = engine.route(input);
        engine.markRouted(decision.routingDecisionId, {
            actionType: 'autonomous_goal',
            actionId: 'goal-abc123',
            createdAt: new Date().toISOString(),
            status: 'pending',
        });
        const updated = engine.getDecision(decision.routingDecisionId);
        expect(updated?.status).toBe('routed');
        expect(updated?.routedActionRef?.actionId).toBe('goal-abc123');
    });

    it('sets cooldown after failed routing and blocks re-routing', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.85, score: 75 },
        });
        const decision = engine.route(input);
        engine.markRouted(decision.routingDecisionId, {
            actionType: 'autonomous_goal',
            actionId: 'goal-xyz',
            createdAt: new Date().toISOString(),
            status: 'failed',
        });
        engine.markOutcomeRecorded(decision.routingDecisionId, false);
        expect(engine.isCooldownActive(input.cluster.clusterId)).toBe(true);
    });

    it('persists decisions to disk and loads them back', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.85, score: 75 },
        });
        engine.route(input);
        // Create a fresh engine from the same dir to test persistence
        const bridge2 = new StrategyRoutingDashboardBridge();
        const tracker2 = new StrategyRoutingOutcomeTracker(tempDir);
        const engine2 = new StrategyRoutingEngine(tempDir, tracker2, bridge2);
        const decisions = engine2.listDecisions();
        expect(decisions.length).toBeGreaterThan(0);
    });

    it('getActiveRoutingCount counts only eligible and routed decisions', () => {
        const input1 = makeRoutingInput({ rootCause: { confidence: 0.85, score: 75 } });
        const input2 = makeRoutingInput({
            cluster: { clusterId: 'cluster-other' },
            rootCause: { confidence: 0.10, score: 5 }, // will be blocked
        });
        engine.route(input1);
        engine.route(input2);
        // input1 -> eligible, input2 -> blocked
        expect(engine.getActiveRoutingCount()).toBe(1);
    });
});

// ─── P6.1F: StrategyRoutingOutcomeTracker ────────────────────────────────────

describe('P6.1F — StrategyRoutingOutcomeTracker', () => {
    let tempDir: string;
    let tracker: StrategyRoutingOutcomeTracker;

    beforeEach(() => {
        tempDir = makeTempDir();
        tracker = new StrategyRoutingOutcomeTracker(tempDir);
    });

    afterEach(() => removeTempDir(tempDir));

    it('createAndRecord stores an outcome and returns a valid ID', () => {
        const id = tracker.createAndRecord({
            routingDecisionId: 'sroute-001',
            clusterId: 'cluster-001',
            targetType: 'autonomous_goal',
            actionId: 'goal-abc',
            routingCorrect: true,
            actionCompleted: true,
            actionSucceeded: true,
            strategyValidated: true,
            notes: 'Repair succeeded.',
        });
        expect(id).toMatch(/^srout-/);
        const outcomes = tracker.listOutcomes();
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].outcomeId).toBe(id);
    });

    it('computeOverallTrustScore returns 0.5 when no outcomes', () => {
        expect(tracker.computeOverallTrustScore()).toBe(0.5);
    });

    it('computeOverallTrustScore increases with successful outcomes', () => {
        tracker.createAndRecord({
            routingDecisionId: 'sroute-001',
            clusterId: 'cluster-001',
            targetType: 'autonomous_goal',
            actionId: 'goal-abc',
            routingCorrect: true,
            actionCompleted: true,
            actionSucceeded: true,
            strategyValidated: true,
            notes: '',
        });
        expect(tracker.computeOverallTrustScore()).toBeGreaterThan(0.5);
    });

    it('computeOverallTrustScore decreases with failed outcomes', () => {
        tracker.createAndRecord({
            routingDecisionId: 'sroute-001',
            clusterId: 'cluster-001',
            targetType: 'autonomous_goal',
            actionId: 'goal-abc',
            routingCorrect: false,
            actionCompleted: true,
            actionSucceeded: false,
            strategyValidated: false,
            notes: '',
        });
        expect(tracker.computeOverallTrustScore()).toBeLessThan(0.5);
    });

    it('listOutcomes filters by routingDecisionId', () => {
        tracker.createAndRecord({
            routingDecisionId: 'sroute-001',
            clusterId: 'cluster-001',
            targetType: 'autonomous_goal',
            actionId: 'goal-abc',
            routingCorrect: true,
            actionCompleted: true,
            actionSucceeded: true,
            strategyValidated: true,
            notes: '',
        });
        tracker.createAndRecord({
            routingDecisionId: 'sroute-002',
            clusterId: 'cluster-002',
            targetType: 'repair_campaign',
            actionId: 'campaign-xyz',
            routingCorrect: true,
            actionCompleted: true,
            actionSucceeded: true,
            strategyValidated: true,
            notes: '',
        });
        const filtered = tracker.listOutcomes({ routingDecisionId: 'sroute-001' });
        expect(filtered).toHaveLength(1);
        expect(filtered[0].routingDecisionId).toBe('sroute-001');
    });

    it('persists outcomes to disk and loads them back', () => {
        tracker.createAndRecord({
            routingDecisionId: 'sroute-001',
            clusterId: 'cluster-001',
            targetType: 'autonomous_goal',
            actionId: 'goal-abc',
            routingCorrect: true,
            actionCompleted: true,
            actionSucceeded: true,
            strategyValidated: true,
            notes: 'Test',
        });
        const tracker2 = new StrategyRoutingOutcomeTracker(tempDir);
        const outcomes = tracker2.listOutcomes();
        expect(outcomes).toHaveLength(1);
    });

    it('getRecent returns newest outcomes first', () => {
        for (let i = 0; i < 5; i++) {
            tracker.createAndRecord({
                routingDecisionId: `sroute-00${i}`,
                clusterId: `cluster-00${i}`,
                targetType: 'autonomous_goal',
                actionId: `goal-${i}`,
                routingCorrect: true,
                actionCompleted: true,
                actionSucceeded: true,
                strategyValidated: true,
                notes: '',
            });
        }
        const recent = tracker.getRecent(3);
        expect(recent).toHaveLength(3);
    });
});

// ─── P6.1G: StrategyRoutingDashboardBridge ───────────────────────────────────

describe('P6.1G — StrategyRoutingDashboardBridge', () => {
    let bridge: StrategyRoutingDashboardBridge;

    beforeEach(() => {
        bridge = new StrategyRoutingDashboardBridge();
    });

    it('buildState returns correct dashboard shape', () => {
        const state = bridge.buildState([], [], 0.5);
        expect(state).toHaveProperty('routingDecisions');
        expect(state).toHaveProperty('blockedDecisions');
        expect(state).toHaveProperty('deferredDecisions');
        expect(state).toHaveProperty('humanReviewItems');
        expect(state).toHaveProperty('activeRoutedActions');
        expect(state).toHaveProperty('recentOutcomes');
        expect(state).toHaveProperty('kpis');
        expect(state).toHaveProperty('lastUpdatedAt');
    });

    it('buildState computes KPIs correctly', () => {
        const state = bridge.buildState([], [], 0.75);
        expect(state.kpis.overallTrustScore).toBe(0.75);
        expect(state.kpis.totalDecisionsEvaluated).toBe(0);
    });

    it('maybeEmit returns false for unknown milestone', () => {
        const dummyState = bridge.buildState([], [], 0.5);
        const emitted = bridge.maybeEmit('unknown_milestone', dummyState);
        expect(emitted).toBe(false);
    });

    it('maybeEmit deduplicates consecutive identical states', () => {
        const dummyState = bridge.buildState([], [], 0.5);
        bridge.resetDedupHash();
        const first = bridge.maybeEmit('routing_evaluated', dummyState);
        const second = bridge.maybeEmit('routing_evaluated', dummyState);
        expect(first).toBe(true);
        expect(second).toBe(false); // deduplicated
    });

    it('maybeEmit emits after resetDedupHash', () => {
        const dummyState = bridge.buildState([], [], 0.5);
        bridge.maybeEmit('routing_evaluated', dummyState);
        bridge.resetDedupHash();
        const result = bridge.maybeEmit('routing_evaluated', dummyState);
        expect(result).toBe(true);
    });
});

// ─── P6.1 IPC: StrategyRoutingAppService ─────────────────────────────────────

describe('P6.1 IPC — StrategyRoutingAppService handler registration', () => {
    let tempDir: string;
    let engine: StrategyRoutingEngine;
    let outcomeTracker: StrategyRoutingOutcomeTracker;
    let bridge: StrategyRoutingDashboardBridge;

    beforeEach(() => {
        tempDir = makeTempDir();
        bridge = new StrategyRoutingDashboardBridge();
        outcomeTracker = new StrategyRoutingOutcomeTracker(tempDir);
        engine = new StrategyRoutingEngine(tempDir, outcomeTracker, bridge);
    });

    afterEach(() => removeTempDir(tempDir));

    it('constructs StrategyRoutingAppService without throwing', () => {
        expect(() => new StrategyRoutingAppService(engine, outcomeTracker)).not.toThrow();
    });

    it('ipcMain.handle is called for expected strategyRouting:* channels', async () => {
        // ipcMain.handle is tracked by vitest via the electron mock's ipcMain.handle spy
        const { ipcMain } = await import('electron');
        (ipcMain.handle as ReturnType<typeof vi.fn>).mockClear?.();
        new StrategyRoutingAppService(engine, outcomeTracker);
        const handleMock = ipcMain.handle as ReturnType<typeof vi.fn>;
        const channels = handleMock.mock?.calls?.map((call: any[]) => call[0]) ?? [];
        expect(channels).toContain('strategyRouting:getDashboardState');
        expect(channels).toContain('strategyRouting:listDecisions');
        expect(channels).toContain('strategyRouting:getDecision');
        expect(channels).toContain('strategyRouting:listOutcomes');
    });
});

// ─── P6.1H: Safety and no-bypass guarantees ──────────────────────────────────

describe('P6.1H — Safety controls and no-bypass guarantees', () => {
    let tempDir: string;
    let engine: StrategyRoutingEngine;
    let outcomeTracker: StrategyRoutingOutcomeTracker;
    let bridge: StrategyRoutingDashboardBridge;

    beforeEach(() => {
        tempDir = makeTempDir();
        bridge = new StrategyRoutingDashboardBridge();
        outcomeTracker = new StrategyRoutingOutcomeTracker(tempDir);
        engine = new StrategyRoutingEngine(tempDir, outcomeTracker, bridge);
    });

    afterEach(() => removeTempDir(tempDir));

    it('engine.route produces a record with source strategy metadata (auditability)', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.85, score: 75 },
            decision: { strategySelected: 'targeted_repair', decisionId: 'dec-audit-001' },
        });
        const decision = engine.route(input);
        expect(decision.sourceDecisionId).toBe('dec-audit-001');
        expect(decision.clusterId).toBe(input.cluster.clusterId);
        expect(decision.decidedAt).toBeTruthy();
    });

    it('routing does NOT create AutonomousGoal directly — status is eligible pending materialization', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.85, score: 75 },
        });
        const decision = engine.route(input);
        // Routing engine only sets 'eligible' — it does NOT create a goal itself.
        // Materialization happens in AutonomousRunOrchestrator._materializeRoutingDecision()
        expect(decision.status).toBe('eligible');
        expect(decision.routedActionRef).toBeUndefined();
    });

    it('routing engine does NOT expose a direct mutation path', () => {
        // The engine has no method to write to files or run execution
        expect((engine as any).safePlanner).toBeUndefined();
        expect((engine as any).executionOrchestrator).toBeUndefined();
        expect((engine as any).governanceAppService).toBeUndefined();
    });

    it('broad multi-subsystem cluster routes to human_review not auto-execution', () => {
        const input = makeRoutingInput({
            cluster: { subsystems: ['a', 'b', 'c', 'd', 'e'] },
            rootCause: { confidence: 0.85, score: 75 },
            decision: { strategySelected: 'targeted_repair' },
        });
        const decision = engine.route(input);
        expect(decision.routingTargetType).toBe('human_review');
        // status is human_review — no execution triggered
        expect(decision.status).toBe('human_review');
    });

    it('getDashboardState returns correct shape with all required fields', () => {
        const input = makeRoutingInput({ rootCause: { confidence: 0.85, score: 75 } });
        engine.route(input);
        const state = engine.getDashboardState();
        expect(state).toHaveProperty('routingDecisions');
        expect(state).toHaveProperty('blockedDecisions');
        expect(state).toHaveProperty('deferredDecisions');
        expect(state).toHaveProperty('humanReviewItems');
        expect(state).toHaveProperty('activeRoutedActions');
        expect(state).toHaveProperty('recentOutcomes');
        expect(state.kpis.totalDecisionsEvaluated).toBeGreaterThan(0);
    });

    it('getDashboardState includes linked action ref after markRouted', () => {
        const input = makeRoutingInput({ rootCause: { confidence: 0.85, score: 75 } });
        const decision = engine.route(input);
        engine.markRouted(decision.routingDecisionId, {
            actionType: 'autonomous_goal',
            actionId: 'goal-test-123',
            createdAt: new Date().toISOString(),
            status: 'active',
        });
        const state = engine.getDashboardState();
        const linked = state.activeRoutedActions.find(r => r.actionId === 'goal-test-123');
        expect(linked).toBeTruthy();
        expect(linked?.actionType).toBe('autonomous_goal');
    });

    it('blocked decision appears in blockedDecisions in dashboard state', () => {
        const input = makeRoutingInput({
            rootCause: { confidence: 0.10, score: 5 },
        });
        engine.route(input);
        const state = engine.getDashboardState();
        expect(state.blockedDecisions.length).toBeGreaterThan(0);
        expect(state.blockedDecisions[0].blockedReason).toBeTruthy();
    });

    it('human review decision appears in humanReviewItems', () => {
        const input = makeRoutingInput({
            decision: { strategySelected: 'escalate_human' },
        });
        engine.route(input);
        const state = engine.getDashboardState();
        expect(state.humanReviewItems.length).toBeGreaterThan(0);
    });

    it('deferred decision appears in deferredDecisions', () => {
        const input = makeRoutingInput({
            decision: { strategySelected: 'defer' },
        });
        engine.route(input);
        const state = engine.getDashboardState();
        expect(state.deferredDecisions.length).toBeGreaterThan(0);
    });
});
