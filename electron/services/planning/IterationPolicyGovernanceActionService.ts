import { v4 as uuidv4 } from 'uuid';
import type {
    IterationGovernanceActionRequest,
    IterationGovernanceActionResult,
    IterationGovernanceHistoryEntry,
    IterationGovernanceActionStatus,
} from '../../../shared/planning/IterationPolicyGovernanceOperationsTypes';
import { TelemetryBus } from '../telemetry/TelemetryBus';
import { IterationPolicyTuningRepository } from './IterationPolicyTuningRepository';

export class IterationPolicyGovernanceActionService {
    constructor(
        private readonly _repository: IterationPolicyTuningRepository = IterationPolicyTuningRepository.getInstance(),
    ) {}

    executeAction(request: IterationGovernanceActionRequest): IterationGovernanceActionResult {
        const nowIso = request.nowIso ?? new Date().toISOString();
        const actionId = `igovact-${uuidv4()}`;
        const telemetry = TelemetryBus.getInstance();
        telemetry.emit({
            executionId: request.targetArtifactId ?? actionId,
            subsystem: 'planning',
            event: 'planning.iteration_governance_action_requested',
            payload: {
                actionId,
                actionType: request.actionType,
                targetArtifactId: request.targetArtifactId,
                origin: request.origin,
            },
        });

        let result: IterationGovernanceActionResult;
        switch (request.actionType) {
            case 'promote_recommendation':
                result = this._promoteRecommendation(actionId, request, nowIso);
                break;
            case 'reject_recommendation':
                result = this._rejectRecommendation(actionId, request, nowIso);
                break;
            case 'expire_recommendation':
                result = this._expireRecommendation(actionId, request, nowIso);
                break;
            case 'revalidate_override':
                result = this._revalidateOverride(actionId, request, nowIso);
                break;
            case 'retire_override':
                result = this._retireOverride(actionId, request, nowIso);
                break;
            case 'disable_override':
                result = this._disableOverride(actionId, request, nowIso);
                break;
            case 'reenable_override':
                result = this._reenableOverride(actionId, request, nowIso);
                break;
            case 'supersede_override':
                result = this._supersedeOverride(actionId, request, nowIso);
                break;
            case 'acknowledge_incompatibility':
                result = this._acknowledgeIncompatibility(actionId, request, nowIso);
                break;
            case 'run_governance_sweep':
            default:
                result = this._buildBlockedResult(actionId, request, nowIso, 'invalid_transition', [
                    'governance_action.blocked_invalid_transition',
                ]);
                break;
        }

        this._recordHistory(actionId, request, result, nowIso);
        const completedEvent = result.status === 'completed'
            ? 'planning.iteration_governance_action_completed'
            : 'planning.iteration_governance_action_blocked';
        telemetry.emit({
            executionId: result.targetArtifactId ?? actionId,
            subsystem: 'planning',
            event: completedEvent,
            payload: {
                actionId: result.actionId,
                actionType: result.actionType,
                status: result.status,
                reasonCodes: result.reasonCodes,
                blockedReasonCodes: result.blockedReasonCodes,
                targetArtifactId: result.targetArtifactId,
            },
        });
        if (result.status === 'completed') {
            const lifecycleEventByAction: Partial<Record<typeof result.actionType, string>> = {
                promote_recommendation: 'planning.iteration_governance_recommendation_promoted',
                reject_recommendation: 'planning.iteration_governance_recommendation_rejected',
                expire_recommendation: 'planning.iteration_governance_recommendation_expired',
                revalidate_override: 'planning.iteration_governance_override_revalidated',
                retire_override: 'planning.iteration_governance_override_retired',
                disable_override: 'planning.iteration_governance_override_disabled',
                reenable_override: 'planning.iteration_governance_override_reenabled',
            };
            const lifecycleEvent = lifecycleEventByAction[result.actionType];
            if (lifecycleEvent) {
                telemetry.emit({
                    executionId: result.targetArtifactId ?? actionId,
                    subsystem: 'planning',
                    event: lifecycleEvent as import('../../../shared/runtimeEventTypes').RuntimeEventType,
                    payload: {
                        actionId: result.actionId,
                        targetArtifactId: result.targetArtifactId,
                        resultingState: result.resultingRecommendationState ?? result.resultingOverrideState,
                        reasonCodes: result.reasonCodes,
                    },
                });
            }
        }
        return result;
    }

    private _promoteRecommendation(
        actionId: string,
        request: IterationGovernanceActionRequest,
        nowIso: string,
    ): IterationGovernanceActionResult {
        if (!request.targetArtifactId) {
            return this._buildBlockedResult(actionId, request, nowIso, 'not_found', ['governance_action.blocked_not_found']);
        }
        const pending = this._repository.getState().pendingRecommendations.find(
            (item) => item.recommendation.recommendationId === request.targetArtifactId,
        );
        if (!pending) {
            return this._buildBlockedResult(actionId, request, nowIso, 'not_found', ['governance_action.blocked_not_found']);
        }
        const eligibility = this._repository.evaluateRecommendationEligibility(request.targetArtifactId, nowIso);
        if (!eligibility || eligibility.status !== 'eligible') {
            return this._buildBlockedResult(actionId, request, nowIso, 'blocked', [
                'governance_action.blocked_not_eligible',
                ...(eligibility?.reasonCodes ?? []),
            ]);
        }
        const promoted = this._repository.promoteRecommendationWithGovernance(
            request.targetArtifactId,
            request.origin === 'operator'
                ? 'manual_operator_review'
                : request.origin === 'maintenance'
                    ? 'maintenance_review_promotion'
                    : 'approved_auto_promotion',
            request.actorId,
            nowIso,
        );
        if (!promoted) {
            return this._buildBlockedResult(actionId, request, nowIso, 'blocked', ['governance_action.blocked_not_eligible']);
        }
        const active = this._repository.getState().activeOverrides.find((item) => item.recommendationId === request.targetArtifactId);
        return {
            actionId,
            actionType: request.actionType,
            status: 'completed',
            origin: request.origin,
            actorId: request.actorId,
            targetArtifactId: request.targetArtifactId,
            targetArtifactType: 'recommendation',
            priorRecommendationState: 'pending_review',
            resultingRecommendationState: 'promoted',
            resultingOverrideState: active?.lifecycleState,
            createdOverrideId: active?.overrideId,
            blockedReasonCodes: [],
            reasonCodes: ['governance_action.promoted'],
            completedAt: nowIso,
        };
    }

    private _rejectRecommendation(
        actionId: string,
        request: IterationGovernanceActionRequest,
        nowIso: string,
    ): IterationGovernanceActionResult {
        if (!request.targetArtifactId) {
            return this._buildBlockedResult(actionId, request, nowIso, 'not_found', ['governance_action.blocked_not_found']);
        }
        const pending = this._repository.getState().pendingRecommendations.find(
            (item) => item.recommendation.recommendationId === request.targetArtifactId,
        );
        if (!pending) {
            return this._buildBlockedResult(actionId, request, nowIso, 'invalid_transition', ['governance_action.blocked_invalid_transition']);
        }
        this._repository.rejectRecommendation(
            request.targetArtifactId,
            request.note ?? 'rejected_by_governance_action',
            request.actorId,
            nowIso,
        );
        return {
            actionId,
            actionType: request.actionType,
            status: 'completed',
            origin: request.origin,
            actorId: request.actorId,
            targetArtifactId: request.targetArtifactId,
            targetArtifactType: 'recommendation',
            priorRecommendationState: 'pending_review',
            resultingRecommendationState: 'rejected',
            blockedReasonCodes: [],
            reasonCodes: ['governance_action.rejected'],
            completedAt: nowIso,
        };
    }

    private _expireRecommendation(
        actionId: string,
        request: IterationGovernanceActionRequest,
        nowIso: string,
    ): IterationGovernanceActionResult {
        if (!request.targetArtifactId) {
            return this._buildBlockedResult(actionId, request, nowIso, 'not_found', ['governance_action.blocked_not_found']);
        }
        const pending = this._repository.getState().pendingRecommendations.find(
            (item) => item.recommendation.recommendationId === request.targetArtifactId,
        );
        if (!pending) {
            return this._buildBlockedResult(actionId, request, nowIso, 'invalid_transition', ['governance_action.blocked_invalid_transition']);
        }
        const expired = this._repository.expireRecommendation(
            request.targetArtifactId,
            'stale_evidence_window_elapsed',
            nowIso,
        );
        if (!expired) {
            return this._buildBlockedResult(actionId, request, nowIso, 'failed', ['governance_action.blocked_invalid_transition']);
        }
        return {
            actionId,
            actionType: request.actionType,
            status: 'completed',
            origin: request.origin,
            actorId: request.actorId,
            targetArtifactId: request.targetArtifactId,
            targetArtifactType: 'recommendation',
            priorRecommendationState: 'pending_review',
            resultingRecommendationState: 'expired',
            blockedReasonCodes: [],
            reasonCodes: ['governance_action.expired'],
            completedAt: nowIso,
        };
    }

    private _revalidateOverride(
        actionId: string,
        request: IterationGovernanceActionRequest,
        nowIso: string,
    ): IterationGovernanceActionResult {
        if (!request.targetArtifactId) {
            return this._buildBlockedResult(actionId, request, nowIso, 'not_found', ['governance_action.blocked_not_found']);
        }
        const prior = this._repository.getOverrideRecord(request.targetArtifactId);
        if (!prior) {
            return this._buildBlockedResult(actionId, request, nowIso, 'not_found', ['governance_action.blocked_not_found']);
        }
        const updated = this._repository.revalidateOverride(request.targetArtifactId, nowIso);
        if (!updated) {
            return this._buildBlockedResult(actionId, request, nowIso, 'invalid_transition', ['governance_action.blocked_invalid_transition']);
        }
        return {
            actionId,
            actionType: request.actionType,
            status: 'completed',
            origin: request.origin,
            actorId: request.actorId,
            targetArtifactId: request.targetArtifactId,
            targetArtifactType: 'override',
            priorOverrideState: prior.lifecycleState,
            resultingOverrideState: updated.lifecycleState,
            blockedReasonCodes: [],
            reasonCodes: ['governance_action.revalidated'],
            completedAt: nowIso,
        };
    }

    private _retireOverride(
        actionId: string,
        request: IterationGovernanceActionRequest,
        nowIso: string,
    ): IterationGovernanceActionResult {
        if (!request.targetArtifactId) {
            return this._buildBlockedResult(actionId, request, nowIso, 'not_found', ['governance_action.blocked_not_found']);
        }
        const prior = this._repository.getOverrideRecord(request.targetArtifactId);
        if (!prior) {
            return this._buildBlockedResult(actionId, request, nowIso, 'not_found', ['governance_action.blocked_not_found']);
        }
        const retired = this._repository.retireOverride(
            request.targetArtifactId,
            'stale_evidence_retirement',
            nowIso,
        );
        if (!retired) {
            return this._buildBlockedResult(actionId, request, nowIso, 'invalid_transition', ['governance_action.blocked_invalid_transition']);
        }
        return {
            actionId,
            actionType: request.actionType,
            status: 'completed',
            origin: request.origin,
            actorId: request.actorId,
            targetArtifactId: request.targetArtifactId,
            targetArtifactType: 'override',
            priorOverrideState: prior.lifecycleState,
            resultingOverrideState: retired.lifecycleState,
            blockedReasonCodes: [],
            reasonCodes: ['governance_action.retired'],
            completedAt: nowIso,
        };
    }

    private _disableOverride(
        actionId: string,
        request: IterationGovernanceActionRequest,
        nowIso: string,
    ): IterationGovernanceActionResult {
        if (!request.targetArtifactId) {
            return this._buildBlockedResult(actionId, request, nowIso, 'not_found', ['governance_action.blocked_not_found']);
        }
        const prior = this._repository.getOverrideRecord(request.targetArtifactId);
        if (!prior) {
            return this._buildBlockedResult(actionId, request, nowIso, 'not_found', ['governance_action.blocked_not_found']);
        }
        const disabled = this._repository.disableOverride(request.targetArtifactId, nowIso);
        if (!disabled) {
            return this._buildBlockedResult(actionId, request, nowIso, 'invalid_transition', ['governance_action.blocked_invalid_transition']);
        }
        return {
            actionId,
            actionType: request.actionType,
            status: 'completed',
            origin: request.origin,
            actorId: request.actorId,
            targetArtifactId: request.targetArtifactId,
            targetArtifactType: 'override',
            priorOverrideState: prior.lifecycleState,
            resultingOverrideState: disabled.lifecycleState,
            blockedReasonCodes: [],
            reasonCodes: ['governance_action.disabled'],
            completedAt: nowIso,
        };
    }

    private _reenableOverride(
        actionId: string,
        request: IterationGovernanceActionRequest,
        nowIso: string,
    ): IterationGovernanceActionResult {
        if (!request.targetArtifactId) {
            return this._buildBlockedResult(actionId, request, nowIso, 'not_found', ['governance_action.blocked_not_found']);
        }
        const prior = this._repository.getOverrideRecord(request.targetArtifactId);
        if (!prior) {
            return this._buildBlockedResult(actionId, request, nowIso, 'not_found', ['governance_action.blocked_not_found']);
        }
        if (prior.lifecycleState !== 'disabled_by_operator') {
            return this._buildBlockedResult(actionId, request, nowIso, 'invalid_transition', ['governance_action.blocked_invalid_transition']);
        }
        const enabled = this._repository.reenableOverride(request.targetArtifactId, nowIso);
        if (!enabled) {
            return this._buildBlockedResult(actionId, request, nowIso, 'blocked', ['governance_action.blocked_doctrine_incompatible']);
        }
        return {
            actionId,
            actionType: request.actionType,
            status: 'completed',
            origin: request.origin,
            actorId: request.actorId,
            targetArtifactId: request.targetArtifactId,
            targetArtifactType: 'override',
            priorOverrideState: prior.lifecycleState,
            resultingOverrideState: enabled.lifecycleState,
            blockedReasonCodes: [],
            reasonCodes: ['governance_action.reenabled'],
            completedAt: nowIso,
        };
    }

    private _supersedeOverride(
        actionId: string,
        request: IterationGovernanceActionRequest,
        nowIso: string,
    ): IterationGovernanceActionResult {
        // Supersession is executed via promoting a newer recommendation.
        return this._promoteRecommendation(actionId, {
            ...request,
            actionType: 'promote_recommendation',
        }, nowIso);
    }

    private _acknowledgeIncompatibility(
        actionId: string,
        request: IterationGovernanceActionRequest,
        nowIso: string,
    ): IterationGovernanceActionResult {
        return {
            actionId,
            actionType: request.actionType,
            status: 'completed',
            origin: request.origin,
            actorId: request.actorId,
            targetArtifactId: request.targetArtifactId,
            targetArtifactType: request.targetArtifactType,
            blockedReasonCodes: [],
            reasonCodes: ['governance_action.acknowledged'],
            completedAt: nowIso,
        };
    }

    private _buildBlockedResult(
        actionId: string,
        request: IterationGovernanceActionRequest,
        nowIso: string,
        status: Exclude<IterationGovernanceActionStatus, 'completed'>,
        codes: IterationGovernanceActionResult['blockedReasonCodes'],
    ): IterationGovernanceActionResult {
        return {
            actionId,
            actionType: request.actionType,
            status,
            origin: request.origin,
            actorId: request.actorId,
            targetArtifactId: request.targetArtifactId,
            targetArtifactType: request.targetArtifactType,
            blockedReasonCodes: codes,
            reasonCodes: [...codes],
            completedAt: nowIso,
        };
    }

    private _recordHistory(
        actionId: string,
        request: IterationGovernanceActionRequest,
        result: IterationGovernanceActionResult,
        nowIso: string,
    ): void {
        const entry: IterationGovernanceHistoryEntry = {
            historyId: `igovhist-${uuidv4()}`,
            actionId,
            actionType: request.actionType,
            actionStatus: result.status,
            origin: request.origin,
            actorId: request.actorId,
            targetArtifactId: request.targetArtifactId,
            targetArtifactType: request.targetArtifactType,
            priorLifecycleState: result.priorRecommendationState ?? result.priorOverrideState,
            resultingLifecycleState: result.resultingRecommendationState ?? result.resultingOverrideState,
            recommendationId: request.targetArtifactType === 'recommendation' ? request.targetArtifactId : undefined,
            overrideId: request.targetArtifactType === 'override' ? request.targetArtifactId : undefined,
            note: request.note,
            reasonCodes: [...result.reasonCodes],
            blockedReasonCodes: [...result.blockedReasonCodes],
            timestamp: nowIso,
        };
        this._repository.appendGovernanceHistory(entry);
    }
}
