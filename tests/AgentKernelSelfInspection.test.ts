import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../electron/services/telemetry/TelemetryBus';

const stubTurnOutput = {
    message: 'chat output',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

function makeKernel(overrides?: {
    executeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}) {
    const agentStub = {
        chat: vi.fn().mockResolvedValue(stubTurnOutput),
        executeTool: vi.fn(overrides?.executeTool ?? (async () => '# README')),
        executeWorkflow: vi.fn().mockResolvedValue({ success: true }),
    };
    const kernel = new AgentKernel(agentStub as any);
    return { kernel, agentStub };
}

describe('AgentKernel self-inspection authority routing', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('overrides greeting/chat suppression and routes self-inspection tool-first in rp mode', async () => {
        const { kernel, agentStub } = makeKernel({
            executeTool: async (name, args) => {
                if (name === 'fs_read_text' && args.path === 'README.md') {
                    return '# Tala README';
                }
                return 'Error: unexpected tool';
            },
        });
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event));

        const result = await kernel.execute({
            userMessage: 'You should read your local README.md',
            operatorMode: 'chat',
            executionMode: 'rp',
        });

        expect(agentStub.chat).not.toHaveBeenCalled();
        expect(agentStub.executeTool).toHaveBeenCalledWith('fs_read_text', { path: 'README.md' });
        expect(result.message).toContain('Read README.md');
        const arbitrated = events.find((event) => event.event === 'kernel.turn_arbitrated');
        expect(arbitrated?.payload?.mode).not.toBe('conversational');
        expect(arbitrated?.payload?.selfInspectionRequest).toBe(true);
        expect(events.some((event) => event.event === 'agent.self_inspection_bypassed_greeting_policy')).toBe(true);
        expect(events.some((event) => event.event === 'agent.self_inspection_tool_attempted')).toBe(true);
    });

    it('routes technical self-inspection turns to tools, not LLM-only path', async () => {
        const { kernel, agentStub } = makeKernel({
            executeTool: async (name, args) => {
                if (name === 'fs_read_text' && args.path === 'README.md') {
                    return '# Systems and capabilities';
                }
                if (name === 'fs_list') {
                    return '[FILE] README.md';
                }
                return 'Error: unexpected tool';
            },
        });

        const result = await kernel.execute({
            userMessage: 'What do you know about your systems?',
            operatorMode: 'chat',
            executionMode: 'rp',
        });

        expect(agentStub.chat).not.toHaveBeenCalled();
        expect(agentStub.executeTool).toHaveBeenCalled();
        expect(result.message.toLowerCase()).not.toContain('cannot browse');
        expect(result.message.toLowerCase()).not.toContain('just a language model');
    });

    it('keeps tools eligible on follow-up "Did you read your local files?" regression path', async () => {
        const { kernel, agentStub } = makeKernel({
            executeTool: async (name, args) => {
                if (name === 'fs_read_text' && args.path === 'README.md') {
                    return '# Tala README';
                }
                if (name === 'fs_list' && args.path === '') {
                    return '[FILE] README.md\n[DIR] docs';
                }
                return 'Error: unexpected tool';
            },
        });

        await kernel.execute({
            userMessage: 'You should read your local README.md',
            operatorMode: 'chat',
            executionMode: 'rp',
        });

        const followUp = await kernel.execute({
            userMessage: 'Did you read your local files?',
            operatorMode: 'chat',
            executionMode: 'rp',
        });

        expect(agentStub.chat).not.toHaveBeenCalled();
        expect(agentStub.executeTool).toHaveBeenCalledWith('fs_list', { path: '' });
        expect(followUp.message.toLowerCase()).not.toContain('cannot access local files');
        expect(followUp.message.toLowerCase()).not.toContain('just a language model');
    });
});

