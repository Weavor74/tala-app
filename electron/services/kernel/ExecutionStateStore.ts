/**
 * ExecutionStateStore.ts — In-Memory Execution State Store
 *
 * Provides lightweight CRUD for runtime ExecutionState objects during a
 * Tala session. All state is held in a plain Map keyed by executionId.
 * No persistence, no disk I/O, no external dependencies.
 *
 * Design principles:
 * - Single responsibility: store and retrieve ExecutionState values only
 * - Immutable reads: get() and getAll() return deep copies (via structuredClone)
 *   so callers cannot mutate stored state — including nested arrays — directly
 * - Safe writes: upsert() deep-copies on entry so mutations to the caller's
 *   object after upsert() do not affect the stored record
 * - Bounded: enforces a max-size cap to prevent unbounded memory growth
 *   during long sessions; oldest entry is evicted when the cap is reached
 * - No side-effects: no IPC, no telemetry, no logging from within the store
 *
 * Callers that need to advance execution state should use the helper
 * functions in `shared/runtime/executionHelpers.ts` to produce the updated
 * state value, then pass it to upsert().
 */

import type { ExecutionState, RuntimeExecutionStatus } from '../../../shared/runtime/executionTypes';

// ─── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Maximum number of ExecutionState entries held in memory at one time.
 * When this limit is reached the oldest entry (by insertion order) is evicted.
 *
 * Sizing rationale: a typical Tala session generates roughly 1 entry per
 * chat turn plus autonomy runs. 2000 entries at ~1–2 KB each ≈ 2–4 MB,
 * well within acceptable memory for a long-running desktop session. Adjust
 * upward if session volumes grow significantly beyond ~1000 turns/day.
 */
const MAX_STORE_SIZE = 2000;

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * ExecutionStateStore
 *
 * In-memory store for tracking the lifecycle state of all active and recently
 * completed execution units within a Tala runtime session.
 *
 * Usage:
 *   const store = new ExecutionStateStore();
 *   store.upsert(initialState);
 *   const state = store.get(executionId);
 *   store.upsert(advanceExecutionState(state!, 'executing', 'tool_dispatch'));
 *   store.delete(executionId);
 */
export class ExecutionStateStore {
    private readonly _store: Map<string, ExecutionState> = new Map();

    // ─── Write ────────────────────────────────────────────────────────────────

    /**
     * Insert or replace the ExecutionState for the given executionId.
     *
     * If the store is at capacity the oldest entry is evicted before inserting
     * the new one, so the store size never exceeds MAX_STORE_SIZE.
     *
     * @param state  The ExecutionState to store. Must have a non-empty executionId.
     * @throws {Error} If state.executionId is empty.
     */
    upsert(state: ExecutionState): void {
        if (!state.executionId) {
            throw new Error('ExecutionStateStore.upsert: state.executionId must not be empty');
        }
        // Evict oldest entry only when we are at cap and this is a new key
        if (!this._store.has(state.executionId) && this._store.size >= MAX_STORE_SIZE) {
            const oldestKey = this._store.keys().next().value;
            if (oldestKey !== undefined) {
                this._store.delete(oldestKey);
            }
        }
        this._store.set(state.executionId, structuredClone(state));
    }

    // ─── Read ─────────────────────────────────────────────────────────────────

    /**
     * Returns a deep copy of the stored ExecutionState, or `undefined` if
     * no entry exists for the given executionId.
     *
     * The returned value is fully independent: mutating top-level fields or
     * nested arrays (e.g. `toolCalls`) will not affect the stored record.
     */
    get(executionId: string): ExecutionState | undefined {
        const entry = this._store.get(executionId);
        return entry !== undefined ? structuredClone(entry) : undefined;
    }

    /**
     * Returns true when an entry exists for the given executionId.
     */
    has(executionId: string): boolean {
        return this._store.has(executionId);
    }

    /**
     * Returns deep copies of all stored ExecutionState entries.
     * Order follows Map insertion order (oldest first).
     */
    getAll(): ExecutionState[] {
        return Array.from(this._store.values()).map(s => structuredClone(s));
    }

    /**
     * Returns deep copies of all entries whose `status` matches one of the
     * provided statuses.
     */
    getByStatus(...statuses: RuntimeExecutionStatus[]): ExecutionState[] {
        const statusSet = new Set<string>(statuses);
        return Array.from(this._store.values())
            .filter(s => statusSet.has(s.status))
            .map(s => structuredClone(s));
    }

    // ─── Delete ───────────────────────────────────────────────────────────────

    /**
     * Removes the entry for the given executionId.
     * Returns true if an entry was removed, false if the key was not found.
     */
    delete(executionId: string): boolean {
        return this._store.delete(executionId);
    }

    /**
     * Removes all entries from the store.
     * Useful for test teardown or explicit session resets.
     */
    clear(): void {
        this._store.clear();
    }

    // ─── Introspection ────────────────────────────────────────────────────────

    /**
     * Current number of entries in the store.
     */
    get size(): number {
        return this._store.size;
    }
}
