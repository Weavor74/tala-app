/**
 * DeferredMemoryWorkRepository.ts — Persistent queue for deferred memory tasks
 *
 * Data layer for the deferred_memory_work table introduced in migration
 * 012_deferred_memory_work.sql.  Provides bounded CRUD operations required
 * by DeferredMemoryReplayService and MemoryService.
 *
 * No business logic lives here — this is purely a data-access layer.
 * All queries use parameterised SQL.  No ORM.
 *
 * Node.js only — this file lives in electron/ and must not be imported by
 * the renderer.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeferredMemoryWorkKind =
    | 'extraction'
    | 'embedding'
    | 'graph_projection';

export type DeferredMemoryWorkStatus =
    | 'pending'
    | 'in_progress'
    | 'completed'
    | 'failed'
    | 'dead_letter';

export type DeferredMemoryWorkItem = {
    id: string;
    kind: DeferredMemoryWorkKind;
    status: DeferredMemoryWorkStatus;
    canonicalMemoryId: string;
    sessionId: string | null;
    turnId: string | null;
    payload: Record<string, unknown>;
    attemptCount: number;
    maxAttempts: number;
    lastError: string | null;
    nextAttemptAt: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    deadLetteredAt: string | null;
};

export type EnqueueDeferredWorkInput = {
    kind: DeferredMemoryWorkKind;
    canonicalMemoryId: string;
    sessionId?: string | null;
    turnId?: string | null;
    payload?: Record<string, unknown>;
    maxAttempts?: number;
};

export type DeferredWorkStats = {
    total: number;
    byKind: Partial<Record<DeferredMemoryWorkKind, number>>;
    byStatus: Partial<Record<DeferredMemoryWorkStatus, number>>;
};

// ---------------------------------------------------------------------------
// DeferredMemoryWorkRepository
// ---------------------------------------------------------------------------

/**
 * Repository for the deferred_memory_work table.
 *
 * Lifecycle:
 *   - Constructed with a shared Pool (same as other DB repositories)
 *   - All methods are async and may throw on DB error
 *   - The caller (DeferredMemoryReplayService) is responsible for error
 *     handling and retry logic
 */
export class DeferredMemoryWorkRepository {
    constructor(private readonly pool: Pool) {}

    /**
     * Persist a new deferred work item with status = 'pending'.
     * Returns the generated id.
     */
    async enqueue(input: EnqueueDeferredWorkInput): Promise<string> {
        const id = uuidv4();
        const maxAttempts = input.maxAttempts ?? 3;
        const payload = JSON.stringify(input.payload ?? {});

        await this.pool.query(
            `INSERT INTO deferred_memory_work
               (id, kind, status, canonical_memory_id, session_id, turn_id,
                payload, attempt_count, max_attempts, next_attempt_at)
             VALUES ($1, $2, 'pending', $3, $4, $5, $6::jsonb, 0, $7, NOW())`,
            [
                id,
                input.kind,
                input.canonicalMemoryId,
                input.sessionId ?? null,
                input.turnId ?? null,
                payload,
                maxAttempts,
            ],
        );

        return id;
    }

    /**
     * Atomically claim up to `batchSize` pending items that are due for
     * processing, transition them to status = 'in_progress', and return them.
     *
     * Only items with status = 'pending' and next_attempt_at <= NOW() are
     * selected.  The claim is performed in a single UPDATE…RETURNING so
     * concurrent callers cannot double-claim the same item.
     */
    async claimBatch(
        batchSize: number,
        kinds?: DeferredMemoryWorkKind[],
    ): Promise<DeferredMemoryWorkItem[]> {
        const safeBatchSize = Math.max(1, Math.min(batchSize, 100));

        let kindsClause = '';
        const params: unknown[] = [new Date().toISOString()];

        if (kinds && kinds.length > 0) {
            params.push(kinds);
            kindsClause = `AND kind = ANY($2::text[])`;
        }

        const result = await this.pool.query<Record<string, unknown>>(
            `UPDATE deferred_memory_work
             SET    status     = 'in_progress',
                    updated_at = NOW()
             WHERE  id IN (
                 SELECT id
                 FROM   deferred_memory_work
                 WHERE  status = 'pending'
                   AND  next_attempt_at <= $1
                   ${kindsClause}
                 ORDER  BY next_attempt_at
                 LIMIT  ${safeBatchSize}
                 FOR    UPDATE SKIP LOCKED
             )
             RETURNING *`,
            params,
        );

        return result.rows.map(mapRow);
    }

    /**
     * Mark a claimed item as successfully completed.
     */
    async markCompleted(id: string): Promise<void> {
        await this.pool.query(
            `UPDATE deferred_memory_work
             SET status       = 'completed',
                 completed_at = NOW(),
                 updated_at   = NOW()
             WHERE id = $1`,
            [id],
        );
    }

    /**
     * Mark a claimed item as failed.
     *
     * If attempt_count + 1 >= max_attempts the item is moved to 'dead_letter'.
     * Otherwise the item is reset to 'pending' with exponential backoff on
     * next_attempt_at (30s * 2^attempt_count, capped at 1 hour).
     */
    async markFailed(id: string, error: string): Promise<void> {
        await this.pool.query(
            `UPDATE deferred_memory_work
             SET attempt_count   = attempt_count + 1,
                 last_error      = $2,
                 updated_at      = NOW(),
                 status          = CASE
                     WHEN attempt_count + 1 >= max_attempts
                         THEN 'dead_letter'
                     ELSE 'pending'
                 END,
                 next_attempt_at = CASE
                     WHEN attempt_count + 1 >= max_attempts
                         THEN next_attempt_at   -- unchanged for dead_letter
                     ELSE NOW() + (LEAST(3600, 30 * POWER(2, attempt_count)) * INTERVAL '1 second')
                 END,
                 dead_lettered_at = CASE
                     WHEN attempt_count + 1 >= max_attempts
                         THEN NOW()
                     ELSE dead_lettered_at
                 END
             WHERE id = $1`,
            [id, error],
        );
    }

    /**
     * Aggregate queue statistics for observability.
     *
     * Returns counts grouped by (kind, status) so callers can compute both
     * per-kind and per-status totals from a single round-trip.
     */
    async getStats(): Promise<DeferredWorkStats> {
        const result = await this.pool.query<{ kind: string; status: string; cnt: string }>(
            `SELECT kind, status, COUNT(*) AS cnt
             FROM   deferred_memory_work
             GROUP  BY kind, status`,
        );

        const byKind: Partial<Record<DeferredMemoryWorkKind, number>> = {};
        const byStatus: Partial<Record<DeferredMemoryWorkStatus, number>> = {};
        let total = 0;

        for (const row of result.rows) {
            const kind = row.kind as DeferredMemoryWorkKind;
            const status = row.status as DeferredMemoryWorkStatus;
            const cnt = parseInt(row.cnt, 10);

            byKind[kind] = (byKind[kind] ?? 0) + cnt;
            byStatus[status] = (byStatus[status] ?? 0) + cnt;
            total += cnt;
        }

        return { total, byKind, byStatus };
    }

    /**
     * Count pending (not yet claimed) items, optionally filtered by kind.
     * Used by MemoryService.getDeferredWorkCounts() to derive queue-backed
     * backlog numbers.
     */
    async countPending(kinds?: DeferredMemoryWorkKind[]): Promise<Record<DeferredMemoryWorkKind, number>> {
        const result = await this.pool.query<{ kind: string; cnt: string }>(
            `SELECT kind, COUNT(*) AS cnt
             FROM   deferred_memory_work
             WHERE  status IN ('pending', 'in_progress')
               AND  ($1::text[] IS NULL OR kind = ANY($1::text[]))
             GROUP  BY kind`,
            [kinds ?? null],
        );

        const out: Record<DeferredMemoryWorkKind, number> = {
            extraction: 0,
            embedding: 0,
            graph_projection: 0,
        };

        for (const row of result.rows) {
            out[row.kind as DeferredMemoryWorkKind] = parseInt(row.cnt, 10);
        }

        return out;
    }
}

// ---------------------------------------------------------------------------
// Internal row mapper
// ---------------------------------------------------------------------------

function mapRow(row: Record<string, unknown>): DeferredMemoryWorkItem {
    return {
        id: row.id as string,
        kind: row.kind as DeferredMemoryWorkKind,
        status: row.status as DeferredMemoryWorkStatus,
        canonicalMemoryId: row.canonical_memory_id as string,
        sessionId: (row.session_id as string | null) ?? null,
        turnId: (row.turn_id as string | null) ?? null,
        payload: (row.payload as Record<string, unknown>) ?? {},
        attemptCount: row.attempt_count as number,
        maxAttempts: row.max_attempts as number,
        lastError: (row.last_error as string | null) ?? null,
        nextAttemptAt: (row.next_attempt_at as Date).toISOString(),
        createdAt: (row.created_at as Date).toISOString(),
        updatedAt: (row.updated_at as Date).toISOString(),
        completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : null,
        deadLetteredAt: row.dead_lettered_at ? (row.dead_lettered_at as Date).toISOString() : null,
    };
}
