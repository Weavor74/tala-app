/**
 * HybridStillContextualPublishGuard.test.ts
 *
 * Verifies that the RP publish-boundary guard does NOT collapse hybrid mode
 * into full RP enforcement.  Explicit system/app questions in hybrid mode
 * must still allow system-truth responses.
 *
 * Tests: HCPG-01 – HCPG-04
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import {
    applyRpFinalOntologyGuard,
} from '../electron/services/agent/RpPublishBoundaryGuard';

const stubTurnOutput = {
    message: 'chat output',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

describe('Hybrid mode remains contextual — publish guard does not over-enforce', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        vi.restoreAllMocks();
    });

    it('HCPG-01: guard does not fire for hybrid mode — agent identity passes through', () => {
        const text = 'I am an agent running in this environment, and these are my capabilities.';
        const result = applyRpFinalOntologyGuard({
            finalText: text,
            mode: 'hybrid',
            userMessage: 'What tools do you have?',
            isOperationalRequest: true,
            isSystemKnowledgeRequest: true,
        });
        expect(result.guardFired).toBe(false);
        expect(result.actionTaken).toBe('passthrough');
        expect(result.finalText).toBe(text);
    });

    it('HCPG-02: hybrid mode does not trigger rp_publish_guard_evaluated event', async () => {
        const { TelemetryBus } = await import('../electron/services/telemetry/TelemetryBus');
        TelemetryBus._resetForTesting();
        const events: Array<{ event: string }> = [];
        TelemetryBus.getInstance().subscribe((e) => events.push(e));

        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue({
                ...stubTurnOutput,
                message: 'I am an agent running in this app with access to these tools.',
            }),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        await kernel.execute({
            userMessage: 'What tools do you have in this app?',
            executionMode: 'hybrid',
            conversationId: 'hybrid-contextual-guard',
            operatorMode: 'chat',
        });

        // Guard must not have fired (mode != rp)
        const guardEvents = events.filter((e) => e.event === 'agent.rp_publish_guard_evaluated');
        expect(guardEvents.length).toBe(0);
    });

    it('HCPG-03: hybrid explicit operational truth is not collapsed into RP persona', async () => {
        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue({
                ...stubTurnOutput,
                message: 'I am a local AI agent. My available tools include file access and memory search.',
            }),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const result = await kernel.execute({
            userMessage: 'Tell me what you are and what tools you have.',
            executionMode: 'hybrid',
            conversationId: 'hybrid-not-collapsed',
            operatorMode: 'chat',
        });

        // The guard must not have produced a persona-only rewrite
        expect(result.message.toLowerCase()).not.toBe('tala: i am human, and i am here with you.');
        // Must not have been rewritten to the blocked persona fallback
        expect(result.message.toLowerCase()).not.toContain('i am human, and i am here with you');
    });

    it('HCPG-04: guard passthrough for assistant mode does not modify system identity text', () => {
        const text = 'I am a local agent. I do not have biological experiences.';
        const result = applyRpFinalOntologyGuard({
            finalText: text,
            mode: 'assistant',
            userMessage: 'Are you human?',
        });
        expect(result.guardFired).toBe(false);
        expect(result.actionTaken).toBe('passthrough');
        expect(result.finalText).toBe(text);
    });
});
