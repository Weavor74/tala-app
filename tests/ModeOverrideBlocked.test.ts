import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../shared/runtimeEventTypes';

const stubTurnOutput = {
    message: 'mode check',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

describe('Mode override blocked', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
    });

    it('blocks mismatched downstream mode and keeps authoritative resolution', async () => {
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event));

        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue(stubTurnOutput),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const result = await kernel.execute({
            userMessage: 'hello',
            executionMode: 'assistant',
            modeResolution: {
                resolvedMode: 'rp',
                source: 'settings_manager',
                reasonCodes: ['test.authoritative_mode_rp'],
                turnId: 'turn-mode-override',
            },
            turnId: 'turn-mode-override',
        });

        expect(result.meta.mode).toBe('rp');
        expect(events.some((event) => event.event === 'agent.turn_mode_override_blocked')).toBe(true);
    });
});

