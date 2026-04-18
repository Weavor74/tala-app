import type { RecoveryDecision, RecoveryTrigger } from './RecoveryTypes';

export interface AgentKernelRecoveryPort {
    retryExecution(input: { executionId: string; executionBoundaryId?: string; reasonCode: string }): Promise<void>;
    escalateExecution(input: { executionId: string; executionBoundaryId?: string; reasonCode: string }): Promise<void>;
    continueExecution(input: { executionId: string; executionBoundaryId?: string; reasonCode: string }): Promise<void>;
    stopExecution(input: { executionId: string; executionBoundaryId?: string; reasonCode: string }): Promise<void>;
}

export interface PlanningRecoveryPort {
    requestRecoveryReplan(input: {
        executionId: string;
        executionBoundaryId?: string;
        reasonCode: string;
        planId?: string;
    }): Promise<void>;
}

export interface RuntimeDegradedModePort {
    applyDegradedMode(input: {
        executionId: string;
        executionBoundaryId?: string;
        reasonCode: string;
        mode: NonNullable<RecoveryDecision['degradedMode']>;
    }): Promise<void>;
}

export class RecoveryActionExecutor {
    constructor(
        private readonly _agentKernelPort: AgentKernelRecoveryPort,
        private readonly _planningPort: PlanningRecoveryPort,
        private readonly _degradedModePort?: RuntimeDegradedModePort,
    ) {}

    async executeDecision(decision: RecoveryDecision, trigger: RecoveryTrigger): Promise<void> {
        const executionBoundaryId = decision.executionBoundaryId ?? trigger.executionBoundaryId;
        switch (decision.type) {
            case 'retry':
                await this._agentKernelPort.retryExecution({
                    executionId: decision.executionId,
                    executionBoundaryId,
                    reasonCode: decision.reasonCode,
                });
                return;
            case 'replan':
                await this._planningPort.requestRecoveryReplan({
                    executionId: decision.executionId,
                    executionBoundaryId,
                    reasonCode: decision.reasonCode,
                    planId: trigger.planId,
                });
                return;
            case 'escalate':
                await this._agentKernelPort.escalateExecution({
                    executionId: decision.executionId,
                    executionBoundaryId,
                    reasonCode: decision.reasonCode,
                });
                return;
            case 'degrade_and_continue':
                if (decision.degradedMode && this._degradedModePort) {
                    await this._degradedModePort.applyDegradedMode({
                        executionId: decision.executionId,
                        executionBoundaryId,
                        reasonCode: decision.reasonCode,
                        mode: decision.degradedMode,
                    });
                }
                await this._agentKernelPort.continueExecution({
                    executionId: decision.executionId,
                    executionBoundaryId,
                    reasonCode: decision.reasonCode,
                });
                return;
            case 'stop':
                await this._agentKernelPort.stopExecution({
                    executionId: decision.executionId,
                    executionBoundaryId,
                    reasonCode: decision.reasonCode,
                });
                return;
        }
    }
}

