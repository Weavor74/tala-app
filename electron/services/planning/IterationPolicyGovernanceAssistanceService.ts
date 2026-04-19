import { v4 as uuidv4 } from 'uuid';
import type {
    IterationGovernanceActionType,
    IterationGovernanceQueueItem,
} from '../../../shared/planning/IterationPolicyGovernanceOperationsTypes';
import type {
    IterationGovernanceAttentionSummary,
    IterationGovernanceContradictionSignal,
    IterationGovernanceDriftSignal,
    IterationGovernanceExplanation,
    IterationGovernanceImpactPreview,
    IterationGovernancePriorityScore,
    IterationGovernanceReviewRecommendation,
    IterationGovernanceSuggestedAction,
    IterationGovernanceSimulationResult,
    IterationGovernanceTriageFactors,
} from '../../../shared/planning/IterationPolicyGovernanceAssistanceTypes';
import type { IterationWorthinessClass, ReplanAllowance } from '../../../shared/planning/IterationPolicyTypes';
import { resolveIterationDoctrineDefaults } from './IterationPolicyResolver';
import { IterationPolicyGovernanceQueryService } from './IterationPolicyGovernanceQueryService';
import { IterationPolicyPromotionGovernorService } from './IterationPolicyPromotionGovernor';
import { IterationPolicyTuningRepository } from './IterationPolicyTuningRepository';
import { TelemetryBus } from '../telemetry/TelemetryBus';

function daysBetween(startIso: string, endIso: string): number {
    const deltaMs = Math.max(0, new Date(endIso).getTime() - new Date(startIso).getTime());
    return Math.floor(deltaMs / (1000 * 60 * 60 * 24));
}

function rankKey(score: IterationGovernancePriorityScore): string {
    return `${1000 - score.score}-${score.taskClass}-${score.artifactId}`;
}

function determineDoctrineRiskClass(taskClass: IterationWorthinessClass): 'low' | 'medium' | 'high' {
    if (taskClass === 'operator_sensitive' || taskClass === 'recovery_repair' || taskClass === 'autonomous_maintenance') {
        return 'high';
    }
    if (taskClass === 'workflow_execution' || taskClass === 'tool_multistep') {
        return 'medium';
    }
    return 'low';
}

function determineSuggestedAction(
    queue: IterationGovernanceQueueItem,
    priorityClass: IterationGovernancePriorityScore['priorityClass'],
): IterationGovernanceSuggestedAction {
    if (queue.queueType === 'eligible_for_promotion' && priorityClass !== 'low') return 'promote_candidate';
    if (queue.queueType === 'blocked_recommendations') return 'manual_review_required';
    if (queue.queueType === 'stale_overrides') return 'retire_or_revalidate';
    if (queue.queueType === 'incompatible_overrides') return 'acknowledge_incompatibility';
    if (queue.queueType === 'active_overrides' && queue.lifecycleState === 'disabled_by_operator') return 'no_action_required';
    return 'manual_review_required';
}

function summarizeExplanation(queue: IterationGovernanceQueueItem, reasons: string[]): string {
    if (queue.queueType === 'eligible_for_promotion') return 'Recommendation is promotable under current doctrine and evidence thresholds.';
    if (queue.queueType === 'blocked_recommendations') return 'Recommendation is blocked by governance eligibility checks and needs explicit operator review.';
    if (queue.queueType === 'stale_overrides') return 'Active override is stale and should be revalidated or retired before drift grows.';
    if (queue.queueType === 'incompatible_overrides') return 'Override is doctrine-incompatible and should not remain active without intervention.';
    return `Governance artifact requires review (${reasons[0] ?? 'no_reason_code'}).`;
}

export class IterationPolicyGovernanceAssistanceService {
    constructor(
        private readonly _repository: IterationPolicyTuningRepository = IterationPolicyTuningRepository.getInstance(),
        private readonly _queries: IterationPolicyGovernanceQueryService = new IterationPolicyGovernanceQueryService(),
        private readonly _governor: IterationPolicyPromotionGovernorService = new IterationPolicyPromotionGovernorService(),
    ) {}

    listPrioritizedRecommendations(nowIso: string = new Date().toISOString()): IterationGovernanceReviewRecommendation[] {
        const pending = this._queries.getPendingRecommendationQueue(nowIso);
        const eligibleSet = new Set(this._queries.getEligibleRecommendationQueue(nowIso).map((item) => item.artifactId));
        return pending
            .map((item) => this._buildReviewRecommendation(item, nowIso, eligibleSet.has(item.artifactId), false))
            .sort((a, b) => rankKey(a.priority).localeCompare(rankKey(b.priority)));
    }

    listPrioritizedOverrideAttention(nowIso: string = new Date().toISOString()): IterationGovernanceReviewRecommendation[] {
        const stale = this._queries.getStaleOverrideQueue();
        const incompatible = this._queries.getIncompatibleOverrideQueue();
        const attention = [...stale, ...incompatible];
        return attention
            .map((item) => this._buildReviewRecommendation(item, nowIso, false, true))
            .sort((a, b) => rankKey(a.priority).localeCompare(rankKey(b.priority)));
    }

    getBlockedRecommendationExplanations(nowIso: string = new Date().toISOString()): IterationGovernanceExplanation[] {
        const explanations = this._queries.getBlockedRecommendationQueue(nowIso).map((item) => ({
            artifactId: item.artifactId,
            artifactType: item.artifactType,
            lifecycleState: item.lifecycleState,
            summary: summarizeExplanation(item, item.reasonCodes),
            reasonCodes: [...item.reasonCodes],
            factors: [
                `eligibility_status=${item.note ?? 'unknown'}`,
                `confidence=${item.confidence ?? 'unknown'}`,
                `evidence_sufficiency=${item.evidenceSufficiency ?? 'unknown'}`,
            ],
        }));
        TelemetryBus.getInstance().emit({
            executionId: 'iteration-governance-assistance',
            subsystem: 'planning',
            event: 'planning.iteration_governance_explanation_generated',
            payload: {
                explanationCount: explanations.length,
            },
        });
        return explanations;
    }

    previewGovernanceAction(
        actionType: Extract<IterationGovernanceActionType, 'promote_recommendation' | 'retire_override' | 'disable_override' | 'reenable_override' | 'supersede_override'>,
        targetArtifactId: string,
        nowIso: string = new Date().toISOString(),
    ): IterationGovernanceImpactPreview {
        const state = this._repository.getState();
        const simulationResults: IterationGovernanceSimulationResult[] = [];
        const affectedTaskFamilies = new Set<IterationWorthinessClass>();
        let baselineFallbackCount = 0;
        const reasonCodes = new Set<string>(['governance_assistance.preview_read_only']);
        let targetArtifactType: 'recommendation' | 'override' = 'recommendation';

        if (actionType === 'promote_recommendation' || actionType === 'supersede_override') {
            const rec = state.pendingRecommendations.find((item) => item.recommendation.recommendationId === targetArtifactId);
            if (rec) {
                targetArtifactType = 'recommendation';
                const taskClass = rec.recommendation.taskClass;
                affectedTaskFamilies.add(taskClass);
                const current = this._resolveCurrentPolicy(taskClass, state);
                const projected = this._applySafetyCaps(
                    taskClass,
                    rec.recommendation.recommendedMaxIterations,
                    rec.recommendation.recommendedReplanAllowance,
                );
                const changed = current.maxIterations !== projected.maxIterations || current.replanAllowance !== projected.replanAllowance || current.source !== 'promoted_override';
                simulationResults.push({
                    taskClass,
                    currentPolicySource: current.source,
                    projectedPolicySource: 'promoted_override',
                    currentMaxIterations: current.maxIterations,
                    projectedMaxIterations: projected.maxIterations,
                    currentReplanAllowance: current.replanAllowance,
                    projectedReplanAllowance: projected.replanAllowance,
                    changed,
                    safetyCapApplied: projected.safetyCapApplied,
                });
                if (!changed) {
                    reasonCodes.add('governance_assistance.preview_negligible_change');
                }
            }
        } else {
            targetArtifactType = 'override';
            const override = state.activeOverrides.find((item) => item.overrideId === targetArtifactId);
            if (override) {
                const taskClass = override.taskClass;
                affectedTaskFamilies.add(taskClass);
                const current = this._resolveCurrentPolicy(taskClass, state);
                const baselineDefaults = resolveIterationDoctrineDefaults(taskClass);
                const projected = this._applySafetyCaps(taskClass, baselineDefaults.maxIterations, baselineDefaults.replanAllowance);
                const changed = current.maxIterations !== projected.maxIterations || current.replanAllowance !== projected.replanAllowance || current.source !== 'baseline';
                simulationResults.push({
                    taskClass,
                    currentPolicySource: current.source,
                    projectedPolicySource: actionType === 'reenable_override'
                        ? (override.lifecycleState === 'active_stale' ? 'stale_active_override' : 'promoted_override')
                        : 'baseline',
                    currentMaxIterations: current.maxIterations,
                    projectedMaxIterations: actionType === 'reenable_override' ? current.maxIterations : projected.maxIterations,
                    currentReplanAllowance: current.replanAllowance,
                    projectedReplanAllowance: actionType === 'reenable_override' ? current.replanAllowance : projected.replanAllowance,
                    changed,
                    safetyCapApplied: projected.safetyCapApplied,
                });
                if (actionType === 'retire_override' || actionType === 'disable_override') {
                    baselineFallbackCount = changed ? 1 : 0;
                }
            }
        }

        const severity = simulationResults.some((item) => item.changed && item.safetyCapApplied)
            ? 'medium'
            : simulationResults.some((item) => item.changed)
                ? 'low'
                : 'none';
        const summary = simulationResults.length === 0
            ? 'No eligible artifact was found for preview.'
            : simulationResults.every((item) => !item.changed)
                ? 'Preview indicates little to no runtime policy change for the selected action.'
                : 'Preview indicates runtime policy resolution would change for affected task families.';

        TelemetryBus.getInstance().emit({
            executionId: targetArtifactId,
            subsystem: 'planning',
            event: 'planning.iteration_governance_preview_generated',
            payload: {
                actionType,
                targetArtifactId,
                affectedTaskFamilies: [...affectedTaskFamilies],
                severity,
                advisoryOnly: true,
            },
        });

        return {
            previewId: `igovprev-${uuidv4()}`,
            advisoryOnly: true,
            actionType,
            targetArtifactId,
            targetArtifactType,
            scope: affectedTaskFamilies.size > 1 ? 'multi_task_family' : 'single_task_family',
            severity,
            affectedTaskFamilies: [...affectedTaskFamilies],
            baselineFallbackCount,
            simulationResults,
            summary,
            uncertaintyNotes: [
                'Preview is read-only and does not mutate governed policy state.',
                'Safety caps remain applied in simulation outputs.',
            ],
            reasonCodes: [...reasonCodes],
            generatedAt: nowIso,
        };
    }

    detectDriftSignals(nowIso: string = new Date().toISOString()): IterationGovernanceDriftSignal[] {
        const state = this._repository.getState();
        const signals: IterationGovernanceDriftSignal[] = [];
        for (const override of state.activeOverrides) {
            const ageDays = daysBetween(override.promotedAt, nowIso);
            if (override.lifecycleState === 'active_stale' || override.lifecycleState === 'stale_requires_revalidation') {
                signals.push({
                    signalId: `igovdrift-${uuidv4()}`,
                    artifactId: override.overrideId,
                    artifactType: 'override',
                    taskClass: override.taskClass,
                    severity: ageDays > 14 ? 'critical' : 'high',
                    reasonCodes: ['governance_assistance.stale_active_override'],
                    summary: 'Active override is stale and aging; governance drift risk is increasing.',
                    suggestedAction: 'retire_or_revalidate',
                });
            }
            if (override.lifecycleState === 'blocked_by_doctrine') {
                signals.push({
                    signalId: `igovdrift-${uuidv4()}`,
                    artifactId: override.overrideId,
                    artifactType: 'override',
                    taskClass: override.taskClass,
                    severity: 'critical',
                    reasonCodes: ['governance_assistance.doctrine_incompatible_override'],
                    summary: 'Override is doctrine-incompatible and should not govern runtime policy.',
                    suggestedAction: 'acknowledge_incompatibility',
                });
            }

            const baseline = resolveIterationDoctrineDefaults(override.taskClass);
            if (
                baseline.maxIterations === override.adjustment.maxIterations
                && baseline.replanAllowance === override.adjustment.replanAllowance
            ) {
                signals.push({
                    signalId: `igovdrift-${uuidv4()}`,
                    artifactId: override.overrideId,
                    artifactType: 'override',
                    taskClass: override.taskClass,
                    severity: 'medium',
                    reasonCodes: ['governance_assistance.override_low_value'],
                    summary: 'Active override currently matches baseline behavior and may be low-value.',
                    suggestedAction: 'manual_review_required',
                });
            }
        }

        return signals.sort((a, b) => a.artifactId.localeCompare(b.artifactId));
    }

    detectContradictionSignals(nowIso: string = new Date().toISOString()): IterationGovernanceContradictionSignal[] {
        const _ = nowIso;
        const state = this._repository.getState();
        const signals: IterationGovernanceContradictionSignal[] = [];
        const byTaskClass = new Map<IterationWorthinessClass, typeof state.pendingRecommendations>();
        for (const rec of state.pendingRecommendations) {
            const list = byTaskClass.get(rec.recommendation.taskClass) ?? [];
            list.push(rec);
            byTaskClass.set(rec.recommendation.taskClass, list);
        }

        for (const [taskClass, recs] of byTaskClass.entries()) {
            if (recs.length > 1) {
                const conflicting = new Set(recs.map((item) => `${item.recommendation.recommendedMaxIterations}:${item.recommendation.recommendedReplanAllowance}`));
                if (conflicting.size > 1) {
                    signals.push({
                        signalId: `igovcontra-${uuidv4()}`,
                        taskClass,
                        relatedArtifactIds: recs.map((item) => item.recommendation.recommendationId),
                        severity: 'high',
                        reasonCodes: ['governance_assistance.overlapping_pending_recommendations'],
                        summary: 'Multiple pending recommendations conflict for the same task family.',
                        suggestedAction: 'manual_review_required',
                    });
                }
            }

            const active = state.activeOverrides.find((item) => item.taskClass === taskClass);
            const strongest = recs.find((item) => item.recommendation.confidence === 'high' && item.recommendation.evidenceSufficiency === 'sufficient');
            if (active && strongest) {
                const differs =
                    active.adjustment.maxIterations !== strongest.recommendation.recommendedMaxIterations
                    || active.adjustment.replanAllowance !== strongest.recommendation.recommendedReplanAllowance;
                if (differs) {
                    signals.push({
                        signalId: `igovcontra-${uuidv4()}`,
                        taskClass,
                        relatedArtifactIds: [active.overrideId, strongest.recommendation.recommendationId],
                        severity: 'medium',
                        reasonCodes: ['governance_assistance.active_override_contradicted_by_new_evidence'],
                        summary: 'Active override is contradicted by stronger pending evidence.',
                        suggestedAction: 'retire_or_revalidate',
                    });
                }
            }
        }

        return signals.sort((a, b) => a.taskClass.localeCompare(b.taskClass));
    }

    buildAttentionSummary(nowIso: string = new Date().toISOString()): IterationGovernanceAttentionSummary {
        const recommendationAttention = this.listPrioritizedRecommendations(nowIso);
        const overrideAttention = this.listPrioritizedOverrideAttention(nowIso);
        const topReviewRecommendations = [...recommendationAttention, ...overrideAttention]
            .sort((a, b) => rankKey(a.priority).localeCompare(rankKey(b.priority)))
            .slice(0, 10);
        const driftSignals = this.detectDriftSignals(nowIso);
        const contradictionSignals = this.detectContradictionSignals(nowIso);
        const blockedRecommendationExplanations = this.getBlockedRecommendationExplanations(nowIso);

        TelemetryBus.getInstance().emit({
            executionId: 'iteration-governance-assistance',
            subsystem: 'planning',
            event: 'planning.iteration_governance_priority_computed',
            payload: {
                topReviewCount: topReviewRecommendations.length,
                driftSignalCount: driftSignals.length,
                contradictionSignalCount: contradictionSignals.length,
            },
        });

        return {
            generatedAt: nowIso,
            topReviewRecommendations,
            driftSignals,
            contradictionSignals,
            blockedRecommendationExplanations,
        };
    }

    private _buildReviewRecommendation(
        queue: IterationGovernanceQueueItem,
        nowIso: string,
        eligible: boolean,
        overrideAttention: boolean,
    ): IterationGovernanceReviewRecommendation {
        const factors = this._buildTriageFactors(queue, nowIso, eligible, overrideAttention);
        const score = this._computePriorityScore(queue, factors);
        const suggestedAction = determineSuggestedAction(queue, score.priorityClass);
        const explanation: IterationGovernanceExplanation = {
            artifactId: queue.artifactId,
            artifactType: queue.artifactType,
            lifecycleState: queue.lifecycleState,
            summary: summarizeExplanation(queue, queue.reasonCodes),
            reasonCodes: [...score.reasonCodes],
            factors: [
                `queue_age_days=${factors.queueAgeDays}`,
                `runtime_impact=${factors.runtimeImpact}`,
                `doctrine_risk=${factors.doctrineRiskClass}`,
                `freshness=${factors.freshnessStatus ?? 'unknown'}`,
            ],
        };
        return {
            artifactId: queue.artifactId,
            artifactType: queue.artifactType,
            taskClass: queue.taskClass,
            priority: score,
            explanation,
            suggestedAction,
        };
    }

    private _buildTriageFactors(
        queue: IterationGovernanceQueueItem,
        nowIso: string,
        eligible: boolean,
        overrideAttention: boolean,
    ): IterationGovernanceTriageFactors {
        const doctrineRiskClass = determineDoctrineRiskClass(queue.taskClass);
        const queueAgeDays = daysBetween(queue.createdAt, nowIso);
        const runtimeImpact = queue.artifactType === 'override'
            ? (queue.lifecycleState === 'active' || queue.lifecycleState === 'active_stale' ? 'active' : 'potential')
            : (eligible ? 'potential' : 'none');
        const contradictionDetected = queue.reasonCodes.some((code) => code.includes('contradicted') || code.includes('superseded'));
        const staleActiveRisk = overrideAttention || queue.lifecycleState === 'active_stale' || queue.lifecycleState === 'stale_requires_revalidation';
        const freshnessStatus = queue.note === 'blocked_stale_evidence' || queue.note === 'expired'
            ? 'stale'
            : queue.note === 'aging'
                ? 'aging'
                : 'fresh';
        return {
            queueAgeDays,
            confidence: queue.confidence,
            evidenceSufficiency: queue.evidenceSufficiency,
            freshnessStatus,
            doctrineRiskClass,
            runtimeImpact,
            contradictionDetected,
            staleActiveRisk,
        };
    }

    private _computePriorityScore(
        queue: IterationGovernanceQueueItem,
        factors: IterationGovernanceTriageFactors,
    ): IterationGovernancePriorityScore {
        let score = 0;
        const reasonCodes = new Set<string>();
        if (queue.queueType === 'incompatible_overrides') {
            score += 100;
            reasonCodes.add('governance_assistance.priority_doctrine_incompatible');
        }
        if (queue.queueType === 'stale_overrides' || factors.staleActiveRisk) {
            score += 60;
            reasonCodes.add('governance_assistance.priority_stale_override');
        }
        if (factors.runtimeImpact === 'active') {
            score += 30;
            reasonCodes.add('governance_assistance.priority_active_runtime_impact');
        }
        if (factors.queueAgeDays >= 14) {
            score += 20;
            reasonCodes.add('governance_assistance.priority_long_queue_age');
        }
        if (factors.confidence === 'high' && factors.evidenceSufficiency === 'sufficient' && queue.queueType === 'pending_review') {
            score += 25;
            reasonCodes.add('governance_assistance.priority_strong_promotion_candidate');
        }
        if (queue.queueType === 'blocked_recommendations') {
            score += 10;
            reasonCodes.add('governance_assistance.priority_blocked_needs_explanation');
        }
        if (factors.doctrineRiskClass === 'high') {
            score += 15;
            reasonCodes.add('governance_assistance.priority_high_risk_class');
        }
        if (factors.contradictionDetected) {
            score += 15;
            reasonCodes.add('governance_assistance.priority_contradiction');
        }

        const priorityClass: IterationGovernancePriorityScore['priorityClass'] =
            score >= 90 ? 'critical'
                : score >= 60 ? 'high'
                    : score >= 35 ? 'medium'
                        : 'low';

        return {
            artifactId: queue.artifactId,
            artifactType: queue.artifactType,
            queueType: queue.queueType,
            taskClass: queue.taskClass,
            priorityClass,
            score,
            factors,
            reasonCodes: [...reasonCodes],
        };
    }

    private _resolveCurrentPolicy(
        taskClass: IterationWorthinessClass,
        state: ReturnType<IterationPolicyTuningRepository['getState']>,
    ): {
        source: 'baseline' | 'promoted_override' | 'stale_active_override';
        maxIterations: number;
        replanAllowance: ReplanAllowance;
    } {
        const override = state.activeOverrides.find((item) => item.taskClass === taskClass);
        if (!override || (override.lifecycleState !== 'active' && override.lifecycleState !== 'active_stale')) {
            const defaults = resolveIterationDoctrineDefaults(taskClass);
            const baseline = this._applySafetyCaps(taskClass, defaults.maxIterations, defaults.replanAllowance);
            return {
                source: 'baseline',
                maxIterations: baseline.maxIterations,
                replanAllowance: baseline.replanAllowance,
            };
        }
        const current = this._applySafetyCaps(taskClass, override.adjustment.maxIterations ?? 1, override.adjustment.replanAllowance ?? 'none');
        return {
            source: override.lifecycleState === 'active_stale' ? 'stale_active_override' : 'promoted_override',
            maxIterations: current.maxIterations,
            replanAllowance: current.replanAllowance,
        };
    }

    private _applySafetyCaps(
        taskClass: IterationWorthinessClass,
        maxIterations: number,
        replanAllowance: ReplanAllowance,
    ): { maxIterations: number; replanAllowance: ReplanAllowance; safetyCapApplied: boolean } {
        if (taskClass === 'operator_sensitive') {
            return { maxIterations: 1, replanAllowance: 'none', safetyCapApplied: true };
        }
        return { maxIterations, replanAllowance, safetyCapApplied: false };
    }
}
