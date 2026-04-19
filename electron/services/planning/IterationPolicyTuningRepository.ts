import { v4 as uuidv4 } from 'uuid';
import type {
    IterationEffectivenessSnapshot,
    IterationPolicyAdjustment,
    IterationPolicyPromotionRecord,
    IterationPolicyRejectionRecord,
    IterationPolicyTuningState,
    IterationTuningRecommendation,
} from '../../../shared/planning/IterationEffectivenessTypes';
import type {
    IterationGovernedOverrideRecord,
    IterationGovernedRecommendationRecord,
    IterationPolicyGovernanceReasonCode,
    IterationPromotionDecision,
    IterationPromotionEligibilityResult,
    OverrideRetirementReason,
    PolicyDoctrineVersion,
    PromotionDecisionOrigin,
    RecommendationExpiryReason,
} from '../../../shared/planning/IterationPolicyGovernanceTypes';
import type {
    IterationGovernanceHistoryEntry,
    IterationGovernanceMaintenanceReport,
} from '../../../shared/planning/IterationPolicyGovernanceOperationsTypes';
import type { IterationWorthinessClass } from '../../../shared/planning/IterationPolicyTypes';
import { IterationPolicyPromotionGovernorService } from './IterationPolicyPromotionGovernor';

function cloneRecommendation(record: IterationGovernedRecommendationRecord): IterationGovernedRecommendationRecord {
    return {
        ...record,
        recommendation: { ...record.recommendation },
        reasonCodes: [...record.reasonCodes],
    };
}

function cloneOverride(record: IterationGovernedOverrideRecord): IterationGovernedOverrideRecord {
    return {
        ...record,
        adjustment: { ...record.adjustment },
        reasonCodes: [...record.reasonCodes],
    };
}

function cloneDecision(record: IterationPromotionDecision): IterationPromotionDecision {
    return {
        ...record,
        resultingOverride: record.resultingOverride ? { ...record.resultingOverride } : undefined,
        reasonCodes: [...record.reasonCodes],
    };
}

function cloneHistoryEntry(entry: IterationGovernanceHistoryEntry): IterationGovernanceHistoryEntry {
    return {
        ...entry,
        reasonCodes: [...entry.reasonCodes],
        blockedReasonCodes: [...entry.blockedReasonCodes],
    };
}

function cloneMaintenanceReport(report: IterationGovernanceMaintenanceReport): IterationGovernanceMaintenanceReport {
    return {
        ...report,
        sweepResults: report.sweepResults.map((item) => ({
            ...item,
            actionIds: [...item.actionIds],
            reasonCodes: [...item.reasonCodes],
        })),
        summary: { ...report.summary },
        recommendationQueueCounts: { ...report.recommendationQueueCounts },
        overrideQueueCounts: { ...report.overrideQueueCounts },
        unresolvedIncompatibleOverrideIds: [...report.unresolvedIncompatibleOverrideIds],
    };
}

function cloneState(state: IterationPolicyTuningState): IterationPolicyTuningState {
    return {
        doctrineVersion: state.doctrineVersion,
        appliedOverrides: { ...state.appliedOverrides },
        pendingRecommendations: state.pendingRecommendations.map(cloneRecommendation),
        promotedRecommendations: state.promotedRecommendations.map((item) => ({
            ...item,
            appliedAdjustment: { ...item.appliedAdjustment },
        })),
        rejectedRecommendations: state.rejectedRecommendations.map((item) => ({ ...item })),
        expiredRecommendations: state.expiredRecommendations.map(cloneRecommendation),
        supersededRecommendations: state.supersededRecommendations.map(cloneRecommendation),
        activeOverrides: state.activeOverrides.map(cloneOverride),
        staleOverrides: state.staleOverrides.map(cloneOverride),
        retiredOverrides: state.retiredOverrides.map(cloneOverride),
        supersededOverrides: state.supersededOverrides.map(cloneOverride),
        promotionDecisions: state.promotionDecisions.map(cloneDecision),
        governanceHistory: state.governanceHistory.map(cloneHistoryEntry),
        lastMaintenanceReport: state.lastMaintenanceReport
            ? cloneMaintenanceReport(state.lastMaintenanceReport)
            : undefined,
        overrideSupersessionRecords: state.overrideSupersessionRecords.map((item) => ({ ...item, reasonCodes: [...item.reasonCodes] })),
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

    private readonly _governor: IterationPolicyPromotionGovernorService;
    private _state: IterationPolicyTuningState;

    constructor(governor?: IterationPolicyPromotionGovernorService) {
        this._governor = governor ?? new IterationPolicyPromotionGovernorService();
        this._state = {
            doctrineVersion: this._governor.getDoctrineVersion(),
            appliedOverrides: {},
            pendingRecommendations: [],
            promotedRecommendations: [],
            rejectedRecommendations: [],
            expiredRecommendations: [],
            supersededRecommendations: [],
            activeOverrides: [],
            staleOverrides: [],
            retiredOverrides: [],
            supersededOverrides: [],
            promotionDecisions: [],
            governanceHistory: [],
            overrideSupersessionRecords: [],
        };
    }

    static getInstance(): IterationPolicyTuningRepository {
        if (!IterationPolicyTuningRepository._instance) {
            IterationPolicyTuningRepository._instance = new IterationPolicyTuningRepository();
        }
        return IterationPolicyTuningRepository._instance;
    }

    static _resetForTesting(governor?: IterationPolicyPromotionGovernorService): void {
        IterationPolicyTuningRepository._instance = new IterationPolicyTuningRepository(governor);
    }

    getState(): IterationPolicyTuningState {
        return cloneState(this._state);
    }

    getDoctrineVersion(): PolicyDoctrineVersion {
        return this._state.doctrineVersion;
    }

    setLastMaintenanceReport(report: IterationGovernanceMaintenanceReport): void {
        this._state.lastMaintenanceReport = cloneMaintenanceReport(report);
    }

    getLastMaintenanceReport(): IterationGovernanceMaintenanceReport | undefined {
        return this._state.lastMaintenanceReport
            ? cloneMaintenanceReport(this._state.lastMaintenanceReport)
            : undefined;
    }

    appendGovernanceHistory(entry: IterationGovernanceHistoryEntry): void {
        this._state.governanceHistory.push(cloneHistoryEntry(entry));
        if (this._state.governanceHistory.length > 500) {
            this._state.governanceHistory = this._state.governanceHistory.slice(-500);
        }
    }

    listGovernanceHistory(limit: number = 50): IterationGovernanceHistoryEntry[] {
        return this._state.governanceHistory
            .slice(Math.max(0, this._state.governanceHistory.length - limit))
            .map(cloneHistoryEntry);
    }

    getRecommendationRecord(
        recommendationId: string,
    ): IterationGovernedRecommendationRecord | undefined {
        const allRecords = [
            ...this._state.pendingRecommendations,
            ...this._state.expiredRecommendations,
            ...this._state.supersededRecommendations,
        ];
        const record = allRecords.find(
            (item) => item.recommendation.recommendationId === recommendationId,
        );
        return record ? cloneRecommendation(record) : undefined;
    }

    getOverrideRecord(overrideId: string): IterationGovernedOverrideRecord | undefined {
        const allRecords = [
            ...this._state.activeOverrides,
            ...this._state.staleOverrides,
            ...this._state.retiredOverrides,
            ...this._state.supersededOverrides,
        ];
        const record = allRecords.find((item) => item.overrideId === overrideId);
        return record ? cloneOverride(record) : undefined;
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

    setRecommendations(
        recommendations: IterationTuningRecommendation[],
        options?: { nowIso?: string; evidenceSnapshotId?: string },
    ): void {
        const nowIso = options?.nowIso ?? new Date().toISOString();
        const evidenceSnapshotId = options?.evidenceSnapshotId ?? `evidence-${uuidv4()}`;
        this.expireStaleRecommendations(nowIso);

        for (const recommendation of recommendations) {
            const existingPending = this._state.pendingRecommendations.find((item) => item.recommendation.taskClass === recommendation.taskClass);
            if (existingPending) {
                existingPending.lifecycleState = 'superseded';
                existingPending.supersededByRecommendationId = recommendation.recommendationId;
                existingPending.reasonCodes = [
                    ...existingPending.reasonCodes,
                    'governance.recommendation_superseded',
                ];
                this._state.supersededRecommendations.push(cloneRecommendation(existingPending));
                this._state.pendingRecommendations = this._state.pendingRecommendations.filter(
                    (item) => item.recommendation.recommendationId !== existingPending.recommendation.recommendationId,
                );
            }
            const freshness = this._governor.evaluateEvidenceFreshness(recommendation, nowIso);
            const eligibility = this._governor.evaluateEligibility(
                recommendation,
                nowIso,
                this._state.doctrineVersion,
            );
            const expiresAt = new Date(new Date(nowIso).getTime() + 1000 * 60 * 60 * 24 * 14).toISOString();
            const governed: IterationGovernedRecommendationRecord = {
                recommendation: { ...recommendation, status: 'pending' },
                lifecycleState: 'pending_review',
                doctrineVersion: this._state.doctrineVersion,
                evidenceSnapshotId,
                evidenceGeneratedAt: recommendation.createdAt,
                expiresAt,
                freshnessStatus: freshness,
                reasonCodes: [...eligibility.reasonCodes],
            };
            this._state.pendingRecommendations.push(governed);
        }

        this._state.lastRecommendationRunAt = nowIso;
    }

    evaluateRecommendationEligibility(recommendationId: string, nowIso?: string): IterationPromotionEligibilityResult | undefined {
        const record = this._state.pendingRecommendations.find((item) => item.recommendation.recommendationId === recommendationId);
        if (!record) return undefined;
        return this._governor.evaluateEligibility(record.recommendation, nowIso, record.doctrineVersion);
    }

    getActiveOverride(taskClass: IterationWorthinessClass): IterationGovernedOverrideRecord | undefined {
        return this._state.activeOverrides.find((item) => item.taskClass === taskClass && (item.lifecycleState === 'active' || item.lifecycleState === 'active_stale'));
    }

    getAppliedOverride(taskClass: IterationWorthinessClass): IterationPolicyAdjustment | undefined {
        const active = this.getActiveOverride(taskClass);
        if (!active) return undefined;
        return { ...active.adjustment };
    }

    applyManualOverride(
        adjustment: Omit<IterationPolicyAdjustment, 'origin' | 'promotedAt'> & {
            promotedAt?: string;
            doctrineVersion?: PolicyDoctrineVersion;
        },
    ): IterationPolicyAdjustment {
        const promotedAt = adjustment.promotedAt ?? new Date().toISOString();
        const applied: IterationPolicyAdjustment = {
            ...adjustment,
            origin: 'manual',
            promotedAt,
        };
        this._activateOverride({
            overrideId: `iover-${uuidv4()}`,
            recommendationId: undefined,
            taskClass: adjustment.taskClass,
            adjustment: applied,
            lifecycleState: 'active',
            doctrineVersion: adjustment.doctrineVersion ?? this._state.doctrineVersion,
            promotedAt,
            promotedBy: adjustment.promotedBy,
            promotionOrigin: 'manual_operator_review',
            evidenceSnapshotId: `manual-${uuidv4()}`,
            evidenceGeneratedAt: promotedAt,
            stalenessStatus: 'fresh',
            requiresRevalidation: 'not_required',
            reasonCodes: ['governance.override_active'],
        });
        return { ...applied };
    }

    promoteRecommendation(
        recommendationId: string,
        origin: 'manual' | 'approved_auto' | 'maintenance_review',
        promotedBy?: string,
        nowIso?: string,
    ): IterationPolicyPromotionRecord | undefined {
        const mappedOrigin: PromotionDecisionOrigin =
            origin === 'manual'
                ? 'manual_operator_review'
                : origin === 'approved_auto'
                    ? 'approved_auto_promotion'
                    : 'maintenance_review_promotion';
        return this.promoteRecommendationWithGovernance(recommendationId, mappedOrigin, promotedBy, nowIso);
    }

    promoteRecommendationWithGovernance(
        recommendationId: string,
        origin: PromotionDecisionOrigin,
        promotedBy?: string,
        nowIso?: string,
    ): IterationPolicyPromotionRecord | undefined {
        const record = this._state.pendingRecommendations.find((item) => item.recommendation.recommendationId === recommendationId);
        if (!record) return undefined;
        const decision = this._governor.buildPromotionDecision({
            recommendation: record.recommendation,
            origin,
            evidenceSnapshotId: record.evidenceSnapshotId,
            decidedBy: promotedBy,
            nowIso,
            recommendationDoctrineVersion: record.doctrineVersion,
        });
        this._state.promotionDecisions.push(cloneDecision(decision));

        if (!decision.approved || !decision.resultingOverride) {
            return undefined;
        }

        const promotedAt = decision.decidedAt;
        record.lifecycleState = 'promoted';
        record.promotedAt = promotedAt;
        record.promotedBy = promotedBy;
        record.confidenceAtDecision = decision.confidenceAtDecision;
        record.evidenceSufficiencyAtDecision = decision.evidenceSufficiencyAtDecision;
        record.reasonCodes = [...record.reasonCodes, ...decision.reasonCodes];
        this._state.pendingRecommendations = this._state.pendingRecommendations.filter(
            (item) => item.recommendation.recommendationId !== recommendationId,
        );

        const governanceReasonCodes: IterationPolicyGovernanceReasonCode[] = ['governance.override_active'];
        this._activateOverride({
            overrideId: `iover-${uuidv4()}`,
            recommendationId: recommendationId,
            taskClass: record.recommendation.taskClass,
            adjustment: decision.resultingOverride,
            lifecycleState: 'active',
            doctrineVersion: decision.doctrineVersion,
            promotedAt,
            promotedBy,
            promotionOrigin: origin,
            evidenceSnapshotId: decision.evidenceSnapshotId,
            evidenceGeneratedAt: record.evidenceGeneratedAt,
            stalenessStatus: 'fresh',
            requiresRevalidation: 'not_required',
            reasonCodes: governanceReasonCodes,
        });

        const promotionRecord: IterationPolicyPromotionRecord = {
            recommendationId,
            taskClass: record.recommendation.taskClass,
            promotedAt,
            promotedBy,
            origin: decision.resultingOverride.origin,
            appliedAdjustment: { ...decision.resultingOverride },
        };
        this._state.promotedRecommendations.push({ ...promotionRecord, appliedAdjustment: { ...promotionRecord.appliedAdjustment } });
        return promotionRecord;
    }

    rejectRecommendation(
        recommendationId: string,
        rejectionReason: string,
        rejectedBy?: string,
        nowIso?: string,
    ): IterationPolicyRejectionRecord | undefined {
        const record = this._state.pendingRecommendations.find((item) => item.recommendation.recommendationId === recommendationId);
        if (!record) return undefined;
        const rejectedAt = nowIso ?? new Date().toISOString();
        record.lifecycleState = 'rejected';
        record.rejectedAt = rejectedAt;
        record.rejectedBy = rejectedBy;
        record.rejectionReason = rejectionReason;
        record.reasonCodes = [...record.reasonCodes, 'governance.recommendation_rejected'];

        const rejectionRecord: IterationPolicyRejectionRecord = {
            recommendationId,
            taskClass: record.recommendation.taskClass,
            rejectedAt,
            rejectedBy,
            rejectionReason,
        };
        this._state.rejectedRecommendations.push({ ...rejectionRecord });
        this._state.pendingRecommendations = this._state.pendingRecommendations.filter(
            (item) => item.recommendation.recommendationId !== recommendationId,
        );
        return rejectionRecord;
    }

    expireStaleRecommendations(nowIso: string = new Date().toISOString()): number {
        let expired = 0;
        const remaining: IterationGovernedRecommendationRecord[] = [];
        for (const record of this._state.pendingRecommendations) {
            const freshness = this._governor.evaluateEvidenceFreshness(record.recommendation, nowIso);
            record.freshnessStatus = freshness;
            if (freshness === 'expired') {
                record.lifecycleState = 'expired';
                record.expiredAt = nowIso;
                record.expiryReason = 'stale_evidence_window_elapsed';
                record.reasonCodes = [...record.reasonCodes, 'governance.recommendation_expired'];
                this._state.expiredRecommendations.push(cloneRecommendation(record));
                expired += 1;
                continue;
            }
            remaining.push(record);
        }
        this._state.pendingRecommendations = remaining;
        return expired;
    }

    expireRecommendation(
        recommendationId: string,
        expiryReason: RecommendationExpiryReason,
        nowIso: string = new Date().toISOString(),
    ): IterationGovernedRecommendationRecord | undefined {
        const record = this._state.pendingRecommendations.find(
            (item) => item.recommendation.recommendationId === recommendationId,
        );
        if (!record) return undefined;
        record.lifecycleState = 'expired';
        record.expiredAt = nowIso;
        record.expiryReason = expiryReason;
        record.reasonCodes = [...record.reasonCodes, 'governance.recommendation_expired'];
        this._state.expiredRecommendations.push(cloneRecommendation(record));
        this._state.pendingRecommendations = this._state.pendingRecommendations.filter(
            (item) => item.recommendation.recommendationId !== recommendationId,
        );
        return cloneRecommendation(record);
    }

    revalidateActiveOverrides(nowIso: string = new Date().toISOString()): number {
        let staleCount = 0;
        for (const override of this._state.activeOverrides) {
            const ageMs = Math.max(0, new Date(nowIso).getTime() - new Date(override.evidenceGeneratedAt).getTime());
            if (ageMs > 1000 * 60 * 60 * 24 * 21) {
                override.lifecycleState = 'stale_requires_revalidation';
                override.stalenessStatus = 'stale_requires_revalidation';
                override.staleSince = override.staleSince ?? nowIso;
                override.requiresRevalidation = 'required_before_use';
                override.reasonCodes = [...override.reasonCodes, 'governance.override_marked_stale'];
                staleCount += 1;
            }
            if (override.doctrineVersion !== this._state.doctrineVersion) {
                override.lifecycleState = 'blocked_by_doctrine';
                override.stalenessStatus = 'incompatible';
                override.requiresRevalidation = 'required_before_use';
                override.reasonCodes = [...override.reasonCodes, 'governance.override_blocked_by_doctrine'];
            }
        }
        this._rebuildActiveOverrideIndexes();
        return staleCount;
    }

    revalidateOverride(
        overrideId: string,
        nowIso: string = new Date().toISOString(),
    ): IterationGovernedOverrideRecord | undefined {
        const override = this._state.activeOverrides.find((item) => item.overrideId === overrideId);
        if (!override) return undefined;
        const ageMs = Math.max(0, new Date(nowIso).getTime() - new Date(override.evidenceGeneratedAt).getTime());
        if (override.doctrineVersion !== this._state.doctrineVersion) {
            override.lifecycleState = 'blocked_by_doctrine';
            override.stalenessStatus = 'incompatible';
            override.requiresRevalidation = 'required_before_use';
            override.reasonCodes = [...override.reasonCodes, 'governance.override_blocked_by_doctrine'];
        } else if (ageMs > 1000 * 60 * 60 * 24 * 21) {
            override.lifecycleState = 'stale_requires_revalidation';
            override.stalenessStatus = 'stale_requires_revalidation';
            override.staleSince = override.staleSince ?? nowIso;
            override.requiresRevalidation = 'required_before_use';
            override.reasonCodes = [...override.reasonCodes, 'governance.override_marked_stale'];
        } else if (override.lifecycleState === 'disabled_by_operator') {
            // Preserve explicit operator disablement.
        } else {
            override.lifecycleState = 'active';
            override.stalenessStatus = 'fresh';
            override.requiresRevalidation = 'not_required';
            override.reasonCodes = [...override.reasonCodes, 'governance.override_revalidated'];
        }
        this._rebuildActiveOverrideIndexes();
        return cloneOverride(override);
    }

    runAutoPromotionPass(nowIso: string = new Date().toISOString()): string[] {
        const promotedIds: string[] = [];
        for (const pending of [...this._state.pendingRecommendations]) {
            const eligibility = this._governor.evaluateEligibility(
                pending.recommendation,
                nowIso,
                pending.doctrineVersion,
            );
            pending.reasonCodes = [...new Set([...pending.reasonCodes, ...eligibility.reasonCodes])];
            if (!eligibility.autoPromotionEligible) continue;
            const promoted = this.promoteRecommendationWithGovernance(
                pending.recommendation.recommendationId,
                'approved_auto_promotion',
                'iteration-policy-governor',
                nowIso,
            );
            if (promoted) {
                promotedIds.push(promoted.recommendationId);
            }
        }
        return promotedIds;
    }

    disableOverride(
        overrideId: string,
        nowIso: string = new Date().toISOString(),
    ): IterationGovernedOverrideRecord | undefined {
        const override = this._state.activeOverrides.find((item) => item.overrideId === overrideId)
            ?? this._state.staleOverrides.find((item) => item.overrideId === overrideId);
        if (!override) return undefined;
        if (
            override.lifecycleState === 'retired'
            || override.lifecycleState === 'superseded'
        ) {
            return undefined;
        }
        override.lifecycleState = 'disabled_by_operator';
        override.disabledAt = nowIso;
        override.reasonCodes = [...override.reasonCodes, 'governance.override_disabled_by_operator'];
        delete this._state.appliedOverrides[override.taskClass];
        this._rebuildActiveOverrideIndexes();
        return cloneOverride(override);
    }

    reenableOverride(
        overrideId: string,
        nowIso: string = new Date().toISOString(),
    ): IterationGovernedOverrideRecord | undefined {
        const override = this._state.activeOverrides.find((item) => item.overrideId === overrideId);
        if (!override) return undefined;
        if (override.lifecycleState !== 'disabled_by_operator') return undefined;
        if (override.doctrineVersion !== this._state.doctrineVersion) {
            override.lifecycleState = 'blocked_by_doctrine';
            override.stalenessStatus = 'incompatible';
            override.requiresRevalidation = 'required_before_use';
            override.reasonCodes = [...override.reasonCodes, 'governance.override_blocked_by_doctrine'];
            this._rebuildActiveOverrideIndexes();
            return undefined;
        }
        const ageMs = Math.max(0, new Date(nowIso).getTime() - new Date(override.evidenceGeneratedAt).getTime());
        if (ageMs > 1000 * 60 * 60 * 24 * 21) {
            override.lifecycleState = 'active_stale';
            override.stalenessStatus = 'stale_requires_revalidation';
            override.staleSince = override.staleSince ?? nowIso;
            override.requiresRevalidation = 'required';
            override.reasonCodes = [...override.reasonCodes, 'governance.override_marked_stale'];
        } else {
            override.lifecycleState = 'active';
            override.stalenessStatus = 'fresh';
            override.reasonCodes = [...override.reasonCodes, 'governance.override_active'];
        }
        this._rebuildActiveOverrideIndexes();
        return cloneOverride(override);
    }

    retireOverride(
        overrideId: string,
        reason: OverrideRetirementReason,
        nowIso: string = new Date().toISOString(),
    ): IterationGovernedOverrideRecord | undefined {
        const override = this._state.activeOverrides.find((item) => item.overrideId === overrideId)
            ?? this._state.staleOverrides.find((item) => item.overrideId === overrideId);
        if (!override) return undefined;
        override.lifecycleState = 'retired';
        override.retiredAt = nowIso;
        override.retirementReason = reason;
        override.reasonCodes = [...override.reasonCodes, 'governance.override_retired'];
        this._state.retiredOverrides.push(cloneOverride(override));
        this._state.activeOverrides = this._state.activeOverrides.filter((item) => item.overrideId !== overrideId);
        this._state.staleOverrides = this._state.staleOverrides.filter((item) => item.overrideId !== overrideId);
        delete this._state.appliedOverrides[override.taskClass];
        return cloneOverride(override);
    }

    private _activateOverride(record: IterationGovernedOverrideRecord): void {
        const prior = this._state.activeOverrides.find((item) => item.taskClass === record.taskClass && item.overrideId !== record.overrideId);
        if (prior) {
            prior.lifecycleState = 'superseded';
            prior.supersededByOverrideId = record.overrideId;
            prior.retiredAt = record.promotedAt;
            prior.retirementReason = 'superseded_by_new_override';
            prior.reasonCodes = [...prior.reasonCodes, 'governance.override_superseded'];
            this._state.supersededOverrides.push(cloneOverride(prior));
            this._state.overrideSupersessionRecords.push({
                priorOverrideId: prior.overrideId,
                supersededByOverrideId: record.overrideId,
                supersededAt: record.promotedAt,
                taskClass: record.taskClass,
                reasonCodes: ['governance.override_superseded'],
            });
            this._state.activeOverrides = this._state.activeOverrides.filter((item) => item.overrideId !== prior.overrideId);
            this._state.staleOverrides = this._state.staleOverrides.filter((item) => item.overrideId !== prior.overrideId);
        }
        this._state.activeOverrides.push(cloneOverride(record));
        this._state.appliedOverrides[record.taskClass] = { ...record.adjustment };
        this._rebuildActiveOverrideIndexes();
    }

    private _rebuildActiveOverrideIndexes(): void {
        this._state.staleOverrides = this._state.activeOverrides
            .filter((item) => item.lifecycleState === 'stale_requires_revalidation' || item.lifecycleState === 'active_stale')
            .map(cloneOverride);

        const nextApplied: Partial<Record<IterationWorthinessClass, IterationPolicyAdjustment>> = {};
        for (const override of this._state.activeOverrides) {
            if (
                override.lifecycleState === 'active' ||
                override.lifecycleState === 'active_stale'
            ) {
                nextApplied[override.taskClass] = { ...override.adjustment };
            }
        }
        this._state.appliedOverrides = nextApplied;
    }
}
