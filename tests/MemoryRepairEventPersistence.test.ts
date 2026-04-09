/**
 * MemoryRepairEventPersistence.test.ts
 *
 * Focused tests for the memory repair evidence persistence layer:
 *   - TelemetryBus event → MemoryRepairOutcomeRepository.append() wiring
 *   - DeferredMemoryReplayService dead-letter event emission
 *   - MemoryRepairAnalyticsService consuming persisted evidence
 *
 * Covers:
 *   MREP-01  — memory.health_transition persisted as eventType='health_transition'
 *   MREP-02  — memory.deferred_work_drain_started persisted as eventType='deferred_replay'
 *   MREP-03  — memory.deferred_work_drain_completed persisted with summary counts
 *   MREP-04  — memory.deferred_work_item_failed persisted
 *   MREP-05  — memory.deferred_dead_lettered persisted as eventType='dead_letter'
 *   MREP-06  — Persistence failures do not throw into the caller path
 *   MREP-07  — Analytics uses persisted health transitions in trajectory analysis
 *   MREP-08  — Analytics uses persisted dead-letter events in backlog summaries
 *   MREP-09  — Only emitted transition events are stored (not stable health evaluations)
 *   MREP-10  — All persisted event rows survive repository round-trip and are queryable
 *
 * No real DB, no Electron. All DB interactions are stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Stub TelemetryBus — capture emitted events AND expose subscribe/unsubscribe
// ---------------------------------------------------------------------------

type BusHandler = (event: Record<string, unknown>) => void;
const busHandlers: BusHandler[] = [];
const emittedEvents: unknown[] = [];

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (event: unknown) => {
                emittedEvents.push(event);
                // Deliver to all subscribers synchronously (matching real bus behaviour)
                for (const h of busHandlers) {
                    try { h(event as Record<string, unknown>); } catch { /* ignore */ }
                }
            },
            subscribe: (handler: BusHandler) => {
                busHandlers.push(handler);
                return () => {
                    const idx = busHandlers.indexOf(handler);
                    if (idx !== -1) busHandlers.splice(idx, 1);
                };
            },
            unsubscribe: (handler: BusHandler) => {
                const idx = busHandlers.indexOf(handler);
                if (idx !== -1) busHandlers.splice(idx, 1);
            },
        }),
    },
}));

// ---------------------------------------------------------------------------
// Imports (after mock registrations)
// ---------------------------------------------------------------------------

import {
    MemoryRepairOutcomeRepository,
} from '../electron/services/db/MemoryRepairOutcomeRepository';
import { MemoryRepairAnalyticsService } from '../electron/services/memory/MemoryRepairAnalyticsService';
import { DeferredMemoryReplayService } from '../electron/services/memory/DeferredMemoryReplayService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { MemoryHealthStatus } from '../shared/memory/MemoryHealthStatus';
import type { DeferredMemoryWorkItem } from '../electron/services/db/DeferredMemoryWorkRepository';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockQueryFn = (sql: string, params?: unknown[]) => { rows: Record<string, unknown>[] };

function makePool(queryFn: MockQueryFn = () => ({ rows: [] })) {
    return {
        query: vi.fn().mockImplementation(queryFn),
    } as unknown as import('pg').Pool;
}

/** Build a minimal MemoryHealthStatus. */
function makeHealthStatus(overrides: Partial<MemoryHealthStatus> = {}): MemoryHealthStatus {
    return {
        state: 'healthy',
        mode: 'full',
        hardDisabled: false,
        shouldTriggerRepair: false,
        reasons: [],
        capabilities: {
            canonical: true,
            mem0: true,
            extraction: true,
            embeddings: true,
            graphProjection: true,
            ragLogging: true,
        },
        evaluatedAt: new Date().toISOString(),
        ...overrides,
    };
}

/** Build a minimal DeferredMemoryWorkItem for tests. */
function makeDeferredItem(overrides: Partial<DeferredMemoryWorkItem> = {}): DeferredMemoryWorkItem {
    const now = new Date().toISOString();
    return {
        id: 'item-abc',
        kind: 'extraction',
        status: 'in_progress',
        canonicalMemoryId: 'canon-123',
        sessionId: null,
        turnId: null,
        payload: {},
        attemptCount: 0,
        maxAttempts: 3,
        lastError: null,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        deadLetteredAt: null,
        ...overrides,
    };
}

/**
 * Build a subscriber-based persistence bridge (mirrors AgentService wiring)
 * and returns a reference to the outcomeRepo mock.
 */
function buildPersistenceBridge(appendFn?: ReturnType<typeof vi.fn>) {
    const append = appendFn ?? vi.fn().mockResolvedValue('mock-id');
    const outcomeRepo = { append } as unknown as MemoryRepairOutcomeRepository;

    const bus = TelemetryBus.getInstance();

    bus.subscribe((evt: Record<string, unknown>) => {
        if (evt['event'] === 'memory.health_transition') {
            const p = (evt['payload'] as Record<string, unknown>) ?? {};
            outcomeRepo.append({
                eventType: 'health_transition',
                state: (p['toState'] as string | undefined) ?? null,
                mode: (p['toMode'] as string | undefined) ?? null,
                reason: Array.isArray(p['reasons']) && p['reasons'].length > 0
                    ? String(p['reasons'][0])
                    : null,
                detailsJson: p,
                occurredAt: (p['at'] as string | undefined) ?? (evt['timestamp'] as string),
            }).catch(() => { /* non-blocking */ });
            return;
        }

        if (evt['event'] === 'memory.deferred_work_drain_started') {
            const p = (evt['payload'] as Record<string, unknown>) ?? {};
            outcomeRepo.append({
                eventType: 'deferred_replay',
                subsystem: Array.isArray(p['eligibleKinds']) && p['eligibleKinds'].length === 1
                    ? String(p['eligibleKinds'][0])
                    : null,
                detailsJson: { phase: 'started', ...p },
                occurredAt: evt['timestamp'] as string,
            }).catch(() => { /* non-blocking */ });
            return;
        }

        if (evt['event'] === 'memory.deferred_work_drain_completed') {
            const p = (evt['payload'] as Record<string, unknown>) ?? {};
            const completed = (p['completed'] as number | undefined) ?? 0;
            const failed = (p['failed'] as number | undefined) ?? 0;
            const outcome = failed === 0 && completed > 0
                ? 'recovered'
                : failed > 0 && completed > 0
                    ? 'partial'
                    : failed > 0
                        ? 'failed'
                        : 'skipped';
            outcomeRepo.append({
                eventType: 'deferred_replay',
                outcome,
                subsystem: Array.isArray(p['eligibleKinds']) && p['eligibleKinds'].length === 1
                    ? String(p['eligibleKinds'][0])
                    : null,
                detailsJson: { phase: 'completed', ...p },
                occurredAt: evt['timestamp'] as string,
            }).catch(() => { /* non-blocking */ });
            return;
        }

        if (evt['event'] === 'memory.deferred_work_item_failed') {
            const p = (evt['payload'] as Record<string, unknown>) ?? {};
            outcomeRepo.append({
                eventType: 'deferred_replay',
                outcome: 'failed',
                subsystem: (p['kind'] as string | undefined) ?? null,
                canonicalMemoryId: (p['canonicalMemoryId'] as string | undefined) ?? null,
                detailsJson: { phase: 'item_failed', ...p },
                occurredAt: evt['timestamp'] as string,
            }).catch(() => { /* non-blocking */ });
            return;
        }

        if (evt['event'] === 'memory.deferred_dead_lettered') {
            const p = (evt['payload'] as Record<string, unknown>) ?? {};
            outcomeRepo.append({
                eventType: 'dead_letter',
                subsystem: (p['kind'] as string | undefined) ?? null,
                canonicalMemoryId: (p['canonicalMemoryId'] as string | undefined) ?? null,
                reason: (p['error'] as string | undefined) ?? null,
                detailsJson: p,
                occurredAt: evt['timestamp'] as string,
            }).catch(() => { /* non-blocking */ });
            return;
        }
    });

    return { outcomeRepo, append };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    emittedEvents.length = 0;
    busHandlers.length = 0;
    DeferredMemoryReplayService.getInstance().reset();
    vi.clearAllMocks();
});

// ===========================================================================
// MREP-01: memory.health_transition → persisted as health_transition
// ===========================================================================

describe('MREP-01: health_transition event persistence', () => {
    it('persists memory.health_transition as eventType=health_transition', async () => {
        const { append } = buildPersistenceBridge();

        TelemetryBus.getInstance().emit({
            event: 'memory.health_transition',
            subsystem: 'memory',
            executionId: 'memory-health',
            timestamp: '2024-01-01T00:00:00.000Z',
            payload: {
                fromState: 'healthy',
                toState: 'degraded',
                fromMode: 'full',
                toMode: 'reduced',
                reasons: ['mem0_unavailable'],
                at: '2024-01-01T00:00:00.000Z',
            },
        } as any);

        // Allow microtask queue to flush
        await Promise.resolve();

        expect(append).toHaveBeenCalledOnce();
        const input = append.mock.calls[0][0] as Record<string, unknown>;
        expect(input['eventType']).toBe('health_transition');
        expect(input['state']).toBe('degraded');
        expect(input['mode']).toBe('reduced');
        expect(input['reason']).toBe('mem0_unavailable');
        expect((input['detailsJson'] as Record<string, unknown>)['fromState']).toBe('healthy');
    });

    it('extracts toState and toMode from payload', async () => {
        const { append } = buildPersistenceBridge();

        TelemetryBus.getInstance().emit({
            event: 'memory.health_transition',
            subsystem: 'memory',
            executionId: 'memory-health',
            timestamp: new Date().toISOString(),
            payload: {
                fromState: 'degraded',
                toState: 'healthy',
                fromMode: 'reduced',
                toMode: 'full',
                reasons: [],
                at: new Date().toISOString(),
            },
        } as any);

        await Promise.resolve();

        expect(append).toHaveBeenCalledOnce();
        const input = append.mock.calls[0][0] as Record<string, unknown>;
        expect(input['state']).toBe('healthy');
        expect(input['mode']).toBe('full');
        expect(input['reason']).toBeNull();
    });
});

// ===========================================================================
// MREP-02: memory.deferred_work_drain_started → persisted as deferred_replay
// ===========================================================================

describe('MREP-02: deferred_replay_started event persistence', () => {
    it('persists drain_started as eventType=deferred_replay', async () => {
        const { append } = buildPersistenceBridge();

        TelemetryBus.getInstance().emit({
            event: 'memory.deferred_work_drain_started',
            subsystem: 'memory',
            executionId: 'deferred-work',
            timestamp: new Date().toISOString(),
            payload: {
                eligibleKinds: ['extraction'],
                batchSize: 25,
                healthState: 'healthy',
            },
        } as any);

        await Promise.resolve();

        expect(append).toHaveBeenCalledOnce();
        const input = append.mock.calls[0][0] as Record<string, unknown>;
        expect(input['eventType']).toBe('deferred_replay');
        expect(input['subsystem']).toBe('extraction');
        expect((input['detailsJson'] as Record<string, unknown>)['phase']).toBe('started');
        expect((input['detailsJson'] as Record<string, unknown>)['batchSize']).toBe(25);
    });
});

// ===========================================================================
// MREP-03: memory.deferred_work_drain_completed → persisted with summary counts
// ===========================================================================

describe('MREP-03: deferred_replay_completed event persistence', () => {
    it('persists drain_completed with outcome=recovered when all succeeded', async () => {
        const { append } = buildPersistenceBridge();

        TelemetryBus.getInstance().emit({
            event: 'memory.deferred_work_drain_completed',
            subsystem: 'memory',
            executionId: 'deferred-work',
            timestamp: new Date().toISOString(),
            payload: {
                eligibleKinds: ['embedding'],
                completed: 5,
                failed: 0,
                healthState: 'healthy',
            },
        } as any);

        await Promise.resolve();

        expect(append).toHaveBeenCalledOnce();
        const input = append.mock.calls[0][0] as Record<string, unknown>;
        expect(input['eventType']).toBe('deferred_replay');
        expect(input['outcome']).toBe('recovered');
        expect((input['detailsJson'] as Record<string, unknown>)['phase']).toBe('completed');
        expect((input['detailsJson'] as Record<string, unknown>)['completed']).toBe(5);
    });

    it('persists drain_completed with outcome=partial when some failed', async () => {
        const { append } = buildPersistenceBridge();

        TelemetryBus.getInstance().emit({
            event: 'memory.deferred_work_drain_completed',
            subsystem: 'memory',
            executionId: 'deferred-work',
            timestamp: new Date().toISOString(),
            payload: { eligibleKinds: [], completed: 3, failed: 2, healthState: 'degraded' },
        } as any);

        await Promise.resolve();

        const input = append.mock.calls[0][0] as Record<string, unknown>;
        expect(input['outcome']).toBe('partial');
    });

    it('persists drain_completed with outcome=failed when all failed', async () => {
        const { append } = buildPersistenceBridge();

        TelemetryBus.getInstance().emit({
            event: 'memory.deferred_work_drain_completed',
            subsystem: 'memory',
            executionId: 'deferred-work',
            timestamp: new Date().toISOString(),
            payload: { eligibleKinds: [], completed: 0, failed: 3, healthState: 'degraded' },
        } as any);

        await Promise.resolve();

        const input = append.mock.calls[0][0] as Record<string, unknown>;
        expect(input['outcome']).toBe('failed');
    });

    it('persists drain_completed with outcome=skipped when nothing processed', async () => {
        const { append } = buildPersistenceBridge();

        TelemetryBus.getInstance().emit({
            event: 'memory.deferred_work_drain_completed',
            subsystem: 'memory',
            executionId: 'deferred-work',
            timestamp: new Date().toISOString(),
            payload: { eligibleKinds: [], completed: 0, failed: 0, healthState: 'healthy' },
        } as any);

        await Promise.resolve();

        const input = append.mock.calls[0][0] as Record<string, unknown>;
        expect(input['outcome']).toBe('skipped');
    });
});

// ===========================================================================
// MREP-04: memory.deferred_work_item_failed → persisted as deferred_replay
// ===========================================================================

describe('MREP-04: deferred_replay_item_failed event persistence', () => {
    it('persists item_failed event as eventType=deferred_replay with phase=item_failed', async () => {
        const { append } = buildPersistenceBridge();

        TelemetryBus.getInstance().emit({
            event: 'memory.deferred_work_item_failed',
            subsystem: 'memory',
            executionId: 'deferred-work',
            timestamp: new Date().toISOString(),
            payload: {
                id: 'item-xyz',
                kind: 'graph_projection',
                canonicalMemoryId: 'canon-456',
                attemptCount: 2,
                maxAttempts: 3,
                error: 'handler_returned_false',
            },
        } as any);

        await Promise.resolve();

        expect(append).toHaveBeenCalledOnce();
        const input = append.mock.calls[0][0] as Record<string, unknown>;
        expect(input['eventType']).toBe('deferred_replay');
        expect(input['outcome']).toBe('failed');
        expect(input['subsystem']).toBe('graph_projection');
        expect(input['canonicalMemoryId']).toBe('canon-456');
        expect((input['detailsJson'] as Record<string, unknown>)['phase']).toBe('item_failed');
        expect((input['detailsJson'] as Record<string, unknown>)['error']).toBe('handler_returned_false');
    });
});

// ===========================================================================
// MREP-05: memory.deferred_dead_lettered → persisted as dead_letter
// ===========================================================================

describe('MREP-05: dead_letter event persistence', () => {
    it('persists dead_lettered event as eventType=dead_letter', async () => {
        const { append } = buildPersistenceBridge();

        TelemetryBus.getInstance().emit({
            event: 'memory.deferred_dead_lettered',
            subsystem: 'memory',
            executionId: 'deferred-work',
            timestamp: new Date().toISOString(),
            payload: {
                id: 'item-dl',
                kind: 'embedding',
                canonicalMemoryId: 'canon-789',
                attemptCount: 3,
                error: 'handler_returned_false',
            },
        } as any);

        await Promise.resolve();

        expect(append).toHaveBeenCalledOnce();
        const input = append.mock.calls[0][0] as Record<string, unknown>;
        expect(input['eventType']).toBe('dead_letter');
        expect(input['subsystem']).toBe('embedding');
        expect(input['canonicalMemoryId']).toBe('canon-789');
        expect(input['reason']).toBe('handler_returned_false');
    });

    it('DeferredMemoryReplayService emits memory.deferred_dead_lettered when maxAttempts exceeded', async () => {
        const replayService = DeferredMemoryReplayService.getInstance();

        // Mock repository where markFailed resolves successfully
        const mockRepo = {
            enqueue: vi.fn(),
            claimBatch: vi.fn().mockResolvedValue([]),
            markCompleted: vi.fn().mockResolvedValue(undefined),
            markFailed: vi.fn().mockResolvedValue(undefined),
            getStats: vi.fn().mockResolvedValue({ total: 0, byKind: {}, byStatus: {} }),
            countPending: vi.fn().mockResolvedValue({ extraction: 0, embedding: 0, graph_projection: 0 }),
        };

        replayService.setRepository(mockRepo as any);
        replayService.setHealthStatusProvider(() => makeHealthStatus());

        // Item is on its last attempt (attemptCount=2, maxAttempts=3 → 2+1 >= 3 → dead-letter)
        const item = makeDeferredItem({ attemptCount: 2, maxAttempts: 3 });

        // Trigger _failItem via a handler that returns false
        replayService.registerHandler('extraction', async () => false);
        mockRepo.claimBatch.mockResolvedValueOnce([item]);

        await replayService.drain();

        const deadLetterEvents = emittedEvents.filter(
            (e: unknown) => (e as Record<string, unknown>)['event'] === 'memory.deferred_dead_lettered'
        );
        expect(deadLetterEvents.length).toBe(1);

        const deadEvent = deadLetterEvents[0] as Record<string, unknown>;
        const payload = deadEvent['payload'] as Record<string, unknown>;
        expect(payload['id']).toBe('item-abc');
        expect(payload['kind']).toBe('extraction');
        expect(payload['canonicalMemoryId']).toBe('canon-123');
    });

    it('DeferredMemoryReplayService does NOT emit dead_lettered when not at maxAttempts', async () => {
        const replayService = DeferredMemoryReplayService.getInstance();

        const mockRepo = {
            enqueue: vi.fn(),
            claimBatch: vi.fn().mockResolvedValue([]),
            markCompleted: vi.fn().mockResolvedValue(undefined),
            markFailed: vi.fn().mockResolvedValue(undefined),
            getStats: vi.fn().mockResolvedValue({ total: 0, byKind: {}, byStatus: {} }),
            countPending: vi.fn().mockResolvedValue({ extraction: 0, embedding: 0, graph_projection: 0 }),
        };

        replayService.setRepository(mockRepo as any);
        replayService.setHealthStatusProvider(() => makeHealthStatus());

        // Item still has attempts remaining (attemptCount=0, maxAttempts=3)
        const item = makeDeferredItem({ attemptCount: 0, maxAttempts: 3 });

        replayService.registerHandler('extraction', async () => false);
        mockRepo.claimBatch.mockResolvedValueOnce([item]);

        await replayService.drain();

        const deadLetterEvents = emittedEvents.filter(
            (e: unknown) => (e as Record<string, unknown>)['event'] === 'memory.deferred_dead_lettered'
        );
        expect(deadLetterEvents.length).toBe(0);
    });
});

// ===========================================================================
// MREP-06: Persistence failures do not throw into the caller path
// ===========================================================================

describe('MREP-06: persistence failures are non-blocking', () => {
    it('does not throw when repository.append rejects', async () => {
        const failingAppend = vi.fn().mockRejectedValue(new Error('DB connection lost'));
        buildPersistenceBridge(failingAppend);

        expect(() => {
            TelemetryBus.getInstance().emit({
                event: 'memory.health_transition',
                subsystem: 'memory',
                executionId: 'memory-health',
                timestamp: new Date().toISOString(),
                payload: {
                    fromState: 'healthy',
                    toState: 'degraded',
                    fromMode: 'full',
                    toMode: 'reduced',
                    reasons: ['canonical_unavailable'],
                    at: new Date().toISOString(),
                },
            } as any);
        }).not.toThrow();

        // Allow microtask queue to flush — rejection must be swallowed
        await new Promise<void>(resolve => setTimeout(resolve, 10));

        expect(failingAppend).toHaveBeenCalledOnce();
    });

    it('does not throw when dead_letter append rejects', async () => {
        const failingAppend = vi.fn().mockRejectedValue(new Error('Pool exhausted'));
        buildPersistenceBridge(failingAppend);

        expect(() => {
            TelemetryBus.getInstance().emit({
                event: 'memory.deferred_dead_lettered',
                subsystem: 'memory',
                executionId: 'deferred-work',
                timestamp: new Date().toISOString(),
                payload: { id: 'x', kind: 'embedding', canonicalMemoryId: 'c', attemptCount: 3, error: 'err' },
            } as any);
        }).not.toThrow();

        await new Promise<void>(resolve => setTimeout(resolve, 10));
        expect(failingAppend).toHaveBeenCalledOnce();
    });
});

// ===========================================================================
// MREP-07: Analytics uses persisted health transitions in trajectory analysis
// ===========================================================================

describe('MREP-07: analytics uses health transition evidence', () => {
    it('trajectories are built from persisted getHealthTransitions rows', async () => {
        const transitions = [
            { from_state: 'healthy', to_state: 'degraded', occurred_at: new Date('2024-01-01T00:00:00Z') },
            { from_state: 'degraded', to_state: 'healthy', occurred_at: new Date('2024-01-01T01:00:00Z') },
        ];

        const pool = makePool((sql) => {
            if (sql.includes('health_transition') && sql.includes('ORDER')) return { rows: transitions };
            if (sql.includes('reason IS NOT NULL')) return { rows: [] };
            if (sql.includes('action_type IS NOT NULL')) return { rows: [] };
            if (sql.includes("'repair_action'")) return { rows: [] };
            if (sql.includes("'deferred_replay'")) return { rows: [] };
            if (sql.includes("'dead_letter'")) return { rows: [] };
            if (sql.includes('LIMIT  20')) return { rows: [] };
            if (sql.includes('COUNT(*)')) return { rows: [{ cnt: '0' }] };
            return { rows: [] };
        });

        const repo = new MemoryRepairOutcomeRepository(pool);
        const analytics = new MemoryRepairAnalyticsService(repo);
        const summary = await analytics.generateSummary({ windowHours: 24 });

        expect(summary.trajectories.length).toBeGreaterThan(0);
        const traj = summary.trajectories[0];
        expect(traj.stateSequence).toContain('degraded');
    });

    it('prolonged_degraded escalation is raised from health_transition data', async () => {
        // Two transitions: healthy → degraded, then nothing (still degraded)
        const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);

        const pool = makePool((sql) => {
            if (sql.includes('health_transition') && sql.includes('ORDER')) {
                return {
                    rows: [
                        { state: 'degraded', occurred_at: twoHoursAgo },
                    ],
                };
            }
            if (sql.includes('reason IS NOT NULL')) return { rows: [] };
            if (sql.includes('action_type IS NOT NULL')) return { rows: [] };
            if (sql.includes("'repair_action'")) return { rows: [] };
            if (sql.includes("'deferred_replay'")) return { rows: [] };
            if (sql.includes("'dead_letter'")) return { rows: [] };
            if (sql.includes('COUNT(*)')) return { rows: [{ cnt: '0' }] };
            return { rows: [] };
        });

        const repo = new MemoryRepairOutcomeRepository(pool);
        const analytics = new MemoryRepairAnalyticsService(repo, {
            escalationDegradedHoursThreshold: 1,
        });
        const summary = await analytics.generateSummary({ windowHours: 24 });

        const escalation = summary.escalationCandidates.find(e => e.code === 'prolonged_degraded');
        expect(escalation).toBeDefined();
        expect(escalation?.evidence['degradedHours']).toBeGreaterThan(1);
    });
});

// ===========================================================================
// MREP-08: Analytics uses persisted dead-letter events
// ===========================================================================

describe('MREP-08: analytics uses dead-letter evidence', () => {
    it('deadLetterCount reflects persisted dead_letter rows', async () => {
        const pool = makePool((sql) => {
            if (sql.includes("'dead_letter'")) {
                // Simulate more recent dead-letters
                return {
                    rows: [
                        { half: 'early', cnt: '2' },
                        { half: 'late', cnt: '5' },
                    ],
                };
            }
            // getReasonCounts — must return empty to avoid .toISOString() on undefined
            if (sql.includes('reason IS NOT NULL')) return { rows: [] };
            if (sql.includes('action_type IS NOT NULL')) return { rows: [] };
            if (sql.includes("'repair_action'")) return { rows: [] };
            if (sql.includes("'deferred_replay'")) return { rows: [] };
            if (sql.includes('LIMIT  20')) return { rows: [] };
            if (sql.includes('COUNT(*)')) return { rows: [{ cnt: '0' }] };
            return { rows: [] };
        });

        const repo = new MemoryRepairOutcomeRepository(pool);
        const analytics = new MemoryRepairAnalyticsService(repo);
        const summary = await analytics.generateSummary({ windowHours: 24 });

        expect(summary.queueBehavior.deadLetterCount).toBe(7);
        expect(summary.queueBehavior.deadLetterGrowing).toBe(true);
    });

    it('growing_dead_letter_queue escalation raised when late > early', async () => {
        const pool = makePool((sql) => {
            if (sql.includes("'dead_letter'")) {
                return { rows: [{ half: 'early', cnt: '1' }, { half: 'late', cnt: '4' }] };
            }
            if (sql.includes('reason IS NOT NULL')) return { rows: [] };
            if (sql.includes('action_type IS NOT NULL')) return { rows: [] };
            if (sql.includes("'repair_action'")) return { rows: [] };
            if (sql.includes("'deferred_replay'")) return { rows: [] };
            if (sql.includes('LIMIT  20')) return { rows: [] };
            if (sql.includes('COUNT(*)')) return { rows: [{ cnt: '0' }] };
            return { rows: [] };
        });

        const repo = new MemoryRepairOutcomeRepository(pool);
        const analytics = new MemoryRepairAnalyticsService(repo);
        const summary = await analytics.generateSummary({ windowHours: 24 });

        const escalation = summary.escalationCandidates.find(
            e => e.code === 'growing_dead_letter_queue'
        );
        expect(escalation).toBeDefined();
        expect(escalation?.evidence['totalDeadLetters']).toBe(5);
    });
});

// ===========================================================================
// MREP-09: Only emitted transition events are stored (not stable evaluations)
// ===========================================================================

describe('MREP-09: only state-changing transitions are persisted', () => {
    it('subscriber only fires on memory.health_transition, not memory.health_evaluated', async () => {
        const { append } = buildPersistenceBridge();

        // Stable evaluation — not a transition
        TelemetryBus.getInstance().emit({
            event: 'memory.health_evaluated',
            subsystem: 'memory',
            executionId: 'memory-health',
            timestamp: new Date().toISOString(),
            payload: { state: 'healthy' },
        } as any);

        await Promise.resolve();
        expect(append).not.toHaveBeenCalled();

        // Now an actual transition
        TelemetryBus.getInstance().emit({
            event: 'memory.health_transition',
            subsystem: 'memory',
            executionId: 'memory-health',
            timestamp: new Date().toISOString(),
            payload: {
                fromState: 'healthy',
                toState: 'degraded',
                fromMode: 'full',
                toMode: 'reduced',
                reasons: ['mem0_unavailable'],
                at: new Date().toISOString(),
            },
        } as any);

        await Promise.resolve();
        expect(append).toHaveBeenCalledOnce();
        const input = append.mock.calls[0][0] as Record<string, unknown>;
        expect(input['eventType']).toBe('health_transition');
    });
});

// ===========================================================================
// MREP-10: Round-trip queryability
// ===========================================================================

describe('MREP-10: persisted rows are queryable in the expected time window', () => {
    it('listRecent returns health_transition rows appended in window', async () => {
        const now = new Date();
        const appendedRows: Record<string, unknown>[] = [];

        const pool = {
            query: vi.fn().mockImplementation((sql: string) => {
                if (sql.includes('INSERT')) {
                    // Capture the insert — simulate it as if stored
                    return { rows: [] };
                }
                if (sql.includes('SELECT *')) {
                    return {
                        rows: appendedRows.map(r => ({
                            ...r,
                            occurred_at: now,
                            created_at: now,
                        })),
                    };
                }
                return { rows: [] };
            }),
        } as unknown as import('pg').Pool;

        const repo = new MemoryRepairOutcomeRepository(pool);

        // Append a health_transition row
        await repo.append({
            eventType: 'health_transition',
            state: 'degraded',
            mode: 'reduced',
            reason: 'canonical_unavailable',
            detailsJson: { fromState: 'healthy', toState: 'degraded' },
            occurredAt: now.toISOString(),
        });

        // Verify the row shape passed to INSERT
        const insertCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
        const params = insertCall[1] as unknown[];
        expect(params[1]).toBe('health_transition');  // event_type
        expect(params[4]).toBe('degraded');            // state
        expect(params[5]).toBe('reduced');             // mode

        // Simulate the SELECT returning that row
        appendedRows.push({
            id: 'test-id',
            event_type: 'health_transition',
            severity: null,
            reason: 'canonical_unavailable',
            state: 'degraded',
            mode: 'reduced',
            outcome: null,
            action_type: null,
            subsystem: null,
            canonical_memory_id: null,
            cycle_id: null,
            details_json: { fromState: 'healthy', toState: 'degraded' },
        });

        const windowSince = new Date(Date.now() - 3_600_000);
        const records = await repo.listRecent(windowSince, 10);

        expect(records.length).toBe(1);
        expect(records[0].eventType).toBe('health_transition');
        expect(records[0].state).toBe('degraded');
    });

    it('getDeadLetterHalves returns counts for persisted dead_letter rows', async () => {
        const pool = makePool((sql) => {
            if (sql.includes("'dead_letter'")) {
                return { rows: [{ half: 'early', cnt: '3' }, { half: 'late', cnt: '6' }] };
            }
            return { rows: [] };
        });

        const repo = new MemoryRepairOutcomeRepository(pool);
        const halves = await repo.getDeadLetterHalves(new Date(Date.now() - 3_600_000));

        expect(halves.total).toBe(9);
        expect(halves.early).toBe(3);
        expect(halves.late).toBe(6);
    });

    it('getHealthTransitions returns rows for health_transition events in window', async () => {
        const ts = new Date('2024-06-01T10:00:00Z');
        const pool = makePool((sql) => {
            if (sql.includes('health_transition') && sql.includes('ORDER')) {
                return {
                    rows: [
                        { from_state: 'healthy', to_state: 'degraded', occurred_at: ts },
                        { from_state: 'degraded', to_state: 'healthy', occurred_at: new Date(ts.getTime() + 3_600_000) },
                    ],
                };
            }
            return { rows: [] };
        });

        const repo = new MemoryRepairOutcomeRepository(pool);
        const transitions = await repo.getHealthTransitions(new Date(Date.now() - 24 * 3_600_000));

        expect(transitions.length).toBe(2);
        expect(transitions[0].fromState).toBe('healthy');
        expect(transitions[0].toState).toBe('degraded');
        expect(transitions[1].toState).toBe('healthy');
    });
});
