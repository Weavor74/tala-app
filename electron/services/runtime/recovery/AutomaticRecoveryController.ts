import { TelemetryBus } from '../../telemetry/TelemetryBus';
import { RecoveryActionExecutor } from './RecoveryActionExecutor';
import { RecoveryBudgetService } from './RecoveryBudgetService';
import { RecoveryHistoryRepositoryService } from './RecoveryHistoryRepository';
import { RecoveryPolicyService } from './RecoveryPolicyEngine';
import type {
    RecoveryApprovalState,
    RecoveryBudgetInput,
    RecoveryDecision,
    RecoveryDecisionOrigin,
    RecoveryDecisionType,
    RecoveryOperatorActionInput,
    RecoveryOperatorSnapshot,
    RecoveryOperatorState,
    RecoveryTrigger,
} from './RecoveryTypes';

interface PendingApprovalRecord {
    decision: RecoveryDecision;
    trigger: RecoveryTrigger;
    controller: AutomaticRecoveryControlService;
    scopeKey: string;
    createdAt: string;
}

type TimestampGenerator = () => string;

type RecoveryActionEventType =
    | 'recovery.retry_requested'
    | 'recovery.replan_requested'
    | 'recovery.escalation_requested'
    | 'recovery.degraded_continue_applied'
    | 'recovery.stop_requested';

const DEFAULT_NOW: TimestampGenerator = () => new Date().toISOString();

export class AutomaticRecoveryControlService {
    private static _pendingByDecisionId = new Map<string, PendingApprovalRecord>();
    private static _latestPendingDecisionByScope = new Map<string, string>();
    private static _operatorStateByScope = new Map<string, RecoveryOperatorSnapshot>();
    private static _historySeq = 0;

    constructor(
        private readonly _policyEngine: RecoveryPolicyService,
        private readonly _budgetService: RecoveryBudgetService,
        private readonly _actionExecutor: RecoveryActionExecutor,
        private readonly _telemetry: TelemetryBus = TelemetryBus.getInstance(),
        private readonly _historyRepository: RecoveryHistoryRepositoryService = RecoveryHistoryRepositoryService.getInstance(),
        private readonly _now: TimestampGenerator = DEFAULT_NOW,
    ) {}

    public static getRecoveryOperatorState(input: {
        executionId: string;
        executionBoundaryId?: string;
    }): RecoveryOperatorSnapshot | undefined {
        const scopeKey = this._toScopeKey(input.executionId, input.executionBoundaryId);
        return this._operatorStateByScope.get(scopeKey);
    }

    public static async submitOperatorRecoveryAction(
        input: RecoveryOperatorActionInput,
        telemetry: TelemetryBus = TelemetryBus.getInstance(),
    ): Promise<RecoveryDecision> {
        const scopeKey = this._toScopeKey(input.executionId, input.executionBoundaryId);
        const pending = this._resolvePending(scopeKey, input.decisionId);
        if (!pending) {
            throw new Error('RECOVERY_OPERATOR_ACTION_NO_PENDING_DECISION');
        }

        telemetry.emit({
            executionId: input.executionId,
            subsystem: 'planning',
            event: 'recovery.override_requested',
            phase: 'recovery',
            payload: {
                executionBoundaryId: input.executionBoundaryId,
                decisionId: pending.decision.decisionId,
                triggerId: pending.trigger.triggerId,
                decisionType: pending.decision.type,
                operatorAction: input.action,
                operatorReasonCode: input.operatorReasonCode,
            },
        });

        if (input.action === 'deny') {
            const deniedDecision: RecoveryDecision = {
                ...pending.decision,
                origin: 'operator_override',
                operatorState: {
                    approvalState: 'denied',
                    overrideAllowed: true,
                    overrideApplied: false,
                    lastOperatorAction: 'deny',
                    operatorReasonCode: input.operatorReasonCode,
                },
            };
            this._clearPending(scopeKey, pending.decision.decisionId);
            this._setOperatorSnapshot(scopeKey, pending.controller._buildOperatorSnapshot(deniedDecision, pending.trigger));
            telemetry.emit({
                executionId: input.executionId,
                subsystem: 'planning',
                event: 'recovery.approval_denied',
                phase: 'recovery',
                payload: {
                    executionBoundaryId: input.executionBoundaryId,
                    decisionId: deniedDecision.decisionId,
                    triggerId: deniedDecision.triggerId,
                    decisionType: deniedDecision.type,
                    reasonCode: deniedDecision.reasonCode,
                    operatorAction: input.action,
                    operatorReasonCode: input.operatorReasonCode,
                },
            });
            telemetry.emit({
                executionId: input.executionId,
                subsystem: 'planning',
                event: 'recovery.override_denied',
                phase: 'recovery',
                payload: {
                    executionBoundaryId: input.executionBoundaryId,
                    decisionId: deniedDecision.decisionId,
                    triggerId: deniedDecision.triggerId,
                    decisionType: deniedDecision.type,
                    reasonCode: deniedDecision.reasonCode,
                    operatorAction: input.action,
                    operatorReasonCode: input.operatorReasonCode,
                },
            });
            await pending.controller._recordHistoryAndEmit(deniedDecision, pending.trigger, 'denied');
            return deniedDecision;
        }

        if (input.action === 'force_stop') {
            const overrideDecision: RecoveryDecision = {
                ...pending.decision,
                type: 'stop',
                reasonCode: 'recovery.stop.operator_forced',
                origin: 'operator_override',
                operatorState: {
                    approvalState: 'approved',
                    overrideAllowed: true,
                    overrideApplied: true,
                    lastOperatorAction: 'force_stop',
                    operatorReasonCode: input.operatorReasonCode,
                },
            };
            this._clearPending(scopeKey, pending.decision.decisionId);
            telemetry.emit({
                executionId: input.executionId,
                subsystem: 'planning',
                event: 'recovery.override_applied',
                phase: 'recovery',
                payload: {
                    executionBoundaryId: input.executionBoundaryId,
                    decisionId: overrideDecision.decisionId,
                    triggerId: overrideDecision.triggerId,
                    decisionType: overrideDecision.type,
                    reasonCode: overrideDecision.reasonCode,
                    operatorAction: input.action,
                    operatorReasonCode: input.operatorReasonCode,
                    origin: overrideDecision.origin,
                },
            });
            await pending.controller._executeWithLifecycle(overrideDecision, pending.trigger);
            this._setOperatorSnapshot(scopeKey, pending.controller._buildOperatorSnapshot(overrideDecision, pending.trigger));
            return overrideDecision;
        }

        this._assertApprovalActionMatchesDecision(input.action, pending.decision.type);

        const approvedDecision: RecoveryDecision = {
            ...pending.decision,
            origin: 'operator_approved',
            operatorState: {
                approvalState: 'approved',
                overrideAllowed: true,
                overrideApplied: false,
                lastOperatorAction: input.action,
                operatorReasonCode: input.operatorReasonCode,
            },
        };

        this._clearPending(scopeKey, pending.decision.decisionId);
        telemetry.emit({
            executionId: input.executionId,
            subsystem: 'planning',
            event: 'recovery.approval_granted',
            phase: 'recovery',
            payload: {
                executionBoundaryId: input.executionBoundaryId,
                decisionId: approvedDecision.decisionId,
                triggerId: approvedDecision.triggerId,
                decisionType: approvedDecision.type,
                reasonCode: approvedDecision.reasonCode,
                operatorAction: input.action,
                operatorReasonCode: input.operatorReasonCode,
                origin: approvedDecision.origin,
            },
        });

        await pending.controller._executeWithLifecycle(approvedDecision, pending.trigger);
        this._setOperatorSnapshot(scopeKey, pending.controller._buildOperatorSnapshot(approvedDecision, pending.trigger));
        return approvedDecision;
    }

    evaluate(trigger: RecoveryTrigger): RecoveryDecision {
        const budgetInput = this._toBudgetInput(trigger);
        const budget = this._budgetService.getBudget(budgetInput);
        const enrichedTrigger: RecoveryTrigger = {
            ...trigger,
            context: {
                ...trigger.context,
                retryCount: trigger.context.retryCount ?? budget.retryCount,
                maxRetries: trigger.context.maxRetries ?? budget.maxRetries,
                replanCount: trigger.context.replanCount ?? budget.replanCount,
                maxReplans: trigger.context.maxReplans ?? budget.maxReplans,
                loopDetected: trigger.context.loopDetected ?? budget.loopDetected,
                scope: trigger.context.scope ?? budget.scope,
            },
        };
        return this._policyEngine.selectDecision(enrichedTrigger);
    }

    async execute(decision: RecoveryDecision, trigger: RecoveryTrigger): Promise<void> {
        await this._actionExecutor.executeDecision(decision, trigger);
        const budgetInput = this._toBudgetInput(trigger, decision.scope);
        if (decision.type === 'retry') {
            this._budgetService.incrementRetry(budgetInput);
        }
        if (decision.type === 'replan') {
            this._budgetService.incrementReplan(budgetInput);
        }
    }

    async handleTrigger(trigger: RecoveryTrigger): Promise<RecoveryDecision> {
        this._telemetry.emit({
            executionId: trigger.executionId,
            subsystem: 'planning',
            event: 'recovery.triggered',
            phase: 'recovery',
            payload: {
                executionBoundaryId: trigger.executionBoundaryId,
                triggerId: trigger.triggerId,
                reasonCode: trigger.reasonCode,
                handoffType: trigger.context.handoffType,
                scope: trigger.context.scope,
            },
        });

        const decision = this.evaluate(trigger);
        decision.origin = decision.origin ?? 'automatic';
        decision.operatorState = decision.operatorState ?? {
            approvalState: 'not_required',
            overrideAllowed: false,
            overrideApplied: false,
        };

        const budgetInput = this._toBudgetInput(trigger, decision.scope);
        const budgetSnapshot = this._budgetService.getBudget(budgetInput);
        const exhausted = this._budgetService.isExhausted(budgetInput);
        const loopSignal = this._budgetService.recordDecision(
            budgetInput,
            decision.type,
            decision.reasonCode,
        );

        if (this._isApprovalRequired(decision, trigger, loopSignal.loopDetected)) {
            decision.operatorState = {
                approvalState: 'pending_operator',
                overrideAllowed: true,
                overrideApplied: false,
            };
            this._registerPendingDecision(decision, trigger);
            this._emitDecisionMade(trigger, decision, budgetSnapshot, exhausted);
            this._telemetry.emit({
                executionId: trigger.executionId,
                subsystem: 'planning',
                event: 'recovery.approval_required',
                phase: 'recovery',
                payload: {
                    executionBoundaryId: decision.executionBoundaryId,
                    triggerId: trigger.triggerId,
                    decisionId: decision.decisionId,
                    decisionType: decision.type,
                    reasonCode: decision.reasonCode,
                    scope: decision.scope,
                    origin: decision.origin,
                    approvalState: decision.operatorState.approvalState,
                },
            });
            await this._recordHistoryAndEmit(decision, trigger, 'superseded');
            return decision;
        }

        return this._executeWithLifecycle(decision, trigger, loopSignal.reasonCode, budgetSnapshot, exhausted);
    }

    private async _executeWithLifecycle(
        decision: RecoveryDecision,
        trigger: RecoveryTrigger,
        loopReasonCode?: string,
        budgetSnapshot = this._budgetService.getBudget(this._toBudgetInput(trigger, decision.scope)),
        exhausted = this._budgetService.isExhausted(this._toBudgetInput(trigger, decision.scope)),
    ): Promise<RecoveryDecision> {
        this._emitDecisionMade(trigger, decision, budgetSnapshot, exhausted);

        if (loopReasonCode) {
            this._telemetry.emit({
                executionId: trigger.executionId,
                subsystem: 'planning',
                event: 'recovery.loop_detected',
                phase: 'recovery',
                payload: {
                    executionBoundaryId: decision.executionBoundaryId,
                    triggerId: trigger.triggerId,
                    decisionId: decision.decisionId,
                    decisionType: decision.type,
                    reasonCode: loopReasonCode,
                    handoffType: trigger.context.handoffType,
                    scope: decision.scope,
                    origin: decision.origin,
                },
            });
        }

        try {
            await this.execute(decision, trigger);
            this._emitActionEvent(decision.type, trigger, decision);
            this._telemetry.emit({
                executionId: trigger.executionId,
                subsystem: 'planning',
                event: 'recovery.action_executed',
                phase: 'recovery',
                payload: {
                    executionBoundaryId: decision.executionBoundaryId,
                    triggerId: trigger.triggerId,
                    decisionId: decision.decisionId,
                    decisionType: decision.type,
                    reasonCode: decision.reasonCode,
                    handoffType: trigger.context.handoffType,
                    scope: decision.scope,
                    degradedMode: decision.degradedMode,
                    origin: decision.origin,
                    operatorState: decision.operatorState,
                },
            });
            await this._recordHistoryAndEmit(decision, trigger, 'executed');
            return decision;
        } catch (err) {
            this._telemetry.emit({
                executionId: trigger.executionId,
                subsystem: 'planning',
                event: 'recovery.action_failed',
                phase: 'recovery',
                payload: {
                    executionBoundaryId: decision.executionBoundaryId,
                    triggerId: trigger.triggerId,
                    decisionId: decision.decisionId,
                    decisionType: decision.type,
                    reasonCode: decision.reasonCode,
                    handoffType: trigger.context.handoffType,
                    scope: decision.scope,
                    degradedMode: decision.degradedMode,
                    origin: decision.origin,
                    operatorState: decision.operatorState,
                    error: err instanceof Error ? err.message : String(err),
                },
            });
            await this._recordHistoryAndEmit(decision, trigger, 'failed');
            throw err;
        }
    }

    private async _recordHistoryAndEmit(
        decision: RecoveryDecision,
        trigger: RecoveryTrigger,
        outcome: 'executed' | 'failed' | 'denied' | 'superseded',
    ): Promise<void> {
        const historyId = this._nextHistoryId();
        const timestamp = this._now();
        await this._historyRepository.record({
            historyId,
            timestamp,
            executionId: decision.executionId,
            executionBoundaryId: decision.executionBoundaryId,
            triggerType: trigger.type,
            decisionType: decision.type,
            reasonCode: decision.reasonCode,
            scope: decision.scope,
            failureFamily: trigger.failure?.family,
            origin: decision.origin ?? 'automatic',
            operatorOverrideApplied: decision.origin === 'operator_override',
            approvalState: decision.operatorState?.approvalState ?? 'not_required',
            outcome,
            degradedMode: decision.degradedMode,
        });

        this._telemetry.emit({
            executionId: decision.executionId,
            subsystem: 'planning',
            event: 'recovery.history_recorded',
            phase: 'recovery',
            payload: {
                executionBoundaryId: decision.executionBoundaryId,
                historyId,
                triggerId: trigger.triggerId,
                decisionId: decision.decisionId,
                decisionType: decision.type,
                reasonCode: decision.reasonCode,
                scope: decision.scope,
                origin: decision.origin,
                approvalState: decision.operatorState?.approvalState,
                outcome,
            },
        });

        const analytics = await this._historyRepository.getAnalyticsSnapshot();
        this._telemetry.emit({
            executionId: decision.executionId,
            subsystem: 'planning',
            event: 'recovery.analytics_updated',
            phase: 'recovery',
            payload: {
                executionBoundaryId: decision.executionBoundaryId,
                totals: analytics.totals,
                topReasonCodes: analytics.topReasonCodes,
            },
        });

        const scopeKey = AutomaticRecoveryControlService._toScopeKey(
            decision.executionId,
            decision.executionBoundaryId,
        );
        AutomaticRecoveryControlService._setOperatorSnapshot(scopeKey, this._buildOperatorSnapshot(decision, trigger));
    }

    private _emitDecisionMade(
        trigger: RecoveryTrigger,
        decision: RecoveryDecision,
        budgetSnapshot: ReturnType<RecoveryBudgetService['getBudget']>,
        exhausted: ReturnType<RecoveryBudgetService['isExhausted']>,
    ): void {
        this._telemetry.emit({
            executionId: trigger.executionId,
            subsystem: 'planning',
            event: 'recovery.decision_made',
            phase: 'recovery',
            payload: {
                executionBoundaryId: decision.executionBoundaryId,
                triggerId: trigger.triggerId,
                decisionId: decision.decisionId,
                decisionType: decision.type,
                reasonCode: decision.reasonCode,
                handoffType: trigger.context.handoffType,
                scope: decision.scope,
                degradedMode: decision.degradedMode,
                origin: decision.origin,
                operatorState: decision.operatorState,
                budget: budgetSnapshot,
                exhausted,
            },
        });
    }

    private _toBudgetInput(trigger: RecoveryTrigger, scope?: RecoveryBudgetInput['scope']): RecoveryBudgetInput {
        return {
            executionId: trigger.executionId,
            executionBoundaryId: trigger.executionBoundaryId,
            scope: scope ?? trigger.context.scope,
        };
    }

    private _emitActionEvent(decisionType: RecoveryDecisionType, trigger: RecoveryTrigger, decision: RecoveryDecision): void {
        const eventByType: Record<RecoveryDecisionType, RecoveryActionEventType> = {
            retry: 'recovery.retry_requested',
            replan: 'recovery.replan_requested',
            escalate: 'recovery.escalation_requested',
            degrade_and_continue: 'recovery.degraded_continue_applied',
            stop: 'recovery.stop_requested',
        };
        this._telemetry.emit({
            executionId: trigger.executionId,
            subsystem: 'planning',
            event: eventByType[decisionType],
            phase: 'recovery',
            payload: {
                executionBoundaryId: decision.executionBoundaryId,
                triggerId: trigger.triggerId,
                decisionId: decision.decisionId,
                decisionType: decision.type,
                reasonCode: decision.reasonCode,
                handoffType: trigger.context.handoffType,
                scope: decision.scope,
                degradedMode: decision.degradedMode,
                origin: decision.origin,
                operatorState: decision.operatorState,
            },
        });
    }

    private _registerPendingDecision(decision: RecoveryDecision, trigger: RecoveryTrigger): void {
        const scopeKey = AutomaticRecoveryControlService._toScopeKey(decision.executionId, decision.executionBoundaryId);
        const pending: PendingApprovalRecord = {
            decision,
            trigger,
            controller: this,
            scopeKey,
            createdAt: this._now(),
        };
        AutomaticRecoveryControlService._pendingByDecisionId.set(decision.decisionId, pending);
        AutomaticRecoveryControlService._latestPendingDecisionByScope.set(scopeKey, decision.decisionId);
        AutomaticRecoveryControlService._setOperatorSnapshot(scopeKey, this._buildOperatorSnapshot(decision, trigger));
    }

    private _buildOperatorSnapshot(decision: RecoveryDecision, trigger: RecoveryTrigger): RecoveryOperatorSnapshot {
        const scopeKey = AutomaticRecoveryControlService._toScopeKey(decision.executionId, decision.executionBoundaryId);
        const budgetInput: RecoveryBudgetInput = {
            executionId: decision.executionId,
            executionBoundaryId: decision.executionBoundaryId,
            scope: decision.scope ?? trigger.context.scope,
        };
        const budget = this._budgetService.getBudget(budgetInput);
        const exhausted = this._budgetService.isExhausted(budgetInput);
        const prior = AutomaticRecoveryControlService._operatorStateByScope.get(scopeKey);

        return {
            executionId: decision.executionId,
            executionBoundaryId: decision.executionBoundaryId,
            activeDecision: decision,
            approvalState: decision.operatorState?.approvalState ?? 'not_required',
            overrideAllowed: decision.operatorState?.overrideAllowed ?? false,
            overrideApplied: decision.operatorState?.overrideApplied ?? false,
            lastOperatorAction: decision.operatorState?.lastOperatorAction ?? prior?.lastOperatorAction,
            operatorReasonCode: decision.operatorState?.operatorReasonCode ?? prior?.operatorReasonCode,
            degradedMode: decision.degradedMode,
            budget,
            exhausted,
            loopDetected: budget.loopDetected,
            updatedAt: this._now(),
        };
    }

    private _isApprovalRequired(decision: RecoveryDecision, trigger: RecoveryTrigger, loopDetected: boolean): boolean {
        if (decision.type === 'degrade_and_continue' && trigger.context.handoffType === 'workflow') {
            return true;
        }
        if (decision.type === 'replan' && loopDetected) {
            return true;
        }
        return false;
    }

    private _nextHistoryId(): string {
        AutomaticRecoveryControlService._historySeq += 1;
        return `rec-hist-${AutomaticRecoveryControlService._historySeq}`;
    }

    private static _resolvePending(scopeKey: string, decisionId?: string): PendingApprovalRecord | undefined {
        if (decisionId) {
            return this._pendingByDecisionId.get(decisionId);
        }
        const latestId = this._latestPendingDecisionByScope.get(scopeKey);
        return latestId ? this._pendingByDecisionId.get(latestId) : undefined;
    }

    private static _clearPending(scopeKey: string, decisionId: string): void {
        this._pendingByDecisionId.delete(decisionId);
        const current = this._latestPendingDecisionByScope.get(scopeKey);
        if (current === decisionId) {
            this._latestPendingDecisionByScope.delete(scopeKey);
        }
    }

    private static _setOperatorSnapshot(scopeKey: string, snapshot: RecoveryOperatorSnapshot): void {
        this._operatorStateByScope.set(scopeKey, snapshot);
    }

    private static _toScopeKey(executionId: string, executionBoundaryId?: string): string {
        if (executionBoundaryId) {
            return `execution_boundary:${executionBoundaryId}`;
        }
        return `execution:${executionId}`;
    }

    private static _assertApprovalActionMatchesDecision(
        action: RecoveryOperatorActionInput['action'],
        decisionType: RecoveryDecisionType,
    ): void {
        if (action === 'approve_retry' && decisionType !== 'retry') {
            throw new Error('RECOVERY_OPERATOR_ACTION_INVALID_FOR_DECISION');
        }
        if (action === 'approve_replan' && decisionType !== 'replan') {
            throw new Error('RECOVERY_OPERATOR_ACTION_INVALID_FOR_DECISION');
        }
        if (action === 'approve_degraded_continue' && decisionType !== 'degrade_and_continue') {
            throw new Error('RECOVERY_OPERATOR_ACTION_INVALID_FOR_DECISION');
        }
    }
}
