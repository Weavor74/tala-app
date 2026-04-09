/**
 * MemoryRepairScheduler.test.ts
 *
 * Unit tests for the scheduled memory repair loop:
 *   - MemoryRepairSchedulerService (scheduled analytics + reflection + decision)
 *   - MemorySelfMaintenanceService (threshold-based decision layer)
 *
 * Covers:
 *   MRS01–MRS10  — MemorySelfMaintenanceService posture derivation
 *   MRS11–MRS20  — MemorySelfMaintenanceService decision flags
 *   MRS21–MRS30  — MemoryRepairSchedulerService.runNow behavior
 *   MRS31–MRS40  — MemoryRepairSchedulerService telemetry + concurrency guard
 *
 * No real DB, no Electron.  All DB interactions are stubbed.
 * TelemetryBus is stubbed.
 * setInterval/clearInterval are faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Stub TelemetryBus
// ---------------------------------------------------------------------------

const emittedEvents: Array<{ event: string; payload?: Record<string, unknown> }> = [];

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (event: unknown) => emittedEvents.push(event as { event: string; payload?: Record<string, unknown> }),
            subscribe: vi.fn().mockReturnValue(vi.fn()),
        }),
    },
}));

// ---------------------------------------------------------------------------
// Stub DeferredMemoryReplayService
// ---------------------------------------------------------------------------

const mockDrain = vi.fn().mockResolvedValue(undefined);

vi.mock('../electron/services/memory/DeferredMemoryReplayService', () => ({
    DeferredMemoryReplayService: {
        getInstance: () => ({
            drain: mockDrain,
        }),
    },
}));

// ---------------------------------------------------------------------------
// Stub MemoryRepairTriggerService
// ---------------------------------------------------------------------------

const mockEmitDirect = vi.fn();

vi.mock('../electron/services/memory/MemoryRepairTriggerService', () => ({
    MemoryRepairTriggerService: {
        getInstance: () => ({
            emitDirect: mockEmitDirect,
        }),
    },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { MemorySelfMaintenanceService } from '../electron/services/memory/MemorySelfMaintenanceService';
import { MemoryRepairSchedulerService } from '../electron/services/memory/MemoryRepairSchedulerService';
import { MemoryRepairAnalyticsService } from '../electron/services/memory/MemoryRepairAnalyticsService';
import { MemoryRepairReflectionService } from '../electron/services/memory/MemoryRepairReflectionService';
import type {
    MemoryRepairInsightSummary,
    MemoryRepairReflectionReport,
} from '../shared/memory/MemoryRepairInsights';
import type { MemoryRepairOutcomeRepository } from '../electron/services/db/MemoryRepairOutcomeRepository';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<MemoryRepairInsightSummary> = {}): MemoryRepairInsightSummary {
    return {
        windowHours: 24,
        generatedAt: new Date().toISOString(),
        totalCycles: 0,
        totalTriggers: 0,
        recurrentFailures: [],
        actionEffectiveness: [],
        queueBehavior: {
            totalReplays: 0,
            replaySuccesses: 0,
            replayFailures: 0,
            deadLetterCount: 0,
            deadLetterGrowing: false,
        },
        escalationCandidates: [],
        trajectories: [],
        ...overrides,
    };
}

function makeReport(
    summary: MemoryRepairInsightSummary,
    overrides: Partial<MemoryRepairReflectionReport> = {},
): MemoryRepairReflectionReport {
    const svc = new MemoryRepairReflectionService();
    const base = svc.generateReport(summary);
    return { ...base, ...overrides };
}

function makeRepo(
    summaryOverride?: Partial<MemoryRepairInsightSummary>,
): MemoryRepairOutcomeRepository {
    const summary = makeSummary(summaryOverride);
    // Stub all query methods used by MemoryRepairAnalyticsService.generateSummary
    return {
        countCycles: vi.fn().mockResolvedValue(summary.totalCycles),
        countTriggers: vi.fn().mockResolvedValue(summary.totalTriggers),
        getReasonCounts: vi.fn().mockResolvedValue(
            summary.recurrentFailures.map(f => ({
                reason: f.reason,
                cnt: f.occurrenceCount,
                first_at: f.firstSeenAt,
                last_at: f.lastSeenAt,
            })),
        ),
        getActionOutcomeCounts: vi.fn().mockResolvedValue([]),
        getCycleOutcomeCounts: vi.fn().mockResolvedValue([]),
        getReplayCounts: vi.fn().mockResolvedValue({
            successes: summary.queueBehavior.replaySuccesses,
            failures: summary.queueBehavior.replayFailures,
        }),
        getDeadLetterHalves: vi.fn().mockResolvedValue({
            early: 0,
            late: summary.queueBehavior.deadLetterGrowing ? 1 : 0,
            total: summary.queueBehavior.deadLetterCount,
        }),
        getHealthTransitions: vi.fn().mockResolvedValue([]),
        countFailedCycles: vi.fn().mockResolvedValue(0),
        getDegradedHours: vi.fn().mockResolvedValue(0),
        getEscalationCandidateReasons: vi.fn().mockResolvedValue(
            summary.escalationCandidates
                .filter(c => c.code === 'repeated_failure_reason')
                .map(c => ({
                    reason: c.evidence['reason'] as string,
                    cnt: c.evidence['occurrenceCount'] as number,
                    first_at: c.firstEvidenceAt,
                    last_at: c.lastEvidenceAt,
                })),
        ),
        append: vi.fn().mockResolvedValue('mock-id'),
    } as unknown as MemoryRepairOutcomeRepository;
}

// ===========================================================================
// MemorySelfMaintenanceService — MRS01–MRS20
// ===========================================================================

describe('MemorySelfMaintenanceService', () => {
    let svc: MemorySelfMaintenanceService;

    beforeEach(() => {
        svc = new MemorySelfMaintenanceService();
    });

    // ── Posture derivation (MRS01–MRS10) ─────────────────────────────────────

    // MRS01 — clean slate → stable
    it('MRS01: clean summary and no recommendations → posture=stable', () => {
        const summary = makeSummary();
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.posture).toBe('stable');
    });

    // MRS02 — single recurring failure → watch
    it('MRS02: single recurring failure (below threshold) → posture=watch', () => {
        const summary = makeSummary({
            recurrentFailures: [{
                reason: 'mem0_unavailable',
                subsystem: 'mem0',
                occurrenceCount: 1,
                firstSeenAt: new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
                recoversBetweenFailures: true,
            }],
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.posture).toBe('watch');
    });

    // MRS03 — recurring failures at threshold → unstable
    it('MRS03: recurring failures >= threshold → posture=unstable', () => {
        const summary = makeSummary({
            recurrentFailures: [
                {
                    reason: 'mem0_unavailable',
                    subsystem: 'mem0',
                    occurrenceCount: 3,
                    firstSeenAt: new Date().toISOString(),
                    lastSeenAt: new Date().toISOString(),
                    recoversBetweenFailures: false,
                },
                {
                    reason: 'graph_projection_unavailable',
                    subsystem: 'graph',
                    occurrenceCount: 2,
                    firstSeenAt: new Date().toISOString(),
                    lastSeenAt: new Date().toISOString(),
                    recoversBetweenFailures: false,
                },
            ],
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.posture).toBe('unstable');
    });

    // MRS04 — one escalation candidate at/above threshold → unstable
    it('MRS04: single escalation candidate → posture=unstable', () => {
        const now = new Date().toISOString();
        const summary = makeSummary({
            escalationCandidates: [{
                code: 'repeated_failure_reason',
                description: 'test',
                evidence: { reason: 'mem0_unavailable', occurrenceCount: 4, threshold: 3 },
                firstEvidenceAt: now,
                lastEvidenceAt: now,
            }],
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.posture).toBe('unstable');
    });

    // MRS05 — critical recommendations in report → critical
    it('MRS05: report with critical recommendations → posture=critical', () => {
        const summary = makeSummary();
        const report = makeReport(summary, { hasCriticalFindings: true });
        const decision = svc.evaluate(summary, report);
        expect(decision.posture).toBe('critical');
    });

    // MRS06 — escalation candidates >= criticalEscalationMin → critical
    it('MRS06: escalation candidates >= criticalMin → posture=critical', () => {
        const now = new Date().toISOString();
        const summary = makeSummary({
            escalationCandidates: [
                {
                    code: 'repeated_cycle_failure',
                    description: 'cycle failed 3 times',
                    evidence: { failedCycles: 3, threshold: 3 },
                    firstEvidenceAt: now,
                    lastEvidenceAt: now,
                },
                {
                    code: 'prolonged_degraded',
                    description: 'degraded 2h',
                    evidence: { degradedHours: 2, threshold: 1 },
                    firstEvidenceAt: now,
                    lastEvidenceAt: now,
                },
            ],
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.posture).toBe('critical');
    });

    // MRS07 — dead-letter items alone → watch
    it('MRS07: dead-letter items only → posture=watch', () => {
        const summary = makeSummary({
            queueBehavior: {
                totalReplays: 0,
                replaySuccesses: 0,
                replayFailures: 0,
                deadLetterCount: 2,
                deadLetterGrowing: false,
            },
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.posture).toBe('watch');
    });

    // MRS08 — growing dead-letter + escalation candidate → unstable
    it('MRS08: growing dead-letter queue escalation candidate → posture=unstable', () => {
        const now = new Date().toISOString();
        const summary = makeSummary({
            queueBehavior: {
                totalReplays: 0,
                replaySuccesses: 0,
                replayFailures: 0,
                deadLetterCount: 3,
                deadLetterGrowing: true,
            },
            escalationCandidates: [{
                code: 'growing_dead_letter_queue',
                description: 'growing',
                evidence: { totalDeadLetters: 3 },
                firstEvidenceAt: now,
                lastEvidenceAt: now,
            }],
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.posture).toBe('unstable');
    });

    // MRS09 — custom thresholds are respected
    it('MRS09: custom threshold recurringFailureMin=5 keeps posture=watch at 3 failures', () => {
        const svcCustom = new MemorySelfMaintenanceService({ repairCycleRecurringFailureMin: 5 });
        const summary = makeSummary({
            recurrentFailures: Array.from({ length: 3 }, (_, i) => ({
                reason: `reason_${i}` as any,
                subsystem: 'unknown',
                occurrenceCount: 2,
                firstSeenAt: new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
                recoversBetweenFailures: false,
            })),
        });
        const report = makeReport(summary);
        const decision = svcCustom.evaluate(summary, report);
        // 3 failures < custom threshold of 5 → watch, not unstable
        expect(decision.posture).toBe('watch');
    });

    // MRS10 — stable with only empty trajectories → stable
    it('MRS10: trajectories present but all end healthy → stable', () => {
        const summary = makeSummary({
            trajectories: [{
                stateSequence: ['degraded', 'healthy'],
                occurrenceCount: 1,
                endsHealthy: true,
            }],
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.posture).toBe('stable');
    });

    // ── Decision flags (MRS11–MRS20) ──────────────────────────────────────────

    // MRS11 — stable posture → no action flags
    it('MRS11: stable posture → all action flags false', () => {
        const summary = makeSummary();
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.shouldTriggerRepairCycle).toBe(false);
        expect(decision.shouldPrioritizeReplay).toBe(false);
        expect(decision.shouldEscalate).toBe(false);
        expect(decision.shouldFlagUnstableSubsystems).toBe(false);
    });

    // MRS12 — unstable posture with recurring failures → shouldTriggerRepairCycle
    it('MRS12: unstable with recurring failures >= threshold → shouldTriggerRepairCycle=true', () => {
        const summary = makeSummary({
            recurrentFailures: [
                {
                    reason: 'mem0_unavailable',
                    subsystem: 'mem0',
                    occurrenceCount: 3,
                    firstSeenAt: new Date().toISOString(),
                    lastSeenAt: new Date().toISOString(),
                    recoversBetweenFailures: false,
                },
                {
                    reason: 'canonical_unavailable',
                    subsystem: 'canonical',
                    occurrenceCount: 2,
                    firstSeenAt: new Date().toISOString(),
                    lastSeenAt: new Date().toISOString(),
                    recoversBetweenFailures: false,
                },
            ],
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.shouldTriggerRepairCycle).toBe(true);
    });

    // MRS13 — dead-letter items → shouldPrioritizeReplay
    it('MRS13: dead-letter items >= threshold → shouldPrioritizeReplay=true', () => {
        const summary = makeSummary({
            queueBehavior: {
                totalReplays: 0,
                replaySuccesses: 0,
                replayFailures: 0,
                deadLetterCount: 1,
                deadLetterGrowing: false,
            },
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.shouldPrioritizeReplay).toBe(true);
    });

    // MRS14 — no dead-letter items → shouldPrioritizeReplay=false
    it('MRS14: no dead-letter items → shouldPrioritizeReplay=false', () => {
        const summary = makeSummary();
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.shouldPrioritizeReplay).toBe(false);
    });

    // MRS15 — unstable posture + escalation candidate → shouldEscalate
    it('MRS15: unstable posture with escalation candidate → shouldEscalate=true', () => {
        const now = new Date().toISOString();
        const summary = makeSummary({
            escalationCandidates: [{
                code: 'repeated_failure_reason',
                description: 'test',
                evidence: { reason: 'mem0_unavailable', occurrenceCount: 4 },
                firstEvidenceAt: now,
                lastEvidenceAt: now,
            }],
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.shouldEscalate).toBe(true);
    });

    // MRS16 — watch posture → shouldEscalate=false
    it('MRS16: watch posture → shouldEscalate=false', () => {
        const summary = makeSummary({
            recurrentFailures: [{
                reason: 'mem0_unavailable',
                subsystem: 'mem0',
                occurrenceCount: 1,
                firstSeenAt: new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
                recoversBetweenFailures: true,
            }],
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.shouldEscalate).toBe(false);
    });

    // MRS17 — action with low success rate and enough executions → shouldFlagUnstableSubsystems
    it('MRS17: action success rate <= critical threshold with enough executions → shouldFlagUnstableSubsystems=true', () => {
        const now = new Date().toISOString();
        const summary = makeSummary({
            // Need unstable posture for flag to be true
            escalationCandidates: [{
                code: 'repeated_failure_reason',
                description: 'test',
                evidence: { reason: 'mem0_unavailable', occurrenceCount: 4 },
                firstEvidenceAt: now,
                lastEvidenceAt: now,
            }],
            actionEffectiveness: [{
                actionType: 'reconnect_mem0',
                totalExecutions: 5,
                successCount: 0,
                failureCount: 5,
                skipCount: 0,
                successRate: 0.0,
            }],
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.shouldFlagUnstableSubsystems).toBe(true);
    });

    // MRS18 — action above success rate threshold → shouldFlagUnstableSubsystems=false
    it('MRS18: action success rate above critical threshold → shouldFlagUnstableSubsystems=false', () => {
        const now = new Date().toISOString();
        const summary = makeSummary({
            escalationCandidates: [{
                code: 'repeated_failure_reason',
                description: 'test',
                evidence: { reason: 'mem0_unavailable', occurrenceCount: 4 },
                firstEvidenceAt: now,
                lastEvidenceAt: now,
            }],
            actionEffectiveness: [{
                actionType: 'reconnect_mem0',
                totalExecutions: 5,
                successCount: 3,
                failureCount: 2,
                skipCount: 0,
                successRate: 0.6,
            }],
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.shouldFlagUnstableSubsystems).toBe(false);
    });

    // MRS19 — actions list always contains publish_report
    it('MRS19: actions always include publish_report', () => {
        const summary = makeSummary();
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.actions.some(a => a.type === 'publish_report')).toBe(true);
    });

    // MRS20 — shouldEscalate adds emit_escalation action
    it('MRS20: shouldEscalate=true adds emit_escalation action', () => {
        const now = new Date().toISOString();
        const summary = makeSummary({
            escalationCandidates: [{
                code: 'repeated_cycle_failure',
                description: 'failed 3 times',
                evidence: { failedCycles: 3, threshold: 3 },
                firstEvidenceAt: now,
                lastEvidenceAt: now,
            }],
        });
        const report = makeReport(summary);
        const decision = svc.evaluate(summary, report);
        expect(decision.actions.some(a => a.type === 'emit_escalation')).toBe(true);
    });

    // ===========================================================================
    // MemoryRepairSchedulerService — MRS21–MRS40
    // ===========================================================================
});

describe('MemoryRepairSchedulerService', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
        mockDrain.mockClear();
        mockEmitDirect.mockClear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // MRS21 — runNow returns a result with correct shape
    it('MRS21: runNow returns a MemoryRepairScheduledRunResult with correct shape', async () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo);
        const result = await scheduler.runNow('test');
        expect(result).toMatchObject({
            windowHours: 24,
            posture: expect.stringMatching(/^(stable|watch|unstable|critical)$/),
            actionsTaken: expect.any(Array),
            escalationCount: expect.any(Number),
            recommendationCount: expect.any(Number),
        });
        expect(result.startedAt).toBeTruthy();
        expect(result.completedAt).toBeTruthy();
    });

    // MRS22 — clean repo → stable posture
    it('MRS22: clean analytics (no issues) → posture=stable, no triggering actions', async () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo);
        const result = await scheduler.runNow('test');
        expect(result.posture).toBe('stable');
        expect(result.actionsTaken).not.toContain('trigger_repair');
        expect(result.actionsTaken).not.toContain('emit_escalation');
    });

    // MRS23 — recurring failures → unstable posture and trigger_repair action
    it('MRS23: recurring failures in analytics → posture=unstable, trigger_repair taken', async () => {
        const repo = makeRepo({
            recurrentFailures: [
                {
                    reason: 'mem0_unavailable',
                    subsystem: 'mem0',
                    occurrenceCount: 3,
                    firstSeenAt: new Date().toISOString(),
                    lastSeenAt: new Date().toISOString(),
                    recoversBetweenFailures: false,
                },
                {
                    reason: 'canonical_unavailable',
                    subsystem: 'canonical',
                    occurrenceCount: 2,
                    firstSeenAt: new Date().toISOString(),
                    lastSeenAt: new Date().toISOString(),
                    recoversBetweenFailures: false,
                },
            ],
        });
        const scheduler = new MemoryRepairSchedulerService(repo);
        const result = await scheduler.runNow('test');
        expect(result.posture).toBe('unstable');
        expect(result.actionsTaken).toContain('trigger_repair');
        expect(mockEmitDirect).toHaveBeenCalledOnce();
    });

    // MRS24 — dead-letter items → prioritize_replay action
    it('MRS24: dead-letter items → prioritize_replay action taken', async () => {
        const repo = makeRepo({
            queueBehavior: {
                totalReplays: 0,
                replaySuccesses: 0,
                replayFailures: 0,
                deadLetterCount: 2,
                deadLetterGrowing: false,
            },
        });
        const scheduler = new MemoryRepairSchedulerService(repo);
        const result = await scheduler.runNow('test');
        expect(result.actionsTaken).toContain('prioritize_replay');
        // drain() is called asynchronously; give microtasks a tick
        await Promise.resolve();
        expect(mockDrain).toHaveBeenCalledOnce();
    });

    // MRS25 — escalation candidate → emit_escalation action
    it('MRS25: escalation candidate → emit_escalation action taken', async () => {
        const now = new Date().toISOString();
        const repo = makeRepo({
            escalationCandidates: [{
                code: 'repeated_failure_reason',
                description: 'test',
                evidence: { reason: 'mem0_unavailable', occurrenceCount: 4, threshold: 3 },
                firstEvidenceAt: now,
                lastEvidenceAt: now,
            }],
        });
        const scheduler = new MemoryRepairSchedulerService(repo);
        const result = await scheduler.runNow('test');
        expect(result.actionsTaken).toContain('emit_escalation');
        const escalationEvent = emittedEvents.find(e => e.event === 'memory.maintenance_escalation');
        expect(escalationEvent).toBeDefined();
    });

    // MRS26 — getLastRun returns null before first run
    it('MRS26: getLastRun returns null before any run', () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo);
        expect(scheduler.getLastRun()).toBeNull();
    });

    // MRS27 — getLastRun returns the result after a run
    it('MRS27: getLastRun returns the last run result after runNow', async () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo);
        const result = await scheduler.runNow('test');
        expect(scheduler.getLastRun()).toEqual(result);
    });

    // MRS28 — overlapping runNow calls return skipped result for the second call
    it('MRS28: concurrent runNow calls result in second call being skipped', async () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo);

        // Start first run but don't await it yet
        const firstPromise = scheduler.runNow('first');
        // Start second run immediately (first is still in flight)
        const secondResult = await scheduler.runNow('second');

        expect(secondResult.skipped).toBe(true);
        expect(secondResult.reason).toBe('run_in_progress');

        // Let the first run complete
        await firstPromise;
    });

    // MRS29 — analytics failure is gracefully handled and returns skipped result
    it('MRS29: analytics error → skipped result with error reason', async () => {
        const failingRepo = {
            ...makeRepo(),
            countCycles: vi.fn().mockRejectedValue(new Error('db timeout')),
        } as unknown as MemoryRepairOutcomeRepository;

        const scheduler = new MemoryRepairSchedulerService(failingRepo);
        const result = await scheduler.runNow('test');
        expect(result.skipped).toBe(true);
        expect(result.reason).toContain('run_error');
        expect(result.reason).toContain('db timeout');
    });

    // MRS30 — custom window config is used
    it('MRS30: custom windowHours config is passed to analytics', async () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo, { windowHours: 6 });
        const result = await scheduler.runNow('test');
        expect(result.windowHours).toBe(6);
    });

    // ── Telemetry (MRS31–MRS36) ───────────────────────────────────────────────

    // MRS31 — run_started event emitted
    it('MRS31: runNow emits memory.maintenance_run_started', async () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo);
        await scheduler.runNow('test');
        const started = emittedEvents.find(e => e.event === 'memory.maintenance_run_started');
        expect(started).toBeDefined();
        expect(started?.payload?.['reason']).toBe('test');
    });

    // MRS32 — run_completed event emitted
    it('MRS32: runNow emits memory.maintenance_run_completed', async () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo);
        await scheduler.runNow('test');
        const completed = emittedEvents.find(e => e.event === 'memory.maintenance_run_completed');
        expect(completed).toBeDefined();
        expect(completed?.payload?.['posture']).toBeDefined();
    });

    // MRS33 — maintenance_decision event emitted
    it('MRS33: runNow emits memory.maintenance_decision with posture and actions', async () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo);
        await scheduler.runNow('test');
        const decision = emittedEvents.find(e => e.event === 'memory.maintenance_decision');
        expect(decision).toBeDefined();
        expect(decision?.payload?.['posture']).toBeDefined();
        expect(Array.isArray(decision?.payload?.['actions'])).toBe(true);
    });

    // MRS34 — skipped run emits maintenance_run_skipped
    it('MRS34: skipped run emits memory.maintenance_run_skipped', async () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo);
        const firstPromise = scheduler.runNow('first');
        await scheduler.runNow('second');  // this one is skipped
        await firstPromise;
        const skipped = emittedEvents.find(e => e.event === 'memory.maintenance_run_skipped');
        expect(skipped).toBeDefined();
        expect(skipped?.payload?.['reason']).toBe('run_in_progress');
    });

    // MRS35 — run_completed payload includes correct fields
    it('MRS35: run_completed payload has escalationCount, recommendationCount, actionsTaken', async () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo);
        await scheduler.runNow('test');
        const completed = emittedEvents.find(e => e.event === 'memory.maintenance_run_completed');
        expect(completed?.payload?.['escalationCount']).toBeDefined();
        expect(completed?.payload?.['recommendationCount']).toBeDefined();
        expect(Array.isArray(completed?.payload?.['actionsTaken'])).toBe(true);
    });

    // MRS36 — critical posture emits maintenance_escalation event
    it('MRS36: critical posture emits memory.maintenance_escalation', async () => {
        // Build a repo that returns enough failed cycles and degraded hours to
        // trigger two escalation candidates (critical threshold = 2)
        const repo = makeRepo();
        // Override the specific analytics queries that produce escalation candidates
        (repo.countFailedCycles as ReturnType<typeof vi.fn>).mockResolvedValue(5);
        (repo.getDegradedHours as ReturnType<typeof vi.fn>).mockResolvedValue(3);
        const scheduler = new MemoryRepairSchedulerService(repo);
        const result = await scheduler.runNow('test');
        expect(result.posture).toBe('critical');
        const esc = emittedEvents.find(e => e.event === 'memory.maintenance_escalation');
        expect(esc).toBeDefined();
    });

    // ── Lifecycle (MRS37–MRS40) ───────────────────────────────────────────────

    // MRS37 — start() sets up an interval
    it('MRS37: start() establishes the periodic interval', () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo, { intervalMs: 1000 });
        scheduler.start();
        expect(vi.getTimerCount()).toBe(1);
        scheduler.stop();
    });

    // MRS38 — stop() clears the interval
    it('MRS38: stop() clears the interval', () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo, { intervalMs: 1000 });
        scheduler.start();
        scheduler.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    // MRS39 — start() is idempotent (calling twice only creates one interval)
    it('MRS39: start() is idempotent — double call does not create extra intervals', () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo, { intervalMs: 1000 });
        scheduler.start();
        scheduler.start();
        expect(vi.getTimerCount()).toBe(1);
        scheduler.stop();
    });

    // MRS40 — interval fires runNow automatically
    it('MRS40: after start(), interval tick fires runNow automatically', async () => {
        const repo = makeRepo();
        const scheduler = new MemoryRepairSchedulerService(repo, { intervalMs: 1000 });
        scheduler.start();

        // Advance timer past the interval
        vi.advanceTimersByTime(1001);
        // Allow any pending microtasks/promises to resolve
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(scheduler.getLastRun()).not.toBeNull();
        scheduler.stop();
    });
});
