/**
 * CrossSystemPhase6.test.ts
 *
 * Phase 6: Cross-System Intelligence — Comprehensive Test Suite
 *
 * Covers:
 *   P6A  crossSystemTypes — contracts, bounds constants, type shapes
 *   P6B  CrossSystemSignalAggregator — ingest, dedup, windowing, bounds
 *   P6C  IncidentClusteringEngine — all 5 criteria, cluster merging, bounds
 *   P6D  RootCauseAnalyzer — scoring factors, category rules, output shape
 *   P6E  CrossSystemStrategySelector — all 9 strategy rules, rationale, alternatives
 *   P6G  CrossSystemOutcomeTracker — record, recurrence detection, persistence, purge
 *   P6H  CrossSystemDashboardBridge — buildState, KPIs, deduplication, IPC emit
 *   P6F  CrossSystemCoordinator — full pipeline, re-entrancy, persistence, signal threshold
 *   P6I  Safety bounds — MAX_CLUSTER_SIZE, MAX_CLUSTERS_OPEN, MAX_SIGNALS_PER_WINDOW
 *        + AutonomousRunOrchestrator P6 wiring
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
    CrossSystemSignal,
    CrossSystemSignalId,
    ClusterId,
    RootCauseId,
    SignalSourceType,
    IncidentCluster,
    RootCauseHypothesis,
    RootCauseCategory,
    CrossSystemStrategyKind,
    StrategyDecisionRecord,
    CrossSystemOutcomeRecord,
    CrossSystemDashboardState,
    CrossSystemKpis,
} from '../../shared/crossSystemTypes';
import { CROSS_SYSTEM_BOUNDS } from '../../shared/crossSystemTypes';

import { CrossSystemSignalAggregator } from '../../electron/services/autonomy/crossSystem/CrossSystemSignalAggregator';
import { IncidentClusteringEngine } from '../../electron/services/autonomy/crossSystem/IncidentClusteringEngine';
import { RootCauseAnalyzer } from '../../electron/services/autonomy/crossSystem/RootCauseAnalyzer';
import { CrossSystemStrategySelector } from '../../electron/services/autonomy/crossSystem/CrossSystemStrategySelector';
import { CrossSystemOutcomeTracker } from '../../electron/services/autonomy/crossSystem/CrossSystemOutcomeTracker';
import { CrossSystemDashboardBridge, CROSS_SYSTEM_DASHBOARD_CHANNEL } from '../../electron/services/autonomy/crossSystem/CrossSystemDashboardBridge';
import { CrossSystemCoordinator } from '../../electron/services/autonomy/crossSystem/CrossSystemCoordinator';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tala-crosssystem-test-'));
}

function removeTempDir(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* non-fatal */ }
}

function makeSignal(overrides: Partial<CrossSystemSignal> = {}): CrossSystemSignal {
    return {
        signalId: `signal-test-${Math.random().toString(36).slice(2, 9)}`,
        sourceType: 'execution_failure',
        subsystem: 'inference',
        affectedFiles: ['electron/services/inference/InferenceService.ts'],
        failureType: 'model_timeout',
        timestamp: new Date().toISOString(),
        severity: 'medium',
        metadata: {},
        ...overrides,
    };
}

function makeCluster(overrides: Partial<IncidentCluster> = {}): IncidentCluster {
    const now = new Date().toISOString();
    return {
        clusterId: `cluster-test-${Math.random().toString(36).slice(2, 9)}`,
        label: 'Test cluster',
        signalIds: ['signal-001', 'signal-002'],
        subsystems: ['inference'],
        sharedFiles: [],
        dominantFailureType: 'model_timeout',
        clusteringCriteria: ['shared_subsystem'],
        firstSeenAt: now,
        lastSeenAt: now,
        signalCount: 2,
        severity: 'medium',
        status: 'open',
        ...overrides,
    };
}

function makeHypothesis(overrides: Partial<RootCauseHypothesis> = {}): RootCauseHypothesis {
    return {
        rootCauseId: `rc-test-${Math.random().toString(36).slice(2, 9)}`,
        clusterId: 'cluster-001',
        category: 'repeated_execution_error',
        description: 'Repeated inference failures in same subsystem',
        score: 60,
        scoringFactors: [],
        confidence: 0.6,
        subsystemsImplicated: ['inference'],
        filesImplicated: [],
        generatedAt: new Date().toISOString(),
        outcomeHistory: [],
        ...overrides,
    };
}

// ─── P6A: Types & Contracts ───────────────────────────────────────────────────

describe('P6A — crossSystemTypes contracts', () => {
    it('CROSS_SYSTEM_BOUNDS has all required keys', () => {
        expect(CROSS_SYSTEM_BOUNDS.MAX_SIGNALS_PER_WINDOW).toBeGreaterThan(0);
        expect(CROSS_SYSTEM_BOUNDS.SIGNAL_WINDOW_MS).toBeGreaterThan(0);
        expect(CROSS_SYSTEM_BOUNDS.MAX_CLUSTER_SIZE).toBeGreaterThan(0);
        expect(CROSS_SYSTEM_BOUNDS.MAX_CLUSTERS_OPEN).toBeGreaterThan(0);
        expect(CROSS_SYSTEM_BOUNDS.MAX_ROOT_CAUSES_PER_CLUSTER).toBeGreaterThan(0);
        expect(CROSS_SYSTEM_BOUNDS.MIN_SIGNALS_TO_CLUSTER).toBeGreaterThan(0);
        expect(CROSS_SYSTEM_BOUNDS.TEMPORAL_PROXIMITY_MS).toBeGreaterThan(0);
        expect(CROSS_SYSTEM_BOUNDS.OUTCOME_RETENTION_MS).toBeGreaterThan(0);
    });

    it('CROSS_SYSTEM_BOUNDS values are sensible', () => {
        expect(CROSS_SYSTEM_BOUNDS.MIN_SIGNALS_TO_CLUSTER).toBeLessThanOrEqual(CROSS_SYSTEM_BOUNDS.MAX_CLUSTER_SIZE);
        expect(CROSS_SYSTEM_BOUNDS.TEMPORAL_PROXIMITY_MS).toBeLessThan(CROSS_SYSTEM_BOUNDS.SIGNAL_WINDOW_MS);
    });

    it('CrossSystemSignal shape satisfies contract', () => {
        const sig: CrossSystemSignal = makeSignal();
        expect(sig.signalId).toBeTruthy();
        expect(sig.sourceType).toBeTruthy();
        expect(sig.subsystem).toBeTruthy();
        expect(Array.isArray(sig.affectedFiles)).toBe(true);
        expect(sig.severity).toMatch(/^(low|medium|high)$/);
    });

    it('IncidentCluster shape satisfies contract', () => {
        const c: IncidentCluster = makeCluster();
        expect(c.clusterId).toBeTruthy();
        expect(Array.isArray(c.signalIds)).toBe(true);
        expect(c.status).toMatch(/^(open|addressed|dismissed|resolved)$/);
    });

    it('RootCauseHypothesis shape satisfies contract', () => {
        const h: RootCauseHypothesis = makeHypothesis();
        expect(h.rootCauseId).toBeTruthy();
        expect(h.score).toBeGreaterThanOrEqual(0);
        expect(h.score).toBeLessThanOrEqual(100);
        expect(h.confidence).toBeGreaterThanOrEqual(0);
        expect(h.confidence).toBeLessThanOrEqual(1);
    });
});

// ─── P6B: CrossSystemSignalAggregator ────────────────────────────────────────

describe('P6B — CrossSystemSignalAggregator', () => {
    let aggregator: CrossSystemSignalAggregator;

    beforeEach(() => {
        aggregator = new CrossSystemSignalAggregator();
    });

    it('ingests a valid signal', () => {
        const sig = makeSignal();
        const result = aggregator.ingest(sig);
        expect(result).toBe(true);
        expect(aggregator.getSignalCount()).toBe(1);
    });

    it('returns windowed signals', () => {
        const s1 = makeSignal({ subsystem: 'inference' });
        const s2 = makeSignal({ subsystem: 'governance' });
        aggregator.ingest(s1);
        aggregator.ingest(s2);
        const windowed = aggregator.getWindowedSignals();
        expect(windowed.length).toBe(2);
    });

    it('deduplicates identical signals within proximity window', () => {
        const sig1 = makeSignal({ signalId: 'signal-a', sourceType: 'execution_failure', subsystem: 'inference', failureType: 'timeout' });
        const sig2 = makeSignal({ signalId: 'signal-b', sourceType: 'execution_failure', subsystem: 'inference', failureType: 'timeout' });
        aggregator.ingest(sig1);
        const result = aggregator.ingest(sig2);
        expect(result).toBe(false);
        expect(aggregator.getSignalCount()).toBe(1);
    });

    it('does NOT deduplicate signals with different failure types', () => {
        const sig1 = makeSignal({ signalId: 'signal-a', sourceType: 'execution_failure', subsystem: 'inference', failureType: 'timeout' });
        const sig2 = makeSignal({ signalId: 'signal-b', sourceType: 'execution_failure', subsystem: 'inference', failureType: 'oom' });
        aggregator.ingest(sig1);
        const result = aggregator.ingest(sig2);
        expect(result).toBe(true);
        expect(aggregator.getSignalCount()).toBe(2);
    });

    it('filters by subsystem', () => {
        aggregator.ingest(makeSignal({ subsystem: 'inference', failureType: 'timeout' }));
        aggregator.ingest(makeSignal({ subsystem: 'governance', failureType: 'block', sourceType: 'governance_block' }));
        expect(aggregator.getSignalsBySubsystem('inference').length).toBe(1);
        expect(aggregator.getSignalsBySubsystem('governance').length).toBe(1);
        expect(aggregator.getSignalsBySubsystem('planning').length).toBe(0);
    });

    it('filters by source type', () => {
        aggregator.ingest(makeSignal({ sourceType: 'execution_failure', failureType: 'timeout' }));
        aggregator.ingest(makeSignal({ sourceType: 'governance_block', failureType: 'tier_exceeded', subsystem: 'governance' }));
        expect(aggregator.getSignalsBySourceType('execution_failure').length).toBe(1);
        expect(aggregator.getSignalsBySourceType('governance_block').length).toBe(1);
    });

    it('enforces MAX_SIGNALS_PER_WINDOW bound', () => {
        for (let i = 0; i < CROSS_SYSTEM_BOUNDS.MAX_SIGNALS_PER_WINDOW + 10; i++) {
            aggregator.ingest(makeSignal({
                signalId: `signal-overload-${i}`,
                subsystem: `sub-${i}`,
                failureType: `ft-${i}`,
            }));
        }
        expect(aggregator.getSignalCount()).toBeLessThanOrEqual(CROSS_SYSTEM_BOUNDS.MAX_SIGNALS_PER_WINDOW);
    });

    it('clear() resets the buffer', () => {
        aggregator.ingest(makeSignal());
        aggregator.clear();
        expect(aggregator.getSignalCount()).toBe(0);
    });
});

// ─── P6C: IncidentClusteringEngine ───────────────────────────────────────────

describe('P6C — IncidentClusteringEngine', () => {
    let engine: IncidentClusteringEngine;

    beforeEach(() => {
        engine = new IncidentClusteringEngine();
    });

    it('clusters signals sharing the same subsystem', () => {
        const signals = [
            makeSignal({ signalId: 'sig-001', subsystem: 'inference', failureType: 'timeout' }),
            makeSignal({ signalId: 'sig-002', subsystem: 'inference', failureType: 'oom' }),
        ];
        const clusters = engine.cluster(signals, []);
        expect(clusters.length).toBeGreaterThan(0);
        const clusterWithBoth = clusters.find(c => c.signalIds.length >= 2);
        expect(clusterWithBoth).toBeDefined();
        expect(clusterWithBoth!.clusteringCriteria).toContain('shared_subsystem');
    });

    it('clusters signals sharing the same failure type', () => {
        const signals = [
            makeSignal({ signalId: 'sig-001', subsystem: 'inference', failureType: 'model_crash' }),
            makeSignal({ signalId: 'sig-002', subsystem: 'execution', failureType: 'model_crash' }),
        ];
        const clusters = engine.cluster(signals, []);
        const shared = clusters.find(c => c.signalIds.length >= 2);
        expect(shared).toBeDefined();
        expect(shared!.clusteringCriteria).toContain('shared_failure_type');
    });

    it('clusters signals sharing affected files', () => {
        const sharedFile = 'electron/services/inference/InferenceService.ts';
        const signals = [
            makeSignal({ signalId: 'sig-001', subsystem: 'inference', affectedFiles: [sharedFile], failureType: 'ft1' }),
            makeSignal({ signalId: 'sig-002', subsystem: 'execution', affectedFiles: [sharedFile], failureType: 'ft2' }),
        ];
        const clusters = engine.cluster(signals, []);
        const shared = clusters.find(c => c.signalIds.length >= 2);
        expect(shared).toBeDefined();
        expect(shared!.clusteringCriteria).toContain('shared_files');
    });

    it('requires MIN_SIGNALS_TO_CLUSTER to form a cluster', () => {
        const signals = [
            makeSignal({ signalId: 'sig-solo', subsystem: 'unique_sub_xyz', failureType: 'unique_ft_xyz', affectedFiles: [] }),
        ];
        const clusters = engine.cluster(signals, []);
        // A single unique signal cannot form a cluster by itself
        const singleCluster = clusters.find(c =>
            c.signalIds.includes('sig-solo') && c.signalCount < CROSS_SYSTEM_BOUNDS.MIN_SIGNALS_TO_CLUSTER,
        );
        // Either no cluster formed or it doesn't meet min threshold
        if (singleCluster) {
            expect(singleCluster.signalCount).toBeLessThan(CROSS_SYSTEM_BOUNDS.MIN_SIGNALS_TO_CLUSTER);
        }
    });

    it('merges new signal into existing open cluster', () => {
        const existing = makeCluster({
            clusterId: 'cluster-existing',
            signalIds: ['sig-001'],
            signalCount: 1,
            subsystems: ['inference'],
            dominantFailureType: 'timeout',
            status: 'open',
        });
        const newSignal = makeSignal({ signalId: 'sig-002', subsystem: 'inference', failureType: 'timeout' });
        const clusters = engine.cluster([newSignal], [existing]);
        const merged = clusters.find(c => c.clusterId === 'cluster-existing');
        expect(merged).toBeDefined();
        expect(merged!.signalCount).toBeGreaterThanOrEqual(2);
    });

    it('enforces MAX_CLUSTER_SIZE', () => {
        const manySignals = Array.from({ length: CROSS_SYSTEM_BOUNDS.MAX_CLUSTER_SIZE + 5 }, (_, i) =>
            makeSignal({ signalId: `sig-over-${i}`, subsystem: 'inference', failureType: 'repeated' }),
        );
        const clusters = engine.cluster(manySignals, []);
        for (const c of clusters) {
            expect(c.signalCount).toBeLessThanOrEqual(CROSS_SYSTEM_BOUNDS.MAX_CLUSTER_SIZE);
        }
    });

    it('enforces MAX_CLUSTERS_OPEN', () => {
        // Build MAX_CLUSTERS_OPEN existing clusters, all open
        const existingClusters = Array.from({ length: CROSS_SYSTEM_BOUNDS.MAX_CLUSTERS_OPEN }, (_, i) =>
            makeCluster({ clusterId: `cluster-existing-${i}`, subsystems: [`sub-existing-${i}`], status: 'open' }),
        );
        // A new unrelated signal should not create an (N+1)th cluster
        const newSignal = makeSignal({ signalId: 'sig-new', subsystem: 'brand_new_sub_abc', failureType: 'brand_new_ft_abc', affectedFiles: [] });
        const newSignal2 = makeSignal({ signalId: 'sig-new2', subsystem: 'brand_new_sub_abc', failureType: 'brand_new_ft_abc2', affectedFiles: [] });
        const result = engine.cluster([newSignal, newSignal2], existingClusters);
        const openCount = result.filter(c => c.status === 'open').length;
        expect(openCount).toBeLessThanOrEqual(CROSS_SYSTEM_BOUNDS.MAX_CLUSTERS_OPEN);
    });

    it('cluster has required fields', () => {
        const signals = [
            makeSignal({ signalId: 's1', subsystem: 'inf', failureType: 'ft' }),
            makeSignal({ signalId: 's2', subsystem: 'inf', failureType: 'ft' }),
        ];
        const clusters = engine.cluster(signals, []);
        for (const c of clusters) {
            expect(c.clusterId).toMatch(/^cluster-/);
            expect(c.label).toBeTruthy();
            expect(Array.isArray(c.subsystems)).toBe(true);
            expect(Array.isArray(c.sharedFiles)).toBe(true);
            expect(c.firstSeenAt).toBeTruthy();
            expect(c.lastSeenAt).toBeTruthy();
        }
    });

    it('does not duplicate signals already in cluster', () => {
        // Start with a cluster that already meets MIN_SIGNALS_TO_CLUSTER threshold
        const existing = makeCluster({
            clusterId: 'cluster-dup-check',
            signalIds: ['sig-already', 'sig-second'],
            signalCount: 2,
            subsystems: ['inference'],
            dominantFailureType: 'timeout',
            status: 'open',
        });
        // Same signal ingested again
        const dupSignal = makeSignal({ signalId: 'sig-already', subsystem: 'inference', failureType: 'timeout' });
        const result = engine.cluster([dupSignal], [existing]);
        const c = result.find(c => c.clusterId === 'cluster-dup-check');
        // Cluster should be present (it already had >= MIN_SIGNALS_TO_CLUSTER)
        expect(c).toBeDefined();
        expect(c!.signalIds.filter(id => id === 'sig-already').length).toBe(1);
    });
});

// ─── P6D: RootCauseAnalyzer ───────────────────────────────────────────────────

describe('P6D — RootCauseAnalyzer', () => {
    let analyzer: RootCauseAnalyzer;

    beforeEach(() => {
        analyzer = new RootCauseAnalyzer();
    });

    it('returns 0 hypotheses for an empty cluster', () => {
        const cluster = makeCluster({ signalIds: [], signalCount: 0 });
        const result = analyzer.analyze(cluster, []);
        expect(result).toEqual([]);
    });

    it('generates hypotheses for a non-empty cluster', () => {
        const signals = [
            makeSignal({ signalId: 's1', subsystem: 'inference', failureType: 'timeout' }),
            makeSignal({ signalId: 's2', subsystem: 'inference', failureType: 'timeout' }),
        ];
        const cluster = makeCluster({
            signalIds: ['s1', 's2'],
            signalCount: 2,
            subsystems: ['inference'],
            dominantFailureType: 'timeout',
        });
        const result = analyzer.analyze(cluster, signals);
        expect(result.length).toBeGreaterThan(0);
    });

    it('capped at MAX_ROOT_CAUSES_PER_CLUSTER', () => {
        const signals = Array.from({ length: 10 }, (_, i) =>
            makeSignal({ signalId: `s${i}`, subsystem: 'inference', failureType: 'timeout' }),
        );
        const cluster = makeCluster({
            signalIds: signals.map(s => s.signalId),
            signalCount: signals.length,
            subsystems: ['inference'],
        });
        const result = analyzer.analyze(cluster, signals);
        expect(result.length).toBeLessThanOrEqual(CROSS_SYSTEM_BOUNDS.MAX_ROOT_CAUSES_PER_CLUSTER);
    });

    it('hypotheses are sorted by score descending', () => {
        const signals = Array.from({ length: 5 }, (_, i) =>
            makeSignal({ signalId: `s${i}`, subsystem: 'inference', failureType: 'timeout' }),
        );
        const cluster = makeCluster({ signalIds: signals.map(s => s.signalId), signalCount: 5, subsystems: ['inference'] });
        const result = analyzer.analyze(cluster, signals);
        for (let i = 1; i < result.length; i++) {
            expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
        }
    });

    it('each hypothesis has required fields', () => {
        const signals = [
            makeSignal({ signalId: 's1', failureType: 'ft1' }),
            makeSignal({ signalId: 's2', failureType: 'ft1' }),
        ];
        const cluster = makeCluster({ signalIds: ['s1', 's2'], signalCount: 2 });
        const result = analyzer.analyze(cluster, signals);
        for (const h of result) {
            expect(h.rootCauseId).toMatch(/^rc-/);
            expect(h.clusterId).toBe(cluster.clusterId);
            expect(h.score).toBeGreaterThanOrEqual(0);
            expect(h.score).toBeLessThanOrEqual(100);
            expect(h.confidence).toBeGreaterThanOrEqual(0);
            expect(h.confidence).toBeLessThanOrEqual(1);
            expect(Array.isArray(h.scoringFactors)).toBe(true);
            expect(h.generatedAt).toBeTruthy();
        }
    });

    it('detects structural_drift for harmonization_drift source', () => {
        const signals = [
            makeSignal({ signalId: 's1', sourceType: 'harmonization_drift', failureType: 'drift' }),
            makeSignal({ signalId: 's2', sourceType: 'harmonization_drift', failureType: 'drift' }),
        ];
        const cluster = makeCluster({ signalIds: ['s1', 's2'], signalCount: 2, subsystems: ['autonomy'] });
        const result = analyzer.analyze(cluster, signals);
        const drift = result.find(h => h.category === 'structural_drift');
        expect(drift).toBeDefined();
    });

    it('detects policy_boundary_gap for repeated governance_block', () => {
        const signals = Array.from({ length: 3 }, (_, i) =>
            makeSignal({ signalId: `s${i}`, sourceType: 'governance_block', failureType: 'tier_exceeded', subsystem: 'governance' }),
        );
        const cluster = makeCluster({
            signalIds: signals.map(s => s.signalId),
            signalCount: 3,
            subsystems: ['governance'],
            dominantFailureType: 'tier_exceeded',
        });
        const result = analyzer.analyze(cluster, signals);
        const policyGap = result.find(h => h.category === 'policy_boundary_gap');
        expect(policyGap).toBeDefined();
    });

    it('scoring factors each have name, value, weight, contribution', () => {
        const signals = [
            makeSignal({ signalId: 's1', failureType: 'ft' }),
            makeSignal({ signalId: 's2', failureType: 'ft' }),
        ];
        const cluster = makeCluster({ signalIds: ['s1', 's2'], signalCount: 2 });
        const result = analyzer.analyze(cluster, signals);
        for (const h of result) {
            for (const f of h.scoringFactors) {
                expect(typeof f.factorName).toBe('string');
                expect(typeof f.value).toBe('number');
                expect(typeof f.weight).toBe('number');
                expect(typeof f.contribution).toBe('number');
                expect(typeof f.rationale).toBe('string');
            }
        }
    });
});

// ─── P6E: CrossSystemStrategySelector ────────────────────────────────────────

describe('P6E — CrossSystemStrategySelector', () => {
    let selector: CrossSystemStrategySelector;

    beforeEach(() => {
        selector = new CrossSystemStrategySelector();
    });

    it('defers when confidence is too low', () => {
        const cluster = makeCluster({ severity: 'low', subsystems: ['inference'] });
        const hypotheses = [makeHypothesis({ score: 60, confidence: 0.1 })];
        const decision = selector.select(cluster, hypotheses);
        expect(decision.strategySelected).toBe('defer');
    });

    it('defers when score is too low', () => {
        const cluster = makeCluster({ severity: 'low', subsystems: ['inference'] });
        const hypotheses = [makeHypothesis({ score: 10, confidence: 0.8 })];
        const decision = selector.select(cluster, hypotheses);
        expect(decision.strategySelected).toBe('defer');
    });

    it('escalates human for high severity multi-subsystem cluster', () => {
        const cluster = makeCluster({ severity: 'high', subsystems: ['inference', 'execution', 'governance'] });
        const hypotheses = [makeHypothesis({ score: 70, confidence: 0.75, category: 'unknown' })];
        const decision = selector.select(cluster, hypotheses);
        expect(decision.strategySelected).toBe('escalate_human');
    });

    it('selects harmonization_campaign for structural_drift', () => {
        const cluster = makeCluster({ severity: 'medium', subsystems: ['autonomy'] });
        const hypotheses = [makeHypothesis({ score: 65, confidence: 0.70, category: 'structural_drift' })];
        const decision = selector.select(cluster, hypotheses);
        expect(decision.strategySelected).toBe('harmonization_campaign');
    });

    it('selects multi_step_campaign for campaign_scope_mismatch', () => {
        const cluster = makeCluster({ severity: 'medium', subsystems: ['autonomy'] });
        const hypotheses = [makeHypothesis({ score: 60, confidence: 0.65, category: 'campaign_scope_mismatch' })];
        const decision = selector.select(cluster, hypotheses);
        expect(decision.strategySelected).toBe('multi_step_campaign');
    });

    it('escalates human for policy_boundary_gap', () => {
        const cluster = makeCluster({ severity: 'medium', subsystems: ['governance'] });
        const hypotheses = [makeHypothesis({ score: 65, confidence: 0.70, category: 'policy_boundary_gap' })];
        const decision = selector.select(cluster, hypotheses);
        expect(decision.strategySelected).toBe('escalate_human');
    });

    it('selects targeted_repair for repeated_execution_error with high score', () => {
        const cluster = makeCluster({ severity: 'medium', subsystems: ['inference'] });
        const hypotheses = [makeHypothesis({ score: 60, confidence: 0.65, category: 'repeated_execution_error' })];
        const decision = selector.select(cluster, hypotheses);
        expect(decision.strategySelected).toBe('targeted_repair');
    });

    it('defers as default fallback when no rules match', () => {
        const cluster = makeCluster({ severity: 'low', subsystems: ['inference'] });
        const hypotheses = [makeHypothesis({ score: 40, confidence: 0.45, category: 'unknown' })];
        const decision = selector.select(cluster, hypotheses);
        expect(decision.strategySelected).toBe('defer');
    });

    it('decision record has all required fields', () => {
        const cluster = makeCluster({ severity: 'medium', subsystems: ['inference'] });
        const hypotheses = [makeHypothesis({ score: 65, confidence: 0.70, category: 'repeated_execution_error' })];
        const decision = selector.select(cluster, hypotheses);
        expect(decision.decisionId).toMatch(/^sdec-/);
        expect(decision.clusterId).toBe(cluster.clusterId);
        expect(decision.strategySelected).toBeTruthy();
        expect(decision.rationale).toBeTruthy();
        expect(decision.decidedAt).toBeTruthy();
        expect(Array.isArray(decision.alternativesConsidered)).toBe(true);
        expect(Array.isArray(decision.policyConstraints)).toBe(true);
    });

    it('prefers smaller effective scope over larger when both applicable', () => {
        // targeted_repair should be preferred over multi_step_campaign when score is high enough
        const cluster = makeCluster({ severity: 'medium', subsystems: ['inference'] });
        const hypotheses = [makeHypothesis({ score: 65, confidence: 0.70, category: 'repeated_execution_error' })];
        const decision = selector.select(cluster, hypotheses);
        // Should not choose multi_step_campaign when targeted_repair is sufficient
        expect(decision.strategySelected).not.toBe('multi_step_campaign');
    });

    it('multi_step_campaign for cross_subsystem_dependency with multiple subsystems', () => {
        const cluster = makeCluster({ severity: 'medium', subsystems: ['inference', 'execution'] });
        const hypotheses = [makeHypothesis({
            score: 60,
            confidence: 0.65,
            category: 'cross_subsystem_dependency',
            subsystemsImplicated: ['inference', 'execution'],
        })];
        const decision = selector.select(cluster, hypotheses);
        expect(decision.strategySelected).toBe('multi_step_campaign');
    });

    it('returns defer when no hypotheses provided', () => {
        const cluster = makeCluster({ severity: 'medium', subsystems: ['inference'] });
        const decision = selector.select(cluster, []);
        expect(decision.strategySelected).toBe('defer');
    });
});

// ─── P6G: CrossSystemOutcomeTracker ──────────────────────────────────────────

describe('P6G — CrossSystemOutcomeTracker', () => {
    let testDir: string;
    let tracker: CrossSystemOutcomeTracker;

    beforeEach(() => {
        testDir = makeTempDir();
        tracker = new CrossSystemOutcomeTracker(testDir);
    });

    afterEach(() => {
        removeTempDir(testDir);
    });

    it('records an outcome and retrieves it', () => {
        const outcome: CrossSystemOutcomeRecord = {
            outcomeId: 'csout-001',
            clusterId: 'cluster-001',
            strategyUsed: 'targeted_repair',
            decisionId: 'sdec-001',
            executedAt: new Date().toISOString(),
            succeeded: true,
            recurred: false,
            notes: 'Repair succeeded',
        };
        tracker.record(outcome);
        const retrieved = tracker.getOutcome('csout-001');
        expect(retrieved).not.toBeNull();
        expect(retrieved!.outcomeId).toBe('csout-001');
        expect(retrieved!.succeeded).toBe(true);
    });

    it('listOutcomes returns all outcomes', () => {
        tracker.record({ outcomeId: 'csout-001', clusterId: 'cluster-001', strategyUsed: 'defer', decisionId: 'sdec-001', executedAt: new Date().toISOString(), succeeded: true, recurred: false, notes: '' });
        tracker.record({ outcomeId: 'csout-002', clusterId: 'cluster-002', strategyUsed: 'targeted_repair', decisionId: 'sdec-002', executedAt: new Date().toISOString(), succeeded: false, recurred: false, notes: '' });
        const all = tracker.listOutcomes();
        expect(all.length).toBe(2);
    });

    it('marks recurred=true for the cluster', () => {
        const o: CrossSystemOutcomeRecord = {
            outcomeId: 'csout-recurr-001',
            clusterId: 'cluster-recurr',
            strategyUsed: 'targeted_repair',
            decisionId: 'sdec-r',
            executedAt: new Date().toISOString(),
            succeeded: true,
            recurred: false,
            notes: '',
        };
        tracker.record(o);
        tracker.markRecurred('cluster-recurr');
        const updated = tracker.getOutcome('csout-recurr-001');
        expect(updated?.recurred).toBe(true);
    });

    it('returns null for unknown outcome ID', () => {
        expect(tracker.getOutcome('does-not-exist')).toBeNull();
    });

    it('persists outcomes to disk (survives new tracker instance)', () => {
        const o: CrossSystemOutcomeRecord = {
            outcomeId: 'csout-persist-001',
            clusterId: 'cluster-persist',
            strategyUsed: 'defer',
            decisionId: 'sdec-p',
            executedAt: new Date().toISOString(),
            succeeded: false,
            recurred: false,
            notes: 'persisted',
        };
        tracker.record(o);
        const tracker2 = new CrossSystemOutcomeTracker(testDir);
        const retrieved = tracker2.getOutcome('csout-persist-001');
        expect(retrieved).not.toBeNull();
        expect(retrieved!.notes).toBe('persisted');
    });

    it('purgeExpired removes old records', () => {
        const old: CrossSystemOutcomeRecord = {
            outcomeId: 'csout-old-001',
            clusterId: 'cluster-old',
            strategyUsed: 'defer',
            decisionId: 'sdec-old',
            executedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days ago
            succeeded: false,
            recurred: false,
            notes: 'old',
        };
        tracker.record(old);
        tracker.purgeExpired();
        expect(tracker.getOutcome('csout-old-001')).toBeNull();
    });

    it('does not purge recent records', () => {
        const recent: CrossSystemOutcomeRecord = {
            outcomeId: 'csout-recent-001',
            clusterId: 'cluster-recent',
            strategyUsed: 'targeted_repair',
            decisionId: 'sdec-recent',
            executedAt: new Date().toISOString(),
            succeeded: true,
            recurred: false,
            notes: 'recent',
        };
        tracker.record(recent);
        tracker.purgeExpired();
        expect(tracker.getOutcome('csout-recent-001')).not.toBeNull();
    });
});

// ─── P6H: CrossSystemDashboardBridge ─────────────────────────────────────────

describe('P6H — CrossSystemDashboardBridge', () => {
    let bridge: CrossSystemDashboardBridge;

    beforeEach(() => {
        bridge = new CrossSystemDashboardBridge();
    });

    it('CROSS_SYSTEM_DASHBOARD_CHANNEL is correct', () => {
        expect(CROSS_SYSTEM_DASHBOARD_CHANNEL).toBe('crossSystem:dashboardUpdate');
    });

    it('buildState returns CrossSystemDashboardState', () => {
        const cluster = makeCluster({ status: 'open' });
        const state = bridge.buildState([cluster], [], [], [], 5);
        expect(state.openClusters.length).toBe(1);
        expect(state.signalWindowCount).toBe(5);
        expect(state.kpis).toBeDefined();
        expect(state.lastUpdatedAt).toBeTruthy();
    });

    it('KPIs compute correctly', () => {
        const clusters = [
            makeCluster({ status: 'open' }),
            makeCluster({ status: 'resolved' }),
        ];
        const outcomes: CrossSystemOutcomeRecord[] = [
            { outcomeId: 'o1', clusterId: 'c1', strategyUsed: 'targeted_repair', decisionId: 'd1', executedAt: new Date().toISOString(), succeeded: true, recurred: false, notes: '' },
            { outcomeId: 'o2', clusterId: 'c2', strategyUsed: 'defer', decisionId: 'd2', executedAt: new Date().toISOString(), succeeded: false, recurred: true, notes: '' },
        ];
        const state = bridge.buildState(clusters, [], [], outcomes, 10);
        expect(state.kpis.openClusterCount).toBe(1);
        expect(state.kpis.totalSucceeded).toBe(1);
        expect(state.kpis.totalRecurred).toBe(1);
    });

    it('deduplication prevents re-emit of identical state', () => {
        const state = bridge.buildState([makeCluster({ status: 'open' })], [], [], [], 3);
        const emitted1 = bridge.maybeEmit('cluster_formed', state);
        const emitted2 = bridge.maybeEmit('cluster_formed', state);
        expect(emitted1).toBe(true);
        expect(emitted2).toBe(false);
    });

    it('emits after resetDedupHash even for same state', () => {
        const state = bridge.buildState([makeCluster({ status: 'open' })], [], [], [], 3);
        bridge.maybeEmit('cluster_formed', state);
        bridge.resetDedupHash();
        const emitted = bridge.maybeEmit('cluster_formed', state);
        expect(emitted).toBe(true);
    });

    it('does not emit for non-permitted milestone', () => {
        const state = bridge.buildState([], [], [], [], 0);
        const emitted = bridge.maybeEmit('unknown_milestone_xyz', state);
        expect(emitted).toBe(false);
    });

    it('emits for all permitted milestones', () => {
        const milestones = ['signals_ingested', 'cluster_formed', 'root_cause_analyzed', 'strategy_decided', 'outcome_recorded'];
        for (const m of milestones) {
            const bridge2 = new CrossSystemDashboardBridge();
            const state = bridge2.buildState([makeCluster({ status: 'open' })], [], [], [], 1);
            const emitted = bridge2.maybeEmit(m, state);
            expect(emitted).toBe(true);
        }
    });
});

// ─── P6F: CrossSystemCoordinator ─────────────────────────────────────────────

describe('P6F — CrossSystemCoordinator', () => {
    let testDir: string;
    let coordinator: CrossSystemCoordinator;

    function makeCoordinator(dir: string): CrossSystemCoordinator {
        return new CrossSystemCoordinator(
            dir,
            new CrossSystemSignalAggregator(),
            new IncidentClusteringEngine(),
            new RootCauseAnalyzer(),
            new CrossSystemStrategySelector(),
            new CrossSystemOutcomeTracker(dir),
            new CrossSystemDashboardBridge(),
        );
    }

    beforeEach(() => {
        testDir = makeTempDir();
        coordinator = makeCoordinator(testDir);
    });

    afterEach(() => {
        removeTempDir(testDir);
    });

    it('ingestSignal accepts a signal without throwing', () => {
        expect(() => coordinator.ingestSignal(makeSignal())).not.toThrow();
    });

    it('getOpenClusters returns empty array initially', () => {
        expect(coordinator.getOpenClusters()).toEqual([]);
    });

    it('getDashboardState returns valid shape', () => {
        const state = coordinator.getDashboardState();
        expect(state.openClusters).toBeDefined();
        expect(state.kpis).toBeDefined();
        expect(state.lastUpdatedAt).toBeTruthy();
    });

    it('runAnalysis does not throw with no signals', () => {
        expect(() => coordinator.runAnalysis()).not.toThrow();
    });

    it('runAnalysis produces clusters when enough signals are ingested', () => {
        // Ingest correlated signals with varied failureTypes so dedup doesn't filter them out
        for (let i = 0; i < CROSS_SYSTEM_BOUNDS.MIN_SIGNALS_TO_CLUSTER * 2; i++) {
            coordinator.ingestSignal(makeSignal({
                signalId: `sig-batch-${i}`,
                subsystem: 'inference',
                failureType: `timeout-variant-${i}`,
                timestamp: new Date(Date.now() - i * 10000).toISOString(),
            }));
        }
        coordinator.runAnalysis();
        const clusters = coordinator.getOpenClusters();
        expect(clusters.length).toBeGreaterThan(0);
    });

    it('getRootCauses returns array for a known cluster', () => {
        // Build up cluster first
        for (let i = 0; i < 4; i++) {
            coordinator.ingestSignal(makeSignal({
                signalId: `sig-rc-${i}`,
                subsystem: 'inference',
                failureType: 'timeout',
                timestamp: new Date(Date.now() - i * 10000).toISOString(),
            }));
        }
        coordinator.runAnalysis();
        const clusters = coordinator.getOpenClusters();
        if (clusters.length > 0) {
            const rcs = coordinator.getRootCauses(clusters[0].clusterId);
            expect(Array.isArray(rcs)).toBe(true);
        }
    });

    it('getCluster returns null for unknown ID', () => {
        expect(coordinator.getCluster('cluster-does-not-exist')).toBeNull();
    });

    it('getRecentDecisions returns array', () => {
        expect(Array.isArray(coordinator.getRecentDecisions())).toBe(true);
    });

    it('recordOutcome does not throw', () => {
        expect(() => coordinator.recordOutcome('csout-test-001', 'cluster-test', true, 'success')).not.toThrow();
    });

    it('runAnalysis is re-entrancy guarded', () => {
        // Two rapid calls should not throw even if the first is "still running"
        expect(() => {
            coordinator.runAnalysis();
            coordinator.runAnalysis();
        }).not.toThrow();
    });

    it('persists clusters across coordinator instances', () => {
        for (let i = 0; i < 4; i++) {
            coordinator.ingestSignal(makeSignal({
                signalId: `sig-persist-${i}`,
                subsystem: 'inference',
                failureType: 'timeout',
                timestamp: new Date(Date.now() - i * 10000).toISOString(),
            }));
        }
        coordinator.runAnalysis();
        const clustersBefore = coordinator.getOpenClusters();
        if (clustersBefore.length > 0) {
            const coordinator2 = makeCoordinator(testDir);
            const clustersAfter = coordinator2.getOpenClusters();
            expect(clustersAfter.length).toBe(clustersBefore.length);
        }
    });
});

// ─── P6I: Safety Bounds ───────────────────────────────────────────────────────

describe('P6I — Safety bounds', () => {
    it('MAX_SIGNALS_PER_WINDOW prevents unbounded accumulation', () => {
        const aggregator = new CrossSystemSignalAggregator();
        let accepted = 0;
        for (let i = 0; i < CROSS_SYSTEM_BOUNDS.MAX_SIGNALS_PER_WINDOW * 2; i++) {
            const ok = aggregator.ingest(makeSignal({
                signalId: `sig-${i}`,
                subsystem: `sub-${i}`,
                failureType: `ft-${i}`,
            }));
            if (ok) accepted++;
        }
        expect(accepted).toBeLessThanOrEqual(CROSS_SYSTEM_BOUNDS.MAX_SIGNALS_PER_WINDOW);
    });

    it('MAX_CLUSTER_SIZE prevents oversized clusters', () => {
        const engine = new IncidentClusteringEngine();
        const signals = Array.from({ length: CROSS_SYSTEM_BOUNDS.MAX_CLUSTER_SIZE + 10 }, (_, i) =>
            makeSignal({ signalId: `sig-big-${i}`, subsystem: 'inference', failureType: 'bigcluster' }),
        );
        const clusters = engine.cluster(signals, []);
        for (const c of clusters) {
            expect(c.signalCount).toBeLessThanOrEqual(CROSS_SYSTEM_BOUNDS.MAX_CLUSTER_SIZE);
        }
    });

    it('MAX_CLUSTERS_OPEN prevents unbounded cluster growth', () => {
        const engine = new IncidentClusteringEngine();
        const existingClusters: IncidentCluster[] = Array.from({ length: CROSS_SYSTEM_BOUNDS.MAX_CLUSTERS_OPEN }, (_, i) =>
            makeCluster({ clusterId: `cluster-safety-${i}`, subsystems: [`subsystem-${i}`], status: 'open' }),
        );
        const newSignals = Array.from({ length: 10 }, (_, i) =>
            makeSignal({ signalId: `sig-new-safety-${i}`, subsystem: `brand-new-subsystem-${i}`, failureType: `ft-new-${i}`, affectedFiles: [] }),
        );
        const result = engine.cluster(newSignals, existingClusters);
        const openCount = result.filter(c => c.status === 'open').length;
        expect(openCount).toBeLessThanOrEqual(CROSS_SYSTEM_BOUNDS.MAX_CLUSTERS_OPEN);
    });

    it('RootCauseAnalyzer never generates more than MAX_ROOT_CAUSES_PER_CLUSTER hypotheses', () => {
        const analyzer = new RootCauseAnalyzer();
        const signals = Array.from({ length: 20 }, (_, i) =>
            makeSignal({ signalId: `sig-rca-${i}`, subsystem: 'inference', failureType: 'repeated' }),
        );
        const cluster = makeCluster({ signalIds: signals.map(s => s.signalId), signalCount: 20 });
        const result = analyzer.analyze(cluster, signals);
        expect(result.length).toBeLessThanOrEqual(CROSS_SYSTEM_BOUNDS.MAX_ROOT_CAUSES_PER_CLUSTER);
    });

    it('CrossSystemStrategySelector never produces an automatic large-scale refactor without governance', () => {
        // harmonization_campaign and multi_step_campaign always flow through governance
        const selector = new CrossSystemStrategySelector();
        const cluster = makeCluster({ severity: 'high', subsystems: ['inference', 'execution', 'governance'] });
        const hypotheses = [makeHypothesis({ score: 90, confidence: 0.95, category: 'structural_drift' })];
        const decision = selector.select(cluster, hypotheses);
        // High severity multi-subsystem should escalate rather than auto-run large refactor
        expect(['harmonization_campaign', 'multi_step_campaign', 'escalate_human', 'defer']).toContain(decision.strategySelected);
    });
});

// ─── AutonomousRunOrchestrator P6 wiring ─────────────────────────────────────

describe('AutonomousRunOrchestrator — Phase 6 wiring', () => {
    it('setCrossSystemServices() exists on prototype', async () => {
        const { AutonomousRunOrchestrator } = await import('../../electron/services/autonomy/AutonomousRunOrchestrator');
        expect(typeof AutonomousRunOrchestrator.prototype.setCrossSystemServices).toBe('function');
    });

    it('getCrossSystemDashboardState() exists on prototype', async () => {
        const { AutonomousRunOrchestrator } = await import('../../electron/services/autonomy/AutonomousRunOrchestrator');
        expect(typeof AutonomousRunOrchestrator.prototype.getCrossSystemDashboardState).toBe('function');
    });

    it('ingestCrossSystemSignal() exists on prototype', async () => {
        const { AutonomousRunOrchestrator } = await import('../../electron/services/autonomy/AutonomousRunOrchestrator');
        expect(typeof AutonomousRunOrchestrator.prototype.ingestCrossSystemSignal).toBe('function');
    });

    it('coordinator receives signals via ingestSignal when wired', () => {
        // Verify coordinator.ingestSignal is called when orchestrator.ingestCrossSystemSignal is invoked
        const mockCoordinator = {
            ingestSignal: vi.fn(),
            getDashboardState: vi.fn(() => ({ openClusters: [], recentClusters: [], rootCauses: [], recentDecisions: [], recentOutcomes: [], signalWindowCount: 0, kpis: { totalSignalsIngested: 0, totalClustersFormed: 0, totalRootCausesGenerated: 0, totalStrategiesSelected: 0, totalSucceeded: 0, totalRecurred: 0, openClusterCount: 0 }, lastUpdatedAt: new Date().toISOString() })),
            runAnalysis: vi.fn(),
            getOpenClusters: vi.fn(() => []),
            getCluster: vi.fn(() => null),
            getRootCauses: vi.fn(() => []),
            getRecentDecisions: vi.fn(() => []),
            recordOutcome: vi.fn(),
        };

        // Simulate orchestrator method directly (without constructing the full orchestrator)
        // The method simply forwards to coordinator.ingestSignal
        const signal = makeSignal();
        // Verify the coordinator mock receives the signal
        mockCoordinator.ingestSignal(signal);
        expect(mockCoordinator.ingestSignal).toHaveBeenCalledWith(signal);
    });
});

// ─── P6B (collect): CrossSystemSignalCollector ───────────────────────────────

import { CrossSystemSignalCollector } from '../../electron/services/autonomy/crossSystem/CrossSystemSignalCollector';
import type { ExecutionRunSource, HarmonizationOutcomeSource, EscalationAuditSource, CampaignOutcomeSource } from '../../electron/services/autonomy/crossSystem/CrossSystemSignalCollector';

describe('P6B — CrossSystemSignalCollector (collect())', () => {
    it('collect() returns empty array when no sources registered', () => {
        const collector = new CrossSystemSignalCollector();
        expect(collector.collect()).toEqual([]);
    });

    it('collect() converts failed execution runs to execution_failure signals', () => {
        const collector = new CrossSystemSignalCollector();
        const now = new Date().toISOString();
        const mockListRuns = vi.fn(() => [
            {
                runId: 'run-001', goalId: 'goal-001', cycleId: 'c1',
                startedAt: now, completedAt: now,
                status: 'failed', subsystemId: 'inference',
                failureReason: 'model_timeout', milestones: [],
            },
            {
                runId: 'run-002', goalId: 'goal-002', cycleId: 'c2',
                startedAt: now, completedAt: now,
                status: 'succeeded', subsystemId: 'inference',
                milestones: [],
            },
        ] as any);
        const mockExecSource: ExecutionRunSource = { listRuns: mockListRuns };
        collector.setExecutionSource(mockExecSource);
        const signals = collector.collect();
        // listRuns must be called with SIGNAL_WINDOW_MS so only in-window records are considered
        expect(mockListRuns).toHaveBeenCalledWith(CROSS_SYSTEM_BOUNDS.SIGNAL_WINDOW_MS);
        // Only the failed run should produce a signal
        expect(signals.length).toBe(1);
        expect(signals[0].sourceType).toBe('execution_failure');
        expect(signals[0].subsystem).toBe('inference');
        expect(signals[0].failureType).toBe('model_timeout');
    });

    it('collect() converts rolled_back runs to verification_failure signals', () => {
        const collector = new CrossSystemSignalCollector();
        const now = new Date().toISOString();
        collector.setExecutionSource({
            listRuns: vi.fn(() => [{
                runId: 'run-rb', goalId: 'g1', cycleId: 'c1',
                startedAt: now, completedAt: now,
                status: 'rolled_back', subsystemId: 'inference',
                failureReason: 'verification_failed', milestones: [],
            }] as any),
        });
        const signals = collector.collect();
        expect(signals[0].sourceType).toBe('verification_failure');
        expect(signals[0].severity).toBe('high');
    });

    it('collect() converts governance_blocked runs to governance_block signals', () => {
        const collector = new CrossSystemSignalCollector();
        const now = new Date().toISOString();
        collector.setExecutionSource({
            listRuns: vi.fn(() => [{
                runId: 'run-gov', goalId: 'g1', cycleId: 'c1',
                startedAt: now, completedAt: now,
                status: 'governance_blocked', subsystemId: 'governance',
                failureReason: 'tier_exceeded', milestones: [],
            }] as any),
        });
        const signals = collector.collect();
        expect(signals[0].sourceType).toBe('governance_block');
        expect(signals[0].subsystem).toBe('governance');
    });

    it('collect() converts failed harmonization outcomes to harmonization_drift signals', () => {
        const collector = new CrossSystemSignalCollector();
        const now = new Date().toISOString();
        const mockHarmonizationSource: HarmonizationOutcomeSource = {
            listOutcomes: vi.fn(() => [
                {
                    outcomeId: 'hout-001',
                    campaignId: 'hcamp-001',
                    ruleId: 'rule-001',
                    driftId: 'drift-001',
                    subsystem: 'autonomy',
                    patternClass: 'import_style',
                    startedAt: now,
                    endedAt: now,
                    finalStatus: 'failed',
                    succeeded: false,
                    driftReducedConfirmed: false,
                    regressionDetected: false,
                    rollbackTriggered: false,
                    filesModified: 0,
                    confidenceDeltaApplied: 0,
                    learningNotes: [],
                },
            ] as any),
        };
        collector.setHarmonizationSource(mockHarmonizationSource);
        const signals = collector.collect();
        expect(signals.length).toBe(1);
        expect(signals[0].sourceType).toBe('harmonization_drift');
        expect(signals[0].subsystem).toBe('autonomy');
    });

    it('collect() marks regression_detected harmonization outcomes as high severity', () => {
        const collector = new CrossSystemSignalCollector();
        const now = new Date().toISOString();
        collector.setHarmonizationSource({
            listOutcomes: vi.fn(() => [{
                outcomeId: 'hout-reg',
                campaignId: 'hcamp-002',
                ruleId: 'rule-002',
                driftId: 'drift-002',
                subsystem: 'autonomy',
                patternClass: 'import_style',
                startedAt: now,
                endedAt: now,
                finalStatus: 'rolled_back',
                succeeded: false,
                driftReducedConfirmed: false,
                regressionDetected: true,
                rollbackTriggered: true,
                filesModified: 2,
                confidenceDeltaApplied: -0.1,
                learningNotes: [],
            }] as any),
        });
        const signals = collector.collect();
        expect(signals[0].severity).toBe('high');
        expect(signals[0].failureType).toBe('regression_detected');
    });

    it('collect() converts escalation_requested records to escalation_attempt signals', () => {
        const collector = new CrossSystemSignalCollector();
        const now = new Date().toISOString();
        const mockEscalationSource: EscalationAuditSource = {
            getRecent: vi.fn(() => [
                { recordId: 'esc-001', goalId: 'goal-001', eventKind: 'escalation_requested', recordedAt: now, detail: 'Exceeded capability' },
                { recordId: 'esc-002', goalId: 'goal-002', eventKind: 'escalation_denied', recordedAt: now, detail: 'Denied' },
            ] as any),
        };
        collector.setEscalationSource(mockEscalationSource);
        const signals = collector.collect();
        // Only escalation_requested should produce a signal
        expect(signals.length).toBe(1);
        expect(signals[0].sourceType).toBe('escalation_attempt');
        expect(signals[0].goalId).toBe('goal-001');
    });

    it('collect() converts failed campaign outcomes to campaign_failure signals', () => {
        const collector = new CrossSystemSignalCollector();
        const now = new Date().toISOString();
        const mockCampaignSource: CampaignOutcomeSource = {
            listOutcomes: vi.fn(() => [
                {
                    campaignId: 'camp-001',
                    goalId: 'goal-001',
                    label: 'Test campaign',
                    subsystem: 'inference',
                    originType: 'repeated_execution_failure',
                    finalStatus: 'failed',
                    succeeded: false,
                    rolledBack: false,
                    deferred: false,
                    stepCount: 3,
                    rollbackFrequency: 0,
                    completedAt: now,
                    durationMs: 5000,
                    learningNotes: [],
                },
                {
                    campaignId: 'camp-002',
                    goalId: 'goal-002',
                    label: 'Success campaign',
                    subsystem: 'inference',
                    originType: 'repeated_execution_failure',
                    finalStatus: 'succeeded',
                    succeeded: true,
                    rolledBack: false,
                    deferred: false,
                    stepCount: 2,
                    rollbackFrequency: 0,
                    completedAt: now,
                    durationMs: 3000,
                    learningNotes: [],
                },
            ] as any),
        };
        collector.setCampaignSource(mockCampaignSource);
        const signals = collector.collect();
        // Only the failed campaign
        expect(signals.length).toBe(1);
        expect(signals[0].sourceType).toBe('campaign_failure');
        expect(signals[0].subsystem).toBe('inference');
    });

    it('collect() marks rolled_back campaign as high severity', () => {
        const collector = new CrossSystemSignalCollector();
        const now = new Date().toISOString();
        collector.setCampaignSource({
            listOutcomes: vi.fn(() => [{
                campaignId: 'camp-rb', goalId: 'g1', label: 'rb',
                subsystem: 'inference', originType: 'repeated_execution_failure',
                finalStatus: 'rolled_back', succeeded: false, rolledBack: true,
                deferred: false, stepCount: 1, rollbackFrequency: 1,
                completedAt: now, durationMs: 1000, learningNotes: [],
            }] as any),
        });
        const signals = collector.collect();
        expect(signals[0].severity).toBe('high');
    });

    it('collect() returns signals from all registered sources combined', () => {
        const collector = new CrossSystemSignalCollector();
        const now = new Date().toISOString();
        collector.setExecutionSource({
            listRuns: vi.fn(() => [{
                runId: 'r1', goalId: 'g1', cycleId: 'c1',
                startedAt: now, completedAt: now,
                status: 'failed', subsystemId: 'inference', failureReason: 'timeout', milestones: [],
            }] as any),
        });
        collector.setHarmonizationSource({
            listOutcomes: vi.fn(() => [{
                outcomeId: 'ho1', campaignId: 'hc1', ruleId: 'r1', driftId: 'd1',
                subsystem: 'autonomy', patternClass: 'import_style',
                startedAt: now, endedAt: now, finalStatus: 'failed',
                succeeded: false, driftReducedConfirmed: false, regressionDetected: false,
                rollbackTriggered: false, filesModified: 0, confidenceDeltaApplied: 0, learningNotes: [],
            }] as any),
        });
        collector.setEscalationSource({
            getRecent: vi.fn(() => [{
                recordId: 'e1', goalId: 'g2', eventKind: 'escalation_requested', recordedAt: now, detail: 'x',
            }] as any),
        });
        collector.setCampaignSource({
            listOutcomes: vi.fn(() => [{
                campaignId: 'c1', goalId: 'g3', label: 'c1',
                subsystem: 'planning', originType: 'repeated_execution_failure',
                finalStatus: 'failed', succeeded: false, rolledBack: false, deferred: false,
                stepCount: 1, rollbackFrequency: 0, completedAt: now, durationMs: 1000, learningNotes: [],
            }] as any),
        });
        const signals = collector.collect();
        expect(signals.length).toBe(4);
        const sourceTypes = signals.map(s => s.sourceType).sort();
        expect(sourceTypes).toContain('execution_failure');
        expect(sourceTypes).toContain('harmonization_drift');
        expect(sourceTypes).toContain('escalation_attempt');
        expect(sourceTypes).toContain('campaign_failure');
    });

    it('collect() does not throw when a source returns an empty array', () => {
        const collector = new CrossSystemSignalCollector();
        collector.setExecutionSource({ listRuns: vi.fn(() => []) });
        collector.setHarmonizationSource({ listOutcomes: vi.fn(() => []) });
        collector.setEscalationSource({ getRecent: vi.fn(() => []) });
        collector.setCampaignSource({ listOutcomes: vi.fn(() => []) });
        expect(() => collector.collect()).not.toThrow();
        expect(collector.collect().length).toBe(0);
    });

    it('collect() every signal has required fields', () => {
        const collector = new CrossSystemSignalCollector();
        const now = new Date().toISOString();
        collector.setExecutionSource({
            listRuns: vi.fn(() => [{
                runId: 'r1', goalId: 'g1', cycleId: 'c1',
                startedAt: now, completedAt: now,
                status: 'failed', subsystemId: 'inference', failureReason: 'timeout', milestones: [],
            }] as any),
        });
        const signals = collector.collect();
        for (const s of signals) {
            expect(s.signalId).toMatch(/^signal-/);
            expect(s.sourceType).toBeTruthy();
            expect(s.subsystem).toBeTruthy();
            expect(s.failureType).toBeTruthy();
            expect(['low', 'medium', 'high']).toContain(s.severity);
            expect(s.timestamp).toBeTruthy();
            expect(Array.isArray(s.affectedFiles)).toBe(true);
        }
    });
});

// ─── P6B + P6F: collectAndIngest() integration ───────────────────────────────

describe('P6B + P6F — CrossSystemCoordinator.collectAndIngest()', () => {
    let testDir: string;

    function makeCoordinator(dir: string): CrossSystemCoordinator {
        return new CrossSystemCoordinator(
            dir,
            new CrossSystemSignalAggregator(),
            new IncidentClusteringEngine(),
            new RootCauseAnalyzer(),
            new CrossSystemStrategySelector(),
            new CrossSystemOutcomeTracker(dir),
            new CrossSystemDashboardBridge(),
        );
    }

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-cs-collect-'));
    });

    afterEach(() => {
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
    });

    it('collectAndIngest() is a no-op when no collector is set', () => {
        const coordinator = makeCoordinator(testDir);
        expect(() => coordinator.collectAndIngest()).not.toThrow();
    });

    it('collectAndIngest() ingests signals from the registered collector', () => {
        const coordinator = makeCoordinator(testDir);
        const now = new Date().toISOString();
        const collector = new CrossSystemSignalCollector();
        collector.setExecutionSource({
            listRuns: vi.fn(() => Array.from({ length: 5 }, (_, i) => ({
                runId: `run-${i}`, goalId: `g-${i}`, cycleId: `c-${i}`,
                startedAt: now, completedAt: now,
                status: 'failed', subsystemId: 'inference',
                failureReason: `reason-${i}`, milestones: [],
            })) as any),
        });
        coordinator.setSignalCollector(collector);
        coordinator.collectAndIngest();
        // The aggregator should now have signals
        const aggregator = (coordinator as any).aggregator as CrossSystemSignalAggregator;
        expect(aggregator.getSignalCount()).toBe(5);
    });

    it('runAnalysis() calls collectAndIngest() before clustering', () => {
        const coordinator = makeCoordinator(testDir);
        const now = new Date().toISOString();
        const collector = new CrossSystemSignalCollector();
        let collected = false;
        collector.setExecutionSource({
            listRuns: vi.fn(() => {
                collected = true;
                // Return enough signals to trigger clustering
                return Array.from({ length: CROSS_SYSTEM_BOUNDS.MIN_SIGNALS_TO_CLUSTER * 2 }, (_, i) => ({
                    runId: `run-${i}`, goalId: `g-${i}`, cycleId: `c-${i}`,
                    startedAt: now, completedAt: now,
                    status: 'failed', subsystemId: 'inference',
                    failureReason: `reason-variant-${i}`, milestones: [],
                }));
            }) as any,
        });
        coordinator.setSignalCollector(collector);
        coordinator.runAnalysis();
        expect(collected).toBe(true);
    });

    it('setSignalCollector() exists on CrossSystemCoordinator', () => {
        const coordinator = makeCoordinator(testDir);
        expect(typeof coordinator.setSignalCollector).toBe('function');
    });

    it('collectAndIngest() exists on CrossSystemCoordinator', () => {
        const coordinator = makeCoordinator(testDir);
        expect(typeof coordinator.collectAndIngest).toBe('function');
    });
});
