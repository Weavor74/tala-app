/**
 * MemoryRepairReflectionService.ts — Summary generation and recommendation synthesis
 *
 * Consumes MemoryRepairInsightSummary output from MemoryRepairAnalyticsService
 * and produces a MemoryRepairReflectionReport containing prioritised,
 * evidence-backed recommendations.
 *
 * Design invariants
 * ─────────────────
 * 1. Deterministic — same insight summary always produces the same report.
 * 2. Explainable — every recommendation cites specific counts and timestamps.
 * 3. Bounded — max recommendations per report is capped (default 10).
 * 4. No side effects — does not modify DB, settings, or provider config.
 *    This pass observes and recommends; future passes consume recommendations.
 * 5. No provider authority — does not bypass MemoryIntegrityPolicy or change
 *    provider settings.
 *
 * Usage
 * ─────
 * const reflectionSvc = new MemoryRepairReflectionService();
 * const report = reflectionSvc.generateReport(summary);
 */

import type {
    MemoryRepairInsightSummary,
    MemoryRepairReflectionReport,
    MemoryRepairRecommendation,
    EscalationCandidate,
    RecurringFailure,
} from '../../../shared/memory/MemoryRepairInsights';
import { TelemetryBus } from '../telemetry/TelemetryBus';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type ReflectionConfig = {
    /** Maximum recommendations in a single report. */
    maxRecommendations: number;
    /** Action success rate below which a 'review_repair_action' recommendation is issued. */
    lowEffectivenessThreshold: number;
    /** Minimum executions for an action to be considered in effectiveness analysis. */
    minExecutionsForEffectiveness: number;
};

const DEFAULT_CONFIG: ReflectionConfig = {
    maxRecommendations: 10,
    lowEffectivenessThreshold: 0.4,
    minExecutionsForEffectiveness: 2,
};

// Priority sort order (lower number = higher priority)
const PRIORITY_ORDER: Record<MemoryRepairRecommendation['priority'], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
};

// ---------------------------------------------------------------------------
// MemoryRepairReflectionService
// ---------------------------------------------------------------------------

export class MemoryRepairReflectionService {
    private readonly config: ReflectionConfig;

    constructor(config?: Partial<ReflectionConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Synthesise a reflection report from an insight summary.
     *
     * The method is synchronous and pure — it does not query the DB directly.
     * Call MemoryRepairAnalyticsService.generateSummary() first, then pass
     * the result here.
     */
    generateReport(summary: MemoryRepairInsightSummary): MemoryRepairReflectionReport {
        const generatedAt = new Date().toISOString();
        const rawRecs = this._buildRecommendations(summary);

        // Sort by priority (critical first), then by code for stable ordering
        rawRecs.sort((a, b) => {
            const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
            if (pDiff !== 0) return pDiff;
            return a.code.localeCompare(b.code);
        });

        const recommendations = rawRecs.slice(0, this.config.maxRecommendations);
        const hasCriticalFindings = recommendations.some(r => r.priority === 'critical');

        const report: MemoryRepairReflectionReport = {
            generatedAt,
            summary,
            recommendations,
            hasCriticalFindings,
        };

        this._emitReportGenerated(report);
        return report;
    }

    // ── Private builders ──────────────────────────────────────────────────────

    private _buildRecommendations(summary: MemoryRepairInsightSummary): MemoryRepairRecommendation[] {
        const recs: MemoryRepairRecommendation[] = [];
        const generatedAt = new Date().toISOString();

        // 1. Escalation-worthy patterns → escalate_to_maintenance or investigate_subsystem
        for (const candidate of summary.escalationCandidates) {
            recs.push(this._escalationToRecommendation(candidate, generatedAt));
        }

        // 2. Recurring failures not already covered by an escalation
        const escalatedReasons = new Set(
            summary.escalationCandidates
                .filter(c => c.code === 'repeated_failure_reason')
                .map(c => c.evidence['reason'] as string),
        );
        for (const failure of summary.recurrentFailures) {
            if (!escalatedReasons.has(failure.reason)) {
                recs.push(this._recurringFailureToRecommendation(failure, generatedAt));
            }
        }

        // 3. Low-effectiveness repair actions
        for (const entry of summary.actionEffectiveness) {
            if (
                entry.totalExecutions >= this.config.minExecutionsForEffectiveness &&
                entry.successRate < this.config.lowEffectivenessThreshold
            ) {
                recs.push({
                    code: 'review_repair_action',
                    description:
                        `Repair action '${entry.actionType}' has low effectiveness: ` +
                        `${(entry.successRate * 100).toFixed(0)}% success rate ` +
                        `over ${entry.totalExecutions} execution(s).`,
                    priority: entry.successRate === 0 ? 'high' : 'medium',
                    evidence: {
                        actionType: entry.actionType,
                        successRate: entry.successRate,
                        totalExecutions: entry.totalExecutions,
                        successCount: entry.successCount,
                        failureCount: entry.failureCount,
                        threshold: this.config.lowEffectivenessThreshold,
                    },
                    generatedAt,
                });
            }
        }

        // 4. Dead-letter queue attention
        if (summary.queueBehavior.deadLetterCount > 0) {
            const priority: MemoryRepairRecommendation['priority'] =
                summary.queueBehavior.deadLetterGrowing ? 'high' : 'medium';
            recs.push({
                code: 'drain_dead_letter_queue',
                description:
                    `${summary.queueBehavior.deadLetterCount} dead-letter item(s) in the ` +
                    `window${summary.queueBehavior.deadLetterGrowing ? ' (queue is growing)' : ''}.`,
                priority,
                evidence: {
                    deadLetterCount: summary.queueBehavior.deadLetterCount,
                    growing: summary.queueBehavior.deadLetterGrowing,
                    replayFailures: summary.queueBehavior.replayFailures,
                },
                generatedAt,
            });
        }

        // 5. Concerning trajectories (non-recovering)
        for (const traj of summary.trajectories) {
            if (!traj.endsHealthy && traj.occurrenceCount >= 2) {
                recs.push({
                    code: 'monitor_trajectory',
                    description:
                        `Repair trajectory [${traj.stateSequence.join(' → ')}] occurred ` +
                        `${traj.occurrenceCount} time(s) without full recovery.`,
                    priority: 'low',
                    evidence: {
                        stateSequence: traj.stateSequence,
                        occurrenceCount: traj.occurrenceCount,
                    },
                    generatedAt,
                });
                break; // One trajectory recommendation per report is sufficient
            }
        }

        // 6. Insufficient data notice
        if (summary.totalCycles === 0 && summary.totalTriggers === 0) {
            recs.push({
                code: 'extend_analysis_window',
                description:
                    `No repair cycles or triggers found in the last ${summary.windowHours}h. ` +
                    `Consider extending the analysis window or verify event persistence.`,
                priority: 'low',
                evidence: {
                    windowHours: summary.windowHours,
                    totalCycles: summary.totalCycles,
                    totalTriggers: summary.totalTriggers,
                },
                generatedAt,
            });
        }

        return recs;
    }

    private _escalationToRecommendation(
        candidate: EscalationCandidate,
        generatedAt: string,
    ): MemoryRepairRecommendation {
        switch (candidate.code) {
            case 'repeated_failure_reason':
                return {
                    code: 'investigate_subsystem',
                    description: candidate.description,
                    priority: 'high',
                    evidence: candidate.evidence,
                    generatedAt,
                };
            case 'repeated_cycle_failure':
                return {
                    code: 'escalate_to_maintenance',
                    description: candidate.description,
                    priority: 'critical',
                    evidence: candidate.evidence,
                    generatedAt,
                };
            case 'prolonged_degraded':
                return {
                    code: 'escalate_to_maintenance',
                    description: candidate.description,
                    priority: 'critical',
                    evidence: candidate.evidence,
                    generatedAt,
                };
            case 'growing_dead_letter_queue':
                return {
                    code: 'drain_dead_letter_queue',
                    description: candidate.description,
                    priority: 'high',
                    evidence: candidate.evidence,
                    generatedAt,
                };
            default:
                return {
                    code: 'escalate_to_maintenance',
                    description: candidate.description,
                    priority: 'high',
                    evidence: candidate.evidence,
                    generatedAt,
                };
        }
    }

    private _recurringFailureToRecommendation(
        failure: RecurringFailure,
        generatedAt: string,
    ): MemoryRepairRecommendation {
        return {
            code: 'investigate_subsystem',
            description:
                `Subsystem '${failure.subsystem}' (reason: '${failure.reason}') failed ` +
                `${failure.occurrenceCount} time(s)` +
                (failure.recoversBetweenFailures
                    ? ' — recovers between failures (instability pattern).'
                    : ' — without consistent recovery.'),
            priority: 'medium',
            evidence: {
                reason: failure.reason,
                subsystem: failure.subsystem,
                occurrenceCount: failure.occurrenceCount,
                firstSeenAt: failure.firstSeenAt,
                lastSeenAt: failure.lastSeenAt,
                recoversBetweenFailures: failure.recoversBetweenFailures,
            },
            generatedAt,
        };
    }

    // ── Telemetry emission ────────────────────────────────────────────────────

    private _emitReportGenerated(report: MemoryRepairReflectionReport): void {
        TelemetryBus.getInstance().emit({
            event: 'memory.repair_reflection_generated',
            subsystem: 'memory',
            executionId: 'repair-reflection',
            payload: {
                generatedAt: report.generatedAt,
                windowHours: report.summary.windowHours,
                totalCycles: report.summary.totalCycles,
                totalTriggers: report.summary.totalTriggers,
                recommendationCount: report.recommendations.length,
                hasCriticalFindings: report.hasCriticalFindings,
                escalationCandidateCount: report.summary.escalationCandidates.length,
            },
        });
    }
}
