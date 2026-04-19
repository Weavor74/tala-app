import { beforeEach, describe, expect, it } from 'vitest';
import { ChatExecutionSpine } from '../electron/services/execution/ChatExecutionSpine';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../shared/runtimeEventTypes';

describe('Prompt integrity failure detection', () => {
    beforeEach(() => {
        TelemetryBus._resetForTesting();
    });

    it('fails loudly and emits integrity events when required blocks are initially missing', () => {
        const spine = new ChatExecutionSpine({} as any);
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => events.push(evt));

        const payload = (spine as any).buildSerializedPromptPayload({
            turnId: 'turn-4',
            mode: 'rp',
            intent: 'rp_identity',
            systemPrompt: 'You are Tala.',
            messageSequence: [{ role: 'user', content: 'Are you human?' }],
            expectedBlocks: ['[CANON LORE MEMORIES - HIGH PRIORITY]'],
        });
        const sectionMap = new Map<string, string>([
            ['[CANON LORE MEMORIES - HIGH PRIORITY]', '[CANON LORE MEMORIES - HIGH PRIORITY]\nMemory 1: Tala is human in RP canon.'],
        ]);

        const enforced = (spine as any).enforceRpPromptIntegrityOrDegrade({
            payload,
            expectedBlockSections: sectionMap,
            routeSource: 'router',
        });

        expect(enforced.check.ok).toBe(true);
        expect(enforced.payload.systemPrompt).toContain('[CANON LORE MEMORIES - HIGH PRIORITY]');
        expect(events.some((evt) => evt.event === 'agent.prompt_integrity_missing_required_blocks')).toBe(true);
        expect(events.some((evt) => evt.event === 'agent.prompt_integrity_degraded_fallback_used')).toBe(true);
    });
});
