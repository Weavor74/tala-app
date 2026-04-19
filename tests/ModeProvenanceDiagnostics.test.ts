import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../shared/runtimeEventTypes';

const stubTurnOutput = {
    message: 'ok',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

describe('Mode provenance diagnostics', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
    });

    it('emits resolved source/version/reason codes for turn mode', async () => {
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event));

        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue(stubTurnOutput),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        await kernel.execute({
            userMessage: 'hello',
            executionMode: 'hybrid',
            turnId: 'turn-mode-provenance',
            conversationId: 'session-mode-provenance',
            modeResolution: {
                resolvedMode: 'hybrid',
                source: 'settings_manager',
                settingsVersion: 12345,
                reasonCodes: ['turn_mode.settings_manager_mode_resolved'],
                turnId: 'turn-mode-provenance',
                sessionId: 'session-mode-provenance',
            },
        });

        const modeEvent = events.find((event) => event.event === 'agent.turn_mode_resolved');
        expect(modeEvent).toBeDefined();
        expect(modeEvent?.payload?.resolvedMode).toBe('hybrid');
        expect(modeEvent?.payload?.source).toBe('settings_manager');
        expect(modeEvent?.payload?.settingsVersion).toBe(12345);
        expect(Array.isArray(modeEvent?.payload?.reasonCodes)).toBe(true);
    });
});

