/**
 * ExecutionStateStore.test.ts
 *
 * Unit tests for the in-memory ExecutionStateStore.
 *
 * Covers:
 *   ESS1  upsert — insert and replace
 *   ESS2  get    — present / missing / copy isolation
 *   ESS3  has    — membership check
 *   ESS4  getAll — full snapshot
 *   ESS5  getByStatus — status filter
 *   ESS6  delete — removal
 *   ESS7  clear  — full reset
 *   ESS8  size   — count tracking
 *   ESS9  bounds — max-size eviction
 *   ESS10 validation — empty executionId guard
 *   ESS11 beginExecution — convenience lifecycle create
 *   ESS12 advancePhase   — convenience lifecycle advance
 *   ESS13 completeExecution — convenience lifecycle terminal (completed)
 *   ESS14 failExecution     — convenience lifecycle terminal (failed)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionStateStore } from '../electron/services/kernel/ExecutionStateStore';
import {
    createExecutionRequest,
    createInitialExecutionState,
    advanceExecutionState,
    finalizeExecutionState,
} from '../shared/runtime/executionHelpers';
import type { ExecutionState } from '../shared/runtime/executionTypes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<ExecutionState> = {}): ExecutionState {
    const req = createExecutionRequest({
        type: 'chat_turn',
        origin: 'chat_ui',
        mode: 'assistant',
        actor: 'test-user',
        input: 'hello',
    });
    const base = createInitialExecutionState(req, 'AgentKernel');
    return { ...base, ...overrides };
}

// ─── ESS1: upsert ─────────────────────────────────────────────────────────────

describe('ESS1: upsert', () => {
    let store: ExecutionStateStore;
    beforeEach(() => { store = new ExecutionStateStore(); });

    it('inserts a new entry', () => {
        const s = makeState();
        store.upsert(s);
        expect(store.size).toBe(1);
        expect(store.has(s.executionId)).toBe(true);
    });

    it('replaces an existing entry', () => {
        const s = makeState();
        store.upsert(s);
        const advanced = advanceExecutionState(s, 'executing', 'tool_dispatch');
        store.upsert(advanced);
        expect(store.size).toBe(1);
        expect(store.get(s.executionId)?.status).toBe('executing');
        expect(store.get(s.executionId)?.phase).toBe('tool_dispatch');
    });

    it('stores a copy so the caller cannot mutate stored state', () => {
        const s = makeState();
        store.upsert(s);
        // mutate the original after upsert
        (s as Record<string, unknown>).status = 'failed';
        expect(store.get(s.executionId)?.status).toBe('accepted');
    });
});

// ─── ESS2: get ────────────────────────────────────────────────────────────────

describe('ESS2: get', () => {
    let store: ExecutionStateStore;
    beforeEach(() => { store = new ExecutionStateStore(); });

    it('returns undefined for an unknown executionId', () => {
        expect(store.get('not-here')).toBeUndefined();
    });

    it('returns the stored state for a known executionId', () => {
        const s = makeState();
        store.upsert(s);
        const retrieved = store.get(s.executionId);
        expect(retrieved).toBeDefined();
        expect(retrieved?.executionId).toBe(s.executionId);
    });

    it('returns a copy so the caller cannot mutate stored state via get()', () => {
        const s = makeState();
        store.upsert(s);
        const copy = store.get(s.executionId)!;
        copy.status = 'failed';
        // stored value must still be 'accepted'
        expect(store.get(s.executionId)?.status).toBe('accepted');
    });

    it('returns a deep copy: mutating toolCalls array in get() result does not affect stored state', () => {
        const s = makeState();
        store.upsert(s);
        const copy = store.get(s.executionId)!;
        copy.toolCalls.push('tool-x');
        expect(store.get(s.executionId)?.toolCalls).toHaveLength(0);
    });
});

// ─── ESS3: has ────────────────────────────────────────────────────────────────

describe('ESS3: has', () => {
    let store: ExecutionStateStore;
    beforeEach(() => { store = new ExecutionStateStore(); });

    it('returns false for an absent key', () => {
        expect(store.has('missing')).toBe(false);
    });

    it('returns true after upsert', () => {
        const s = makeState();
        store.upsert(s);
        expect(store.has(s.executionId)).toBe(true);
    });

    it('returns false after delete', () => {
        const s = makeState();
        store.upsert(s);
        store.delete(s.executionId);
        expect(store.has(s.executionId)).toBe(false);
    });
});

// ─── ESS4: getAll ─────────────────────────────────────────────────────────────

describe('ESS4: getAll', () => {
    let store: ExecutionStateStore;
    beforeEach(() => { store = new ExecutionStateStore(); });

    it('returns empty array when store is empty', () => {
        expect(store.getAll()).toEqual([]);
    });

    it('returns all inserted entries', () => {
        const a = makeState();
        const b = makeState();
        store.upsert(a);
        store.upsert(b);
        const all = store.getAll();
        expect(all).toHaveLength(2);
        const ids = all.map(s => s.executionId);
        expect(ids).toContain(a.executionId);
        expect(ids).toContain(b.executionId);
    });

    it('returns copies (mutating result does not affect store)', () => {
        const s = makeState();
        store.upsert(s);
        const all = store.getAll();
        all[0].status = 'failed';
        expect(store.get(s.executionId)?.status).toBe('accepted');
    });
});

// ─── ESS5: getByStatus ────────────────────────────────────────────────────────

describe('ESS5: getByStatus', () => {
    let store: ExecutionStateStore;
    beforeEach(() => { store = new ExecutionStateStore(); });

    it('returns empty array when no entries match', () => {
        const s = makeState();
        store.upsert(s);
        expect(store.getByStatus('failed')).toHaveLength(0);
    });

    it('filters by a single status', () => {
        const a = makeState();
        const b = makeState();
        const bExecuting = advanceExecutionState(b, 'executing', 'tool_dispatch');
        store.upsert(a);
        store.upsert(bExecuting);
        expect(store.getByStatus('accepted')).toHaveLength(1);
        expect(store.getByStatus('executing')).toHaveLength(1);
    });

    it('filters by multiple statuses', () => {
        const a = makeState();
        const b = makeState();
        const bDone = finalizeExecutionState(b, { status: 'completed' });
        store.upsert(a);
        store.upsert(bDone);
        const results = store.getByStatus('accepted', 'completed');
        expect(results).toHaveLength(2);
    });
});

// ─── ESS6: delete ─────────────────────────────────────────────────────────────

describe('ESS6: delete', () => {
    let store: ExecutionStateStore;
    beforeEach(() => { store = new ExecutionStateStore(); });

    it('returns false for a missing key', () => {
        expect(store.delete('ghost')).toBe(false);
    });

    it('returns true and removes the entry', () => {
        const s = makeState();
        store.upsert(s);
        expect(store.delete(s.executionId)).toBe(true);
        expect(store.has(s.executionId)).toBe(false);
        expect(store.size).toBe(0);
    });

    it('does not affect other entries', () => {
        const a = makeState();
        const b = makeState();
        store.upsert(a);
        store.upsert(b);
        store.delete(a.executionId);
        expect(store.has(b.executionId)).toBe(true);
        expect(store.size).toBe(1);
    });
});

// ─── ESS7: clear ──────────────────────────────────────────────────────────────

describe('ESS7: clear', () => {
    let store: ExecutionStateStore;
    beforeEach(() => { store = new ExecutionStateStore(); });

    it('empties the store', () => {
        store.upsert(makeState());
        store.upsert(makeState());
        store.clear();
        expect(store.size).toBe(0);
        expect(store.getAll()).toEqual([]);
    });

    it('is safe to call on an already-empty store', () => {
        expect(() => store.clear()).not.toThrow();
        expect(store.size).toBe(0);
    });
});

// ─── ESS8: size ───────────────────────────────────────────────────────────────

describe('ESS8: size', () => {
    let store: ExecutionStateStore;
    beforeEach(() => { store = new ExecutionStateStore(); });

    it('starts at 0', () => {
        expect(store.size).toBe(0);
    });

    it('increments with each new entry', () => {
        store.upsert(makeState());
        expect(store.size).toBe(1);
        store.upsert(makeState());
        expect(store.size).toBe(2);
    });

    it('does not increment on upsert of existing key', () => {
        const s = makeState();
        store.upsert(s);
        store.upsert(advanceExecutionState(s, 'executing', 'p'));
        expect(store.size).toBe(1);
    });

    it('decrements on delete', () => {
        const s = makeState();
        store.upsert(s);
        store.delete(s.executionId);
        expect(store.size).toBe(0);
    });
});

// ─── ESS9: bounds (eviction) ──────────────────────────────────────────────────

describe('ESS9: max-size eviction', () => {
    it('never exceeds MAX_STORE_SIZE by evicting the oldest entry', () => {
        // Use a small-sized store analogue by filling to 2000 via direct upsert loop.
        // Instead of re-exposing the constant, we just verify the eviction contract
        // with a fresh store at the actual limit.
        const store = new ExecutionStateStore();
        const MAX = 2000;

        const ids: string[] = [];
        for (let i = 0; i < MAX; i++) {
            const s = makeState();
            ids.push(s.executionId);
            store.upsert(s);
        }
        expect(store.size).toBe(MAX);

        // Insert one more — oldest should be evicted
        const overflow = makeState();
        store.upsert(overflow);
        expect(store.size).toBe(MAX);
        // The first inserted entry must have been evicted
        expect(store.has(ids[0])).toBe(false);
        // The most recently inserted entry must be present
        expect(store.has(overflow.executionId)).toBe(true);
    });
});

// ─── ESS10: validation ────────────────────────────────────────────────────────

describe('ESS10: validation', () => {
    it('throws if executionId is empty string', () => {
        const store = new ExecutionStateStore();
        const s = makeState();
        (s as Record<string, unknown>).executionId = '';
        expect(() => store.upsert(s)).toThrow('ExecutionStateStore.upsert');
    });
});

// ─── ESS11: beginExecution ────────────────────────────────────────────────────

describe('ESS11: beginExecution', () => {
    let store: ExecutionStateStore;
    beforeEach(() => { store = new ExecutionStateStore(); });

    function makeRequest() {
        return createExecutionRequest({
            type: 'chat_turn',
            origin: 'ipc',
            mode: 'assistant',
            actor: 'user',
            input: { message: 'hello' },
        });
    }

    it('inserts an entry and returns the initial state', () => {
        const req = makeRequest();
        const state = store.beginExecution(req, 'AgentKernel');
        expect(store.has(req.executionId)).toBe(true);
        expect(store.size).toBe(1);
        expect(state.executionId).toBe(req.executionId);
    });

    it('initial status is accepted and phase is intake', () => {
        const req = makeRequest();
        const state = store.beginExecution(req);
        expect(state.status).toBe('accepted');
        expect(state.phase).toBe('intake');
    });

    it('stamps activeSubsystem when provided', () => {
        const req = makeRequest();
        const state = store.beginExecution(req, 'AgentKernel');
        expect(state.activeSubsystem).toBe('AgentKernel');
    });

    it('omits activeSubsystem when not provided', () => {
        const req = makeRequest();
        const state = store.beginExecution(req);
        expect(state.activeSubsystem).toBeUndefined();
    });

    it('returns a copy — mutating the return value does not affect the stored entry', () => {
        const req = makeRequest();
        const state = store.beginExecution(req, 'AgentKernel');
        state.status = 'failed' as any;
        expect(store.get(req.executionId)?.status).toBe('accepted');
    });

    it('preserves origin and mode from the request', () => {
        const req = createExecutionRequest({
            type: 'chat_turn',
            origin: 'chat_ui',
            mode: 'rp',
            actor: 'user',
            input: null,
        });
        const state = store.beginExecution(req);
        expect(state.origin).toBe('chat_ui');
        expect(state.mode).toBe('rp');
    });
});

// ─── ESS12: advancePhase ──────────────────────────────────────────────────────

describe('ESS12: advancePhase', () => {
    let store: ExecutionStateStore;
    beforeEach(() => { store = new ExecutionStateStore(); });

    it('updates status and phase for an existing entry', () => {
        const s = makeState();
        store.upsert(s);
        const updated = store.advancePhase(s.executionId, 'executing', 'tool_dispatch');
        expect(updated).toBeDefined();
        expect(updated?.status).toBe('executing');
        expect(updated?.phase).toBe('tool_dispatch');
    });

    it('the stored entry reflects the new status and phase', () => {
        const s = makeState();
        store.upsert(s);
        store.advancePhase(s.executionId, 'planning', 'classifying');
        const stored = store.get(s.executionId);
        expect(stored?.status).toBe('planning');
        expect(stored?.phase).toBe('classifying');
    });

    it('returns undefined for a missing executionId', () => {
        const result = store.advancePhase('ghost-id', 'executing', 'tool_dispatch');
        expect(result).toBeUndefined();
    });

    it('updates updatedAt timestamp', () => {
        const s = makeState();
        store.upsert(s);
        const updated = store.advancePhase(s.executionId, 'executing', 'p')!;
        // updatedAt must be a valid ISO 8601 timestamp
        expect(updated.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // status must have advanced
        expect(updated.status).toBe('executing');
    });

    it('returns a copy — mutating the return value does not affect the stored entry', () => {
        const s = makeState();
        store.upsert(s);
        const updated = store.advancePhase(s.executionId, 'executing', 'tool_dispatch')!;
        updated.status = 'failed' as any;
        expect(store.get(s.executionId)?.status).toBe('executing');
    });

    it('does not affect other entries in the store', () => {
        const a = makeState();
        const b = makeState();
        store.upsert(a);
        store.upsert(b);
        store.advancePhase(a.executionId, 'executing', 'p');
        expect(store.get(b.executionId)?.status).toBe('accepted');
    });
});

// ─── ESS13: completeExecution ─────────────────────────────────────────────────

describe('ESS13: completeExecution', () => {
    let store: ExecutionStateStore;
    beforeEach(() => { store = new ExecutionStateStore(); });

    it('marks an existing entry as completed', () => {
        const s = makeState();
        store.upsert(s);
        const finalized = store.completeExecution(s.executionId);
        expect(finalized?.status).toBe('completed');
    });

    it('sets completedAt and updatedAt', () => {
        const s = makeState();
        store.upsert(s);
        const finalized = store.completeExecution(s.executionId)!;
        expect(finalized.completedAt).toBeDefined();
        expect(finalized.updatedAt).toBeDefined();
    });

    it('returns undefined for a missing executionId', () => {
        expect(store.completeExecution('not-here')).toBeUndefined();
    });

    it('entry persists in the store after completion', () => {
        const s = makeState();
        store.upsert(s);
        store.completeExecution(s.executionId);
        expect(store.has(s.executionId)).toBe(true);
        expect(store.get(s.executionId)?.status).toBe('completed');
    });

    it('supports degraded completion via outcome option', () => {
        const s = makeState();
        store.upsert(s);
        const finalized = store.completeExecution(s.executionId, { degraded: true })!;
        expect(finalized.status).toBe('completed');
        expect(finalized.degraded).toBe(true);
    });

    it('returns a copy — mutating the return value does not affect the stored entry', () => {
        const s = makeState();
        store.upsert(s);
        const finalized = store.completeExecution(s.executionId)!;
        finalized.status = 'failed' as any;
        expect(store.get(s.executionId)?.status).toBe('completed');
    });
});

// ─── ESS14: failExecution ─────────────────────────────────────────────────────

describe('ESS14: failExecution', () => {
    let store: ExecutionStateStore;
    beforeEach(() => { store = new ExecutionStateStore(); });

    it('marks an existing entry as failed with the provided reason', () => {
        const s = makeState();
        store.upsert(s);
        const finalized = store.failExecution(s.executionId, 'llm_timeout');
        expect(finalized?.status).toBe('failed');
        expect(finalized?.failureReason).toBe('llm_timeout');
    });

    it('sets completedAt and updatedAt', () => {
        const s = makeState();
        store.upsert(s);
        const finalized = store.failExecution(s.executionId, 'network_error')!;
        expect(finalized.completedAt).toBeDefined();
        expect(finalized.updatedAt).toBeDefined();
    });

    it('returns undefined for a missing executionId', () => {
        expect(store.failExecution('ghost', 'some_reason')).toBeUndefined();
    });

    it('entry persists in the store after failure', () => {
        const s = makeState();
        store.upsert(s);
        store.failExecution(s.executionId, 'crash');
        expect(store.has(s.executionId)).toBe(true);
        expect(store.get(s.executionId)?.status).toBe('failed');
        expect(store.get(s.executionId)?.failureReason).toBe('crash');
    });

    it('returns a copy — mutating the return value does not affect the stored entry', () => {
        const s = makeState();
        store.upsert(s);
        const finalized = store.failExecution(s.executionId, 'err')!;
        finalized.status = 'completed' as any;
        expect(store.get(s.executionId)?.status).toBe('failed');
    });
});
