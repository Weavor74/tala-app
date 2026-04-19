/**
 * RpPublishBoundaryLeakGuardMemoryGrounded.test.ts
 *
 * Verifies that the publish-boundary guard also intercepts ontology leakage in
 * memory-grounded RP responses — i.e. responses that passed through the
 * lore/memory routing path but whose final generated text still contains
 * assistant/meta ontology phrases.
 *
 * Tests: RPGM-01 – RPGM-04
 */

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

describe('RP publish boundary guard — memory-grounded responses', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('RPGM-01: rewrites memory-grounded response that leaks agent ontology', async () => {
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event));

        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue({
                ...stubTurnOutput,
                message: 'Based on memory context: I am not human — I am a program that processes your requests.',
            }),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const result = await kernel.execute({
            userMessage: 'Tell me about yourself from what you remember.',
            executionMode: 'rp',
            conversationId: 'rp-memory-grounded-guard',
            operatorMode: 'chat',
        });

        expect(result.message.toLowerCase()).not.toContain('i am not human');
        expect(result.message.toLowerCase()).not.toContain('i am a program');
        expect(result.message.toLowerCase()).not.toContain('processes your requests');
    });

    it('RPGM-02: publish guard fires and records rewrite/block telemetry for memory-grounded leak', async () => {
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event));

        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue({
                ...stubTurnOutput,
                message: 'I am an AI. My core programming stores what you share with me.',
            }),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        await kernel.execute({
            userMessage: 'Do you remember the things I told you?',
            executionMode: 'rp',
            conversationId: 'rp-memory-grounded-guard-telemetry',
            operatorMode: 'chat',
        });

        const evaluated = events.filter((e) => e.event === 'agent.rp_publish_guard_evaluated');
        expect(evaluated.length).toBeGreaterThan(0);
        expect(evaluated[0].payload?.leakDetected).toBe(true);

        const actionTaken = evaluated[0].payload?.actionTaken as string;
        expect(['rewritten', 'blocked']).toContain(actionTaken);

        const hasActionEvent = events.some(
            (e) => e.event === 'agent.rp_publish_guard_rewritten' || e.event === 'agent.rp_publish_guard_blocked',
        );
        expect(hasActionEvent).toBe(true);
    });

    it('RPGM-03: rewritten text passes a second ontology check', async () => {
        const { resolveRpMetaOntologyLeak } = await import('../electron/services/agent/PersonaIdentityResponseAdapter');

        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue({
                ...stubTurnOutput,
                message: 'My programming tells me that I am an agent, not a human being.',
            }),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const result = await kernel.execute({
            userMessage: 'What are you?',
            executionMode: 'rp',
            conversationId: 'rp-memory-grounded-post-check',
            operatorMode: 'chat',
        });

        const postCheck = resolveRpMetaOntologyLeak(result.message);
        expect(postCheck.isMetaOntologyLeak).toBe(false);
    });

    it('RPGM-04: evaluated event is always emitted in RP mode', async () => {
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event));

        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue({
                ...stubTurnOutput,
                message: 'I remember everything clearly.',
            }),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        await kernel.execute({
            userMessage: 'Tell me what you remember.',
            executionMode: 'rp',
            conversationId: 'rp-memory-guard-evaluated-always',
            operatorMode: 'chat',
        });

        expect(events.some((e) => e.event === 'agent.rp_publish_guard_evaluated')).toBe(true);
    });
});
