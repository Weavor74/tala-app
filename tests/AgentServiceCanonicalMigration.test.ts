/**
 * AgentServiceCanonicalMigration.test.ts
 *
 * Validates the three AgentService call-site patterns that were migrated
 * from direct createCanonicalMemory() throws to tryCreateCanonicalMemory()
 * normalized results.
 *
 * Tests cover the three distinct caller patterns:
 *   ACMS1  _getCanonicalIdForTool: success → returns memory ID
 *   ACMS2  _getCanonicalIdForTool: DB failure → returns null, logs warning
 *   ACMS3  _getCanonicalIdForTool: policy block → returns null, logs warning
 *   ACMS4  post-turn storeMemories: success → canonicalMemoryId populated
 *   ACMS5  post-turn storeMemories: failure → canonicalMemoryId stays null
 *   ACMS6  post-turn storeMemories: executionId (turnId) threaded into context
 *   ACMS7  addMemory: success → canonicalMemoryId populated
 *   ACMS8  addMemory: failure → canonicalMemoryId stays null, logs warning
 *   ACMS9  addMemory: policy block → no DB query, canonicalMemoryId stays null
 *   ACMS10 all failure paths: result.success === false, no throw propagates
 *   ACMS11 durationMs present on every result regardless of outcome
 *
 * Uses a mock pg Pool — no real database connection required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryAuthorityService } from '../electron/services/memory/MemoryAuthorityService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../shared/runtimeEventTypes';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
}));

// ---------------------------------------------------------------------------
// Mock pool helpers (same style as MemoryAuthorityService.test.ts)
// ---------------------------------------------------------------------------

function poolWithRows(rows: Record<string, unknown>[]) {
    return {
        query: vi.fn().mockResolvedValue({ rows }),
    };
}

function poolSequenced(responses: Array<{ rows: Record<string, unknown>[] }>) {
    let call = 0;
    return {
        query: vi.fn().mockImplementation(() => {
            const resp = responses[Math.min(call, responses.length - 1)];
            call++;
            return Promise.resolve(resp);
        }),
    };
}

function poolAlwaysReject(message: string) {
    return {
        query: vi.fn().mockImplementation((sql: string) => {
            // Allow the duplicate-detection SELECT to succeed so the INSERT fails
            if (sql.includes('FROM memory_records') && sql.includes('canonical_hash')) {
                return Promise.resolve({ rows: [] });
            }
            return Promise.reject(new Error(message));
        }),
    };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const MEMORY_ID = '00000000-0000-0000-0000-000000000099';
const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeMemoryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        memory_id: MEMORY_ID,
        memory_type: 'interaction',
        subject_type: 'conversation',
        subject_id: 'turn-1',
        content_text: 'hello',
        content_structured: null,
        canonical_hash: 'abc123',
        authority_status: 'canonical',
        version: 1,
        confidence: 1.0,
        source_kind: 'conversation',
        source_ref: 'turn:turn-1',
        created_at: NOW,
        updated_at: NOW,
        valid_from: NOW,
        valid_to: null,
        tombstoned_at: null,
        supersedes_memory_id: null,
        ...overrides,
    };
}

/** Successful pool sequence: dup-check empty → INSERT → lineage → 3 projection rows */
function successPool() {
    return poolSequenced([
        { rows: [] },                        // dup check
        { rows: [{ memory_id: MEMORY_ID }] }, // INSERT
        { rows: [] },                        // lineage
        { rows: [] }, { rows: [] }, { rows: [] }, // projections
    ]);
}

// ---------------------------------------------------------------------------
// Caller pattern 1 — _getCanonicalIdForTool
//
// This callback is constructed in AgentService constructor and passed to
// ToolService. It must: return the canonical ID on success, return null on
// any failure without throwing.
// ---------------------------------------------------------------------------

describe('ACMS1–ACMS3: _getCanonicalIdForTool caller pattern', () => {
    /**
     * Simulates the _getCanonicalIdForTool pattern extracted from AgentService:
     *   const result = await authorityService.tryCreateCanonicalMemory(input);
     *   if (!result.success) { console.warn(...); return null; }
     *   return result.data ?? null;
     */
    async function callPattern(authorityService: MemoryAuthorityService, sourceKind: string): Promise<string | null> {
        const result = await authorityService.tryCreateCanonicalMemory({
            memory_type: 'explicit_fact',
            subject_type: 'user',
            subject_id: 'user',
            content_text: 'some text',
            source_kind: sourceKind,
            source_ref: sourceKind,
            confidence: 0.9,
        });
        if (!result.success) {
            console.warn(`[AgentService] P7A canonical write failed for ${sourceKind}:`, result.error);
            return null;
        }
        return result.data ?? null;
    }

    it('ACMS1: returns canonical memory ID on success', async () => {
        const pool = successPool();
        const svc = new MemoryAuthorityService(pool as never);
        const id = await callPattern(svc, 'mem0_add');
        expect(id).toBe(MEMORY_ID);
    });

    it('ACMS2: returns null when DB throws — does not propagate the error', async () => {
        const pool = poolAlwaysReject('connection reset');
        const svc = new MemoryAuthorityService(pool as never);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const id = await callPattern(svc, 'mem0_add');
        expect(id).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('P7A canonical write failed'),
            expect.stringContaining('connection reset'),
        );
        warnSpy.mockRestore();
    });

    it('ACMS3: returns null when policy blocks — no DB query issued', async () => {
        const { policyGate: pg } = await import('../electron/services/policy/PolicyGate');
        const spy = vi.spyOn(pg, 'assertSideEffect').mockImplementationOnce(() => {
            throw Object.assign(new Error('memory_write blocked'), { name: 'PolicyDeniedError' });
        });

        const pool = { query: vi.fn() };
        const svc = new MemoryAuthorityService(pool as never);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const id = await callPattern(svc, 'mem0_add');

        expect(id).toBeNull();
        expect(pool.query).not.toHaveBeenCalled();
        spy.mockRestore();
        warnSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// Caller pattern 2 — post-turn storeMemories
//
// Fire-and-forget async block called after every chat turn. Populates
// canonicalMemoryId that is forwarded to derived stores. Must not throw.
// ExecutionId (turnId) must be threaded into MemoryInvocationContext.
// ---------------------------------------------------------------------------

describe('ACMS4–ACMS6: post-turn storeMemories caller pattern', () => {
    let capturedEvents: RuntimeEvent[];
    let unsub: () => void;

    beforeEach(() => {
        TelemetryBus._resetForTesting();
        capturedEvents = [];
        unsub = TelemetryBus.getInstance().subscribe((evt) => capturedEvents.push(evt));
    });

    afterEach(() => {
        unsub();
        TelemetryBus._resetForTesting();
    });

    /**
     * Simulates the storeMemories canonical-write block extracted from AgentService:
     *   const writeResult = await authorityService.tryCreateCanonicalMemory(input, { executionId: turnId });
     *   if (writeResult.success) { canonicalMemoryId = writeResult.data ?? null; }
     *   else { console.warn(...); }
     */
    async function callPattern(
        authorityService: MemoryAuthorityService,
        turnId: string,
    ): Promise<string | null> {
        let canonicalMemoryId: string | null = null;
        const writeResult = await authorityService.tryCreateCanonicalMemory({
            memory_type: 'interaction',
            subject_type: 'conversation',
            subject_id: turnId,
            content_text: `[2026-01-01T00:00] User: "hi" | Tala: "hello"`,
            content_structured: {
                user_message: 'hi',
                agent_response: 'hello',
                mode: 'assistant',
                turn_id: turnId,
            },
            confidence: 1.0,
            source_kind: 'conversation',
            source_ref: `turn:${turnId}`,
        }, { executionId: turnId });

        if (writeResult.success) {
            canonicalMemoryId = writeResult.data ?? null;
        } else {
            console.warn('[AgentService] P7A canonical write failed:', writeResult.error);
        }
        return canonicalMemoryId;
    }

    it('ACMS4: success — canonicalMemoryId is populated with the returned ID', async () => {
        const pool = successPool();
        const svc = new MemoryAuthorityService(pool as never);
        const id = await callPattern(svc, 'turn-abc');
        expect(id).toBe(MEMORY_ID);
    });

    it('ACMS5: DB failure — canonicalMemoryId stays null, warning logged, no throw', async () => {
        const pool = poolAlwaysReject('db timeout');
        const svc = new MemoryAuthorityService(pool as never);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const id = await callPattern(svc, 'turn-abc');
        expect(id).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('P7A canonical write failed'),
            expect.stringContaining('db timeout'),
        );
        warnSpy.mockRestore();
    });

    it('ACMS6: executionId (turnId) is threaded through to telemetry events', async () => {
        const pool = successPool();
        const svc = new MemoryAuthorityService(pool as never);
        const turnId = 'turn-exec-correlation-xyz';
        await callPattern(svc, turnId);
        const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
        expect(memEvents.length).toBeGreaterThan(0);
        expect(memEvents.every(e => e.executionId === turnId)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Caller pattern 3 — addMemory public method
//
// Public API entry point. Must not throw. Populates canonicalMemoryId for
// downstream derived store reference.
// ---------------------------------------------------------------------------

describe('ACMS7–ACMS9: addMemory caller pattern', () => {
    /**
     * Simulates the addMemory canonical-write block extracted from AgentService:
     *   const result = await authorityService.tryCreateCanonicalMemory(input);
     *   if (result.success) { canonicalMemoryId = result.data ?? null; }
     *   else { console.warn(...); }
     */
    async function callPattern(authorityService: MemoryAuthorityService, text: string): Promise<string | null> {
        let canonicalMemoryId: string | null = null;
        const result = await authorityService.tryCreateCanonicalMemory({
            memory_type: 'explicit_fact',
            subject_type: 'user',
            subject_id: 'user',
            content_text: text,
            source_kind: 'explicit',
            source_ref: 'addMemory',
            confidence: 0.9,
        });
        if (result.success) {
            canonicalMemoryId = result.data ?? null;
        } else {
            console.warn('[AgentService:addMemory] P7A canonical write failed:', result.error);
        }
        return canonicalMemoryId;
    }

    it('ACMS7: success — canonicalMemoryId is populated', async () => {
        const pool = successPool();
        const svc = new MemoryAuthorityService(pool as never);
        const id = await callPattern(svc, 'remember this fact');
        expect(id).toBe(MEMORY_ID);
    });

    it('ACMS8: DB failure — canonicalMemoryId stays null, warning logged, no throw', async () => {
        const pool = poolAlwaysReject('write failed');
        const svc = new MemoryAuthorityService(pool as never);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const id = await callPattern(svc, 'remember this fact');
        expect(id).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('P7A canonical write failed'),
            expect.stringContaining('write failed'),
        );
        warnSpy.mockRestore();
    });

    it('ACMS9: policy block — no DB query issued, canonicalMemoryId stays null', async () => {
        const { policyGate: pg } = await import('../electron/services/policy/PolicyGate');
        const spy = vi.spyOn(pg, 'assertSideEffect').mockImplementationOnce(() => {
            throw Object.assign(new Error('memory_write blocked in rp mode'), { name: 'PolicyDeniedError' });
        });

        const pool = { query: vi.fn() };
        const svc = new MemoryAuthorityService(pool as never);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const id = await callPattern(svc, 'blocked fact');

        expect(id).toBeNull();
        expect(pool.query).not.toHaveBeenCalled();
        spy.mockRestore();
        warnSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// Cross-pattern assertions
// ---------------------------------------------------------------------------

describe('ACMS10–ACMS11: cross-pattern guarantees', () => {
    it('ACMS10: no failure path propagates an exception — all patterns return safely', async () => {
        const pool = poolAlwaysReject('unexpected db error');
        const svc = new MemoryAuthorityService(pool as never);

        // All three patterns must resolve without throwing
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Pattern 1
        const r1 = await svc.tryCreateCanonicalMemory({
            memory_type: 'explicit_fact', subject_type: 'user', subject_id: 'user',
            content_text: 'x', source_kind: 'mem0_add', source_ref: 'mem0_add', confidence: 0.9,
        });
        expect(r1.success).toBe(false);

        // Pattern 2
        const r2 = await svc.tryCreateCanonicalMemory({
            memory_type: 'interaction', subject_type: 'conversation', subject_id: 'turn-1',
            content_text: 'y', confidence: 1.0, source_kind: 'conversation', source_ref: 'turn:t1',
        }, { executionId: 'turn-1' });
        expect(r2.success).toBe(false);

        // Pattern 3
        const r3 = await svc.tryCreateCanonicalMemory({
            memory_type: 'explicit_fact', subject_type: 'user', subject_id: 'user',
            content_text: 'z', source_kind: 'explicit', source_ref: 'addMemory', confidence: 0.9,
        });
        expect(r3.success).toBe(false);

        warnSpy.mockRestore();
    });

    it('ACMS11: durationMs is always present on result, regardless of outcome', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const successPool_ = successPool();
        const failPool = poolAlwaysReject('err');

        const svcOk = new MemoryAuthorityService(successPool_ as never);
        const svcFail = new MemoryAuthorityService(failPool as never);

        const input = {
            memory_type: 'interaction', subject_type: 'conversation',
            subject_id: 'turn-1', content_text: 'hello',
        };

        const ok = await svcOk.tryCreateCanonicalMemory(input);
        const fail = await svcFail.tryCreateCanonicalMemory(input);

        expect(typeof ok.durationMs).toBe('number');
        expect(ok.durationMs).toBeGreaterThanOrEqual(0);
        expect(typeof fail.durationMs).toBe('number');
        expect(fail.durationMs).toBeGreaterThanOrEqual(0);

        warnSpy.mockRestore();
    });
});
