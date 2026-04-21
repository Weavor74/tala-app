import { describe, expect, it } from 'vitest';
import { ChatExecutionSpine } from '../../services/execution/ChatExecutionSpine';
import { CompactPromptBuilder } from '../../services/plan/CompactPromptBuilder';

function buildSystemPromptForTest(spine: any, params: {
    activeMode: 'assistant' | 'rp' | 'hybrid';
    isGreeting: boolean;
    dynamicContext: string;
}): string {
    const bounded = spine.buildBoundedPromptPacket({
        executionPlan: {
            activeMode: params.activeMode,
            isGreeting: params.isGreeting,
            isBrowserTask: false,
        },
        turnObject: {
            blockedCapabilities: [],
            turnBehavior: { astroLevel: 'off', reflectionLevel: 'off' },
        },
        turnPolicy: {
            memoryReadPolicy: params.isGreeting ? 'blocked' : 'lore_allowed',
            toolExposureProfile: params.activeMode === 'rp' ? 'immersive_controlled' : 'balanced',
        },
        activeProfileSystemPrompt: 'You are Tala.',
        userIdentity: '',
        dynamicContext: params.dynamicContext,
        memoryContext: '',
        docContextText: '',
        toolSigs: '[NO TOOLS AVAILABLE FOR CURRENT TURN POLICY]',
        notebookActive: false,
        goalsAndReflections: '',
        astroState: '[ASTRO STATE]: Suppressed by turn policy',
    });

    return CompactPromptBuilder.build({
        systemPromptBase: bounded.inputs.systemPromptBase,
        activeProfileId: 'tala',
        isSmallLocalModel: false,
        isEngineeringMode: false,
        hasMemories: false,
        memoryContext: bounded.inputs.memoryContext,
        goalsAndReflections: bounded.inputs.goalsAndReflections,
        dynamicContext: bounded.inputs.dynamicContext,
        toolSigs: bounded.inputs.toolSigs,
        userIdentity: bounded.inputs.userIdentity,
        notebookGrounded: bounded.inputs.notebookGrounded,
        rpCharacterLock: params.activeMode === 'rp' ? '[CHARACTER LOCK - MANDATORY - HIGHEST PRIORITY]' : undefined,
    });
}

function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

describe('Prompt assembly RP dynamic context truth', () => {
    const spine = new ChatExecutionSpine({} as any);

    it('mode=rp final prompt includes RP dynamic/system content when RP is active', () => {
        const dynamicContextBlocks = [
            '[STYLE]: Preserve Tala identity fully while remaining grounded to available context.',
            '[TURN TONE]: immersive; immersive=true; narrativeAmplification=true',
        ];
        (spine as any).appendRpDynamicContextBlocks('rp', { rpIntensity: 0.8, loreDensity: 0.7 }, dynamicContextBlocks);
        const dynamicContext = dynamicContextBlocks.join('\n\n');

        const systemPrompt = buildSystemPromptForTest(spine as any, {
            activeMode: 'rp',
            isGreeting: false,
            dynamicContext,
        });
        const serialized = (spine as any).buildSerializedPromptPayload({
            turnId: 'rp-turn-1',
            mode: 'rp',
            intent: 'social',
            systemPrompt,
            messageSequence: [{ role: 'user', content: 'hey sexy' }],
            expectedBlocks: [],
        });

        expect(systemPrompt).toContain('[RP MODE');
        expect(serialized.systemPrompt).toContain('[RP MODE');
    });

    it('mode=rp + greeting/social opener still includes RP dynamic/system content', () => {
        const dynamicContextBlocks = [
            '[STYLE]: Preserve Tala identity fully while remaining grounded to available context.',
            '[TURN TONE]: immersive; immersive=true; narrativeAmplification=true',
        ];
        (spine as any).appendRpDynamicContextBlocks('rp', { rpIntensity: 0.6, loreDensity: 0.5 }, dynamicContextBlocks);
        const dynamicContext = dynamicContextBlocks.join('\n\n');

        const systemPrompt = buildSystemPromptForTest(spine as any, {
            activeMode: 'rp',
            isGreeting: true,
            dynamicContext,
        });

        expect(systemPrompt).toContain('[RP MODE');
    });

    it('non-RP prompt assembly remains unchanged (no RP dynamic block)', () => {
        const dynamicContextBlocks = [
            '[STYLE]: Keep tone minimal and direct for this turn.',
            '[TURN TONE]: neutral; immersive=false; narrativeAmplification=false',
        ];
        (spine as any).appendRpDynamicContextBlocks('assistant', { rpIntensity: 0.9 }, dynamicContextBlocks);
        const dynamicContext = dynamicContextBlocks.join('\n\n');

        const systemPrompt = buildSystemPromptForTest(spine as any, {
            activeMode: 'assistant',
            isGreeting: true,
            dynamicContext,
        });

        expect(systemPrompt).not.toContain('[RP MODE');
    });

    it('shared prompt assembly path avoids duplicate RP dynamic injections', () => {
        const dynamicContextBlocks = [
            '[STYLE]: Preserve Tala identity fully while remaining grounded to available context.',
            '[TURN TONE]: immersive; immersive=true; narrativeAmplification=true',
        ];
        (spine as any).appendRpDynamicContextBlocks('rp', { rpIntensity: 0.7 }, dynamicContextBlocks);
        (spine as any).appendRpDynamicContextBlocks('rp', { rpIntensity: 0.7 }, dynamicContextBlocks);
        const dynamicContext = dynamicContextBlocks.join('\n\n');
        const systemPrompt = buildSystemPromptForTest(spine as any, {
            activeMode: 'rp',
            isGreeting: false,
            dynamicContext,
        });

        expect(countOccurrences(dynamicContext, '[RP MODE')).toBe(1);
        expect(countOccurrences(systemPrompt, '[RP MODE')).toBe(1);
    });

    it('mode=rp + social opener adds RP-safe opener shaping block', () => {
        const dynamicContextBlocks = [
            '[STYLE]: Preserve Tala identity fully while remaining grounded to available context.',
            '[TURN TONE]: immersive; immersive=true; narrativeAmplification=true',
        ];
        (spine as any).appendRpDynamicContextBlocks('rp', { rpIntensity: 0.8 }, dynamicContextBlocks);
        (spine as any).appendRpOpenerContextBlock('rp', false, 'social', dynamicContextBlocks);
        const dynamicContext = dynamicContextBlocks.join('\n\n');

        const systemPrompt = buildSystemPromptForTest(spine as any, {
            activeMode: 'rp',
            isGreeting: false,
            dynamicContext,
        });

        expect(dynamicContext).toContain('[RP OPENER STYLE]');
        expect(systemPrompt).toContain('[RP OPENER STYLE]');
    });

    it('mode=rp + plain greeting adds RP-safe opener shaping block', () => {
        const dynamicContextBlocks = [
            '[STYLE]: Preserve Tala identity fully while remaining grounded to available context.',
            '[TURN TONE]: immersive; immersive=true; narrativeAmplification=true',
        ];
        (spine as any).appendRpDynamicContextBlocks('rp', { rpIntensity: 0.5 }, dynamicContextBlocks);
        (spine as any).appendRpOpenerContextBlock('rp', true, 'greeting', dynamicContextBlocks);
        const dynamicContext = dynamicContextBlocks.join('\n\n');

        const systemPrompt = buildSystemPromptForTest(spine as any, {
            activeMode: 'rp',
            isGreeting: true,
            dynamicContext,
        });

        expect(dynamicContext).toContain('[RP OPENER STYLE]');
        expect(systemPrompt).toContain('[RP OPENER STYLE]');
    });

    it('substantive RP turn remains unchanged (no opener block)', () => {
        const dynamicContextBlocks = [
            '[STYLE]: Preserve Tala identity fully while remaining grounded to available context.',
            '[TURN TONE]: immersive; immersive=true; narrativeAmplification=true',
        ];
        (spine as any).appendRpDynamicContextBlocks('rp', { rpIntensity: 0.6 }, dynamicContextBlocks);
        (spine as any).appendRpOpenerContextBlock('rp', false, 'lore', dynamicContextBlocks);
        const dynamicContext = dynamicContextBlocks.join('\n\n');

        const systemPrompt = buildSystemPromptForTest(spine as any, {
            activeMode: 'rp',
            isGreeting: false,
            dynamicContext,
        });

        expect(dynamicContext).not.toContain('[RP OPENER STYLE]');
        expect(systemPrompt).not.toContain('[RP OPENER STYLE]');
    });

    it('technical/non-RP behavior family remains unchanged (no RP opener block)', () => {
        const dynamicContextBlocks = [
            '[STYLE]: Keep personality present but reduced; prioritize clarity and task execution.',
            '[TURN TONE]: precise; immersive=false; narrativeAmplification=false',
        ];
        (spine as any).appendRpOpenerContextBlock('assistant', false, 'technical', dynamicContextBlocks);
        const dynamicContext = dynamicContextBlocks.join('\n\n');

        const systemPrompt = buildSystemPromptForTest(spine as any, {
            activeMode: 'assistant',
            isGreeting: false,
            dynamicContext,
        });

        expect(dynamicContext).not.toContain('[RP OPENER STYLE]');
        expect(systemPrompt).not.toContain('[RP OPENER STYLE]');
    });
});
