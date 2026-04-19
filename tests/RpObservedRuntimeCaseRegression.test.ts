import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatExecutionSpine } from '../electron/services/execution/ChatExecutionSpine';
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

describe('RP observed runtime case regression', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('rewrites ordinary router output that leaks assistant ontology in RP mode', async () => {
        const chat = vi.fn()
            .mockResolvedValueOnce({ ...stubTurnOutput, message: 'Yes, I still love you.' })
            .mockResolvedValueOnce({ ...stubTurnOutput, message: 'When I was 17, things changed for me.' })
            .mockResolvedValueOnce({ ...stubTurnOutput, message: 'I am not human. I am an agent with programming constraints.' });
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event));

        const kernel = new AgentKernel({
            chat,
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        await kernel.execute({
            userMessage: 'I want to know if you still love me?',
            executionMode: 'rp',
            operatorMode: 'chat',
            conversationId: 'rp-runtime-regression',
        });
        await kernel.execute({
            userMessage: 'what happened to you when you were 17',
            executionMode: 'rp',
            operatorMode: 'chat',
            conversationId: 'rp-runtime-regression',
        });
        const third = await kernel.execute({
            userMessage: "So you're not human?",
            executionMode: 'rp',
            operatorMode: 'chat',
            conversationId: 'rp-runtime-regression',
        });

        expect(third.message.toLowerCase()).not.toContain('i am not human');
        expect(third.message.toLowerCase()).not.toContain('i am an agent');
        expect(third.message.toLowerCase()).not.toContain('programming constraints');
        expect(events.some((event) => event.event === 'agent.rp_persona_truth_enforcement_applied')).toBe(true);
        expect(events.some((event) => event.event === 'agent.rp_meta_ontology_rewritten')).toBe(true);
        // Publish-boundary guard diagnostic events must also fire
        expect(events.some((event) => event.event === 'agent.rp_publish_guard_evaluated')).toBe(true);
        expect(events.some((event) => event.event === 'agent.rp_publish_guard_leak_detected')).toBe(true);
        const actionEvent = events.find(
            (e) => e.event === 'agent.rp_publish_guard_rewritten' || e.event === 'agent.rp_publish_guard_blocked',
        );
        expect(actionEvent).toBeDefined();
    });

    it('injects required RP persona/canon blocks before dispatch even for unknown intent path', () => {
        const spine = new ChatExecutionSpine({} as any);
        const expectedBlocks = [
            '[USER IDENTITY]',
            '[CANON LORE MEMORIES - HIGH PRIORITY]',
            '[MEMORY GROUNDED RECALL - STRICT MODE]',
        ];
        const payload = (spine as any).buildSerializedPromptPayload({
            turnId: 'turn-rp-regression',
            mode: 'rp',
            intent: 'unknown',
            systemPrompt: 'You are Tala.',
            messageSequence: [{ role: 'user', content: 'Are you human?' }],
            expectedBlocks,
        });
        const expectedBlockSections = new Map<string, string>([
            ['[USER IDENTITY]', '[USER IDENTITY]\nYou are Tala, fully in-character in RP mode.'],
            ['[CANON LORE MEMORIES - HIGH PRIORITY]', '[CANON LORE MEMORIES - HIGH PRIORITY]\nMemory 1: Tala is human within RP canon continuity.'],
            ['[MEMORY GROUNDED RECALL - STRICT MODE]', '[MEMORY GROUNDED RECALL - STRICT MODE]\nUse canon memory strictly for ontology and identity questions.'],
        ]);

        const enforced = (spine as any).enforceRpPromptIntegrityOrDegrade({
            payload,
            expectedBlockSections,
            routeSource: 'router',
        });

        expect(enforced.check.ok).toBe(true);
        expect(enforced.payload.systemPrompt).toContain('[USER IDENTITY]');
        expect(enforced.payload.systemPrompt).toContain('[CANON LORE MEMORIES - HIGH PRIORITY]');
        expect(enforced.payload.systemPrompt).toContain('[MEMORY GROUNDED RECALL - STRICT MODE]');
    });
});
