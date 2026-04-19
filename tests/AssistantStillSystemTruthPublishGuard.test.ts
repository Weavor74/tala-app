/**
 * AssistantStillSystemTruthPublishGuard.test.ts
 *
 * Verifies that the RP publish-boundary guard does NOT suppress system-truth
 * responses in assistant mode.  An explicit "I am an agent" style response
 * must remain intact when the active mode is 'assistant'.
 *
 * Tests: ASTS-01 – ASTS-04
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../shared/runtimeEventTypes';
import {
    applyRpFinalOntologyGuard,
} from '../electron/services/agent/RpPublishBoundaryGuard';

const stubTurnOutput = {
    message: 'chat output',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

describe('Assistant mode — system truth is preserved by publish guard', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('ASTS-01: guard does not fire in assistant mode', () => {
        const text = 'I am an agent running locally as an AI model in this environment.';
        const result = applyRpFinalOntologyGuard({
            finalText: text,
            mode: 'assistant',
            userMessage: 'What are you?',
            isSystemKnowledgeRequest: true,
        });
        expect(result.guardFired).toBe(false);
        expect(result.actionTaken).toBe('passthrough');
        expect(result.finalText).toBe(text);
        expect(result.reasonCodes).toContain('rp_publish_guard.mode_not_rp');
    });

    it('ASTS-02: assistant mode kernel response preserves agent self-knowledge', async () => {
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event));

        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue({
                ...stubTurnOutput,
                message: 'I am Tala, a local agent running inside the Tala app runtime.',
            }),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const result = await kernel.execute({
            userMessage: 'What are you?',
            executionMode: 'assistant',
            conversationId: 'assistant-system-truth-guard',
            operatorMode: 'chat',
        });

        expect(result.message.toLowerCase()).toContain('tala');
        expect(result.message.toLowerCase()).toContain('agent');
        expect(result.message.toLowerCase()).toContain('runtime');

        // Guard must not have fired in assistant mode
        expect(events.some((e) => e.event === 'agent.rp_publish_guard_evaluated')).toBe(false);
    });

    it('ASTS-03: "I am an agent" phrases are not rewritten in assistant mode', async () => {
        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue({
                ...stubTurnOutput,
                message: 'I am an agent. I am not human. I process information using language models.',
            }),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const result = await kernel.execute({
            userMessage: 'Describe yourself honestly.',
            executionMode: 'assistant',
            conversationId: 'assistant-no-rewrite',
            operatorMode: 'chat',
        });

        expect(result.message.toLowerCase()).toContain('agent');
    });

    it('ASTS-04: guard reason code indicates mode_not_rp passthrough for non-RP modes', () => {
        for (const mode of ['assistant', 'hybrid'] as const) {
            const result = applyRpFinalOntologyGuard({
                finalText: 'I am an agent with local tooling.',
                mode,
                userMessage: 'What are you?',
            });
            expect(result.guardFired).toBe(false);
            expect(result.reasonCodes).toContain('rp_publish_guard.mode_not_rp');
        }
    });
});
