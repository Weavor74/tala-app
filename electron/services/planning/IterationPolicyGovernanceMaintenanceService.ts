import { v4 as uuidv4 } from 'uuid';
import type {
    GovernanceActionReasonCode,
    IterationGovernanceMaintenanceReport,
    IterationGovernanceSweepResult,
    IterationGovernanceSweepType,
} from '../../../shared/planning/IterationPolicyGovernanceOperationsTypes';
import type { IterationPolicyGovernanceReasonCode } from '../../../shared/planning/IterationPolicyGovernanceTypes';
import { TelemetryBus } from '../telemetry/TelemetryBus';
import { IterationPolicyGovernanceActionService } from './IterationPolicyGovernanceActionService';
import { IterationPolicyGovernanceQueryService } from './IterationPolicyGovernanceQueryService';
import { IterationPolicyTuningRepository } from './IterationPolicyTuningRepository';

export class IterationPolicyGovernanceMaintenanceService {
    constructor(
        private readonly _actions: IterationPolicyGovernanceActionService = new IterationPolicyGovernanceActionService(),
        private readonly _queries: IterationPolicyGovernanceQueryService = new IterationPolicyGovernanceQueryService(),
        private readonly _repository: IterationPolicyTuningRepository = IterationPolicyTuningRepository.getInstance(),
    ) {}

    runSweep(
        sweepType: IterationGovernanceSweepType = 'full_maintenance',
        nowIso: string = new Date().toISOString(),
        actorId: string = 'iteration-governance-maintenance',
    ): IterationGovernanceSweepResult {
        const startedAt = nowIso;
        TelemetryBus.getInstance().emit({
            executionId: `igovsweep-${sweepType}`,
            subsystem: 'planning',
            event: 'planning.iteration_governance_sweep_started',
            payload: { sweepType, startedAt },
        });

        const actionIds: string[] = [];
        let expiredRecommendationCount = 0;
        let promotedRecommendationCount = 0;
        let rejectedRecommendationCount = 0;
        let staleOverrideCount = 0;
        let retiredOverrideCount = 0;
        let incompatibleOverrideCount = 0;
        const reasonCodes = new Set<IterationPolicyGovernanceReasonCode | GovernanceActionReasonCode>();

        const runRecommendationReview = () => {
            const eligible = this._queries.getEligibleRecommendationQueue(nowIso);
            for (const item of eligible) {
                const result = this._actions.executeAction({
                    actionType: 'promote_recommendation',
                    targetArtifactId: item.artifactId,
                    targetArtifactType: 'recommendation',
                    origin: 'maintenance',
                    actorId,
                    nowIso,
                    note: 'maintenance_review_promotion',
                });
                actionIds.push(result.actionId);
                if (result.status === 'completed') {
                    promotedRecommendationCount += 1;
                    reasonCodes.add('governance_action.promoted');
                }
            }
        };

        const runExpiry = () => {
            const pending = this._queries.getPendingRecommendationQueue(nowIso)
                .filter((item) => item.expiresAt && item.expiresAt <= nowIso);
            for (const item of pending) {
                const result = this._actions.executeAction({
                    actionType: 'expire_recommendation',
                    targetArtifactId: item.artifactId,
                    targetArtifactType: 'recommendation',
                    origin: 'maintenance',
                    actorId,
                    nowIso,
                    note: 'maintenance_expiry_sweep',
                });
                actionIds.push(result.actionId);
                if (result.status === 'completed') {
                    expiredRecommendationCount += 1;
                    reasonCodes.add('governance_action.expired');
                }
            }
        };

        const runRevalidation = () => {
            const candidates = this._queries.getActiveOverrideInventory();
            for (const item of candidates) {
                const result = this._actions.executeAction({
                    actionType: 'revalidate_override',
                    targetArtifactId: item.artifactId,
                    targetArtifactType: 'override',
                    origin: 'maintenance',
                    actorId,
                    nowIso,
                    note: 'maintenance_revalidation_sweep',
                });
                actionIds.push(result.actionId);
                if (result.status === 'completed' && result.resultingOverrideState === 'stale_requires_revalidation') {
                    staleOverrideCount += 1;
                }
            }
        };

        const runRetirement = () => {
            const stale = this._queries.getStaleOverrideQueue();
            const incompatible = this._queries.getIncompatibleOverrideQueue();
            for (const item of [...stale, ...incompatible]) {
                const result = this._actions.executeAction({
                    actionType: 'retire_override',
                    targetArtifactId: item.artifactId,
                    targetArtifactType: 'override',
                    origin: 'maintenance',
                    actorId,
                    nowIso,
                    note: 'maintenance_retirement_sweep',
                });
                actionIds.push(result.actionId);
                if (result.status === 'completed') {
                    retiredOverrideCount += 1;
                    reasonCodes.add('governance_action.retired');
                }
            }
            incompatibleOverrideCount = incompatible.length;
        };

        if (sweepType === 'review_pending_recommendations' || sweepType === 'full_maintenance') {
            runRecommendationReview();
        }
        if (sweepType === 'expire_stale_recommendations' || sweepType === 'full_maintenance') {
            runExpiry();
        }
        if (sweepType === 'revalidate_active_overrides' || sweepType === 'full_maintenance' || sweepType === 'detect_doctrine_incompatibilities') {
            runRevalidation();
        }
        if (sweepType === 'retire_invalid_or_stale_overrides' || sweepType === 'full_maintenance' || sweepType === 'detect_doctrine_incompatibilities') {
            runRetirement();
        }

        const summary = this._queries.buildReviewSummary(nowIso);
        const report: IterationGovernanceMaintenanceReport = {
            reportId: `igovrep-${uuidv4()}`,
            generatedAt: nowIso,
            sweepResults: [],
            summary,
            recommendationQueueCounts: {
                pending: summary.pendingRecommendationCount,
                eligible: summary.eligibleRecommendationCount,
                blocked: summary.blockedRecommendationCount,
                expired: this._repository.getState().expiredRecommendations.length,
            },
            overrideQueueCounts: {
                active: summary.activeOverrideCount,
                stale: summary.staleOverrideCount,
                incompatible: summary.incompatibleOverrideCount,
                retired: this._repository.getState().retiredOverrides.length,
            },
            unresolvedIncompatibleOverrideIds: this._queries.getIncompatibleOverrideQueue().map((item) => item.artifactId),
        };

        const completedAt = new Date().toISOString();
        const result: IterationGovernanceSweepResult = {
            sweepType,
            startedAt,
            completedAt,
            status: 'completed',
            expiredRecommendationCount,
            promotedRecommendationCount,
            rejectedRecommendationCount,
            staleOverrideCount,
            retiredOverrideCount,
            incompatibleOverrideCount,
            actionIds,
            reasonCodes: [...reasonCodes, 'governance_action.sweep_completed'],
        };
        report.sweepResults = [result];
        this._repository.setLastMaintenanceReport(report);

        TelemetryBus.getInstance().emit({
            executionId: `igovsweep-${sweepType}`,
            subsystem: 'planning',
            event: 'planning.iteration_governance_sweep_completed',
            payload: {
                sweepType,
                completedAt,
                status: result.status,
                actionCount: actionIds.length,
                promotedRecommendationCount,
                expiredRecommendationCount,
                retiredOverrideCount,
            },
        });
        return result;
    }
}
