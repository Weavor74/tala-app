import type { StructuredFailure } from '../../../../shared/runtime/failureRecoveryTypes';
import type {
    FailureFamily,
    NormalizedExecutionFailure,
    RecoveryScope,
    RecoveryTrigger,
} from './RecoveryTypes';

type IdGenerator = () => string;
type TimestampGenerator = () => string;

const DEFAULT_TRIGGER_ID_GENERATOR: IdGenerator = (() => {
    let seq = 0;
    return () => {
        seq += 1;
        return `rec-trg-${seq}`;
    };
})();

const DEFAULT_TIMESTAMP_GENERATOR: TimestampGenerator = () => new Date().toISOString();

function mapFamily(failure?: StructuredFailure): FailureFamily {
    if (!failure) return 'unknown';
    if (failure.class === 'timeout') return 'timeout';
    if (failure.class === 'rate_limited') return 'rate_limited';
    if (failure.class === 'auth_required' || failure.class === 'permission_denied') {
        return 'authentication_failed';
    }
    if (failure.class === 'resource_unavailable' || failure.class === 'dependency_unreachable') {
        return 'unavailable';
    }
    if (failure.class === 'policy_blocked') return 'policy_blocked';
    if (failure.class === 'invalid_input') return 'invalid_input';
    if (failure.class === 'partial_result') return 'dependency_degraded';
    if (failure.class === 'unsupported_capability') return 'capability_unavailable';
    if (failure.class === 'invariant_violation') return 'conflict';
    return 'unknown';
}

function normalizeFailure(failure?: StructuredFailure): NormalizedExecutionFailure | undefined {
    if (!failure) return undefined;
    return {
        family: mapFamily(failure),
        message: failure.message,
        retryable: failure.retryable,
        toolId: failure.toolId,
        workflowId: failure.workflowId,
        providerId: failure.providerId,
        reasonCode: failure.reasonCode,
    };
}

interface CommonBuildInput {
    executionId: string;
    executionBoundaryId?: string;
    planId?: string;
    stepId?: string;
    reasonCode: string;
    retryCount?: number;
    maxRetries?: number;
    replanCount?: number;
    maxReplans?: number;
    canReplan?: boolean;
    canEscalate?: boolean;
    canDegradeContinue?: boolean;
    degradedCapability?: string;
    degradedModeHint?: 'reduced_capability' | 'read_only' | 'local_only';
    scope?: RecoveryScope;
}

export class RecoveryTriggerService {
    constructor(
        private readonly _nextTriggerId: IdGenerator = DEFAULT_TRIGGER_ID_GENERATOR,
        private readonly _now: TimestampGenerator = DEFAULT_TIMESTAMP_GENERATOR,
    ) {}

    forToolFailure(input: CommonBuildInput & { failure: StructuredFailure }): RecoveryTrigger {
        return {
            triggerId: this._nextTriggerId(),
            executionId: input.executionId,
            executionBoundaryId: input.executionBoundaryId,
            planId: input.planId,
            stepId: input.stepId,
            type: 'tool_failed',
            reasonCode: input.reasonCode,
            timestamp: this._now(),
            failure: normalizeFailure(input.failure),
            context: {
                handoffType: 'tool',
                toolId: input.failure.toolId,
                providerId: input.failure.providerId,
                retryCount: input.retryCount,
                maxRetries: input.maxRetries,
                replanCount: input.replanCount,
                maxReplans: input.maxReplans,
                canReplan: input.canReplan,
                canEscalate: input.canEscalate,
                canDegradeContinue: input.canDegradeContinue,
                degradedCapability: input.degradedCapability,
                degradedModeHint: input.degradedModeHint,
                scope: input.scope,
            },
        };
    }

    forWorkflowFailure(input: CommonBuildInput & { failure: StructuredFailure }): RecoveryTrigger {
        return {
            triggerId: this._nextTriggerId(),
            executionId: input.executionId,
            executionBoundaryId: input.executionBoundaryId,
            planId: input.planId,
            stepId: input.stepId,
            type: 'workflow_failed',
            reasonCode: input.reasonCode,
            timestamp: this._now(),
            failure: normalizeFailure(input.failure),
            context: {
                handoffType: 'workflow',
                workflowId: input.failure.workflowId,
                providerId: input.failure.providerId,
                retryCount: input.retryCount,
                maxRetries: input.maxRetries,
                replanCount: input.replanCount,
                maxReplans: input.maxReplans,
                canReplan: input.canReplan,
                canEscalate: input.canEscalate,
                canDegradeContinue: input.canDegradeContinue,
                degradedCapability: input.degradedCapability,
                degradedModeHint: input.degradedModeHint,
                scope: input.scope,
            },
        };
    }

    forRuntimeDegraded(input: CommonBuildInput): RecoveryTrigger {
        return {
            triggerId: this._nextTriggerId(),
            executionId: input.executionId,
            executionBoundaryId: input.executionBoundaryId,
            planId: input.planId,
            stepId: input.stepId,
            type: 'runtime_degraded',
            reasonCode: input.reasonCode,
            timestamp: this._now(),
            context: {
                canReplan: input.canReplan,
                canEscalate: input.canEscalate,
                canDegradeContinue: input.canDegradeContinue,
                degradedCapability: input.degradedCapability,
                degradedModeHint: input.degradedModeHint,
                retryCount: input.retryCount,
                maxRetries: input.maxRetries,
                replanCount: input.replanCount,
                maxReplans: input.maxReplans,
                scope: input.scope,
            },
        };
    }
}
