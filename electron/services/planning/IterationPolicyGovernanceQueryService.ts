import type {
    IterationGovernanceQueueItem,
    IterationGovernanceQueueType,
    IterationGovernanceReviewSummary,
} from '../../../shared/planning/IterationPolicyGovernanceOperationsTypes';
import { IterationPolicyPromotionGovernorService } from './IterationPolicyPromotionGovernor';
import { IterationPolicyTuningRepository } from './IterationPolicyTuningRepository';

export class IterationPolicyGovernanceQueryService {
    constructor(
        private readonly _repository: IterationPolicyTuningRepository = IterationPolicyTuningRepository.getInstance(),
        private readonly _governor: IterationPolicyPromotionGovernorService = new IterationPolicyPromotionGovernorService(),
    ) {}

    getPendingRecommendationQueue(nowIso: string = new Date().toISOString()): IterationGovernanceQueueItem[] {
        return this._repository.getState().pendingRecommendations
            .map((record) => ({
                queueType: 'pending_review' as const,
                artifactId: record.recommendation.recommendationId,
                artifactType: 'recommendation' as const,
                taskClass: record.recommendation.taskClass,
                lifecycleState: record.lifecycleState,
                reasonCodes: [...record.reasonCodes],
                confidence: record.recommendation.confidence,
                evidenceSufficiency: record.recommendation.evidenceSufficiency,
                createdAt: record.recommendation.createdAt,
                updatedAt: record.evidenceGeneratedAt,
                expiresAt: record.expiresAt,
                note: this._governor.evaluateEligibility(record.recommendation, nowIso, record.doctrineVersion).status,
            }))
            .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? ''));
    }

    getEligibleRecommendationQueue(nowIso: string = new Date().toISOString()): IterationGovernanceQueueItem[] {
        return this._repository.getState().pendingRecommendations
            .filter((record) => this._governor.evaluateEligibility(record.recommendation, nowIso, record.doctrineVersion).status === 'eligible')
            .map((record) => ({
                queueType: 'eligible_for_promotion' as const,
                artifactId: record.recommendation.recommendationId,
                artifactType: 'recommendation' as const,
                taskClass: record.recommendation.taskClass,
                lifecycleState: record.lifecycleState,
                reasonCodes: [...record.reasonCodes],
                confidence: record.recommendation.confidence,
                evidenceSufficiency: record.recommendation.evidenceSufficiency,
                createdAt: record.recommendation.createdAt,
                updatedAt: record.evidenceGeneratedAt,
                expiresAt: record.expiresAt,
            }));
    }

    getBlockedRecommendationQueue(nowIso: string = new Date().toISOString()): IterationGovernanceQueueItem[] {
        return this._repository.getState().pendingRecommendations
            .map((record) => ({
                record,
                eligibility: this._governor.evaluateEligibility(record.recommendation, nowIso, record.doctrineVersion),
            }))
            .filter((item) => item.eligibility.status !== 'eligible')
            .map((item) => ({
                queueType: 'blocked_recommendations' as const,
                artifactId: item.record.recommendation.recommendationId,
                artifactType: 'recommendation' as const,
                taskClass: item.record.recommendation.taskClass,
                lifecycleState: item.record.lifecycleState,
                reasonCodes: [...new Set([...item.record.reasonCodes, ...item.eligibility.reasonCodes])],
                confidence: item.record.recommendation.confidence,
                evidenceSufficiency: item.record.recommendation.evidenceSufficiency,
                createdAt: item.record.recommendation.createdAt,
                updatedAt: item.record.evidenceGeneratedAt,
                expiresAt: item.record.expiresAt,
                note: item.eligibility.status,
            }));
    }

    getStaleOverrideQueue(): IterationGovernanceQueueItem[] {
        return this._repository.getState().activeOverrides
            .filter((record) => record.lifecycleState === 'active_stale' || record.lifecycleState === 'stale_requires_revalidation')
            .map((record) => ({
                queueType: 'stale_overrides' as const,
                artifactId: record.overrideId,
                artifactType: 'override' as const,
                taskClass: record.taskClass,
                lifecycleState: record.lifecycleState,
                reasonCodes: [...record.reasonCodes],
                createdAt: record.promotedAt,
                updatedAt: record.staleSince ?? record.promotedAt,
                note: record.stalenessStatus,
            }));
    }

    getIncompatibleOverrideQueue(): IterationGovernanceQueueItem[] {
        return this._repository.getState().activeOverrides
            .filter((record) => record.lifecycleState === 'blocked_by_doctrine')
            .map((record) => ({
                queueType: 'incompatible_overrides' as const,
                artifactId: record.overrideId,
                artifactType: 'override' as const,
                taskClass: record.taskClass,
                lifecycleState: record.lifecycleState,
                reasonCodes: [...record.reasonCodes],
                createdAt: record.promotedAt,
                updatedAt: record.staleSince ?? record.promotedAt,
                note: 'blocked_by_doctrine',
            }));
    }

    getActiveOverrideInventory(): IterationGovernanceQueueItem[] {
        return this._repository.getState().activeOverrides
            .map((record) => ({
                queueType: 'active_overrides' as const,
                artifactId: record.overrideId,
                artifactType: 'override' as const,
                taskClass: record.taskClass,
                lifecycleState: record.lifecycleState,
                reasonCodes: [...record.reasonCodes],
                createdAt: record.promotedAt,
                updatedAt: record.staleSince ?? record.promotedAt,
                note: record.promotionOrigin,
            }));
    }

    getQueue(queueType: IterationGovernanceQueueType, nowIso: string = new Date().toISOString()): IterationGovernanceQueueItem[] {
        switch (queueType) {
            case 'pending_review':
                return this.getPendingRecommendationQueue(nowIso);
            case 'eligible_for_promotion':
                return this.getEligibleRecommendationQueue(nowIso);
            case 'blocked_recommendations':
                return this.getBlockedRecommendationQueue(nowIso);
            case 'stale_overrides':
                return this.getStaleOverrideQueue();
            case 'incompatible_overrides':
                return this.getIncompatibleOverrideQueue();
            case 'active_overrides':
                return this.getActiveOverrideInventory();
            case 'history':
            default:
                return [];
        }
    }

    getRecentHistory(limit: number = 20) {
        return this._repository.listGovernanceHistory(limit);
    }

    buildReviewSummary(nowIso: string = new Date().toISOString()): IterationGovernanceReviewSummary {
        return {
            pendingRecommendationCount: this.getPendingRecommendationQueue(nowIso).length,
            eligibleRecommendationCount: this.getEligibleRecommendationQueue(nowIso).length,
            blockedRecommendationCount: this.getBlockedRecommendationQueue(nowIso).length,
            staleOverrideCount: this.getStaleOverrideQueue().length,
            incompatibleOverrideCount: this.getIncompatibleOverrideQueue().length,
            activeOverrideCount: this.getActiveOverrideInventory().length,
            recentActionCount: this.getRecentHistory(50).length,
        };
    }
}
