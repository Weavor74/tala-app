/**
 * DeferredMemoryReplay.test.ts
 *
 * Unit tests for DeferredMemoryReplayService — the bounded deferred-work
 * replay layer.
 *
 * Covers:
 *   DMR01–DMR05  — singleton / lifecycle
 *   DMR06–DMR12  — enqueue behavior
 *   DMR13–DMR22  — drain health gating and policy
 *   DMR23–DMR30  — item completion, failure, dead-letter
 *   DMR31–DMR36  — telemetry emission
 *   DMR37–DMR40  — stats and observability
 *
 * No real DB, no Electron.
 * TelemetryBus and DeferredMemoryWorkRepository are stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeferredMemoryReplayService } from '../electron/services/memory/DeferredMemoryReplayService';
import type {
    DeferredMemoryWorkKind,
    DeferredMemoryWorkItem,
    DeferredWorkStats,
    EnqueueDeferredWorkInput,
} from '../electron/services/db/DeferredMemoryWorkRepository';
import type { MemoryHealthStatus } from '../shared/memory/MemoryHealthStatus';

// ---------------------------------------------------------------------------
// Stub TelemetryBus
// ---------------------------------------------------------------------------

const emittedEvents: Array<{ event: string; payload?: Record<string, unknown> }> = [];

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (event: unknown) => emittedEvents.push(event as any),
            subscribe: vi.fn().mockReturnValue(vi.fn()),
        }),
    },
}));

// ---------------------------------------------------------------------------
// Health status factories
// ---------------------------------------------------------------------------

function healthyStatus(): MemoryHealthStatus {
    return {
        state: 'healthy',
        capabilities: {
            canonical: true,
            extraction: true,
            embeddings: true,
            mem0Runtime: true,
            graphProjection: true,
            ragLogging: true,
        },
        reasons: ['none'],
        mode: 'full_memory',
        hardDisabled: false,
        shouldTriggerRepair: false,
        shouldEscalate: false,
        summary: 'Memory[HEALTHY]',
        evaluatedAt: new Date().toISOString(),
    };
}

function reducedStatus(overrides: Partial<MemoryHealthStatus['capabilities']> = {}): MemoryHealthStatus {
    return {
        state: 'reduced',
        capabilities: {
            canonical: true,
            extraction: false,
            embeddings: false,
            mem0Runtime: true,
            graphProjection: false,
            ragLogging: true,
            ...overrides,
        },
        reasons: ['extraction_provider_unavailable'],
        mode: 'canonical_only',
        hardDisabled: false,
        shouldTriggerRepair: false,
        shouldEscalate: false,
        summary: 'Memory[REDUCED]',
        evaluatedAt: new Date().toISOString(),
    };
}

function criticalStatus(): MemoryHealthStatus {
    return {
        state: 'critical',
        capabilities: {
            canonical: false,
            extraction: false,
            embeddings: false,
            mem0Runtime: false,
            graphProjection: false,
            ragLogging: false,
        },
        reasons: ['canonical_unavailable'],
        mode: 'unknown',
        hardDisabled: true,
        shouldTriggerRepair: true,
        shouldEscalate: true,
        summary: 'Memory[CRITICAL]',
        evaluatedAt: new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Mock DeferredMemoryWorkRepository
// ---------------------------------------------------------------------------

function makeItem(
    id: string,
    kind: DeferredMemoryWorkKind = 'extraction',
    attemptCount = 0,
    maxAttempts = 3,
): DeferredMemoryWorkItem {
    return {
        id,
        kind,
        status: 'in_progress',
        canonicalMemoryId: `mem-${id}`,
        sessionId: null,
        turnId: null,
        payload: {},
        attemptCount,
        maxAttempts,
        lastError: null,
        nextAttemptAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        deadLetteredAt: null,
    };
}

function makeRepo(overrides: {
    enqueue?: (input: EnqueueDeferredWorkInput) => Promise<string>;
    claimBatch?: (batchSize: number, kinds?: DeferredMemoryWorkKind[]) => Promise<DeferredMemoryWorkItem[]>;
    markCompleted?: (id: string) => Promise<void>;
    markFailed?: (id: string, error: string) => Promise<void>;
    getStats?: () => Promise<DeferredWorkStats>;
    countPending?: (kinds?: DeferredMemoryWorkKind[]) => Promise<Record<DeferredMemoryWorkKind, number>>;
} = {}) {
    return {
        enqueue: overrides.enqueue ?? vi.fn().mockResolvedValue('new-id'),
        claimBatch: overrides.claimBatch ?? vi.fn().mockResolvedValue([]),
        markCompleted: overrides.markCompleted ?? vi.fn().mockResolvedValue(undefined),
        markFailed: overrides.markFailed ?? vi.fn().mockResolvedValue(undefined),
        getStats: overrides.getStats ?? vi.fn().mockResolvedValue({
            total: 0,
            byKind: {},
            byStatus: {},
        }),
        countPending: overrides.countPending ?? vi.fn().mockResolvedValue({
            extraction: 0,
            embedding: 0,
            graph_projection: 0,
        }),
    };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSvc() {
    const svc = DeferredMemoryReplayService.getInstance();
    svc.reset();
    emittedEvents.length = 0;
    return svc;
}

function withHealth(svc: DeferredMemoryReplayService, fn: () => MemoryHealthStatus) {
    svc.setHealthStatusProvider(fn);
}

function withRepo(svc: DeferredMemoryReplayService, repo: ReturnType<typeof makeRepo>) {
    svc.setRepository(repo as any);
}

// ===========================================================================
// Tests
// ===========================================================================

describe('DMR: singleton and lifecycle', () => {

    it('DMR01: getInstance() always returns the same instance', () => {
        const a = DeferredMemoryReplayService.getInstance();
        const b = DeferredMemoryReplayService.getInstance();
        expect(a).toBe(b);
    });

    it('DMR02: reset() clears repository, handlers, and health provider', async () => {
        const svc = makeSvc();
        const repo = makeRepo();
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());
        svc.registerHandler('extraction', async () => true);

        svc.reset();

        // After reset: enqueue should log warning and return null (no repo)
        const id = await svc.enqueue({ kind: 'extraction', canonicalMemoryId: 'mem-1' });
        expect(id).toBeNull();
        expect(repo.enqueue).not.toHaveBeenCalled();
    });

    it('DMR03: reset() stops any in-progress drain flag', async () => {
        const svc = makeSvc();
        svc.reset();
        // After reset the service should accept a new drain call without being blocked
        const repo = makeRepo({ claimBatch: vi.fn().mockResolvedValue([]) });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());
        await svc.drain();
        expect(repo.claimBatch).toHaveBeenCalled();
    });
});

describe('DMR: enqueue', () => {

    it('DMR06: enqueue persists item via repository and returns id', async () => {
        const svc = makeSvc();
        const repo = makeRepo({ enqueue: vi.fn().mockResolvedValue('abc-123') });
        withRepo(svc, repo);

        const id = await svc.enqueue({
            kind: 'extraction',
            canonicalMemoryId: 'mem-1',
            turnId: 'turn-42',
        });

        expect(id).toBe('abc-123');
        expect(repo.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'extraction', canonicalMemoryId: 'mem-1', turnId: 'turn-42' }),
        );
    });

    it('DMR07: enqueue without repository returns null and does not throw', async () => {
        const svc = makeSvc();
        // no repository injected

        const id = await svc.enqueue({ kind: 'embedding', canonicalMemoryId: 'mem-2' });
        expect(id).toBeNull();
    });

    it('DMR08: enqueue emits memory.deferred_work_enqueued telemetry event', async () => {
        const svc = makeSvc();
        const repo = makeRepo({ enqueue: vi.fn().mockResolvedValue('evt-id') });
        withRepo(svc, repo);

        await svc.enqueue({ kind: 'graph_projection', canonicalMemoryId: 'mem-3' });

        const evt = emittedEvents.find((e: any) => e.event === 'memory.deferred_work_enqueued');
        expect(evt).toBeDefined();
        expect((evt as any).payload?.kind).toBe('graph_projection');
        expect((evt as any).payload?.canonicalMemoryId).toBe('mem-3');
    });

    it('DMR09: enqueue repository error returns null without throwing', async () => {
        const svc = makeSvc();
        const repo = makeRepo({ enqueue: vi.fn().mockRejectedValue(new Error('db error')) });
        withRepo(svc, repo);

        const id = await svc.enqueue({ kind: 'extraction', canonicalMemoryId: 'mem-4' });
        expect(id).toBeNull();
    });

    it('DMR10: enqueue passes through payload, sessionId, and turnId', async () => {
        const svc = makeSvc();
        const repo = makeRepo({ enqueue: vi.fn().mockResolvedValue('x') });
        withRepo(svc, repo);

        await svc.enqueue({
            kind: 'embedding',
            canonicalMemoryId: 'mem-5',
            sessionId: 'sess-1',
            turnId: 'turn-7',
            payload: { contentText: 'hello', mode: 'chat' },
        });

        expect(repo.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 'sess-1',
                turnId: 'turn-7',
                payload: { contentText: 'hello', mode: 'chat' },
            }),
        );
    });
});

describe('DMR: drain health gating', () => {

    it('DMR13: drain returns immediately when canonical is unhealthy', async () => {
        const svc = makeSvc();
        const repo = makeRepo({ claimBatch: vi.fn().mockResolvedValue([]) });
        withRepo(svc, repo);
        withHealth(svc, () => criticalStatus());

        await svc.drain();

        expect(repo.claimBatch).not.toHaveBeenCalled();
    });

    it('DMR14: drain returns immediately when no health provider is set', async () => {
        const svc = makeSvc();
        const repo = makeRepo({ claimBatch: vi.fn().mockResolvedValue([]) });
        withRepo(svc, repo);
        // no health provider

        await svc.drain();

        expect(repo.claimBatch).not.toHaveBeenCalled();
    });

    it('DMR15: drain returns immediately when no repository is set', async () => {
        const svc = makeSvc();
        withHealth(svc, () => healthyStatus());
        // no repo — claimBatch would throw if called

        await expect(svc.drain()).resolves.toBeUndefined();
    });

    it('DMR16: drain claims only extraction when only extraction is available', async () => {
        const svc = makeSvc();
        const claimBatch = vi.fn().mockResolvedValue([]);
        const repo = makeRepo({ claimBatch });
        withRepo(svc, repo);
        withHealth(svc, () => reducedStatus({ extraction: true, embeddings: false, graphProjection: false }));

        await svc.drain();

        expect(claimBatch).toHaveBeenCalledWith(
            expect.any(Number),
            expect.arrayContaining(['extraction']),
        );
        const [, kinds] = claimBatch.mock.calls[0];
        expect(kinds).not.toContain('embedding');
        expect(kinds).not.toContain('graph_projection');
    });

    it('DMR17: drain claims all three kinds when health is fully healthy', async () => {
        const svc = makeSvc();
        const claimBatch = vi.fn().mockResolvedValue([]);
        const repo = makeRepo({ claimBatch });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());

        await svc.drain();

        const [, kinds] = claimBatch.mock.calls[0];
        expect(kinds).toContain('extraction');
        expect(kinds).toContain('embedding');
        expect(kinds).toContain('graph_projection');
    });

    it('DMR18: drain returns immediately when no eligible kinds exist', async () => {
        const svc = makeSvc();
        const claimBatch = vi.fn().mockResolvedValue([]);
        const repo = makeRepo({ claimBatch });
        withRepo(svc, repo);
        // canonical=true but all capabilities false
        withHealth(svc, () => ({
            ...reducedStatus(),
            capabilities: {
                canonical: true,
                extraction: false,
                embeddings: false,
                mem0Runtime: false,
                graphProjection: false,
                ragLogging: false,
            },
        }));

        await svc.drain();

        expect(claimBatch).not.toHaveBeenCalled();
    });

    it('DMR19: concurrent drain() calls — second call is a no-op', async () => {
        const svc = makeSvc();
        let resolveDrain!: () => void;
        const claimBatch = vi.fn().mockImplementation(
            () => new Promise<DeferredMemoryWorkItem[]>(resolve => { resolveDrain = () => resolve([]); }),
        );
        const repo = makeRepo({ claimBatch });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());

        const first = svc.drain();
        const second = svc.drain(); // should be a no-op

        resolveDrain();
        await Promise.all([first, second]);

        expect(claimBatch).toHaveBeenCalledTimes(1);
    });
});

describe('DMR: item completion and failure', () => {

    it('DMR23: successful handler causes markCompleted to be called', async () => {
        const svc = makeSvc();
        const items = [makeItem('item-1', 'extraction')];
        const markCompleted = vi.fn().mockResolvedValue(undefined);
        const repo = makeRepo({
            claimBatch: vi.fn().mockResolvedValue(items),
            markCompleted,
        });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());
        svc.registerHandler('extraction', async () => true);

        await svc.drain();

        expect(markCompleted).toHaveBeenCalledWith('item-1');
    });

    it('DMR24: handler returning false causes markFailed to be called', async () => {
        const svc = makeSvc();
        const items = [makeItem('item-2', 'embedding')];
        const markFailed = vi.fn().mockResolvedValue(undefined);
        const repo = makeRepo({
            claimBatch: vi.fn().mockResolvedValue(items),
            markFailed,
        });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());
        svc.registerHandler('embedding', async () => false);

        await svc.drain();

        expect(markFailed).toHaveBeenCalledWith('item-2', 'handler_returned_false');
    });

    it('DMR25: handler throwing causes markFailed with error message', async () => {
        const svc = makeSvc();
        const items = [makeItem('item-3', 'graph_projection')];
        const markFailed = vi.fn().mockResolvedValue(undefined);
        const repo = makeRepo({
            claimBatch: vi.fn().mockResolvedValue(items),
            markFailed,
        });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());
        svc.registerHandler('graph_projection', async () => {
            throw new Error('graph unavailable');
        });

        await svc.drain();

        expect(markFailed).toHaveBeenCalledWith('item-3', 'graph unavailable');
    });

    it('DMR26: item with no handler is marked failed with no_handler_registered', async () => {
        const svc = makeSvc();
        const items = [makeItem('item-4', 'extraction')];
        const markFailed = vi.fn().mockResolvedValue(undefined);
        const repo = makeRepo({
            claimBatch: vi.fn().mockResolvedValue(items),
            markFailed,
        });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());
        // no handler registered for 'extraction'

        await svc.drain();

        expect(markFailed).toHaveBeenCalledWith('item-4', 'no_handler_registered');
    });

    it('DMR27: drain processes multiple items in one batch', async () => {
        const svc = makeSvc();
        const items = [
            makeItem('item-a', 'extraction'),
            makeItem('item-b', 'embedding'),
            makeItem('item-c', 'graph_projection'),
        ];
        const markCompleted = vi.fn().mockResolvedValue(undefined);
        const repo = makeRepo({
            claimBatch: vi.fn().mockResolvedValue(items),
            markCompleted,
        });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());
        svc.registerHandler('extraction', async () => true);
        svc.registerHandler('embedding', async () => true);
        svc.registerHandler('graph_projection', async () => true);

        await svc.drain();

        expect(markCompleted).toHaveBeenCalledTimes(3);
    });

    it('DMR28: markFailed error during fail processing does not abort remaining items', async () => {
        const svc = makeSvc();
        const items = [makeItem('item-x', 'extraction'), makeItem('item-y', 'embedding')];
        const markCompleted = vi.fn().mockResolvedValue(undefined);
        const markFailed = vi.fn()
            .mockRejectedValueOnce(new Error('db error on first'))
            .mockResolvedValueOnce(undefined);
        const repo = makeRepo({
            claimBatch: vi.fn().mockResolvedValue(items),
            markCompleted,
            markFailed,
        });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());
        svc.registerHandler('extraction', async () => false); // will fail
        svc.registerHandler('embedding', async () => true);   // will succeed

        await expect(svc.drain()).resolves.toBeUndefined();
        expect(markCompleted).toHaveBeenCalledWith('item-y');
    });
});

describe('DMR: telemetry emission', () => {

    it('DMR31: drain emits memory.deferred_work_drain_started event', async () => {
        const svc = makeSvc();
        const repo = makeRepo({ claimBatch: vi.fn().mockResolvedValue([]) });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());

        await svc.drain();

        const evt = emittedEvents.find((e: any) => e.event === 'memory.deferred_work_drain_started');
        expect(evt).toBeDefined();
    });

    it('DMR32: drain emits memory.deferred_work_drain_completed event with counts', async () => {
        const svc = makeSvc();
        const items = [makeItem('x', 'extraction')];
        const repo = makeRepo({ claimBatch: vi.fn().mockResolvedValue(items) });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());
        svc.registerHandler('extraction', async () => true);

        await svc.drain();

        const evt = emittedEvents.find((e: any) => e.event === 'memory.deferred_work_drain_completed') as any;
        expect(evt).toBeDefined();
        expect(evt.payload?.completed).toBe(1);
        expect(evt.payload?.failed).toBe(0);
    });

    it('DMR33: successful item emits memory.deferred_work_item_completed', async () => {
        const svc = makeSvc();
        const items = [makeItem('done-1', 'embedding')];
        const repo = makeRepo({ claimBatch: vi.fn().mockResolvedValue(items) });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());
        svc.registerHandler('embedding', async () => true);

        await svc.drain();

        const evt = emittedEvents.find((e: any) => e.event === 'memory.deferred_work_item_completed') as any;
        expect(evt).toBeDefined();
        expect(evt.payload?.id).toBe('done-1');
        expect(evt.payload?.kind).toBe('embedding');
    });

    it('DMR34: failed item emits memory.deferred_work_item_failed', async () => {
        const svc = makeSvc();
        const items = [makeItem('fail-1', 'graph_projection')];
        const repo = makeRepo({ claimBatch: vi.fn().mockResolvedValue(items) });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());
        svc.registerHandler('graph_projection', async () => false);

        await svc.drain();

        const evt = emittedEvents.find((e: any) => e.event === 'memory.deferred_work_item_failed') as any;
        expect(evt).toBeDefined();
        expect(evt.payload?.id).toBe('fail-1');
        expect(evt.payload?.kind).toBe('graph_projection');
    });
});

describe('DMR: stats and observability', () => {

    it('DMR37: getStats() delegates to repository', async () => {
        const svc = makeSvc();
        const stats: DeferredWorkStats = {
            total: 5,
            byKind: { extraction: 3, embedding: 2 },
            byStatus: { pending: 4, completed: 1 },
        };
        const repo = makeRepo({ getStats: vi.fn().mockResolvedValue(stats) });
        withRepo(svc, repo);

        const result = await svc.getStats();

        expect(result).toEqual(stats);
    });

    it('DMR38: getStats() returns null when no repository is set', async () => {
        const svc = makeSvc();
        // no repo

        const result = await svc.getStats();

        expect(result).toBeNull();
    });

    it('DMR39: getStats() returns null on repository error', async () => {
        const svc = makeSvc();
        const repo = makeRepo({ getStats: vi.fn().mockRejectedValue(new Error('db error')) });
        withRepo(svc, repo);

        const result = await svc.getStats();

        expect(result).toBeNull();
    });

    it('DMR40: drain uses default batch size when none specified', async () => {
        const svc = makeSvc();
        const claimBatch = vi.fn().mockResolvedValue([]);
        const repo = makeRepo({ claimBatch });
        withRepo(svc, repo);
        withHealth(svc, () => healthyStatus());

        await svc.drain(); // no batchSize arg

        expect(claimBatch).toHaveBeenCalledWith(
            expect.any(Number),
            expect.any(Array),
        );
        const batchSize = claimBatch.mock.calls[0][0] as number;
        expect(batchSize).toBeGreaterThan(0);
        expect(batchSize).toBeLessThanOrEqual(100);
    });
});
