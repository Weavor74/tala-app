import type {
    IterationEffectivenessSnapshot,
    IterationPolicyAdjustment,
    IterationPolicyPromotionRecord,
    IterationPolicyRejectionRecord,
    IterationPolicyTuningState,
    IterationTuningRecommendation,
} from '../../../shared/planning/IterationEffectivenessTypes';
import type { IterationWorthinessClass } from '../../../shared/planning/IterationPolicyTypes';

function cloneState(state: IterationPolicyTuningState): IterationPolicyTuningState {
    return {
        appliedOverrides: { ...state.appliedOverrides },
        pendingRecommendations: state.pendingRecommendations.map((item) => ({ ...item })),
        promotedRecommendations: state.promotedRecommendations.map((item) => ({
            ...item,
            appliedAdjustment: { ...item.appliedAdjustment },
        })),
        rejectedRecommendations: state.rejectedRecommendations.map((item) => ({ ...item })),
        lastAnalyticsSnapshot: state.lastAnalyticsSnapshot
            ? {
                ...state.lastAnalyticsSnapshot,
                taskFamilyStats: state.lastAnalyticsSnapshot.taskFamilyStats.map((item) => ({
                    ...item,
                    depthProfiles: item.depthProfiles.map((depth) => ({ ...depth })),
                    replan: { ...item.replan },
                    retry: { ...item.retry },
                    waste: { ...item.waste },
                })),
            }
            : undefined,
        lastRecommendationRunAt: state.lastRecommendationRunAt,
    };
}

export class IterationPolicyTuningRepository {
    private static _instance: IterationPolicyTuningRepository | null = null;

    private _state: IterationPolicyTuningState = {
        appliedOverrides: {},
        pendingRecommendations: [],
        promotedRecommendations: [],
        rejectedRecommendations: [],
    };

    static getInstance(): IterationPolicyTuningRepository {
        if (!IterationPolicyTuningRepository._instance) {
            IterationPolicyTuningRepository._instance = new IterationPolicyTuningRepository();
        }
        return IterationPolicyTuningRepository._instance;
    }

    static _resetForTesting(): void {
        IterationPolicyTuningRepository._instance = new IterationPolicyTuningRepository();
    }

    getState(): IterationPolicyTuningState {
        return cloneState(this._state);
    }

    setLastAnalyticsSnapshot(snapshot: IterationEffectivenessSnapshot): void {
        this._state.lastAnalyticsSnapshot = {
            ...snapshot,
            taskFamilyStats: snapshot.taskFamilyStats.map((item) => ({
                ...item,
                depthProfiles: item.depthProfiles.map((depth) => ({ ...depth })),
                replan: { ...item.replan },
                retry: { ...item.retry },
                waste: { ...item.waste },
            })),
        };
    }

    setRecommendations(recommendations: IterationTuningRecommendation[]): void {
        const promotedIds = new Set(this._state.promotedRecommendations.map((item) => item.recommendationId));
        const rejectedIds = new Set(this._state.rejectedRecommendations.map((item) => item.recommendationId));
        this._state.pendingRecommendations = recommendations
            .filter((rec) => !promotedIds.has(rec.recommendationId) && !rejectedIds.has(rec.recommendationId))
            .map((rec) => ({ ...rec, status: 'pending' }));
        this._state.lastRecommendationRunAt = new Date().toISOString();
    }

    getAppliedOverride(taskClass: IterationWorthinessClass): IterationPolicyAdjustment | undefined {
        const entry = this._state.appliedOverrides[taskClass];
        return entry ? { ...entry } : undefined;
    }

    applyManualOverride(
        adjustment: Omit<IterationPolicyAdjustment, 'origin' | 'promotedAt'> & {
            promotedAt?: string;
        },
    ): IterationPolicyAdjustment {
        const applied: IterationPolicyAdjustment = {
            ...adjustment,
            origin: 'manual',
            promotedAt: adjustment.promotedAt ?? new Date().toISOString(),
        };
        this._state.appliedOverrides[adjustment.taskClass] = applied;
        return { ...applied };
    }

    promoteRecommendation(
        recommendationId: string,
        origin: IterationPolicyPromotionRecord['origin'],
        promotedBy?: string,
    ): IterationPolicyPromotionRecord | undefined {
        const recommendation = this._state.pendingRecommendations.find((item) => item.recommendationId === recommendationId);
        if (!recommendation) return undefined;
        const promotedAt = new Date().toISOString();
        const adjustment: IterationPolicyAdjustment = {
            taskClass: recommendation.taskClass,
            maxIterations: recommendation.recommendedMaxIterations,
            replanAllowance: recommendation.recommendedReplanAllowance,
            promotedAt,
            promotedBy,
            origin,
            reasonCodes: recommendation.reasonCodes,
        };
        this._state.appliedOverrides[recommendation.taskClass] = adjustment;

        const record: IterationPolicyPromotionRecord = {
            recommendationId,
            taskClass: recommendation.taskClass,
            promotedAt,
            promotedBy,
            origin,
            appliedAdjustment: adjustment,
        };
        this._state.promotedRecommendations.push(record);
        this._state.pendingRecommendations = this._state.pendingRecommendations.filter((item) => item.recommendationId !== recommendationId);
        return {
            ...record,
            appliedAdjustment: { ...record.appliedAdjustment },
        };
    }

    rejectRecommendation(
        recommendationId: string,
        rejectionReason: string,
        rejectedBy?: string,
    ): IterationPolicyRejectionRecord | undefined {
        const recommendation = this._state.pendingRecommendations.find((item) => item.recommendationId === recommendationId);
        if (!recommendation) return undefined;
        const record: IterationPolicyRejectionRecord = {
            recommendationId,
            taskClass: recommendation.taskClass,
            rejectedAt: new Date().toISOString(),
            rejectedBy,
            rejectionReason,
        };
        this._state.rejectedRecommendations.push(record);
        this._state.pendingRecommendations = this._state.pendingRecommendations.filter((item) => item.recommendationId !== recommendationId);
        return { ...record };
    }
}
