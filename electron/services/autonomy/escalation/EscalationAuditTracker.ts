/**
 * EscalationAuditTracker.ts — Phase 5.1 P5.1F
 *
 * In-memory audit trail for model escalation events.
 *
 * Records all escalation-related events including:
 *   - Capability assessments
 *   - Escalation requests and decisions
 *   - Strategy selections
 *   - Decomposition events
 *   - Fallback applications
 *
 * In-memory storage (capped at MAX_RECORDS entries, newest first).
 * Safe for IPC and UI surfaces — no raw model content.
 *
 * Design notes:
 *   - All records are immutable after insertion
 *   - Cap prevents memory growth
 *   - getRecentEscalationCount() supports the spam guard in EscalationPolicyEngine
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    EscalationAuditRecord,
    EscalationAuditEventKind,
} from '../../../../shared/escalationTypes';

// ─── Cap ──────────────────────────────────────────────────────────────────────

const MAX_RECORDS = 500;

// ─── EscalationAuditTracker ───────────────────────────────────────────────────

export class EscalationAuditTracker {
    private readonly records: EscalationAuditRecord[] = [];

    /**
     * Records a single escalation event.
     *
     * @param goalId    Goal ID this event belongs to.
     * @param eventKind What happened.
     * @param detail    Human-readable description of the event.
     * @param runId     Optional run ID if this event occurred during a run.
     * @param data      Optional structured data (must be serializable).
     * @returns The record that was stored.
     */
    record(
        goalId: string,
        eventKind: EscalationAuditEventKind,
        detail: string,
        runId?: string,
        data?: Record<string, unknown>,
    ): EscalationAuditRecord {
        const rec: EscalationAuditRecord = {
            recordId: uuidv4(),
            goalId,
            runId,
            eventKind,
            recordedAt: new Date().toISOString(),
            detail,
            data,
        };

        // Prepend (newest first) and cap
        this.records.unshift(rec);
        if (this.records.length > MAX_RECORDS) {
            this.records.length = MAX_RECORDS;
        }

        return rec;
    }

    /**
     * Returns recent escalation event records, newest first.
     * @param limit Max records to return (default: 50).
     */
    getRecent(limit = 50): EscalationAuditRecord[] {
        return this.records.slice(0, limit);
    }

    /**
     * Returns all records for a specific goal, newest first.
     */
    getForGoal(goalId: string): EscalationAuditRecord[] {
        return this.records.filter(r => r.goalId === goalId);
    }

    /**
     * Returns the count of escalation_requested events in the given time window.
     * Used by EscalationPolicyEngine to enforce the spam guard.
     *
     * @param windowMs Time window in milliseconds (e.g. 3600000 for 1 hour).
     */
    getRecentEscalationCount(windowMs: number): number {
        const cutoff = Date.now() - windowMs;
        return this.records.filter(r =>
            r.eventKind === 'escalation_requested'
            && new Date(r.recordedAt).getTime() >= cutoff,
        ).length;
    }

    /**
     * Returns the total count of all recorded events.
     */
    getTotalCount(): number {
        return this.records.length;
    }

    /**
     * Returns counts by event kind for KPI computation.
     */
    getCountByKind(): Map<EscalationAuditEventKind, number> {
        const counts = new Map<EscalationAuditEventKind, number>();
        for (const r of this.records) {
            counts.set(r.eventKind, (counts.get(r.eventKind) ?? 0) + 1);
        }
        return counts;
    }

    /**
     * Clears all records. Used in tests only.
     */
    clearAll(): void {
        this.records.length = 0;
    }
}
