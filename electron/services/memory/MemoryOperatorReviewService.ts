/**
 * MemoryOperatorReviewService.ts — Backend aggregator for the operator review surface
 *
 * Assembles a MemoryOperatorReviewModel from existing backend services:
 *   - MemoryService          — current health status and deferred work counts
 *   - MemoryRepairSchedulerService — last/recent runs, latest analytics outputs
 *
 * Design invariants
 * ─────────────────
 * 1. Read-only — does not mutate any service state.
 * 2. Non-blocking on missing data — returns sensible defaults when no
 *    analytics run has completed yet.
 * 3. Bounded — all lists are capped before inclusion in the model.
 * 4. No analytics re-computation — consumes cached outputs from the
 *    scheduler; never invokes analytics/plan/suggestion services directly.
 * 5. Deterministic — stable sort for all lists; same inputs → same model
 *    (excluding generatedAt).
 *
 * Node.js only — this file lives in electron/ and must not be imported
 * by the renderer.
 */

import type { MemoryService } from '../MemoryService';
import type { MemoryRepairSchedulerService } from './MemoryRepairSchedulerService';
import type {
    MemoryOperatorReviewModel,
    OperatorReviewPosture,
    OperatorReviewHealth,
    OperatorReviewSummary,
    OperatorReviewAdaptivePlan,
    OperatorReviewOptimizationSuggestions,
    OperatorReviewQueues,
    OperatorReviewRecentRepair,
    OperatorReviewRecentCycle,
    OperatorReviewActionEffectiveness,
} from '../../../shared/memory/MemoryOperatorReviewModel';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOP_FAILURE_REASONS_LIMIT = 5;
const TOP_UNSTABLE_SUBSYSTEMS_LIMIT = 5;
const TOP_SUGGESTIONS_LIMIT = 8;
const TOP_PRIORITIES_LIMIT = 5;
const TOP_ACTION_EFFECTIVENESS_LIMIT = 5;
const RECENT_CYCLES_LIMIT = 5;

const ADVISORY_NOTES: string[] = [
    'Optimization suggestions are advisory only — no settings were auto-changed.',
    'Current integrity policy and scheduler configuration remain in effect.',
    'Changes based on these recommendations require explicit human action.',
];

// ---------------------------------------------------------------------------
// MemoryOperatorReviewService
// ---------------------------------------------------------------------------

export class MemoryOperatorReviewService {
    constructor(
        private readonly memorySvc: MemoryService,
        private readonly scheduler: MemoryRepairSchedulerService | null,
    ) {}

    /**
     * Assemble and return the current MemoryOperatorReviewModel.
     *
     * Safe to call repeatedly.  Returns a stable, bounded model regardless
     * of whether scheduled analytics have run yet.
     */
    async getModel(): Promise<MemoryOperatorReviewModel> {
        const generatedAt = new Date().toISOString();

        const health = this._buildHealth();
        const lastRun = this.scheduler?.getLastRun() ?? null;
        const insightSummary = this.scheduler?.getLatestInsightSummary() ?? null;
        const adaptivePlan = this.scheduler?.getLatestAdaptivePlan() ?? null;
        const suggestionReport = this.scheduler?.getLatestSuggestionReport() ?? null;
        const recentRuns = this.scheduler?.getRecentRuns() ?? [];
        const deferredCounts = this.memorySvc.getDeferredWorkCounts();

        const posture: OperatorReviewPosture = (lastRun?.posture as OperatorReviewPosture) ?? 'stable';

        const summary = this._buildSummary(posture, insightSummary, adaptivePlan);
        const builtAdaptivePlan = this._buildAdaptivePlan(adaptivePlan);
        const optimizationSuggestions = this._buildOptimizationSuggestions(suggestionReport);
        const queues = this._buildQueues(deferredCounts, insightSummary);
        const recentRepair = this._buildRecentRepair(lastRun, recentRuns, insightSummary);

        console.log(
            `[MemoryOperatorReview] model generated posture=${posture}` +
            ` suggestions=${optimizationSuggestions.totalSuggestions}` +
            ` priorities=${builtAdaptivePlan?.topPriorities.length ?? 0}`,
        );

        return {
            generatedAt,
            posture,
            health,
            summary,
            adaptivePlan: builtAdaptivePlan,
            optimizationSuggestions,
            queues,
            recentRepair,
            notes: ADVISORY_NOTES,
        };
    }

    // ── Section builders ─────────────────────────────────────────────────────

    private _buildHealth(): OperatorReviewHealth {
        const status = this.memorySvc.getHealthStatus();
        return {
            state: status.state,
            mode: status.mode,
            reasons: [...status.reasons],
            hardDisabled: status.hardDisabled,
            shouldTriggerRepair: status.shouldTriggerRepair,
            shouldEscalate: status.shouldEscalate,
        };
    }

    private _buildSummary(
        posture: OperatorReviewPosture,
        insightSummary: ReturnType<MemoryRepairSchedulerService['getLatestInsightSummary']>,
        adaptivePlan: ReturnType<MemoryRepairSchedulerService['getLatestAdaptivePlan']>,
    ): OperatorReviewSummary {
        if (!insightSummary) {
            return {
                headline: this._postureHeadline(posture),
                keyFindings: ['No analytics run has completed yet. Check back after the first scheduled maintenance cycle.'],
                topFailureReasons: [],
                unstableSubsystems: [],
            };
        }

        // Top failure reasons (bounded, sorted by count desc then lexically)
        const topFailureReasons = [...insightSummary.recurrentFailures]
            .sort((a, b) => b.occurrenceCount - a.occurrenceCount || a.reason.localeCompare(b.reason))
            .slice(0, TOP_FAILURE_REASONS_LIMIT)
            .map(f => ({ reason: f.reason, count: f.occurrenceCount }));

        // Unstable subsystems from adaptive plan (bounded, sorted by subsystem name)
        const unstableSubsystems: Array<{ subsystem: string; count: number }> = adaptivePlan
            ? [...adaptivePlan.unstableSubsystems]
                .sort()
                .slice(0, TOP_UNSTABLE_SUBSYSTEMS_LIMIT)
                .map(sub => ({
                    subsystem: sub,
                    count: insightSummary.recurrentFailures
                        .filter(f => f.subsystem === sub)
                        .reduce((n, f) => n + f.occurrenceCount, 0),
                }))
            : [];

        // Key findings derived from escalation candidates
        const keyFindings: string[] = insightSummary.escalationCandidates
            .slice(0, 5)
            .map(c => c.description);

        if (keyFindings.length === 0 && posture === 'stable') {
            keyFindings.push('No escalation signals detected in the current analysis window.');
        }

        return {
            headline: this._postureHeadline(posture),
            keyFindings,
            topFailureReasons,
            unstableSubsystems,
        };
    }

    private _buildAdaptivePlan(
        plan: ReturnType<MemoryRepairSchedulerService['getLatestAdaptivePlan']>,
    ): OperatorReviewAdaptivePlan | null {
        if (!plan) return null;

        const topPriority = plan.priorities[0];
        const recommendedPrimaryAction = topPriority
            ? `Address ${topPriority.target}: ${topPriority.reason}`
            : plan.summary || 'No specific prioritisation needed in the current window.';

        const defaultIntervalMinutes = 10;
        const cadenceRecommendationMinutes = Math.round(
            defaultIntervalMinutes * plan.cadence.suggestedMultiplier,
        );

        const topPriorities = [...plan.priorities]
            .slice(0, TOP_PRIORITIES_LIMIT)
            .map(p => ({ target: p.target, score: p.score, reason: p.reason }));

        return {
            recommendedPrimaryAction,
            escalationBias: plan.escalation.bias,
            cadenceRecommendationMinutes,
            topPriorities,
        };
    }

    private _buildOptimizationSuggestions(
        report: ReturnType<MemoryRepairSchedulerService['getLatestSuggestionReport']>,
    ): OperatorReviewOptimizationSuggestions {
        if (!report) {
            return { totalSuggestions: 0, topSuggestions: [] };
        }

        const topSuggestions = [...report.suggestions]
            .sort((a, b) => {
                if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
                return a.id.localeCompare(b.id);
            })
            .slice(0, TOP_SUGGESTIONS_LIMIT)
            .map(s => ({
                id: s.id,
                category: s.category,
                title: s.title,
                summary: s.summary,
                severity: s.severity,
                priorityScore: s.priorityScore,
                recommendedHumanAction: s.rationale,
                affectedSubsystems: [...s.affectedSubsystems],
            }));

        return {
            totalSuggestions: report.suggestions.length,
            topSuggestions,
        };
    }

    private _buildQueues(
        deferredCounts: ReturnType<MemoryService['getDeferredWorkCounts']>,
        insightSummary: ReturnType<MemoryRepairSchedulerService['getLatestInsightSummary']>,
    ): OperatorReviewQueues {
        const deadLetterCount = insightSummary?.queueBehavior.deadLetterCount ?? 0;
        const deadLetters = deadLetterCount > 0
            ? [{ kind: 'deferred_work', count: deadLetterCount }]
            : [];

        return {
            extractionPending: deferredCounts.extraction,
            embeddingPending: deferredCounts.embedding,
            graphPending: deferredCounts.projection,
            deadLetters,
        };
    }

    private _buildRecentRepair(
        lastRun: ReturnType<MemoryRepairSchedulerService['getLastRun']>,
        recentRuns: ReturnType<MemoryRepairSchedulerService['getRecentRuns']>,
        insightSummary: ReturnType<MemoryRepairSchedulerService['getLatestInsightSummary']>,
    ): OperatorReviewRecentRepair {
        const recentCycles: OperatorReviewRecentCycle[] = [...recentRuns]
            .reverse() // most recent first
            .slice(0, RECENT_CYCLES_LIMIT)
            .map(run => ({
                outcome: run.posture,
                startedAt: run.startedAt,
                completedAt: run.completedAt,
                attemptedActions: [...run.actionsTaken],
                skipped: run.skipped === true,
            }));

        const actionEffectiveness: OperatorReviewActionEffectiveness[] = insightSummary
            ? [...insightSummary.actionEffectiveness]
                .sort((a, b) => {
                    // Sort by total executions desc then lexically for stable order
                    if (b.totalExecutions !== a.totalExecutions) return b.totalExecutions - a.totalExecutions;
                    return a.actionType.localeCompare(b.actionType);
                })
                .slice(0, TOP_ACTION_EFFECTIVENESS_LIMIT)
                .map(e => ({
                    action: e.actionType,
                    successRate: e.successRate,
                    totalExecutions: e.totalExecutions,
                }))
            : [];

        return {
            lastRunAt: lastRun?.completedAt ?? null,
            recentCycles,
            actionEffectiveness,
        };
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private _postureHeadline(posture: OperatorReviewPosture): string {
        switch (posture) {
            case 'critical':  return 'Critical — memory maintenance requires immediate operator attention.';
            case 'unstable':  return 'Unstable — recurring failures detected; repair cycles recommended.';
            case 'watch':     return 'Watch — minor signals detected; monitoring warranted.';
            case 'stable':    return 'Stable — no recurring issues; memory maintenance is healthy.';
            default:          return 'Unknown posture.';
        }
    }
}
