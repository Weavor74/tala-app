/**
 * PolicyGateMemoryProtection.test.ts
 *
 * Tests for the POLICY_MEMORY_WRITE_RP_BLOCK rule and the gate enforcement wired
 * into MemoryAuthorityService.tryUpdateCanonicalMemory() and tryTombstoneMemory().
 *
 * Rule:
 *   POLICY_MEMORY_WRITE_RP_BLOCK — blocks memory_write when executionMode === 'rp'
 *                                   AND mutationIntent === 'write'
 *
 * Validates:
 *   PMP1   evaluate() returns allowed=false for memory_write/rp/intent=write
 *   PMP2   evaluate() returns code POLICY_MEMORY_WRITE_RP_BLOCK
 *   PMP3   evaluate() returns reason containing 'memory_write' and 'rp mode'
 *   PMP4   evaluate() returns allowed=true for memory_write/rp without mutationIntent=write
 *   PMP5   evaluate() returns allowed=true for memory_write in non-rp modes with intent=write
 *   PMP6   evaluate() returns allowed=true for memory_write/assistant
 *   PMP7   evaluate() returns allowed=true for memory_write/system
 *   PMP8   checkSideEffect() propagates the block for memory_write/rp/intent=write
 *   PMP9   assertSideEffect() throws PolicyDeniedError for memory_write/rp/intent=write
 *   PMP10  thrown error carries POLICY_MEMORY_WRITE_RP_BLOCK code
 *   PMP11  assertSideEffect() does NOT throw for memory_write in non-rp modes
 *   PMP12  policyGate singleton enforces the rule
 *   PMP13  tryUpdateCanonicalMemory() calls assertSideEffect with actionKind=memory_write
 *   PMP14  tryUpdateCanonicalMemory() passes executionMode to assertSideEffect
 *   PMP15  tryUpdateCanonicalMemory() passes targetSubsystem=MemoryAuthorityService
 *   PMP16  tryUpdateCanonicalMemory() passes mutationIntent=write
 *   PMP17  tryUpdateCanonicalMemory() blocked in rp mode returns success:false with PolicyDeniedError
 *   PMP18  tryUpdateCanonicalMemory() blocked does NOT call pool.query
 *   PMP19  tryUpdateCanonicalMemory() allowed in system mode returns success:true
 *   PMP20  tryTombstoneMemory() calls assertSideEffect with actionKind=memory_write
 *   PMP21  tryTombstoneMemory() passes executionMode to assertSideEffect
 *   PMP22  tryTombstoneMemory() passes targetSubsystem=MemoryAuthorityService
 *   PMP23  tryTombstoneMemory() passes mutationIntent=write
 *   PMP24  tryTombstoneMemory() blocked in rp mode returns success:false with PolicyDeniedError
 *   PMP25  tryTombstoneMemory() blocked does NOT call pool.query
 *   PMP26  PolicyDeniedError captured in _cause from tryUpdateCanonicalMemory()
 *   PMP27  PolicyDeniedError captured in _cause from tryTombstoneMemory()
 *
 * No DB, no IPC, no Electron.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    PolicyGate,
    PolicyDeniedError,
    policyGate,
    type SideEffectContext,
} from '../electron/services/policy/PolicyGate';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-pmp-test' },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    ipcMain: { handle: vi.fn() },
}));

vi.mock('imapflow', () => ({}));

import { MemoryAuthorityService } from '../electron/services/memory/MemoryAuthorityService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWriteCtx(overrides: Partial<SideEffectContext> = {}): SideEffectContext {
    return {
        actionKind: 'memory_write',
        executionMode: 'rp',
        targetSubsystem: 'MemoryAuthorityService',
        mutationIntent: 'write',
        ...overrides,
    };
}

function makeBlockDecision() {
    return { allowed: false, reason: 'blocked by test rule', code: 'TEST_MEM_BLOCK' };
}

/** Pool stub: _fetchRecord returns an existing canonical record; query succeeds for mutations. */
function makePool(memoryId = 'mem-pmp-01') {
    const NOW = new Date('2026-01-01T00:00:00.000Z');
    const existingRow = {
        memory_id: memoryId,
        memory_type: 'explicit_fact',
        subject_type: 'user',
        subject_id: 'u1',
        content_text: 'original content',
        content_structured: null,
        canonical_hash: 'hash-pmp-01',
        authority_status: 'canonical',
        version: 1,
        confidence: 1.0,
        source_kind: 'explicit',
        source_ref: 'test',
        valid_from: NOW,
        valid_to: null,
        created_at: NOW,
        updated_at: NOW,
        tombstoned_at: null,
        supersedes_memory_id: null,
    };
    return {
        query: vi.fn().mockResolvedValue({ rows: [existingRow] }),
    };
}

// ─── PMP1–PMP12: evaluate() and typed API for POLICY_MEMORY_WRITE_RP_BLOCK ────

describe('PMP1–PMP7: evaluate() — memory_write/rp/intent=write rule', () => {
    it('PMP1: returns allowed=false for memory_write in rp mode with intent=write', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'memory_write', mode: 'rp', payload: { mutationIntent: 'write' } });
        expect(d.allowed).toBe(false);
    });

    it('PMP2: returns code POLICY_MEMORY_WRITE_RP_BLOCK', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'memory_write', mode: 'rp', payload: { mutationIntent: 'write' } });
        expect(d.code).toBe('POLICY_MEMORY_WRITE_RP_BLOCK');
    });

    it('PMP3: returns reason containing "memory_write" and "rp mode"', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'memory_write', mode: 'rp', payload: { mutationIntent: 'write' } });
        expect(d.reason).toContain('memory_write');
        expect(d.reason).toContain('rp mode');
    });

    it('PMP4: returns allowed=true for memory_write/rp without mutationIntent=write', () => {
        const gate = new PolicyGate();
        // Different intent — rule must NOT fire
        const d1 = gate.evaluate({ action: 'memory_write', mode: 'rp', payload: { mutationIntent: 'derived_memory_write' } });
        expect(d1.allowed).toBe(true);
        const d2 = gate.evaluate({ action: 'memory_write', mode: 'rp' });
        expect(d2.allowed).toBe(true);
        const d3 = gate.evaluate({ action: 'memory_write', mode: 'rp', payload: {} });
        expect(d3.allowed).toBe(true);
    });

    it('PMP5: returns allowed=true for memory_write/non-rp modes with intent=write', () => {
        const gate = new PolicyGate();
        for (const mode of ['assistant', 'hybrid', 'system']) {
            const d = gate.evaluate({ action: 'memory_write', mode, payload: { mutationIntent: 'write' } });
            expect(d.allowed).toBe(true);
            expect(d.code).toBe('POLICY_DEFAULT_ALLOW');
        }
    });

    it('PMP6: returns allowed=true for memory_write in assistant mode', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'memory_write', mode: 'assistant', payload: { mutationIntent: 'write' } });
        expect(d.allowed).toBe(true);
    });

    it('PMP7: returns allowed=true for memory_write in system mode', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'memory_write', mode: 'system', payload: { mutationIntent: 'write' } });
        expect(d.allowed).toBe(true);
    });
});

describe('PMP8–PMP12: checkSideEffect / assertSideEffect for memory_write', () => {
    it('PMP8: checkSideEffect() propagates block for memory_write/rp/intent=write', () => {
        const gate = new PolicyGate();
        const d = gate.checkSideEffect(makeWriteCtx({ executionMode: 'rp' }));
        expect(d.allowed).toBe(false);
        expect(d.code).toBe('POLICY_MEMORY_WRITE_RP_BLOCK');
    });

    it('PMP9: assertSideEffect() throws PolicyDeniedError for memory_write/rp/intent=write', () => {
        const gate = new PolicyGate();
        expect(() => gate.assertSideEffect(makeWriteCtx({ executionMode: 'rp' }))).toThrow(PolicyDeniedError);
    });

    it('PMP10: thrown error carries decision with POLICY_MEMORY_WRITE_RP_BLOCK code', () => {
        const gate = new PolicyGate();
        let caught: unknown;
        try {
            gate.assertSideEffect(makeWriteCtx({ executionMode: 'rp' }));
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(PolicyDeniedError);
        const denied = caught as PolicyDeniedError;
        expect(denied.decision.allowed).toBe(false);
        expect(denied.decision.code).toBe('POLICY_MEMORY_WRITE_RP_BLOCK');
        expect(denied.decision.reason).toContain('rp mode');
    });

    it('PMP11: assertSideEffect() does NOT throw for memory_write in non-rp modes', () => {
        const gate = new PolicyGate();
        for (const mode of ['assistant', 'system', 'hybrid']) {
            expect(() => gate.assertSideEffect(makeWriteCtx({ executionMode: mode }))).not.toThrow();
        }
        expect(() => gate.assertSideEffect(makeWriteCtx({ executionMode: undefined }))).not.toThrow();
    });

    it('PMP12: policyGate singleton enforces the rule', () => {
        const d = policyGate.checkSideEffect(makeWriteCtx({ executionMode: 'rp' }));
        expect(d.allowed).toBe(false);
        expect(d.code).toBe('POLICY_MEMORY_WRITE_RP_BLOCK');
    });
});

// ─── PMP13–PMP19: tryUpdateCanonicalMemory() enforcement ─────────────────────

describe('PMP13–PMP19: MemoryAuthorityService.tryUpdateCanonicalMemory() — PolicyGate enforcement', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('PMP13: calls assertSideEffect with actionKind=memory_write', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await svc.tryUpdateCanonicalMemory('mem-pmp-01', { content_text: 'new text' });

        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ actionKind: 'memory_write' }),
        );
    });

    it('PMP14: passes executionMode to assertSideEffect', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await svc.tryUpdateCanonicalMemory('mem-pmp-01', { content_text: 'new text' }, { executionMode: 'system' });

        const ctx = spy.mock.calls[0][0];
        expect(ctx.executionMode).toBe('system');
    });

    it('PMP15: passes targetSubsystem=MemoryAuthorityService', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await svc.tryUpdateCanonicalMemory('mem-pmp-01', { content_text: 'new text' });

        const ctx = spy.mock.calls[0][0];
        expect(ctx.targetSubsystem).toBe('MemoryAuthorityService');
    });

    it('PMP16: passes mutationIntent=write', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await svc.tryUpdateCanonicalMemory('mem-pmp-01', { content_text: 'new text' });

        const ctx = spy.mock.calls[0][0];
        expect(ctx.mutationIntent).toBe('write');
    });

    it('PMP17: blocked in rp mode returns success:false with PolicyDeniedError in _cause', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        const result = await svc.tryUpdateCanonicalMemory('mem-pmp-01', { content_text: 'blocked' }, { executionMode: 'rp' });
        expect(result.success).toBe(false);
        expect(result._cause).toBeInstanceOf(PolicyDeniedError);
    });

    it('PMP18: blocked does NOT call pool.query', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        const result = await svc.tryUpdateCanonicalMemory('mem-pmp-01', { content_text: 'blocked' }, { executionMode: 'rp' });
        expect(result.success).toBe(false);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('PMP19: allowed in system mode — returns success:true', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        // no spy mock — uses real policyGate; system mode should not block
        const result = await svc.tryUpdateCanonicalMemory('mem-pmp-01', { content_text: 'updated text' }, { executionMode: 'system' });
        expect(result.success).toBe(true);
    });
});

// ─── PMP20–PMP27: tryTombstoneMemory() enforcement ───────────────────────────

describe('PMP20–PMP27: MemoryAuthorityService.tryTombstoneMemory() — PolicyGate enforcement', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('PMP20: calls assertSideEffect with actionKind=memory_write', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await svc.tryTombstoneMemory('mem-pmp-01');

        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ actionKind: 'memory_write' }),
        );
    });

    it('PMP21: passes executionMode to assertSideEffect', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await svc.tryTombstoneMemory('mem-pmp-01', { executionMode: 'assistant' });

        const ctx = spy.mock.calls[0][0];
        expect(ctx.executionMode).toBe('assistant');
    });

    it('PMP22: passes targetSubsystem=MemoryAuthorityService', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await svc.tryTombstoneMemory('mem-pmp-01');

        const ctx = spy.mock.calls[0][0];
        expect(ctx.targetSubsystem).toBe('MemoryAuthorityService');
    });

    it('PMP23: passes mutationIntent=write', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await svc.tryTombstoneMemory('mem-pmp-01');

        const ctx = spy.mock.calls[0][0];
        expect(ctx.mutationIntent).toBe('write');
    });

    it('PMP24: blocked in rp mode returns success:false with PolicyDeniedError in _cause', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        const result = await svc.tryTombstoneMemory('mem-pmp-01', { executionMode: 'rp' });
        expect(result.success).toBe(false);
        expect(result._cause).toBeInstanceOf(PolicyDeniedError);
    });

    it('PMP25: blocked does NOT call pool.query', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        const result = await svc.tryTombstoneMemory('mem-pmp-01', { executionMode: 'rp' });
        expect(result.success).toBe(false);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('PMP26: PolicyDeniedError captured in _cause from tryUpdateCanonicalMemory', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        const result = await svc.tryUpdateCanonicalMemory('mem-pmp-01', { content_text: 'blocked' }, { executionMode: 'rp' });
        expect(result.success).toBe(false);
        expect(result._cause).toBeInstanceOf(PolicyDeniedError);
        const denied = result._cause as PolicyDeniedError;
        expect(denied.decision.code).toBe('TEST_MEM_BLOCK');
        expect(denied.decision.reason).toContain('blocked by test rule');
    });

    it('PMP27: PolicyDeniedError captured in _cause from tryTombstoneMemory', async () => {
        const pool = makePool();
        const svc = new MemoryAuthorityService(pool as any);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        const result = await svc.tryTombstoneMemory('mem-pmp-01', { executionMode: 'rp' });
        expect(result.success).toBe(false);
        expect(result._cause).toBeInstanceOf(PolicyDeniedError);
        const denied = result._cause as PolicyDeniedError;
        expect(denied.decision.code).toBe('TEST_MEM_BLOCK');
        expect(denied.decision.reason).toContain('blocked by test rule');
    });
});
