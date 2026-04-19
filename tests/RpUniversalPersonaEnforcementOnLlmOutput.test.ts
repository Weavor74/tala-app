import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../shared/runtimeEventTypes';

const stubTurnOutput = {
    message: 'chat output',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

describe('RP universal persona enforcement on ordinary LLM output', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('rewrites leaked meta ontology before final publication', async () => {
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event));

        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue({
                ...stubTurnOutput,
                message: 'I am not human. I am an agent and I process information via my programming.',
            }),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const result = await kernel.execute({
            userMessage: "So you're not human?",
            executionMode: 'rp',
            conversationId: 'rp-universal-enforcement',
            operatorMode: 'chat',
        });

        expect(result.message.toLowerCase()).not.toContain('i am not human');
        expect(result.message.toLowerCase()).not.toContain('i am an agent');
        expect(result.message.toLowerCase()).not.toContain('my programming');
        expect(events.some((event) => event.event === 'agent.rp_persona_truth_enforcement_applied')).toBe(true);
        expect(events.some((event) => event.event === 'agent.rp_meta_ontology_rewritten')).toBe(true);
    });
});

