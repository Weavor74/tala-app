import { TelemetryBus } from '../../telemetry/TelemetryBus';
import { AutomaticRecoveryControlService } from './AutomaticRecoveryController';
import type {
    RecoveryDecision,
    RecoveryOperatorActionInput,
} from './RecoveryTypes';

export class RecoveryOperatorControlService {
    constructor(private readonly _telemetry: TelemetryBus = TelemetryBus.getInstance()) {}

    async submitOperatorRecoveryAction(input: RecoveryOperatorActionInput): Promise<RecoveryDecision> {
        return AutomaticRecoveryControlService.submitOperatorRecoveryAction(input, this._telemetry);
    }

    getRecoveryOperatorState(input: { executionId: string; executionBoundaryId?: string }) {
        return AutomaticRecoveryControlService.getRecoveryOperatorState(input);
    }
}
