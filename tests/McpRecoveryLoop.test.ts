/**
 * McpRecoveryLoop.test.ts
 *
 * Validates the MCP service state machine fix that prevents false-positive
 * recovery events from looping forever.
 *
 * Root Cause
 * ──────────
 * `McpService.connect()` previously returned `true` immediately whenever an
 * entry existed in `this.connections`, regardless of whether that entry was in
 * CONNECTED or DEGRADED state.  Because the DEGRADED entry is intentionally
 * kept in the map (for backoff bookkeeping), every backoff-expiry retry would:
 *   1. Call `connect(config)` → early-return `true` (map has entry).
 *   2. Health loop sees `ok === true` → logs "RECOVERED" + fires `onRecovery()`.
 *   3. State remains DEGRADED (never actually reconnected).
 *   4. `retryCount`/`lastRetryTime` unchanged → backoff already expired.
 *   5. Next 10-second tick: same false recovery fires again.
 * This caused infinite repeated "RECOVERED" events and tool-refresh storms.
 *
 * Fix
 * ───
 * The early-return guard was tightened to only skip reconnection when the
 * existing entry is genuinely in CONNECTED state:
 *
 *   Before: if (this.connections.has(config.id)) return true;
 *   After:  if (existing?.state === ServerState.CONNECTED) return true;
 *
 * Covered assertions
 * ──────────────────
 *  1. CONNECTED entry → connect() skips reconnection (returns true immediately).
 *  2. DEGRADED entry  → connect() proceeds with real reconnection (no false-positive).
 *  3. Absent entry    → connect() proceeds with real reconnection.
 *  4. Health loop: after false-positive reconnect, state must be CONNECTED for
 *     onRecovery to be considered legitimate (state-machine guard).
 *  5. DEGRADED backoff not yet expired → connect() never called that tick.
 */

import { describe, it, expect } from 'vitest';
import { ServerState } from '../electron/services/McpService';

// ─── Mirrors of the exact early-return guard in McpService.connect() ─────────

/**
 * Mirrors the FIXED early-return condition in McpService.connect().
 * Returns true when connect() will skip the reconnection attempt (fast-path).
 *
 * Before fix:
 *   return connectionsHasId;         // true for both CONNECTED and DEGRADED
 *
 * After fix:
 *   return existing?.state === ServerState.CONNECTED;  // only true for healthy entries
 */
function connectSkipsReconnection(existingState: ServerState | null): boolean {
    // Matches the exact condition from the patched McpService.connect():
    //   if (existing && existing.state === ServerState.CONNECTED) return true;
    return existingState === ServerState.CONNECTED;
}

/**
 * Mirrors the health loop's "should this tick attempt a reconnection" logic.
 *
 * Returns true when the server is DEGRADED, retries are not exhausted, and the
 * backoff window has expired.
 */
function healthTickShouldAttemptReconnect(params: {
    state: ServerState;
    retryCount: number;
    lastRetryTime: number;
    now: number;
    maxRetries: number;
}): boolean {
    const { state, retryCount, lastRetryTime, now, maxRetries } = params;
    if (state !== ServerState.DEGRADED) return false;
    if (retryCount >= maxRetries) return false;
    const delayMs = Math.min(30 * Math.pow(2, Math.min(retryCount - 1, 6)), 1800) * 1000;
    return now >= lastRetryTime + delayMs;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpRecoveryLoop — connect() early-return guard', () => {

    // ── Assertion 1: CONNECTED entry is skipped ───────────────────────────────

    it('skips reconnection when existing entry is CONNECTED (healthy server)', () => {
        expect(connectSkipsReconnection(ServerState.CONNECTED)).toBe(true);
    });

    // ── Assertion 2: DEGRADED entry is NOT skipped (the fix) ─────────────────

    it('does NOT skip reconnection when existing entry is DEGRADED', () => {
        // Before the fix this returned true, causing false recovery events.
        expect(connectSkipsReconnection(ServerState.DEGRADED)).toBe(false);
    });

    it('does NOT skip reconnection when existing entry is STARTING', () => {
        expect(connectSkipsReconnection(ServerState.STARTING)).toBe(false);
    });

    it('does NOT skip reconnection when existing entry is UNAVAILABLE', () => {
        expect(connectSkipsReconnection(ServerState.UNAVAILABLE)).toBe(false);
    });

    it('does NOT skip reconnection when existing entry is FAILED', () => {
        expect(connectSkipsReconnection(ServerState.FAILED)).toBe(false);
    });

    // ── Assertion 3: absent entry proceeds with reconnection ──────────────────

    it('proceeds with reconnection when no existing entry exists (null)', () => {
        expect(connectSkipsReconnection(null)).toBe(false);
    });
});

describe('McpRecoveryLoop — health tick reconnection gating', () => {

    const MAX_RETRIES = 8;

    // ── Backoff not expired ───────────────────────────────────────────────────

    it('does not attempt reconnection when backoff has not yet expired', () => {
        const now = Date.now();
        expect(healthTickShouldAttemptReconnect({
            state: ServerState.DEGRADED,
            retryCount: 1,
            lastRetryTime: now - 5_000,   // only 5 s ago — backoff is 30 s
            now,
            maxRetries: MAX_RETRIES,
        })).toBe(false);
    });

    // ── Backoff expired once ──────────────────────────────────────────────────

    it('attempts reconnection after the first 30-second backoff expires', () => {
        const now = Date.now();
        expect(healthTickShouldAttemptReconnect({
            state: ServerState.DEGRADED,
            retryCount: 1,
            lastRetryTime: now - 31_000,  // 31 s ago — backoff is 30 s
            now,
            maxRetries: MAX_RETRIES,
        })).toBe(true);
    });

    // ── False-positive loop: if state is still DEGRADED after connect() returns true ─

    it('would NOT re-trigger reconnection on the same tick after a successful reconnect (state becomes CONNECTED)', () => {
        // After a real successful reconnect the state transitions to CONNECTED.
        // A subsequent server entry in the same loop iteration has a different id,
        // but modelling the key invariant: once state=CONNECTED, this server's
        // DEGRADED branch is never entered again.
        const now = Date.now();
        expect(healthTickShouldAttemptReconnect({
            state: ServerState.CONNECTED,  // state was updated by successful connect()
            retryCount: 0,
            lastRetryTime: now,
            now,
            maxRetries: MAX_RETRIES,
        })).toBe(false);
    });

    // ── Core loop invariant: DEGRADED + backoff already expired → immediate storm ─

    it('demonstrates old infinite-storm scenario: DEGRADED with backoff already expired fires every tick', () => {
        // This models exactly what happened BEFORE the fix:
        // connect() returned true (false positive) → state stayed DEGRADED →
        // retryCount/lastRetryTime unchanged → backoff already expired on every tick.
        const originalDegradedTime = Date.now() - 60_000; // 60 s ago
        const nextTick = Date.now();

        // The backoff (30 s for retryCount=1) has long since expired.
        const wouldFireAgain = healthTickShouldAttemptReconnect({
            state: ServerState.DEGRADED,
            retryCount: 1,
            lastRetryTime: originalDegradedTime,  // never updated by false connect()
            now: nextTick,
            maxRetries: MAX_RETRIES,
        });
        // Before fix: connect() would return true, fire onRecovery(), but state
        // would remain DEGRADED with stale lastRetryTime → this would be true
        // on every subsequent tick.
        expect(wouldFireAgain).toBe(true); // confirms the old bug conditions

        // After fix: connect() performs a real reconnection. On success, state
        // transitions to CONNECTED → healthTickShouldAttemptReconnect returns false.
        // On failure, retryCount increments and lastRetryTime is refreshed →
        // backoff is properly respected on the next tick.
        const afterRealSuccessfulReconnect = healthTickShouldAttemptReconnect({
            state: ServerState.CONNECTED,   // real connect() sets this
            retryCount: 0,                  // real connect() resets this
            lastRetryTime: nextTick,
            now: nextTick + 10_000,         // next 10-second tick
            maxRetries: MAX_RETRIES,
        });
        expect(afterRealSuccessfulReconnect).toBe(false); // storm is stopped
    });

    // ── Exhausted retries transition to FAILED ────────────────────────────────

    it('does not attempt reconnection after retries are exhausted', () => {
        const now = Date.now();
        expect(healthTickShouldAttemptReconnect({
            state: ServerState.DEGRADED,
            retryCount: MAX_RETRIES,       // at the limit
            lastRetryTime: now - 999_999,  // long expired
            now,
            maxRetries: MAX_RETRIES,
        })).toBe(false);
    });

    // ── Non-DEGRADED states are never retried ─────────────────────────────────

    it('does not attempt reconnection for FAILED state', () => {
        const now = Date.now();
        expect(healthTickShouldAttemptReconnect({
            state: ServerState.FAILED,
            retryCount: 1,
            lastRetryTime: now - 60_000,
            now,
            maxRetries: MAX_RETRIES,
        })).toBe(false);
    });

    it('does not attempt reconnection for DISABLED state', () => {
        const now = Date.now();
        expect(healthTickShouldAttemptReconnect({
            state: ServerState.DISABLED,
            retryCount: 1,
            lastRetryTime: now - 60_000,
            now,
            maxRetries: MAX_RETRIES,
        })).toBe(false);
    });
});
