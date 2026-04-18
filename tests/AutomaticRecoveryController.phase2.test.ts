import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import { AutomaticRecoveryControlService } from '../electron/services/runtime/recovery/AutomaticRecoveryController';
import { RecoveryActionExecutor } from '../electron/services/runtime/recovery/RecoveryActionExecutor';
import { RecoveryBudgetService } from '../electron/services/runtime/recovery/RecoveryBudgetService';
import { RecoveryPolicyService } from '../electron/services/runtime/recovery/RecoveryPolicyEngine';
import type { RecoveryTrigger } from '../electron/services/runtime/recovery/RecoveryTypes';

function makeTrigger(overrides: Partial<RecoveryTrigger> = {}): RecoveryTrigger {
    return {
        triggerId: 'trg-c2',
        executionId: 'exec-c2',
        executionBoundaryId: 'boundary-c2',
        type: 'workflow_failed',
        reasonCode: 'test.reason',
        timestamp: '2026-04-18T00:00:00.000Z',
        context: {
            retryCount: 0,
            maxRetries: 2,
            replanCount: 0,
            maxReplans: 2,
            canReplan: true,
            canEscalate: true,
            canDegradeContinue: false,
            handoffType: 'workflow',
            scope: 'execution_boundary',
        },
        ...overrides,
    };
}

describe('AutomaticRecoveryControlService Phase 2', () => {
    beforeEach(() => {
        TelemetryBus._resetForTesting();
    });

    it('increments replan budget on replan only', async () => {
        const budget = new RecoveryBudgetService(2, 2);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-rp'),
            budget,
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
            ),
        );

        await controller.handleTrigger(
            makeTrigger({
                failure: { family: 'unavailable', message: 'down', retryable: false },
            }),
        );

        const snapshot = budget.getBudget({ executionId: 'exec-c2', executionBoundaryId: 'boundary-c2' });
        expect(snapshot.replanCount).toBe(1);
        expect(snapshot.retryCount).toBe(0);
    });

    it('increments retry budget on retry only', async () => {
        const budget = new RecoveryBudgetService(2, 2);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-rt'),
            budget,
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
            ),
        );

        await controller.handleTrigger(
            makeTrigger({
                failure: { family: 'rate_limited', message: '429', retryable: true },
            }),
        );

        const snapshot = budget.getBudget({ executionId: 'exec-c2', executionBoundaryId: 'boundary-c2' });
        expect(snapshot.retryCount).toBe(1);
        expect(snapshot.replanCount).toBe(0);
    });

    it('records degraded continuation decisions', async () => {
        const continueExecution = vi.fn().mockResolvedValue(undefined);
        const applyDegradedMode = vi.fn().mockResolvedValue(undefined);
        const bus = TelemetryBus.getInstance();
        const seen: string[] = [];
        bus.subscribe((event) => seen.push(event.event));

        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-dc'),
            new RecoveryBudgetService(2, 2),
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution,
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
                { applyDegradedMode },
            ),
            bus,
        );

        const decision = await controller.handleTrigger(
            makeTrigger({
                type: 'runtime_degraded',
                context: {
                    ...makeTrigger().context,
                    handoffType: 'tool',
                    canReplan: false,
                    canDegradeContinue: true,
                    degradedCapability: 'web_retrieval',
                    degradedModeHint: 'local_only',
                },
            }),
        );

        expect(decision.type).toBe('degrade_and_continue');
        expect(applyDegradedMode).toHaveBeenCalledOnce();
        expect(continueExecution).toHaveBeenCalledOnce();
        expect(seen).toContain('recovery.degraded_continue_applied');
    });

    it('blocks unsafe repeated cycling when loop detected', async () => {
        const budget = new RecoveryBudgetService(5, 5, 4, 10);
        let decSeq = 0;
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => {
                decSeq += 1;
                return `dec-loop-${decSeq}`;
            }),
            budget,
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
            ),
        );

        await controller.handleTrigger(
            makeTrigger({ failure: { family: 'timeout', message: 't1', retryable: true } }),
        );
        await controller.handleTrigger(
            makeTrigger({ failure: { family: 'unavailable', message: 'u1', retryable: false } }),
        );
        await controller.handleTrigger(
            makeTrigger({ failure: { family: 'timeout', message: 't2', retryable: true } }),
        );
        await controller.handleTrigger(
            makeTrigger({ failure: { family: 'unavailable', message: 'u2', retryable: false } }),
        );

        const decision = await controller.handleTrigger(
            makeTrigger({ failure: { family: 'timeout', message: 't3', retryable: true } }),
        );

        expect(['escalate', 'stop']).toContain(decision.type);
        expect(decision.reasonCode.includes('loop_detected') || decision.reasonCode.includes('recovery_exhausted')).toBe(true);
    });

    it('emits failure telemetry when degraded continuation apply fails', async () => {
        const bus = TelemetryBus.getInstance();
        const seen: string[] = [];
        bus.subscribe((event) => seen.push(event.event));

        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-fail'),
            new RecoveryBudgetService(2, 2),
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
                { applyDegradedMode: vi.fn().mockRejectedValue(new Error('cannot apply degraded mode')) },
            ),
            bus,
        );

        await expect(
            controller.handleTrigger(
                makeTrigger({
                type: 'runtime_degraded',
                context: {
                    ...makeTrigger().context,
                    handoffType: 'tool',
                    canReplan: false,
                    canDegradeContinue: true,
                    degradedCapability: 'memory_write',
                    degradedModeHint: 'read_only',
                },
                }),
            ),
        ).rejects.toThrow('cannot apply degraded mode');

        expect(seen).toContain('recovery.action_failed');
    });
});
