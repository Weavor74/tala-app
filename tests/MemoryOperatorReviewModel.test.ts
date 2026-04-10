/**
 * MemoryOperatorReviewModel.test.ts
 *
 * Unit tests for the Memory Operator Review Surface:
 *   - MemoryOperatorReviewService model assembly
 *   - MemoryRepairSchedulerService caching (new getters)
 *   - Ordering and bounding invariants
 *
 * Covers:
 *   MOR-01  critical posture model assembles correctly
 *   MOR-02  adaptive plan is included and ordered correctly
 *   MOR-03  optimization suggestions are capped and sorted deterministically
 *   MOR-04  queue/dead-letter stats appear correctly
 *   MOR-05  recent repair cycles are bounded and in expected order
 *   MOR-06  stable posture renders with low-noise state
 *   MOR-07  advisory-only labeling is present in optimization suggestions
 *   MOR-08  missing optional sections degrade gracefully (no adaptive plan yet)
 *   MOR-09  manual refresh path returns current model safely
 *   MOR-10  same backend inputs produce same rendered ordering
 *
 * No real DB, no Electron.  All DB interactions are stubbed.
 * TelemetryBus is stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Stub TelemetryBus
// ---------------------------------------------------------------------------

const emittedEvents: Array<{ event: string }> = [];

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (e: unknown) => emittedEvents.push(e as { event: string }),
            subscribe: vi.fn().mockReturnValue(vi.fn()),
        }),
    },
}));

// ---------------------------------------------------------------------------
// Stub DeferredMemoryReplayService
// ---------------------------------------------------------------------------

vi.mock('../electron/services/memory/DeferredMemoryReplayService', () => ({
    DeferredMemoryReplayService: {
        getInstance: () => ({ drain: vi.fn().mockResolvedValue(undefined) }),
    },
}));

// ---------------------------------------------------------------------------
// Stub MemoryRepairTriggerService
// ---------------------------------------------------------------------------

vi.mock('../electron/services/memory/MemoryRepairTriggerService', () => ({
    MemoryRepairTriggerService: {
        getInstance: () => ({ emitDirect: vi.fn() }),
    },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { MemoryOperatorReviewService } from '../electron/services/memory/MemoryOperatorReviewService';
import type { MemoryOperatorReviewModel } from '../shared/memory/MemoryOperatorReviewModel';
import type { MemoryHealthStatus } from '../shared/memory/MemoryHealthStatus';
import type { MemoryRepairInsightSummary } from '../shared/memory/MemoryRepairInsights';
import type { MemoryAdaptivePlan } from '../shared/memory/MemoryAdaptivePlan';
import type { MemoryOptimizationSuggestionReport, MemoryOptimizationSuggestion } from '../shared/memory/MemoryOptimizationSuggestion';
import type { MemoryRepairScheduledRunResult } from '../shared/memory/MemoryMaintenanceState';

// ---------------------------------------------------------------------------
// Minimal factory helpers
// ---------------------------------------------------------------------------

function makeHealthStatus(overrides: Partial<MemoryHealthStatus> = {}): MemoryHealthStatus {
    return {
        state: 'healthy',
        capabilities: { canonical: true, extraction: true, embeddings: true, mem0Runtime: true, graphProjection: true, ragLogging: true },
        reasons: [],
        mode: 'full_memory',
        hardDisabled: false,
        shouldTriggerRepair: false,
        shouldEscalate: false,
        summary: 'All systems healthy.',
        evaluatedAt: new Date().toISOString(),
        ...overrides,
    };
}

function makeInsightSummary(overrides: Partial<MemoryRepairInsightSummary> = {}): MemoryRepairInsightSummary {
    return {
        windowHours: 24,
        generatedAt: new Date().toISOString(),
        totalCycles: 0,
        totalTriggers: 0,
        recurrentFailures: [],
        actionEffectiveness: [],
        queueBehavior: { totalReplays: 0, replaySuccesses: 0, replayFailures: 0, deadLetterCount: 0, deadLetterGrowing: false },
        escalationCandidates: [],
        trajectories: [],
        ...overrides,
    };
}

function makeAdaptivePlan(overrides: Partial<MemoryAdaptivePlan> = {}): MemoryAdaptivePlan {
    return {
        generatedAt: new Date().toISOString(),
        windowHours: 24,
        priorities: [],
        cadence: { recommendation: 'normal', suggestedMultiplier: 1.0, reason: 'normal cadence', evidence: {} },
        escalation: { bias: 'normal', reason: 'no escalation signals', evidence: {} },
        unstableSubsystems: [],
        preferReplayOverRestart: false,
        summary: 'No specific adjustments needed.',
        ...overrides,
    };
}

function makeSuggestion(
    id: string,
    priorityScore: number,
    severity: MemoryOptimizationSuggestion['severity'] = 'info',
): MemoryOptimizationSuggestion {
    return {
        id,
        category: 'subsystem_hardening',
        title: `Suggestion ${id}`,
        summary: `Summary for ${id}`,
        rationale: `Rationale for ${id}`,
        severity,
        priorityScore,
        evidence: {},
        affectedSubsystems: ['mem0'],
        generatedAt: new Date().toISOString(),
    };
}

function makeSuggestionReport(suggestions: MemoryOptimizationSuggestion[]): MemoryOptimizationSuggestionReport {
    return {
        generatedAt: new Date().toISOString(),
        windowHours: 24,
        suggestions,
        hasHighPrioritySuggestions: suggestions.some(s => s.severity === 'critical' || s.severity === 'error'),
        topLineSummary: suggestions.length > 0 ? suggestions[0].title : 'No suggestions.',
    };
}

function makeRunResult(
    posture: MemoryRepairScheduledRunResult['posture'],
    overrides: Partial<MemoryRepairScheduledRunResult> = {},
): MemoryRepairScheduledRunResult {
    return {
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        windowHours: 24,
        posture,
        actionsTaken: [],
        escalationCount: 0,
        recommendationCount: 0,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Mock scheduler
// ---------------------------------------------------------------------------

function makeScheduler(opts: {
    lastRun?: MemoryRepairScheduledRunResult | null;
    recentRuns?: MemoryRepairScheduledRunResult[];
    insightSummary?: MemoryRepairInsightSummary | null;
    adaptivePlan?: MemoryAdaptivePlan | null;
    suggestionReport?: MemoryOptimizationSuggestionReport | null;
} = {}) {
    return {
        getLastRun: () => opts.lastRun ?? null,
        getRecentRuns: () => opts.recentRuns ?? [],
        getLatestInsightSummary: () => opts.insightSummary ?? null,
        getLatestAdaptivePlan: () => opts.adaptivePlan ?? null,
        getLatestSuggestionReport: () => opts.suggestionReport ?? null,
    } as any;
}

// Mock MemoryService
function makeMemorySvc(
    healthOverrides: Partial<MemoryHealthStatus> = {},
    deferredCounts: { extraction: number; embedding: number; projection: number } = { extraction: 0, embedding: 0, projection: 0 },
) {
    return {
        getHealthStatus: () => makeHealthStatus(healthOverrides),
        getDeferredWorkCounts: () => deferredCounts,
    } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryOperatorReviewService', () => {
    let service: MemoryOperatorReviewService;

    // ── MOR-01: critical posture assembles correctly ──────────────────────────

    it('MOR-01 critical posture model assembles correctly with headline, reasons, and hard-disabled flag', async () => {
        const healthStatus = makeHealthStatus({
            state: 'critical',
            reasons: ['canonical_unavailable'],
            hardDisabled: true,
            shouldTriggerRepair: true,
            shouldEscalate: true,
        });

        service = new MemoryOperatorReviewService(
            makeMemorySvc(healthStatus),
            makeScheduler({ lastRun: makeRunResult('critical') }),
        );

        const model = await service.getModel();

        expect(model.posture).toBe('critical');
        expect(model.health.state).toBe('critical');
        expect(model.health.hardDisabled).toBe(true);
        expect(model.health.reasons).toContain('canonical_unavailable');
        expect(model.health.shouldTriggerRepair).toBe(true);
        expect(model.health.shouldEscalate).toBe(true);
        expect(model.summary.headline).toContain('Critical');
    });

    // ── MOR-02: adaptive plan is included and ordered correctly ───────────────

    it('MOR-02 adaptive plan is included and top priorities are preserved in plan order (not re-sorted)', async () => {
        // Priorities are intentionally out of score order to verify the service
        // does NOT re-sort them — the planner is authoritative on ordering.
        const plan = makeAdaptivePlan({
            priorities: [
                { target: 'graph', score: 30, reason: 'occasional failures', evidence: {} },
                { target: 'canonical', score: 90, reason: 'repeated unavailability', evidence: {} },
                { target: 'mem0', score: 60, reason: 'recurring failures', evidence: {} },
            ],
            escalation: { bias: 'accelerate', reason: 'pattern worsening', evidence: {} },
            cadence: { recommendation: 'tighten', suggestedMultiplier: 0.5, reason: 'tighten', evidence: {} },
        });

        service = new MemoryOperatorReviewService(
            makeMemorySvc(),
            makeScheduler({ adaptivePlan: plan, lastRun: makeRunResult('unstable') }),
        );

        const model = await service.getModel();

        expect(model.adaptivePlan).not.toBeNull();
        expect(model.adaptivePlan!.escalationBias).toBe('accelerate');
        expect(model.adaptivePlan!.cadenceRecommendationMinutes).toBe(5); // 10 * 0.5
        const scores = model.adaptivePlan!.topPriorities.map(p => p.score);
        // Service preserves plan order (not re-sorted by score) — planner is authoritative
        expect(scores).toEqual([30, 90, 60]);
        // Verify the targets also preserve order
        expect(model.adaptivePlan!.topPriorities.map(p => p.target)).toEqual(['graph', 'canonical', 'mem0']);
    });

    // ── MOR-03: suggestions capped and sorted deterministically ──────────────

    it('MOR-03 optimization suggestions are capped at 8 and sorted by priorityScore desc then id asc', async () => {
        // Create 10 suggestions with varied scores
        const suggestions = [
            makeSuggestion('z:mem0', 50),
            makeSuggestion('a:canonical', 90, 'critical'),
            makeSuggestion('b:graph', 80, 'error'),
            makeSuggestion('c:rag', 70, 'warning'),
            makeSuggestion('d:embedding', 65),
            makeSuggestion('e:extraction', 55),
            makeSuggestion('f:providers', 50),
            makeSuggestion('g:scheduler', 40),
            makeSuggestion('h:queue', 30),
            makeSuggestion('i:observability', 20),
        ];

        service = new MemoryOperatorReviewService(
            makeMemorySvc(),
            makeScheduler({ suggestionReport: makeSuggestionReport(suggestions) }),
        );

        const model = await service.getModel();

        expect(model.optimizationSuggestions.totalSuggestions).toBe(10);
        expect(model.optimizationSuggestions.topSuggestions.length).toBe(8); // capped at 8
        // First should be the highest score
        expect(model.optimizationSuggestions.topSuggestions[0].id).toBe('a:canonical');
        expect(model.optimizationSuggestions.topSuggestions[0].priorityScore).toBe(90);
        // Tie at score 50: 'f:providers' < 'z:mem0' lexically
        const score50 = model.optimizationSuggestions.topSuggestions.filter(s => s.priorityScore === 50);
        expect(score50.length).toBe(2);
        expect(score50[0].id).toBe('f:providers');
        expect(score50[1].id).toBe('z:mem0');
    });

    // ── MOR-04: queue stats and dead-letter appear correctly ─────────────────

    it('MOR-04 queue stats appear correctly with dead-letter count from insight summary', async () => {
        const summary = makeInsightSummary({
            queueBehavior: { totalReplays: 10, replaySuccesses: 5, replayFailures: 5, deadLetterCount: 3, deadLetterGrowing: true },
        });

        service = new MemoryOperatorReviewService(
            makeMemorySvc({}, { extraction: 12, embedding: 5, projection: 2 }),
            makeScheduler({ insightSummary: summary }),
        );

        const model = await service.getModel();

        expect(model.queues.extractionPending).toBe(12);
        expect(model.queues.embeddingPending).toBe(5);
        expect(model.queues.graphPending).toBe(2);
        expect(model.queues.deadLetters).toHaveLength(1);
        expect(model.queues.deadLetters[0].kind).toBe('deferred_work');
        expect(model.queues.deadLetters[0].count).toBe(3);
    });

    // ── MOR-05: recent cycles bounded and most recent first ──────────────────

    it('MOR-05 recent repair cycles are bounded to 5 and ordered most recent first', async () => {
        const makeRun = (n: number) => makeRunResult('stable', {
            startedAt: new Date(Date.now() - n * 60_000).toISOString(),
            completedAt: new Date(Date.now() - n * 60_000 + 30_000).toISOString(),
            actionsTaken: [`action_${n}`],
        });

        const runs = [makeRun(10), makeRun(9), makeRun(8), makeRun(7), makeRun(6), makeRun(5)]; // 6 runs

        service = new MemoryOperatorReviewService(
            makeMemorySvc(),
            makeScheduler({ recentRuns: runs }),
        );

        const model = await service.getModel();

        // Capped at 5
        expect(model.recentRepair.recentCycles.length).toBe(5);
        // Most recent first (reversed from recentRuns order)
        expect(model.recentRepair.recentCycles[0].attemptedActions).toContain('action_5');
        expect(model.recentRepair.recentCycles[4].attemptedActions).toContain('action_9');
    });

    // ── MOR-06: stable posture — low noise ────────────────────────────────────

    it('MOR-06 stable posture renders low-noise headline with no escalation findings', async () => {
        service = new MemoryOperatorReviewService(
            makeMemorySvc(),
            makeScheduler({
                lastRun: makeRunResult('stable'),
                insightSummary: makeInsightSummary(),
            }),
        );

        const model = await service.getModel();

        expect(model.posture).toBe('stable');
        expect(model.health.hardDisabled).toBe(false);
        expect(model.summary.headline).toContain('Stable');
        expect(model.summary.keyFindings).toContain('No escalation signals detected in the current analysis window.');
        expect(model.summary.topFailureReasons).toHaveLength(0);
        expect(model.summary.unstableSubsystems).toHaveLength(0);
    });

    // ── MOR-07: advisory-only labeling present ────────────────────────────────

    it('MOR-07 advisory notes are present and non-empty', async () => {
        service = new MemoryOperatorReviewService(makeMemorySvc(), makeScheduler());

        const model = await service.getModel();

        expect(model.notes.length).toBeGreaterThan(0);
        const notesText = model.notes.join(' ').toLowerCase();
        expect(notesText).toMatch(/advisory|auto-changed|recommendations/i);
    });

    // ── MOR-08: graceful degradation when no analytics run yet ───────────────

    it('MOR-08 missing optional sections degrade gracefully when no scheduler run has completed', async () => {
        service = new MemoryOperatorReviewService(
            makeMemorySvc(),
            makeScheduler(), // all null
        );

        const model = await service.getModel();

        expect(model.adaptivePlan).toBeNull();
        expect(model.optimizationSuggestions.totalSuggestions).toBe(0);
        expect(model.optimizationSuggestions.topSuggestions).toHaveLength(0);
        expect(model.recentRepair.lastRunAt).toBeNull();
        expect(model.recentRepair.recentCycles).toHaveLength(0);
        expect(model.recentRepair.actionEffectiveness).toHaveLength(0);
        expect(model.summary.keyFindings).toContain('No analytics run has completed yet. Check back after the first scheduled maintenance cycle.');
    });

    // ── MOR-08b: graceful when scheduler is null ─────────────────────────────

    it('MOR-08b model assembles successfully when scheduler is null (no DB pool)', async () => {
        service = new MemoryOperatorReviewService(makeMemorySvc(), null);

        const model = await service.getModel();

        expect(model).toBeDefined();
        expect(model.posture).toBe('stable');
        expect(model.adaptivePlan).toBeNull();
    });

    // ── MOR-09: fetch path returns current model ──────────────────────────────

    it('MOR-09 calling getModel() twice returns independently assembled models', async () => {
        service = new MemoryOperatorReviewService(makeMemorySvc(), makeScheduler());

        const m1 = await service.getModel();
        const m2 = await service.getModel();

        // Both are valid, shape matches
        expect(m1.posture).toBe(m2.posture);
        expect(m1.health.state).toBe(m2.health.state);
        // Results are separate objects (not the same reference)
        expect(m1).not.toBe(m2);
        // Both have a valid generatedAt ISO timestamp
        expect(m1.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(m2.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    // ── MOR-10: same inputs → same ordering ───────────────────────────────────

    it('MOR-10 same backend state produces same ordered output across calls', async () => {
        const suggestions = [
            makeSuggestion('b:item', 70, 'error'),
            makeSuggestion('a:item', 70, 'error'), // same score, lexically before b
            makeSuggestion('c:item', 80, 'critical'),
        ];
        const report = makeSuggestionReport(suggestions);

        service = new MemoryOperatorReviewService(
            makeMemorySvc(),
            makeScheduler({ suggestionReport: report }),
        );

        const m1 = await service.getModel();
        const m2 = await service.getModel();

        const ids1 = m1.optimizationSuggestions.topSuggestions.map(s => s.id);
        const ids2 = m2.optimizationSuggestions.topSuggestions.map(s => s.id);

        expect(ids1).toEqual(ids2);
        // c:item is highest score
        expect(ids1[0]).toBe('c:item');
        // a:item < b:item lexically at same score
        expect(ids1[1]).toBe('a:item');
        expect(ids1[2]).toBe('b:item');
    });

    // ── Bonus: failure reasons bounded to top 5 ───────────────────────────────

    it('MOR-BOUND top failure reasons are bounded to 5 and sorted by count desc', async () => {
        const summary = makeInsightSummary({
            recurrentFailures: [
                { reason: 'mem0_unavailable', subsystem: 'mem0', occurrenceCount: 2, firstSeenAt: '', lastSeenAt: '', recoversBetweenFailures: true },
                { reason: 'canonical_unavailable', subsystem: 'canonical', occurrenceCount: 8, firstSeenAt: '', lastSeenAt: '', recoversBetweenFailures: false },
                { reason: 'graph_projection_unavailable', subsystem: 'graph', occurrenceCount: 3, firstSeenAt: '', lastSeenAt: '', recoversBetweenFailures: true },
                { reason: 'embedding_provider_unavailable', subsystem: 'embedding', occurrenceCount: 5, firstSeenAt: '', lastSeenAt: '', recoversBetweenFailures: true },
                { reason: 'rag_logging_unavailable', subsystem: 'rag', occurrenceCount: 1, firstSeenAt: '', lastSeenAt: '', recoversBetweenFailures: true },
                { reason: 'extraction_provider_unavailable', subsystem: 'extraction', occurrenceCount: 4, firstSeenAt: '', lastSeenAt: '', recoversBetweenFailures: true },
            ],
        });

        service = new MemoryOperatorReviewService(
            makeMemorySvc(),
            makeScheduler({ insightSummary: summary }),
        );

        const model = await service.getModel();

        expect(model.summary.topFailureReasons.length).toBe(5); // bounded
        expect(model.summary.topFailureReasons[0].reason).toBe('canonical_unavailable'); // highest count
        expect(model.summary.topFailureReasons[0].count).toBe(8);
    });

    // ── Bonus: action effectiveness bounded to top 5 ─────────────────────────

    it('MOR-EFF action effectiveness is bounded to 5 entries sorted by total executions desc', async () => {
        const summary = makeInsightSummary({
            actionEffectiveness: [
                { actionType: 'reconnect_mem0', totalExecutions: 10, successCount: 8, failureCount: 2, skipCount: 0, successRate: 0.8 },
                { actionType: 'reconnect_canonical', totalExecutions: 3, successCount: 3, failureCount: 0, skipCount: 0, successRate: 1.0 },
                { actionType: 'reinit_canonical', totalExecutions: 15, successCount: 10, failureCount: 5, skipCount: 0, successRate: 0.67 },
                { actionType: 'reconnect_graph', totalExecutions: 7, successCount: 5, failureCount: 2, skipCount: 0, successRate: 0.71 },
                { actionType: 're_resolve_providers', totalExecutions: 2, successCount: 1, failureCount: 1, skipCount: 0, successRate: 0.5 },
                { actionType: 'drain_deferred_work', totalExecutions: 12, successCount: 11, failureCount: 1, skipCount: 0, successRate: 0.92 },
            ],
        });

        service = new MemoryOperatorReviewService(
            makeMemorySvc(),
            makeScheduler({ insightSummary: summary }),
        );

        const model = await service.getModel();

        expect(model.recentRepair.actionEffectiveness.length).toBe(5); // bounded
        // Sorted by total executions desc: reinit_canonical(15) > drain_deferred_work(12) > reconnect_mem0(10) > ...
        expect(model.recentRepair.actionEffectiveness[0].action).toBe('reinit_canonical');
        expect(model.recentRepair.actionEffectiveness[1].action).toBe('drain_deferred_work');
    });
});

// ---------------------------------------------------------------------------
// MemoryRepairSchedulerService caching tests
// ---------------------------------------------------------------------------

describe('MemoryRepairSchedulerService — caching and ring buffer', () => {
    it('MOR-SCHED-01 getLatestInsightSummary returns null before any run', async () => {
        const { MemoryRepairSchedulerService } = await import('../electron/services/memory/MemoryRepairSchedulerService');

        const mockRepo = {
            countTriggers: vi.fn().mockResolvedValue(0),
            countCycles: vi.fn().mockResolvedValue(0),
            getReasonCounts: vi.fn().mockResolvedValue([]),
            getActionOutcomeCounts: vi.fn().mockResolvedValue([]),
            getCycleOutcomeCounts: vi.fn().mockResolvedValue([]),
            getReplayCounts: vi.fn().mockResolvedValue({ successes: 0, failures: 0 }),
            getDeadLetterHalves: vi.fn().mockResolvedValue({ early: 0, late: 0, total: 0 }),
            getHealthTransitions: vi.fn().mockResolvedValue([]),
            getEscalationCandidateReasons: vi.fn().mockResolvedValue([]),
            countFailedCycles: vi.fn().mockResolvedValue(0),
            getDegradedHours: vi.fn().mockResolvedValue(0),
            append: vi.fn().mockResolvedValue(null),
        } as any;

        const scheduler = new MemoryRepairSchedulerService(mockRepo);

        expect(scheduler.getLatestInsightSummary()).toBeNull();
        expect(scheduler.getLatestAdaptivePlan()).toBeNull();
        expect(scheduler.getLatestSuggestionReport()).toBeNull();
        expect(scheduler.getLatestReflectionReport()).toBeNull();
        expect(scheduler.getRecentRuns()).toHaveLength(0);
    });

    it('MOR-SCHED-02 getRecentRuns ring buffer caps at 5 entries', async () => {
        const { MemoryRepairSchedulerService } = await import('../electron/services/memory/MemoryRepairSchedulerService');

        const mockRepo = {
            countTriggers: vi.fn().mockResolvedValue(0),
            countCycles: vi.fn().mockResolvedValue(0),
            getReasonCounts: vi.fn().mockResolvedValue([]),
            getActionOutcomeCounts: vi.fn().mockResolvedValue([]),
            getCycleOutcomeCounts: vi.fn().mockResolvedValue([]),
            getReplayCounts: vi.fn().mockResolvedValue({ successes: 0, failures: 0 }),
            getDeadLetterHalves: vi.fn().mockResolvedValue({ early: 0, late: 0, total: 0 }),
            getHealthTransitions: vi.fn().mockResolvedValue([]),
            getEscalationCandidateReasons: vi.fn().mockResolvedValue([]),
            countFailedCycles: vi.fn().mockResolvedValue(0),
            getDegradedHours: vi.fn().mockResolvedValue(0),
            append: vi.fn().mockResolvedValue(null),
        } as any;

        const scheduler = new MemoryRepairSchedulerService(mockRepo);

        // Run 7 times — ring buffer should only keep the last 5
        for (let i = 0; i < 7; i++) {
            await scheduler.runNow('test');
        }

        expect(scheduler.getRecentRuns().length).toBe(5);
    });

    it('MOR-SCHED-03 getRecentRuns returns a copy (mutation safe)', async () => {
        const { MemoryRepairSchedulerService } = await import('../electron/services/memory/MemoryRepairSchedulerService');

        const mockRepo = {
            countTriggers: vi.fn().mockResolvedValue(0),
            countCycles: vi.fn().mockResolvedValue(0),
            getReasonCounts: vi.fn().mockResolvedValue([]),
            getActionOutcomeCounts: vi.fn().mockResolvedValue([]),
            getCycleOutcomeCounts: vi.fn().mockResolvedValue([]),
            getReplayCounts: vi.fn().mockResolvedValue({ successes: 0, failures: 0 }),
            getDeadLetterHalves: vi.fn().mockResolvedValue({ early: 0, late: 0, total: 0 }),
            getHealthTransitions: vi.fn().mockResolvedValue([]),
            getEscalationCandidateReasons: vi.fn().mockResolvedValue([]),
            countFailedCycles: vi.fn().mockResolvedValue(0),
            getDegradedHours: vi.fn().mockResolvedValue(0),
            append: vi.fn().mockResolvedValue(null),
        } as any;

        const scheduler = new MemoryRepairSchedulerService(mockRepo);
        await scheduler.runNow('test');

        const runs1 = scheduler.getRecentRuns();
        runs1.push({} as any); // mutate the returned copy

        const runs2 = scheduler.getRecentRuns();
        expect(runs2.length).toBe(1); // internal buffer unaffected
    });
});
