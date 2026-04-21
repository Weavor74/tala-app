import { beforeEach, describe, expect, it } from 'vitest';
import { TalaContextRouter } from '../../services/router/TalaContextRouter';
import { MockMemoryService } from './MockServices';

describe('RP behavior shaping hardening', () => {
    let router: TalaContextRouter;
    let memory: MockMemoryService;

    beforeEach(() => {
        memory = new MockMemoryService();
        router = new TalaContextRouter(memory as any);
    });

    it('mode=rp + RP-compatible policy yields non-minimal personality behavior', async () => {
        const ctx = await router.process('rp-behavior-1', 'tell me about your past', 'rp');
        expect(ctx.turnPolicy.policyId).toBe('immersive_roleplay');
        expect(ctx.turnBehavior.personalityLevel).toBe('full');
        expect(ctx.turnBehavior.immersiveStyle).toBe(true);
    });

    it('mode=rp + plain greeting does not end with minimal personality behavior', async () => {
        const ctx = await router.process('rp-behavior-2', 'hello', 'rp');
        expect(ctx.turnBehavior.personalityLevel).not.toBe('minimal');
        expect(ctx.turnBehavior.immersiveStyle).toBe(true);
        expect(ctx.turnBehavior.toneProfile).toBe('immersive');
    });

    it('mode=rp + social opener does not end with minimal personality behavior', async () => {
        const ctx = await router.process('rp-behavior-3', 'hey sexy', 'rp');
        expect(ctx.turnBehavior.personalityLevel).not.toBe('minimal');
        expect(ctx.turnBehavior.immersiveStyle).toBe(true);
        expect(ctx.turnBehavior.toneProfile).toBe('immersive');
    });

    it('non-RP + plain greeting remains minimal', async () => {
        const ctx = await router.process('assistant-behavior-1', 'hello', 'assistant');
        expect(ctx.turnPolicy.policyId).toBe('greeting');
        expect(ctx.turnBehavior.personalityLevel).toBe('minimal');
        expect(ctx.turnBehavior.immersiveStyle).toBe(false);
        expect(ctx.turnBehavior.toneProfile).toBe('neutral');
    });

    it('non-RP technical behavior family remains unchanged', async () => {
        const ctx = await router.process('assistant-behavior-2', 'debug the inference router', 'assistant');
        expect(ctx.turnPolicy.policyId).toBe('technical_execution');
        expect(ctx.turnBehavior.personalityLevel).toBe('reduced');
        expect(ctx.turnBehavior.immersiveStyle).toBe(false);
        expect(ctx.turnBehavior.toneProfile).toBe('precise');
    });

    it('shared fallback/default path remains stable for hybrid conversation policy', async () => {
        const ctx = await router.process('hybrid-behavior-1', 'thanks for the help, lets chat', 'hybrid');
        expect(ctx.turnPolicy.policyId).toBe('normal_hybrid_conversation');
        expect(ctx.turnBehavior.personalityLevel).toBe('normal');
        expect(ctx.turnBehavior.immersiveStyle).toBe(false);
        expect(ctx.turnBehavior.toneProfile).toBe('natural');
    });
});
