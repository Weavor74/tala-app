/**
 * MemoryRepairAnalyticsService.ts — Repair pattern detection and aggregation
 *
 * Reads from MemoryRepairOutcomeRepository and produces a structured
 * MemoryRepairInsightSummary describing recurring failures, action
 * effectiveness, queue behaviour, escalation candidates, and repair
 * trajectories.
 *
 * Design invariants
 * ─────────────────
 * 1. Deterministic — same input data + window produces the same summary.
 * 2. Read-only — does not write to the DB or emit telemetry.
 * 3. Bounded — all query windows are time-bounded; no full-table scans.
 * 4. No speculation — every finding is backed by concrete rows.
 * 5. Thresholds are constants — callers may override via AnalyticsThresholds.
 *
 * Usage
 * ─────
 * const analytics = new MemoryRepairAnalyticsService(outcomeRepo);
 * const summary = await analytics.generateSummary({ windowHours: 24 });
 */

import type { MemoryRepairOutcomeRepository } from '../db/MemoryRepairOutcomeRepository';
import type {
    MemoryRepairInsightSummary,
    RecurringFailure,
    ActionEffectivenessEntry,
    QueueBehaviorSummary,
    EscalationCandidate,
    RepairTrajectory,
} from '../../../shared/memory/MemoryRepairInsights';
import type { MemorySubsystemState } from '../../../shared/memory/MemoryHealthStatus';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Configurable detection thresholds.  All have safe, conservative defaults.
 */
export type AnalyticsThresholds = {
    /** Minimum occurrences of the same failure reason to flag as recurring. */
    recurringFailureMinCount: number;
    /** Minimum occurrences before an escalation candidate is raised. */
    escalationReasonThreshold: number;
    /** Number of consecutive failed cycles before raising an escalation. */
    escalationFailedCyclesThreshold: number;
    /** Hours spent in degraded/critical state before raising an escalation. */
    escalationDegradedHoursThreshold: number;
};

const DEFAULT_THRESHOLDS: AnalyticsThresholds = {
    recurringFailureMinCount: 2,
    escalationReasonThreshold: 3,
    escalationFailedCyclesThreshold: 3,
    escalationDegradedHoursThreshold: 1,
};

// ---------------------------------------------------------------------------
// Subsystem label map
// ---------------------------------------------------------------------------

const REASON_TO_SUBSYSTEM: Record<string, string> = {
    canonical_unavailable: 'canonical',
    canonical_init_failed: 'canonical',
    mem0_unavailable: 'mem0',
    mem0_mode_canonical_only: 'mem0',
    extraction_provider_unavailable: 'extraction',
    embedding_provider_unavailable: 'embedding',
    graph_projection_unavailable: 'graph',
    rag_logging_unavailable: 'rag',
    runtime_mismatch: 'providers',
    unknown: 'unknown',
};

function subsystemForReason(reason: string): string {
    // Fall back to 'unknown' for any reason not in the static map so that
    // analytics outputs remain consistent even as new MemoryFailureReason
    // values are added in future phases.
    return REASON_TO_SUBSYSTEM[reason] ?? 'unknown';
}

// ---------------------------------------------------------------------------
// MemoryRepairAnalyticsService
// ---------------------------------------------------------------------------

export class MemoryRepairAnalyticsService {
    private readonly thresholds: AnalyticsThresholds;

    constructor(
        private readonly repo: MemoryRepairOutcomeRepository,
        thresholds?: Partial<AnalyticsThresholds>,
    ) {
        this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Generate a complete insight summary for the given time window.
     *
     * All sub-analyses are run concurrently for efficiency.
     *
     * @param windowHours — How far back to look (default: 24 hours).
     */
    async generateSummary(opts: { windowHours?: number } = {}): Promise<MemoryRepairInsightSummary> {
        const windowHours = opts.windowHours ?? 24;
        const windowSince = new Date(Date.now() - windowHours * 3_600_000);
        const generatedAt = new Date().toISOString();

        const [
            totalCycles,
            totalTriggers,
            reasonRows,
            actionRows,
            cycleOutcomeRows,
            replayCounts,
            deadLetterHalves,
            transitions,
            failedCycles,
            degradedHours,
            escalationReasons,
        ] = await Promise.all([
            this.repo.countCycles(windowSince),
            this.repo.countTriggers(windowSince),
            this.repo.getReasonCounts(windowSince, this.thresholds.recurringFailureMinCount),
            this.repo.getActionOutcomeCounts(windowSince),
            this.repo.getCycleOutcomeCounts(windowSince),
            this.repo.getReplayCounts(windowSince),
            this.repo.getDeadLetterHalves(windowSince),
            this.repo.getHealthTransitions(windowSince),
            this.repo.countFailedCycles(windowSince),
            this.repo.getDegradedHours(windowSince),
            this.repo.getEscalationCandidateReasons(
                windowSince,
                this.thresholds.escalationReasonThreshold,
            ),
        ]);

        const recurrentFailures = this._buildRecurrentFailures(reasonRows, cycleOutcomeRows);
        const actionEffectiveness = this._buildActionEffectiveness(actionRows);
        const queueBehavior = this._buildQueueBehavior(replayCounts, deadLetterHalves);
        const trajectories = this._buildTrajectories(transitions);
        const escalationCandidates = this._buildEscalationCandidates(
            escalationReasons,
            failedCycles,
            degradedHours,
            queueBehavior,
        );

        return {
            windowHours,
            generatedAt,
            totalCycles,
            totalTriggers,
            recurrentFailures,
            actionEffectiveness,
            queueBehavior,
            escalationCandidates,
            trajectories,
        };
    }

    // ── Private builders ──────────────────────────────────────────────────────

    private _buildRecurrentFailures(
        reasonRows: Awaited<ReturnType<MemoryRepairOutcomeRepository['getReasonCounts']>>,
        cycleOutcomeRows: Awaited<ReturnType<MemoryRepairOutcomeRepository['getCycleOutcomeCounts']>>,
    ): RecurringFailure[] {
        // Build a quick-lookup: how many cycles recovered (outcome='recovered')
        const recoveredCycles = cycleOutcomeRows.find(r => r.outcome === 'recovered')?.cnt ?? 0;
        const totalCycles = cycleOutcomeRows.reduce((s, r) => s + r.cnt, 0);

        return reasonRows.map(row => ({
            reason: row.reason,
            subsystem: subsystemForReason(row.reason),
            occurrenceCount: row.cnt,
            firstSeenAt: row.first_at,
            lastSeenAt: row.last_at,
            // If more than half of all cycles recovered, the system likely
            // recovers between failures (instability pattern).
            recoversBetweenFailures: totalCycles > 0 && recoveredCycles / totalCycles >= 0.5,
        }));
    }

    private _buildActionEffectiveness(
        actionRows: Awaited<ReturnType<MemoryRepairOutcomeRepository['getActionOutcomeCounts']>>,
    ): ActionEffectivenessEntry[] {
        // Group by actionType
        const byAction = new Map<string, { success: number; failure: number; skip: number }>();

        for (const row of actionRows) {
            const entry = byAction.get(row.actionType) ?? { success: 0, failure: 0, skip: 0 };
            if (row.outcome === 'recovered') {
                entry.success += row.cnt;
            } else if (row.outcome === 'skipped') {
                entry.skip += row.cnt;
            } else {
                entry.failure += row.cnt;
            }
            byAction.set(row.actionType, entry);
        }

        return Array.from(byAction.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([actionType, counts]) => {
                const totalExecutions = counts.success + counts.failure + counts.skip;
                const successRate = totalExecutions > 0 ? counts.success / totalExecutions : 0;
                return {
                    actionType,
                    totalExecutions,
                    successCount: counts.success,
                    failureCount: counts.failure,
                    skipCount: counts.skip,
                    successRate: Math.round(successRate * 1000) / 1000,
                };
            });
    }

    private _buildQueueBehavior(
        replayCounts: { successes: number; failures: number },
        deadLetterHalves: { early: number; late: number; total: number },
    ): QueueBehaviorSummary {
        return {
            totalReplays: replayCounts.successes + replayCounts.failures,
            replaySuccesses: replayCounts.successes,
            replayFailures: replayCounts.failures,
            deadLetterCount: deadLetterHalves.total,
            deadLetterGrowing: deadLetterHalves.late > deadLetterHalves.early,
        };
    }

    private _buildTrajectories(
        transitions: Array<{ fromState: string | null; toState: string | null; occurredAt: string }>,
    ): RepairTrajectory[] {
        if (transitions.length === 0) return [];

        // Build state sequences: each consecutive run of transitions from the
        // same starting state counts as a trajectory.  We use a sliding window
        // of up to 4 transitions to keep patterns bounded.
        const MAX_SEQ_LEN = 4;
        const countMap = new Map<string, { seq: MemorySubsystemState[]; count: number }>();

        for (let i = 0; i < transitions.length; i++) {
            const sequence: MemorySubsystemState[] = [];

            if (transitions[i].fromState) {
                sequence.push(transitions[i].fromState as MemorySubsystemState);
            }

            for (let j = i; j < Math.min(i + MAX_SEQ_LEN, transitions.length); j++) {
                if (transitions[j].toState) {
                    sequence.push(transitions[j].toState as MemorySubsystemState);
                }
            }

            if (sequence.length < 2) continue;

            const key = sequence.join('→');
            const existing = countMap.get(key);
            if (existing) {
                existing.count++;
            } else {
                countMap.set(key, { seq: sequence, count: 1 });
            }
        }

        const HEALTHY_STATES = new Set<MemorySubsystemState>(['healthy', 'reduced']);

        return Array.from(countMap.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, 10)
            .map(({ seq, count }) => ({
                stateSequence: seq,
                occurrenceCount: count,
                endsHealthy: HEALTHY_STATES.has(seq[seq.length - 1]),
            }));
    }

    private _buildEscalationCandidates(
        escalationReasons: Awaited<ReturnType<MemoryRepairOutcomeRepository['getEscalationCandidateReasons']>>,
        failedCycles: number,
        degradedHours: number,
        queue: QueueBehaviorSummary,
    ): EscalationCandidate[] {
        const candidates: EscalationCandidate[] = [];

        // Repeated failure reasons
        for (const row of escalationReasons) {
            candidates.push({
                code: 'repeated_failure_reason',
                description:
                    `Failure reason '${row.reason}' occurred ${row.cnt} times between ` +
                    `${row.first_at} and ${row.last_at}.`,
                evidence: {
                    reason: row.reason,
                    subsystem: subsystemForReason(row.reason),
                    occurrenceCount: row.cnt,
                    threshold: this.thresholds.escalationReasonThreshold,
                },
                firstEvidenceAt: row.first_at,
                lastEvidenceAt: row.last_at,
            });
        }

        // Repeated cycle failures
        if (failedCycles >= this.thresholds.escalationFailedCyclesThreshold) {
            const now = new Date().toISOString();
            candidates.push({
                code: 'repeated_cycle_failure',
                description:
                    `Repair cycle outcome=failed occurred ${failedCycles} times in the window.`,
                evidence: {
                    failedCycles,
                    threshold: this.thresholds.escalationFailedCyclesThreshold,
                },
                firstEvidenceAt: now,
                lastEvidenceAt: now,
            });
        }

        // Prolonged degraded state
        if (degradedHours >= this.thresholds.escalationDegradedHoursThreshold) {
            const now = new Date().toISOString();
            candidates.push({
                code: 'prolonged_degraded',
                description:
                    `Memory subsystem has been in a degraded/critical state for ` +
                    `approximately ${degradedHours.toFixed(1)} hours.`,
                evidence: {
                    degradedHours: Math.round(degradedHours * 10) / 10,
                    threshold: this.thresholds.escalationDegradedHoursThreshold,
                },
                firstEvidenceAt: now,
                lastEvidenceAt: now,
            });
        }

        // Growing dead-letter queue
        if (queue.deadLetterGrowing && queue.deadLetterCount > 0) {
            const now = new Date().toISOString();
            candidates.push({
                code: 'growing_dead_letter_queue',
                description:
                    `Dead-letter queue is growing: ${queue.deadLetterCount} items in window, ` +
                    `with more items in the recent half than the earlier half.`,
                evidence: {
                    totalDeadLetters: queue.deadLetterCount,
                },
                firstEvidenceAt: now,
                lastEvidenceAt: now,
            });
        }

        return candidates;
    }
}
