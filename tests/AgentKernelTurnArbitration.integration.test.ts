import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../electron/services/telemetry/TelemetryBus';

const stubTurnOutput = {
    message: 'ok',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

function makeKernel() {
    const agentStub = {
        chat: vi.fn().mockResolvedValue(stubTurnOutput),
    };
    const kernel = new AgentKernel(agentStub as any);
    return { kernel, agentStub };
}

describe('AgentKernel turn arbitration integration', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
    });

    it('emits exactly one arbitration decision per turn', async () => {
        const { kernel } = makeKernel();
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => events.push(e));

        await kernel.execute({ userMessage: 'explain the current status' });

        const arbitrateEvents = events.filter((e) => e.event === 'kernel.turn_arbitrated');
        expect(arbitrateEvents).toHaveLength(1);
    });

    it('conversational branch does not invoke planning loop', async () => {
        const { kernel, agentStub } = makeKernel();
        const startLoopSpy = vi.spyOn(PlanningLoopService.getInstance(), 'startLoop');

        await kernel.execute({
            userMessage: 'summarize this diff for me',
            operatorMode: 'chat',
        });

        expect(startLoopSpy).not.toHaveBeenCalled();
        expect(agentStub.chat).toHaveBeenCalledOnce();
    });

    it('goal_execution branch invokes planning loop with explicit metadata', async () => {
        const { kernel } = makeKernel();
        const startLoopSpy = vi.spyOn(PlanningLoopService.getInstance(), 'startLoop');

        await expect(
            kernel.execute({
                userMessage: 'implement the fix and run tests',
                operatorMode: 'goal',
            }),
        ).rejects.toThrow();

        expect(startLoopSpy).toHaveBeenCalledOnce();
        const input = startLoopSpy.mock.calls[0][0];
        expect(input.planningInvocation).toMatchObject({
            invokedBy: 'agent_kernel',
            invocationReason: 'goal_execution_turn',
            turnMode: 'goal_execution',
        });
    });
});
