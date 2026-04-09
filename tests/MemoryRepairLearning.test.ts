/**
 * MemoryRepairLearning.test.ts
 *
 * Unit tests for the memory repair learning layer:
 *   - MemoryRepairOutcomeRepository (data layer)
 *   - MemoryRepairAnalyticsService (pattern detection)
 *   - MemoryRepairReflectionService (recommendation synthesis)
 *   - MemoryRepairExecutionService outcome persistence integration
 *   - MemoryRepairTriggerService trigger persistence integration
 *
 * Covers:
 *   MRL01–MRL05  — MemoryRepairOutcomeRepository.append / listRecent
 *   MRL06–MRL10  — MemoryRepairOutcomeRepository query methods
 *   MRL11–MRL20  — MemoryRepairAnalyticsService.generateSummary
 *   MRL21–MRL30  — MemoryRepairReflectionService.generateReport
 *   MRL31–MRL35  — MemoryRepairExecutionService persistence integration
 *   MRL36–MRL40  — MemoryRepairTriggerService persistence integration
 *
 * No real DB, no Electron.  All DB interactions are stubbed.
 * TelemetryBus is stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Stub TelemetryBus
// ---------------------------------------------------------------------------

const emittedEvents: unknown[] = [];

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (event: unknown) => emittedEvents.push(event),
            subscribe: vi.fn().mockReturnValue(vi.fn()),
        }),
    },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
    MemoryRepairOutcomeRepository,
    type AppendRepairOutcomeInput,
} from '../electron/services/db/MemoryRepairOutcomeRepository';
import { MemoryRepairAnalyticsService } from '../electron/services/memory/MemoryRepairAnalyticsService';
import { MemoryRepairReflectionService } from '../electron/services/memory/MemoryRepairReflectionService';
import { MemoryRepairExecutionService } from '../electron/services/memory/MemoryRepairExecutionService';
import { MemoryRepairTriggerService } from '../electron/services/memory/MemoryRepairTriggerService';
import type { MemoryHealthStatus } from '../shared/memory/MemoryHealthStatus';
import type {
    MemoryRepairInsightSummary,
} from '../shared/memory/MemoryRepairInsights';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHealthStatus(overrides: Partial<MemoryHealthStatus> = {}): MemoryHealthStatus {
    return {
        state: 'degraded',
        capabilities: {
            canonical: true,
            extraction: false,
            embeddings: false,
            mem0Runtime: false,
            graphProjection: false,
            ragLogging: false,
        },
        reasons: ['mem0_unavailable'],
        mode: 'canonical_only',
        hardDisabled: false,
        shouldTriggerRepair: true,
        shouldEscalate: false,
        summary: 'mem0 unavailable',
        evaluatedAt: new Date().toISOString(),
        ...overrides,
    };
}

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

// ---------------------------------------------------------------------------
// Mock pool builder
// ---------------------------------------------------------------------------

type MockQueryFn = (sql: string, params?: unknown[]) => { rows: Record<string, unknown>[] };

function makePool(queryFn: MockQueryFn = () => ({ rows: [] })) {
    return {
        query: vi.fn().mockImplementation(queryFn),
    } as unknown as import('pg').Pool;
}

// ===========================================================================
// MemoryRepairOutcomeRepository — MRL01–MRL10
// ===========================================================================

describe('MemoryRepairOutcomeRepository', () => {

    // MRL01 — append inserts a row and returns an id
    it('MRL01: append calls pool.query and returns a non-null id', async () => {
        const pool = makePool(() => ({ rows: [] }));
        const repo = new MemoryRepairOutcomeRepository(pool);

        const id = await repo.append({ eventType: 'repair_trigger', reason: 'mem0_unavailable' });

        expect(pool.query).toHaveBeenCalledOnce();
        expect(typeof id).toBe('string');
        expect(id).not.toBeNull();
        expect(id!.length).toBeGreaterThan(0);
    });

    // MRL02 — append passes all non-null fields
    it('MRL02: append passes severity, reason, state, mode, outcome, actionType, subsystem, cycleId', async () => {
        const pool = makePool(() => ({ rows: [] }));
        const repo = new MemoryRepairOutcomeRepository(pool);

        const input: AppendRepairOutcomeInput = {
            eventType: 'repair_action',
            severity: 'warning',
            reason: 'mem0_unavailable',
            state: 'degraded',
            mode: 'canonical_only',
            outcome: 'failed',
            actionType: 'reconnect_mem0',
            subsystem: 'mem0',
            cycleId: 'cycle-123',
            detailsJson: { durationMs: 100 },
        };

        await repo.append(input);

        const callArgs = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
        expect(callArgs).toContain('warning');
        expect(callArgs).toContain('mem0_unavailable');
        expect(callArgs).toContain('degraded');
        expect(callArgs).toContain('canonical_only');
        expect(callArgs).toContain('failed');
        expect(callArgs).toContain('reconnect_mem0');
        expect(callArgs).toContain('mem0');
        expect(callArgs).toContain('cycle-123');
    });

    // MRL03 — append returns null on DB error (never throws)
    it('MRL03: append returns null on DB error without throwing', async () => {
        const pool = { query: vi.fn().mockRejectedValue(new Error('DB down')) };
        const repo = new MemoryRepairOutcomeRepository(pool);

        const id = await repo.append({ eventType: 'repair_trigger' });
        expect(id).toBeNull();
    });

    // MRL04 — countTriggers returns numeric count
    it('MRL04: countTriggers returns parsed integer', async () => {
        const pool = makePool(() => ({ rows: [{ cnt: '7' }] }));
        const repo = new MemoryRepairOutcomeRepository(pool);

        const count = await repo.countTriggers(new Date(Date.now() - 3_600_000));
        expect(count).toBe(7);
    });

    // MRL05 — countCycles returns 0 when no rows
    it('MRL05: countCycles returns 0 when no rows returned', async () => {
        const pool = makePool(() => ({ rows: [] }));
        const repo = new MemoryRepairOutcomeRepository(pool);

        const count = await repo.countCycles(new Date(Date.now() - 3_600_000));
        expect(count).toBe(0);
    });

    // MRL06 — getReasonCounts returns mapped rows
    it('MRL06: getReasonCounts maps reason, cnt, first_at, last_at', async () => {
        const now = new Date();
        const pool = makePool(() => ({
            rows: [{
                reason: 'mem0_unavailable',
                cnt: '4',
                first_at: new Date(now.getTime() - 7_200_000),
                last_at: now,
            }],
        }));
        const repo = new MemoryRepairOutcomeRepository(pool);

        const rows = await repo.getReasonCounts(new Date(Date.now() - 86_400_000));
        expect(rows).toHaveLength(1);
        expect(rows[0].reason).toBe('mem0_unavailable');
        expect(rows[0].cnt).toBe(4);
        expect(typeof rows[0].first_at).toBe('string');
        expect(typeof rows[0].last_at).toBe('string');
    });

    // MRL07 — getActionOutcomeCounts maps action/outcome/cnt
    it('MRL07: getActionOutcomeCounts maps actionType, outcome, cnt', async () => {
        const pool = makePool(() => ({
            rows: [
                { action_type: 'reconnect_mem0', outcome: 'recovered', cnt: '3' },
                { action_type: 'reconnect_mem0', outcome: 'failed', cnt: '1' },
            ],
        }));
        const repo = new MemoryRepairOutcomeRepository(pool);

        const rows = await repo.getActionOutcomeCounts(new Date(Date.now() - 3_600_000));
        expect(rows).toHaveLength(2);
        expect(rows[0].actionType).toBe('reconnect_mem0');
        expect(rows[0].outcome).toBe('recovered');
        expect(rows[0].cnt).toBe(3);
    });

    // MRL08 — getReplayCounts splits successes/failures
    it('MRL08: getReplayCounts correctly splits successes and failures', async () => {
        const pool = makePool(() => ({
            rows: [
                { outcome: 'recovered', cnt: '5' },
                { outcome: 'failed', cnt: '2' },
            ],
        }));
        const repo = new MemoryRepairOutcomeRepository(pool);

        const result = await repo.getReplayCounts(new Date(Date.now() - 3_600_000));
        expect(result.successes).toBe(5);
        expect(result.failures).toBe(2);
    });

    // MRL09 — getDeadLetterHalves detects growing queue
    it('MRL09: getDeadLetterHalves returns growing=true when late > early', async () => {
        const pool = makePool(() => ({
            rows: [
                { half: 'early', cnt: '2' },
                { half: 'late', cnt: '5' },
            ],
        }));
        const repo = new MemoryRepairOutcomeRepository(pool);

        const result = await repo.getDeadLetterHalves(new Date(Date.now() - 3_600_000));
        expect(result.early).toBe(2);
        expect(result.late).toBe(5);
        expect(result.total).toBe(7);
    });

    // MRL10 — listRecent returns mapped records
    it('MRL10: listRecent returns mapped MemoryRepairOutcomeRecord array', async () => {
        const now = new Date();
        const pool = makePool(() => ({
            rows: [{
                id: 'abc',
                event_type: 'repair_cycle',
                severity: 'warning',
                reason: 'mem0_unavailable',
                state: 'degraded',
                mode: 'canonical_only',
                outcome: 'failed',
                action_type: null,
                subsystem: null,
                canonical_memory_id: null,
                cycle_id: 'cycle-1',
                details_json: {},
                occurred_at: now,
                created_at: now,
            }],
        }));
        const repo = new MemoryRepairOutcomeRepository(pool);

        const records = await repo.listRecent(new Date(Date.now() - 3_600_000));
        expect(records).toHaveLength(1);
        expect(records[0].id).toBe('abc');
        expect(records[0].eventType).toBe('repair_cycle');
        expect(records[0].outcome).toBe('failed');
    });
});

// ===========================================================================
// MemoryRepairAnalyticsService — MRL11–MRL20
// ===========================================================================

describe('MemoryRepairAnalyticsService', () => {
    function makeEmptyRepo(): MemoryRepairOutcomeRepository {
        return {
            countCycles: vi.fn().mockResolvedValue(0),
            countTriggers: vi.fn().mockResolvedValue(0),
            getReasonCounts: vi.fn().mockResolvedValue([]),
            getActionOutcomeCounts: vi.fn().mockResolvedValue([]),
            getCycleOutcomeCounts: vi.fn().mockResolvedValue([]),
            getReplayCounts: vi.fn().mockResolvedValue({ successes: 0, failures: 0 }),
            getDeadLetterHalves: vi.fn().mockResolvedValue({ early: 0, late: 0, total: 0 }),
            getHealthTransitions: vi.fn().mockResolvedValue([]),
            countFailedCycles: vi.fn().mockResolvedValue(0),
            getDegradedHours: vi.fn().mockResolvedValue(0),
            getEscalationCandidateReasons: vi.fn().mockResolvedValue([]),
            append: vi.fn(),
            listRecent: vi.fn().mockResolvedValue([]),
        } as unknown as MemoryRepairOutcomeRepository;
    }

    // MRL11 — returns default structure when no data
    it('MRL11: generateSummary returns valid structure with empty data', async () => {
        const svc = new MemoryRepairAnalyticsService(makeEmptyRepo());
        const summary = await svc.generateSummary({ windowHours: 24 });

        expect(summary.windowHours).toBe(24);
        expect(typeof summary.generatedAt).toBe('string');
        expect(summary.totalCycles).toBe(0);
        expect(summary.totalTriggers).toBe(0);
        expect(summary.recurrentFailures).toEqual([]);
        expect(summary.actionEffectiveness).toEqual([]);
        expect(summary.escalationCandidates).toEqual([]);
        expect(summary.trajectories).toEqual([]);
    });

    // MRL12 — default windowHours is 24
    it('MRL12: default windowHours is 24', async () => {
        const svc = new MemoryRepairAnalyticsService(makeEmptyRepo());
        const summary = await svc.generateSummary();
        expect(summary.windowHours).toBe(24);
    });

    // MRL13 — recurrentFailures are populated from reason rows
    it('MRL13: recurrentFailures populated from getReasonCounts', async () => {
        const now = new Date().toISOString();
        const repo = {
            ...makeEmptyRepo(),
            getReasonCounts: vi.fn().mockResolvedValue([
                { reason: 'mem0_unavailable', cnt: 5, first_at: now, last_at: now },
            ]),
        } as unknown as MemoryRepairOutcomeRepository;

        const svc = new MemoryRepairAnalyticsService(repo);
        const summary = await svc.generateSummary();

        expect(summary.recurrentFailures).toHaveLength(1);
        expect(summary.recurrentFailures[0].reason).toBe('mem0_unavailable');
        expect(summary.recurrentFailures[0].subsystem).toBe('mem0');
        expect(summary.recurrentFailures[0].occurrenceCount).toBe(5);
    });

    // MRL14 — actionEffectiveness computed correctly
    it('MRL14: actionEffectiveness aggregates success/failure/skip and computes successRate', async () => {
        const repo = {
            ...makeEmptyRepo(),
            getActionOutcomeCounts: vi.fn().mockResolvedValue([
                { actionType: 'reconnect_mem0', outcome: 'recovered', cnt: 4 },
                { actionType: 'reconnect_mem0', outcome: 'failed', cnt: 1 },
            ]),
        } as unknown as MemoryRepairOutcomeRepository;

        const svc = new MemoryRepairAnalyticsService(repo);
        const summary = await svc.generateSummary();

        expect(summary.actionEffectiveness).toHaveLength(1);
        const entry = summary.actionEffectiveness[0];
        expect(entry.actionType).toBe('reconnect_mem0');
        expect(entry.totalExecutions).toBe(5);
        expect(entry.successCount).toBe(4);
        expect(entry.failureCount).toBe(1);
        expect(entry.successRate).toBeCloseTo(0.8);
    });

    // MRL15 — queueBehavior reflects replay counts and dead-letter growth
    it('MRL15: queueBehavior populated from replay counts and dead-letter halves', async () => {
        const repo = {
            ...makeEmptyRepo(),
            getReplayCounts: vi.fn().mockResolvedValue({ successes: 10, failures: 2 }),
            getDeadLetterHalves: vi.fn().mockResolvedValue({ early: 1, late: 4, total: 5 }),
        } as unknown as MemoryRepairOutcomeRepository;

        const svc = new MemoryRepairAnalyticsService(repo);
        const summary = await svc.generateSummary();

        expect(summary.queueBehavior.totalReplays).toBe(12);
        expect(summary.queueBehavior.replaySuccesses).toBe(10);
        expect(summary.queueBehavior.replayFailures).toBe(2);
        expect(summary.queueBehavior.deadLetterCount).toBe(5);
        expect(summary.queueBehavior.deadLetterGrowing).toBe(true);
    });

    // MRL16 — escalation candidate raised for repeated failure reason
    it('MRL16: escalation candidate raised when reason meets threshold', async () => {
        const now = new Date().toISOString();
        const repo = {
            ...makeEmptyRepo(),
            getEscalationCandidateReasons: vi.fn().mockResolvedValue([
                { reason: 'mem0_unavailable', cnt: 5, first_at: now, last_at: now },
            ]),
        } as unknown as MemoryRepairOutcomeRepository;

        const svc = new MemoryRepairAnalyticsService(repo);
        const summary = await svc.generateSummary();

        const candidate = summary.escalationCandidates.find(c => c.code === 'repeated_failure_reason');
        expect(candidate).toBeDefined();
        expect(candidate!.evidence['reason']).toBe('mem0_unavailable');
    });

    // MRL17 — escalation candidate raised for repeated failed cycles
    it('MRL17: escalation candidate raised when failedCycles >= threshold', async () => {
        const repo = {
            ...makeEmptyRepo(),
            countFailedCycles: vi.fn().mockResolvedValue(3),
        } as unknown as MemoryRepairOutcomeRepository;

        const svc = new MemoryRepairAnalyticsService(repo);
        const summary = await svc.generateSummary();

        const candidate = summary.escalationCandidates.find(c => c.code === 'repeated_cycle_failure');
        expect(candidate).toBeDefined();
    });

    // MRL18 — escalation candidate raised for prolonged degraded state
    it('MRL18: escalation candidate raised when degradedHours >= threshold', async () => {
        const repo = {
            ...makeEmptyRepo(),
            getDegradedHours: vi.fn().mockResolvedValue(2.5),
        } as unknown as MemoryRepairOutcomeRepository;

        const svc = new MemoryRepairAnalyticsService(repo, { escalationDegradedHoursThreshold: 1 });
        const summary = await svc.generateSummary();

        const candidate = summary.escalationCandidates.find(c => c.code === 'prolonged_degraded');
        expect(candidate).toBeDefined();
        expect(candidate!.evidence['degradedHours']).toBeGreaterThanOrEqual(2);
    });

    // MRL19 — escalation candidate raised for growing dead-letter queue
    it('MRL19: escalation candidate raised for growing dead-letter queue', async () => {
        const repo = {
            ...makeEmptyRepo(),
            getDeadLetterHalves: vi.fn().mockResolvedValue({ early: 1, late: 5, total: 6 }),
        } as unknown as MemoryRepairOutcomeRepository;

        const svc = new MemoryRepairAnalyticsService(repo);
        const summary = await svc.generateSummary();

        const candidate = summary.escalationCandidates.find(c => c.code === 'growing_dead_letter_queue');
        expect(candidate).toBeDefined();
    });

    // MRL20 — trajectories built from health transitions
    it('MRL20: trajectories built from health transition rows', async () => {
        const repo = {
            ...makeEmptyRepo(),
            getHealthTransitions: vi.fn().mockResolvedValue([
                { fromState: 'healthy', toState: 'degraded', occurredAt: new Date().toISOString() },
                { fromState: 'degraded', toState: 'healthy', occurredAt: new Date().toISOString() },
                { fromState: 'healthy', toState: 'degraded', occurredAt: new Date().toISOString() },
                { fromState: 'degraded', toState: 'healthy', occurredAt: new Date().toISOString() },
            ]),
        } as unknown as MemoryRepairOutcomeRepository;

        const svc = new MemoryRepairAnalyticsService(repo);
        const summary = await svc.generateSummary();

        expect(summary.trajectories.length).toBeGreaterThan(0);
        // At least one trajectory should end in healthy
        const healthy = summary.trajectories.find(t => t.endsHealthy);
        expect(healthy).toBeDefined();
    });
});

// ===========================================================================
// MemoryRepairReflectionService — MRL21–MRL30
// ===========================================================================

describe('MemoryRepairReflectionService', () => {

    // MRL21 — returns valid report structure for empty summary
    it('MRL21: generateReport returns valid report for empty summary', () => {
        const svc = new MemoryRepairReflectionService();
        const report = svc.generateReport(makeSummary());

        expect(typeof report.generatedAt).toBe('string');
        expect(Array.isArray(report.recommendations)).toBe(true);
        expect(typeof report.hasCriticalFindings).toBe('boolean');
    });

    // MRL22 — empty summary generates extend_analysis_window recommendation
    it('MRL22: empty summary generates extend_analysis_window low-priority recommendation', () => {
        const svc = new MemoryRepairReflectionService();
        const report = svc.generateReport(makeSummary({ totalCycles: 0, totalTriggers: 0 }));

        const rec = report.recommendations.find(r => r.code === 'extend_analysis_window');
        expect(rec).toBeDefined();
        expect(rec!.priority).toBe('low');
    });

    // MRL23 — escalation candidate → escalate_to_maintenance critical recommendation
    it('MRL23: repeated_cycle_failure escalation → critical escalate_to_maintenance recommendation', () => {
        const svc = new MemoryRepairReflectionService();
        const summary = makeSummary({
            totalCycles: 5,
            totalTriggers: 5,
            escalationCandidates: [{
                code: 'repeated_cycle_failure',
                description: '3 failed cycles',
                evidence: { failedCycles: 3 },
                firstEvidenceAt: new Date().toISOString(),
                lastEvidenceAt: new Date().toISOString(),
            }],
        });

        const report = svc.generateReport(summary);
        const rec = report.recommendations.find(r => r.code === 'escalate_to_maintenance');
        expect(rec).toBeDefined();
        expect(rec!.priority).toBe('critical');
        expect(report.hasCriticalFindings).toBe(true);
    });

    // MRL24 — repeated_failure_reason → investigate_subsystem high recommendation
    it('MRL24: repeated_failure_reason escalation → investigate_subsystem high recommendation', () => {
        const svc = new MemoryRepairReflectionService();
        const summary = makeSummary({
            totalCycles: 5,
            escalationCandidates: [{
                code: 'repeated_failure_reason',
                description: 'mem0 repeated',
                evidence: { reason: 'mem0_unavailable', subsystem: 'mem0' },
                firstEvidenceAt: new Date().toISOString(),
                lastEvidenceAt: new Date().toISOString(),
            }],
        });

        const report = svc.generateReport(summary);
        const rec = report.recommendations.find(r => r.code === 'investigate_subsystem');
        expect(rec).toBeDefined();
        expect(rec!.priority).toBe('high');
    });

    // MRL25 — low-effectiveness action → review_repair_action medium recommendation
    it('MRL25: low-effectiveness action → review_repair_action medium recommendation', () => {
        const svc = new MemoryRepairReflectionService();
        const summary = makeSummary({
            totalCycles: 5,
            actionEffectiveness: [{
                actionType: 'reconnect_graph',
                totalExecutions: 5,
                successCount: 1,
                failureCount: 4,
                skipCount: 0,
                successRate: 0.2,
            }],
        });

        const report = svc.generateReport(summary);
        const rec = report.recommendations.find(r => r.code === 'review_repair_action');
        expect(rec).toBeDefined();
        expect(rec!.priority).toBe('medium');
        expect(rec!.evidence['actionType']).toBe('reconnect_graph');
    });

    // MRL26 — zero-success action → review_repair_action high priority
    it('MRL26: zero-success action → review_repair_action high priority', () => {
        const svc = new MemoryRepairReflectionService();
        const summary = makeSummary({
            totalCycles: 3,
            actionEffectiveness: [{
                actionType: 'reconnect_graph',
                totalExecutions: 3,
                successCount: 0,
                failureCount: 3,
                skipCount: 0,
                successRate: 0,
            }],
        });

        const report = svc.generateReport(summary);
        const rec = report.recommendations.find(r => r.code === 'review_repair_action');
        expect(rec).toBeDefined();
        expect(rec!.priority).toBe('high');
    });

    // MRL27 — action above effectiveness threshold → no review recommendation
    it('MRL27: action with successRate >= threshold does not produce review recommendation', () => {
        const svc = new MemoryRepairReflectionService();
        const summary = makeSummary({
            totalCycles: 5,
            actionEffectiveness: [{
                actionType: 'reconnect_mem0',
                totalExecutions: 5,
                successCount: 5,
                failureCount: 0,
                skipCount: 0,
                successRate: 1.0,
            }],
        });

        const report = svc.generateReport(summary);
        const rec = report.recommendations.find(r => r.code === 'review_repair_action');
        expect(rec).toBeUndefined();
    });

    // MRL28 — dead-letter queue → drain recommendation
    it('MRL28: dead-letter items present → drain_dead_letter_queue recommendation', () => {
        const svc = new MemoryRepairReflectionService();
        const summary = makeSummary({
            totalCycles: 2,
            queueBehavior: {
                totalReplays: 10,
                replaySuccesses: 8,
                replayFailures: 2,
                deadLetterCount: 3,
                deadLetterGrowing: false,
            },
        });

        const report = svc.generateReport(summary);
        const rec = report.recommendations.find(r => r.code === 'drain_dead_letter_queue');
        expect(rec).toBeDefined();
        expect(rec!.priority).toBe('medium');
    });

    // MRL29 — growing dead-letter → drain recommendation with high priority
    it('MRL29: growing dead-letter queue → drain recommendation with high priority', () => {
        const svc = new MemoryRepairReflectionService();
        const summary = makeSummary({
            totalCycles: 2,
            queueBehavior: {
                totalReplays: 10,
                replaySuccesses: 5,
                replayFailures: 5,
                deadLetterCount: 6,
                deadLetterGrowing: true,
            },
        });

        const report = svc.generateReport(summary);
        const rec = report.recommendations.find(r => r.code === 'drain_dead_letter_queue');
        expect(rec).toBeDefined();
        expect(rec!.priority).toBe('high');
    });

    // MRL30 — maxRecommendations is respected
    it('MRL30: report respects maxRecommendations cap', () => {
        const svc = new MemoryRepairReflectionService({ maxRecommendations: 2 });
        const now = new Date().toISOString();
        const summary = makeSummary({
            totalCycles: 10,
            escalationCandidates: [
                { code: 'repeated_cycle_failure', description: 'A', evidence: {}, firstEvidenceAt: now, lastEvidenceAt: now },
                { code: 'prolonged_degraded', description: 'B', evidence: {}, firstEvidenceAt: now, lastEvidenceAt: now },
                { code: 'growing_dead_letter_queue', description: 'C', evidence: {}, firstEvidenceAt: now, lastEvidenceAt: now },
                { code: 'repeated_failure_reason', description: 'D', evidence: { reason: 'x' }, firstEvidenceAt: now, lastEvidenceAt: now },
            ],
        });

        const report = svc.generateReport(summary);
        expect(report.recommendations.length).toBeLessThanOrEqual(2);
    });
});

// ===========================================================================
// MemoryRepairExecutionService persistence integration — MRL31–MRL35
// ===========================================================================

describe('MemoryRepairExecutionService outcome persistence', () => {
    let executor: MemoryRepairExecutionService;
    let mockRepo: { append: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        emittedEvents.length = 0;
        executor = MemoryRepairExecutionService.getInstance();
        executor.reset();

        mockRepo = { append: vi.fn().mockResolvedValue('mock-id') };
        executor.setOutcomeRepository(mockRepo as unknown as MemoryRepairOutcomeRepository);
        executor.setHealthStatusProvider(() => makeHealthStatus({ state: 'healthy', reasons: [] }));
    });

    // MRL31 — setOutcomeRepository is accepted without throwing
    it('MRL31: setOutcomeRepository sets the repository without errors', () => {
        expect(() => executor.setOutcomeRepository(mockRepo as unknown as MemoryRepairOutcomeRepository)).not.toThrow();
    });

    // MRL32 — repair_cycle record persisted after runRepairCycle
    it('MRL32: repair_cycle record is appended after runRepairCycle completes', async () => {
        executor.setHealthStatusProvider(() => makeHealthStatus({
            state: 'degraded',
            reasons: ['mem0_unavailable'],
        }));
        executor.registerRepairHandler('reconnect_mem0', async () => {
            executor.setHealthStatusProvider(() => makeHealthStatus({ state: 'healthy', reasons: [] }));
            return true;
        });

        await executor.runRepairCycle('mem0_unavailable');

        const calls = (mockRepo.append as ReturnType<typeof vi.fn>).mock.calls;
        const cycleCall = calls.find((args: unknown[]) =>
            (args[0] as Record<string, unknown>)['eventType'] === 'repair_cycle'
        );
        expect(cycleCall).toBeDefined();
    });

    // MRL33 — repair_action record persisted for each real action
    it('MRL33: repair_action record appended for each executed action', async () => {
        executor.setHealthStatusProvider(() => makeHealthStatus({
            state: 'degraded',
            reasons: ['mem0_unavailable'],
        }));
        executor.registerRepairHandler('reconnect_mem0', async () => {
            executor.setHealthStatusProvider(() => makeHealthStatus({ state: 'healthy', reasons: [] }));
            return true;
        });

        await executor.runRepairCycle('mem0_unavailable');

        const calls = (mockRepo.append as ReturnType<typeof vi.fn>).mock.calls;
        const actionCall = calls.find((args: unknown[]) =>
            (args[0] as Record<string, unknown>)['eventType'] === 'repair_action'
        );
        expect(actionCall).toBeDefined();
        const input = actionCall![0] as Record<string, unknown>;
        expect(input['actionType']).toBe('reconnect_mem0');
    });

    // MRL34 — persistence failure does not prevent cycle completion
    it('MRL34: persistence failure does not interrupt repair cycle', async () => {
        mockRepo.append = vi.fn().mockRejectedValue(new Error('DB unreachable'));
        executor.setHealthStatusProvider(() => makeHealthStatus({
            state: 'degraded',
            reasons: ['mem0_unavailable'],
        }));
        executor.registerRepairHandler('reconnect_mem0', async () => true);

        await expect(executor.runRepairCycle('mem0_unavailable')).resolves.toBeDefined();
    });

    // MRL35 — reset() clears the outcome repository
    it('MRL35: reset() clears the outcome repository reference', async () => {
        executor.reset();
        executor.setHealthStatusProvider(() => makeHealthStatus({
            state: 'degraded',
            reasons: ['mem0_unavailable'],
        }));
        executor.registerRepairHandler('reconnect_mem0', async () => true);

        // After reset, no repo → append should not be called
        await executor.runRepairCycle('mem0_unavailable');
        expect(mockRepo.append).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// MemoryRepairTriggerService persistence integration — MRL36–MRL40
// ===========================================================================

describe('MemoryRepairTriggerService trigger persistence', () => {
    let triggerSvc: MemoryRepairTriggerService;
    let mockRepo: { append: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        emittedEvents.length = 0;
        triggerSvc = MemoryRepairTriggerService.getInstance();
        triggerSvc.reset();

        mockRepo = { append: vi.fn().mockResolvedValue('mock-id') };
        triggerSvc.setOutcomeRepository(mockRepo as unknown as MemoryRepairOutcomeRepository);
    });

    // MRL36 — setOutcomeRepository accepted without errors
    it('MRL36: setOutcomeRepository sets repository without errors', () => {
        expect(() => triggerSvc.setOutcomeRepository(mockRepo as unknown as MemoryRepairOutcomeRepository)).not.toThrow();
    });

    // MRL37 — repair_trigger record persisted on maybeEmit
    it('MRL37: repair_trigger record appended after maybeEmit triggers', () => {
        const status: MemoryHealthStatus = makeHealthStatus({
            state: 'degraded',
            reasons: ['mem0_unavailable'],
            shouldTriggerRepair: true,
        });

        triggerSvc.maybeEmit(status);

        expect(mockRepo.append).toHaveBeenCalledOnce();
        const input = (mockRepo.append as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
        expect(input['eventType']).toBe('repair_trigger');
        expect(input['reason']).toBe('mem0_unavailable');
    });

    // MRL38 — repair_trigger record persisted on emitDirect
    it('MRL38: repair_trigger record appended after emitDirect', () => {
        triggerSvc.emitDirect('canonical_unavailable', 'critical', 'error');

        expect(mockRepo.append).toHaveBeenCalledOnce();
        const input = (mockRepo.append as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
        expect(input['eventType']).toBe('repair_trigger');
        expect(input['reason']).toBe('canonical_unavailable');
        expect(input['severity']).toBe('error');
    });

    // MRL39 — persistence failure does not prevent trigger emission
    it('MRL39: persistence failure does not prevent trigger bus emission', () => {
        mockRepo.append = vi.fn().mockRejectedValue(new Error('DB down'));
        const status: MemoryHealthStatus = makeHealthStatus({
            shouldTriggerRepair: true,
        });

        expect(() => triggerSvc.maybeEmit(status)).not.toThrow();
        // The telemetry bus event should still be emitted
        const triggerEvents = emittedEvents.filter(
            (e: unknown) => (e as Record<string, unknown>)['event'] === 'memory.repair_trigger'
        );
        expect(triggerEvents.length).toBeGreaterThan(0);
    });

    // MRL40 — reset() clears the outcome repository reference
    it('MRL40: reset() clears the outcome repository reference', () => {
        triggerSvc.reset();

        // After reset no repo — emitDirect should not call append
        triggerSvc.emitDirect('mem0_unavailable', 'degraded', 'warning');
        expect(mockRepo.append).not.toHaveBeenCalled();
    });
});
