import type {
    DegradedContinuationMode,
    RecoveryDecision,
    RecoveryTrigger,
} from './RecoveryTypes';

type IdGenerator = () => string;

const DEFAULT_ID_GENERATOR: IdGenerator = (() => {
    let seq = 0;
    return () => {
        seq += 1;
        return `rec-dec-${seq}`;
    };
})();

export class RecoveryPolicyService {
    constructor(private readonly _nextDecisionId: IdGenerator = DEFAULT_ID_GENERATOR) {}

    selectDecision(trigger: RecoveryTrigger): RecoveryDecision {
        const retryCount = trigger.context.retryCount ?? 0;
        const maxRetries = trigger.context.maxRetries ?? 0;
        const replanCount = trigger.context.replanCount ?? 0;
        const maxReplans = trigger.context.maxReplans ?? 0;
        const retriesRemaining = retryCount < maxRetries;
        const replansRemaining = replanCount < maxReplans;
        const loopDetected = trigger.context.loopDetected === true;
        const family = trigger.failure?.family ?? 'unknown';

        if (loopDetected) {
            if (trigger.context.canEscalate) {
                return this._buildDecision(trigger, 'escalate', 'recovery.escalate.loop_detected');
            }
            return this._buildDecision(trigger, 'stop', 'recovery.stop.recovery_exhausted');
        }

        if (family === 'policy_blocked') {
            if (trigger.context.canEscalate) {
                return this._buildDecision(trigger, 'escalate', 'recovery.escalate.policy_blocked');
            }
            return this._buildDecision(trigger, 'stop', 'recovery.stop.no_valid_path');
        }

        if (family === 'authentication_failed') {
            if (trigger.context.canEscalate) {
                return this._buildDecision(trigger, 'escalate', 'recovery.escalate.authentication_failed');
            }
            return this._buildDecision(trigger, 'stop', 'recovery.stop.no_valid_path');
        }

        if (trigger.type === 'runtime_degraded') {
            if (trigger.context.canDegradeContinue) {
                return this._buildDegradedDecision(trigger, this._resolveDegradedMode(trigger));
            }
            if (trigger.context.canReplan && replansRemaining) {
                return this._buildDecision(trigger, 'replan', 'recovery.replan.runtime_degraded');
            }
            if (trigger.context.canEscalate) {
                return this._buildDecision(trigger, 'escalate', 'recovery.escalate.recovery_exhausted');
            }
            return this._buildDecision(trigger, 'stop', 'recovery.stop.recovery_exhausted');
        }

        if ((family === 'timeout' || family === 'rate_limited' || family === 'conflict') && retriesRemaining) {
            const reasonCode = family === 'rate_limited'
                ? 'recovery.retry.rate_limited'
                : family === 'conflict'
                    ? 'recovery.retry.conflict'
                    : 'recovery.retry.timeout';
            return this._buildDecision(trigger, 'retry', reasonCode);
        }

        if (
            (family === 'unavailable' || family === 'capability_unavailable' || family === 'dependency_degraded') &&
            trigger.context.canReplan &&
            replansRemaining
        ) {
            if (family === 'capability_unavailable') {
                return this._buildDecision(trigger, 'replan', 'recovery.replan.capability_unavailable');
            }
            if (family === 'dependency_degraded') {
                return this._buildDecision(trigger, 'replan', 'recovery.replan.dependency_degraded');
            }
            return this._buildDecision(trigger, 'replan', 'recovery.replan.unavailable');
        }

        if (
            (family === 'dependency_degraded' || family === 'capability_unavailable' || family === 'unavailable') &&
            trigger.context.canDegradeContinue
        ) {
            return this._buildDegradedDecision(trigger, this._resolveDegradedMode(trigger));
        }

        if (!retriesRemaining && !replansRemaining) {
            if (trigger.context.canEscalate) {
                return this._buildDecision(trigger, 'escalate', 'recovery.escalate.recovery_exhausted');
            }
            return this._buildDecision(trigger, 'stop', 'recovery.stop.recovery_exhausted');
        }

        return this._buildDecision(trigger, 'stop', 'recovery.stop.no_valid_path');
    }

    private _buildDecision(
        trigger: RecoveryTrigger,
        type: RecoveryDecision['type'],
        reasonCode: string,
    ): RecoveryDecision {
        return {
            decisionId: this._nextDecisionId(),
            triggerId: trigger.triggerId,
            executionId: trigger.executionId,
            executionBoundaryId: trigger.executionBoundaryId,
            type,
            reasonCode,
            scope: trigger.context.scope,
        };
    }

    private _buildDegradedDecision(
        trigger: RecoveryTrigger,
        mode: DegradedContinuationMode,
    ): RecoveryDecision {
        const reasonCode = mode.continueMode === 'read_only'
            ? 'recovery.degrade.read_only'
            : mode.continueMode === 'local_only'
                ? 'recovery.degrade.local_only'
                : 'recovery.degrade.reduced_capability';
        return {
            ...this._buildDecision(trigger, 'degrade_and_continue', reasonCode),
            degradedMode: mode,
        };
    }

    private _resolveDegradedMode(trigger: RecoveryTrigger): DegradedContinuationMode {
        const disabledCapabilities = trigger.context.degradedCapability
            ? [trigger.context.degradedCapability]
            : [];
        const continueMode = trigger.context.degradedModeHint
            ?? (trigger.context.degradedCapability?.includes('memory') ? 'read_only' : 'local_only');
        return {
            disabledCapabilities,
            continueMode,
        };
    }
}
