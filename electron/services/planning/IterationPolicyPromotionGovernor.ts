import { v4 as uuidv4 } from 'uuid';
import type { IterationTuningRecommendation } from '../../../shared/planning/IterationEffectivenessTypes';
import type {
    EvidenceFreshnessStatus,
    IterationPolicyGovernanceReasonCode,
    IterationPromotionDecision,
    IterationPromotionEligibilityResult,
    PolicyDoctrineVersion,
    PromotionDecisionOrigin,
    PromotionEligibilityStatus,
} from '../../../shared/planning/IterationPolicyGovernanceTypes';

export interface IterationPolicyPromotionGovernorOptions {
    doctrineVersion?: PolicyDoctrineVersion;
    recommendationExpiryMs?: number;
    autoPromotionEnabled?: boolean;
}

const DEFAULT_OPTIONS: Required<IterationPolicyPromotionGovernorOptions> = {
    doctrineVersion: 'iteration-doctrine-v1',
    recommendationExpiryMs: 1000 * 60 * 60 * 24 * 14,
    autoPromotionEnabled: false,
};

const AUTO_PROMOTION_ELIGIBLE_TASKS = new Set([
    'retrieval_summarize',
    'retrieval_summarize_verify',
    'notebook_synthesis',
    'artifact_assembly',
    'tool_multistep',
]);

const AUTO_PROMOTION_INELIGIBLE_TASKS = new Set([
    'operator_sensitive',
    'recovery_repair',
    'autonomous_maintenance',
    'conversational_explanation',
]);

export class IterationPolicyPromotionGovernorService {
    private readonly _options: Required<IterationPolicyPromotionGovernorOptions>;

    constructor(options?: IterationPolicyPromotionGovernorOptions) {
        this._options = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
    }

    getDoctrineVersion(): PolicyDoctrineVersion {
        return this._options.doctrineVersion;
    }

    evaluateEvidenceFreshness(recommendation: IterationTuningRecommendation, nowIso: string = new Date().toISOString()): EvidenceFreshnessStatus {
        const now = new Date(nowIso).getTime();
        const created = new Date(recommendation.createdAt).getTime();
        const age = Math.max(0, now - created);
        if (age >= this._options.recommendationExpiryMs) return 'expired';
        if (age >= this._options.recommendationExpiryMs * 0.75) return 'stale';
        if (age >= this._options.recommendationExpiryMs * 0.4) return 'aging';
        return 'fresh';
    }

    evaluateEligibility(
        recommendation: IterationTuningRecommendation,
        nowIso: string = new Date().toISOString(),
        recommendationDoctrineVersion?: PolicyDoctrineVersion,
    ): IterationPromotionEligibilityResult {
        const freshness = this.evaluateEvidenceFreshness(recommendation, nowIso);
        const reasonCodes: IterationPolicyGovernanceReasonCode[] = [];

        let status: PromotionEligibilityStatus = 'eligible';
        if (recommendationDoctrineVersion && recommendationDoctrineVersion !== this._options.doctrineVersion) {
            status = 'blocked_doctrine_version_mismatch';
            reasonCodes.push('governance.blocked_doctrine_version_mismatch');
            return {
                recommendationId: recommendation.recommendationId,
                taskClass: recommendation.taskClass,
                status,
                evidenceFreshness: freshness,
                autoPromotionEligible: false,
                confidence: recommendation.confidence,
                evidenceSufficiency: recommendation.evidenceSufficiency,
                doctrineVersion: this._options.doctrineVersion,
                reasonCodes,
            };
        }
        if (AUTO_PROMOTION_INELIGIBLE_TASKS.has(recommendation.taskClass)) {
            status = 'blocked_task_family_policy';
            reasonCodes.push('governance.blocked_task_family_restriction');
        }
        if (freshness === 'stale' || freshness === 'expired') {
            status = 'blocked_stale_evidence';
            reasonCodes.push('governance.blocked_stale_evidence');
        }
        if (recommendation.evidenceSufficiency !== 'sufficient') {
            status = 'blocked_insufficient_evidence';
            reasonCodes.push('governance.blocked_insufficient_samples');
        }
        if (recommendation.confidence !== 'high') {
            status = 'blocked_low_confidence';
            reasonCodes.push('governance.blocked_low_confidence');
        }
        if (AUTO_PROMOTION_INELIGIBLE_TASKS.has(recommendation.taskClass)) {
            reasonCodes.push('governance.blocked_safety_class');
        }
        if (status === 'eligible') {
            reasonCodes.push('governance.eligible_for_promotion');
        }

        return {
            recommendationId: recommendation.recommendationId,
            taskClass: recommendation.taskClass,
            status,
            evidenceFreshness: freshness,
            autoPromotionEligible: this._options.autoPromotionEnabled
                && AUTO_PROMOTION_ELIGIBLE_TASKS.has(recommendation.taskClass)
                && status === 'eligible',
            confidence: recommendation.confidence,
            evidenceSufficiency: recommendation.evidenceSufficiency,
            doctrineVersion: this._options.doctrineVersion,
            reasonCodes,
        };
    }

    buildPromotionDecision(params: {
        recommendation: IterationTuningRecommendation;
        origin: PromotionDecisionOrigin;
        evidenceSnapshotId: string;
        decidedBy?: string;
        nowIso?: string;
        recommendationDoctrineVersion?: PolicyDoctrineVersion;
    }): IterationPromotionDecision {
        const nowIso = params.nowIso ?? new Date().toISOString();
        const eligibility = this.evaluateEligibility(
            params.recommendation,
            nowIso,
            params.recommendationDoctrineVersion,
        );
        const approved = eligibility.status === 'eligible';
        const reasonCodes: IterationPolicyGovernanceReasonCode[] = [...eligibility.reasonCodes];
        if (approved) {
            reasonCodes.push('governance.promotion_recorded');
        }
        return {
            decisionId: `ipoldec-${uuidv4()}`,
            recommendationId: params.recommendation.recommendationId,
            taskClass: params.recommendation.taskClass,
            origin: params.origin,
            approved,
            decidedAt: nowIso,
            decidedBy: params.decidedBy,
            doctrineVersion: this._options.doctrineVersion,
            evidenceSnapshotId: params.evidenceSnapshotId,
            confidenceAtDecision: params.recommendation.confidence,
            evidenceSufficiencyAtDecision: params.recommendation.evidenceSufficiency,
            resultingOverride: approved
                ? {
                    taskClass: params.recommendation.taskClass,
                    maxIterations: params.recommendation.recommendedMaxIterations,
                    replanAllowance: params.recommendation.recommendedReplanAllowance,
                    promotedAt: nowIso,
                    promotedBy: params.decidedBy,
                    origin:
                        params.origin === 'manual_operator_review'
                            ? 'manual'
                            : params.origin === 'approved_auto_promotion'
                                ? 'approved_auto'
                                : 'maintenance_review',
                    reasonCodes: params.recommendation.reasonCodes,
                }
                : undefined,
            reasonCodes,
        };
    }
}
