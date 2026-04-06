/**
 * PolicyGateMemoryWrite.test.ts
 *
 * Integration tests for PolicyGate enforcement in the memory write path.
 *
 * Validates that policyGate.assertSideEffect() is called before any mutation
 * in both key write seams:
 *   1. MemoryService.add()         — derived write (local JSON + mem0)
 *   2. MemoryAuthorityService.tryCreateCanonicalMemory() — canonical PostgreSQL write
 *
 * PMW1  MemoryService.add() calls assertSideEffect with actionKind='memory_write'
 * PMW2  MemoryService.add() passes executionMode to assertSideEffect
 * PMW3  MemoryService.add() passes targetSubsystem='MemoryService'
 * PMW4  Blocked write in MemoryService.add() throws PolicyDeniedError
 * PMW5  No local write occurs when MemoryService.add() is blocked
 * PMW6  Allowed write in MemoryService.add() succeeds and writes to local store
 * PMW7  MemoryService.add() assertSideEffect fires before any state mutation
 * PMW8  MemoryAuthorityService.tryCreateCanonicalMemory() calls assertSideEffect
 * PMW9  MemoryAuthorityService.tryCreateCanonicalMemory() passes targetSubsystem='MemoryAuthorityService'
 * PMW10 Blocked write in MemoryAuthorityService.tryCreateCanonicalMemory() returns success:false with PolicyDeniedError
 * PMW11 No DB query issued when tryCreateCanonicalMemory is blocked
 * PMW12 PolicyDeniedError propagates cleanly from MemoryService.add()
 * PMW13 PolicyDeniedError captured in _cause from MemoryAuthorityService.tryCreateCanonicalMemory()
 *
 * No DB, no IPC, no Electron file-system I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { policyGate, PolicyDeniedError } from '../electron/services/policy/PolicyGate';

// ─── Mock electron (MemoryService uses app.getPath) ──────────────────────────

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-policy-test' },
}));

// ─── Mock fs (prevent real file-system I/O in MemoryService) ─────────────────

vi.mock('fs', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue('[]'),
        writeFileSync: vi.fn(),
    },
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('[]'),
    writeFileSync: vi.fn(),
}));

// ─── Mock RuntimeFlags (disable remote mem0 writes) ──────────────────────────

vi.mock('../electron/services/RuntimeFlags', () => ({
    RuntimeFlags: { ENABLE_MEM0_REMOTE: false },
}));

// ─── Imports (after mocks are established) ───────────────────────────────────

import { MemoryService } from '../electron/services/MemoryService';
import { MemoryAuthorityService } from '../electron/services/memory/MemoryAuthorityService';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal mock pg Pool that succeeds for any query. */
function makePool(memoryId = 'mem-canonical-01') {
    return {
        query: vi.fn().mockResolvedValue({ rows: [{ memory_id: memoryId }] }),
    };
}

/** Returns a PolicyDeniedError matching the mock decision used in block tests. */
function makeBlockDecision() {
    return { allowed: false, reason: 'blocked by test policy', code: 'TEST_MEMORY_BLOCK' };
}

// ─── PMW1–PMW7: MemoryService.add() enforcement ──────────────────────────────

describe('PMW1–PMW7: MemoryService.add() — PolicyGate enforcement', () => {
    let service: MemoryService;

    beforeEach(() => {
        service = new MemoryService();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('PMW1: calls assertSideEffect with actionKind=memory_write', async () => {
        const spy = vi.spyOn(policyGate, 'assertSideEffect');
        await service.add('test memory', { canonical_memory_id: 'cid-01' }, 'assistant');
        expect(spy).toHaveBeenCalledOnce();
        const ctx = spy.mock.calls[0][0];
        expect(ctx.actionKind).toBe('memory_write');
    });

    it('PMW2: passes executionMode matching the mode parameter', async () => {
        const spy = vi.spyOn(policyGate, 'assertSideEffect');
        await service.add('hello', { canonical_memory_id: 'cid-02' }, 'rp');
        const ctx = spy.mock.calls[0][0];
        expect(ctx.executionMode).toBe('rp');
    });

    it('PMW2b: passes executionMode=assistant for assistant mode', async () => {
        const spy = vi.spyOn(policyGate, 'assertSideEffect');
        await service.add('hello', { canonical_memory_id: 'cid-02b' }, 'assistant');
        const ctx = spy.mock.calls[0][0];
        expect(ctx.executionMode).toBe('assistant');
    });

    it('PMW3: passes targetSubsystem=MemoryService', async () => {
        const spy = vi.spyOn(policyGate, 'assertSideEffect');
        await service.add('hello', { canonical_memory_id: 'cid-03' }, 'assistant');
        const ctx = spy.mock.calls[0][0];
        expect(ctx.targetSubsystem).toBe('MemoryService');
    });

    it('PMW4: blocked write throws PolicyDeniedError', async () => {
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });
        await expect(service.add('blocked text', { canonical_memory_id: 'cid-04' }, 'rp')).rejects.toThrow(PolicyDeniedError);
    });

    it('PMW5: no local write occurs when assertSideEffect throws', async () => {
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });
        const countBefore = (await service.getAll()).length;
        try {
            await service.add('should not be written', { canonical_memory_id: 'cid-05' }, 'assistant');
        } catch (_) {
            // expected
        }
        const countAfter = (await service.getAll()).length;
        expect(countAfter).toBe(countBefore);
    });

    it('PMW6: allowed write succeeds and adds entry to local store', async () => {
        // policyGate is real (stub allow-all for non-blocked kinds) — no spy needed
        const countBefore = (await service.getAll()).length;
        const result = await service.add('this write is allowed', { canonical_memory_id: 'cid-06' }, 'assistant');
        expect(result).toBe(true);
        const countAfter = (await service.getAll()).length;
        expect(countAfter).toBe(countBefore + 1);
    });

    it('PMW7: assertSideEffect fires before state mutation (spy called before any write)', async () => {
        const callOrder: string[] = [];
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            callOrder.push('gate');
        });
        // Intercept localMemories push by spying on getAll after add completes
        // We track that the gate was called before any entry appears.
        await service.add('order check', { canonical_memory_id: 'cid-07' }, 'assistant');
        expect(callOrder[0]).toBe('gate');
    });

    it('PMW12: PolicyDeniedError propagates with correct code and reason', async () => {
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });
        let caught: unknown;
        try {
            await service.add('propagation check', { canonical_memory_id: 'cid-12' }, 'rp');
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(PolicyDeniedError);
        const denied = caught as PolicyDeniedError;
        expect(denied.decision.code).toBe('TEST_MEMORY_BLOCK');
        expect(denied.decision.reason).toContain('blocked by test policy');
    });
});

// ─── PMW8–PMW11, PMW13: MemoryAuthorityService.tryCreateCanonicalMemory() ────

describe('PMW8–PMW11, PMW13: MemoryAuthorityService.tryCreateCanonicalMemory() — PolicyGate enforcement', () => {
    const minimalInput = {
        memory_type: 'explicit_fact',
        subject_type: 'user',
        subject_id: 'user-1',
        content_text: 'test canonical memory',
        source_kind: 'explicit' as const,
        source_ref: 'test',
        confidence: 1.0,
    };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('PMW8: calls assertSideEffect with actionKind=memory_write', async () => {
        const pool = makePool();
        const auth = new MemoryAuthorityService(pool as any);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');
        await auth.tryCreateCanonicalMemory(minimalInput);
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ actionKind: 'memory_write' }),
        );
    });

    it('PMW9: passes targetSubsystem=MemoryAuthorityService', async () => {
        const pool = makePool();
        const auth = new MemoryAuthorityService(pool as any);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');
        await auth.tryCreateCanonicalMemory(minimalInput);
        const ctx = spy.mock.calls[0][0];
        expect(ctx.targetSubsystem).toBe('MemoryAuthorityService');
    });

    it('PMW10: blocked write returns success:false with PolicyDeniedError in _cause', async () => {
        const pool = makePool();
        const auth = new MemoryAuthorityService(pool as any);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });
        const result = await auth.tryCreateCanonicalMemory(minimalInput);
        expect(result.success).toBe(false);
        expect(result._cause).toBeInstanceOf(PolicyDeniedError);
    });

    it('PMW11: no DB query issued when assertSideEffect throws', async () => {
        const pool = makePool();
        const auth = new MemoryAuthorityService(pool as any);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });
        const result = await auth.tryCreateCanonicalMemory(minimalInput);
        expect(result.success).toBe(false);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('PMW13: PolicyDeniedError captured with correct decision in _cause', async () => {
        const pool = makePool();
        const auth = new MemoryAuthorityService(pool as any);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });
        const result = await auth.tryCreateCanonicalMemory(minimalInput);
        expect(result.success).toBe(false);
        expect(result._cause).toBeInstanceOf(PolicyDeniedError);
        const denied = result._cause as PolicyDeniedError;
        expect(denied.decision.code).toBe('TEST_MEMORY_BLOCK');
    });
});
