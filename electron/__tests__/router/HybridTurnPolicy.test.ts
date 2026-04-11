import { beforeEach, describe, expect, it } from 'vitest';
import { TalaContextRouter } from '../../services/router/TalaContextRouter';
import { MockMemoryService } from './MockServices';

describe('Hybrid-first turn policy routing', () => {
    let router: TalaContextRouter;
    let memory: MockMemoryService;

    beforeEach(() => {
        memory = new MockMemoryService();
        router = new TalaContextRouter(memory as any);
    });

    it('greeting turn in hybrid suppresses memory and uses minimal policy', async () => {
        const ctx = await router.process('hybrid-greet-1', 'hello', 'hybrid');
        expect(ctx.turnPolicy.policyId).toBe('greeting');
        expect(ctx.retrieval.suppressed).toBe(true);
        expect(ctx.memoryWriteDecision?.category).toBe('do_not_write');
        expect(ctx.turnPolicy.personalityLevel).toBe('minimal');
        expect(ctx.turnPolicy.astroLevel).toBe('off');
        expect(ctx.turnPolicy.reflectionLevel).toBe('off');
        expect(ctx.turnPolicy.toolExposureProfile).toBe('none');
    });

    it('technical execution turn in hybrid uses reduced personality and strict tools', async () => {
        const ctx = await router.process('hybrid-tech-1', 'debug the failing router pipeline', 'hybrid');
        expect(ctx.turnPolicy.policyId).toBe('technical_execution');
        expect(ctx.turnPolicy.personalityLevel).toBe('reduced');
        expect(ctx.turnPolicy.astroLevel).toBe('off');
        expect(ctx.turnPolicy.toolExposureProfile).toBe('technical_strict');
        expect(ctx.memoryWriteDecision?.category).toBe('short_term');
    });

    it('normal conversation in hybrid uses hybrid conversational policy', async () => {
        const ctx = await router.process('hybrid-convo-1', 'I wanted to check in and chat for a minute', 'hybrid');
        expect(ctx.turnPolicy.policyId).toBe('normal_hybrid_conversation');
        expect(ctx.turnPolicy.personalityLevel).toBe('normal');
        expect(ctx.turnPolicy.memoryReadPolicy).toBe('light');
    });

    it('immersive roleplay intent in hybrid uses immersive policy profile', async () => {
        const ctx = await router.process('hybrid-lore-1', 'Tell me about when you were 17', 'hybrid');
        expect(ctx.turnPolicy.policyId).toBe('immersive_roleplay');
        expect(ctx.turnPolicy.personalityLevel).toBe('full');
        expect(ctx.turnPolicy.memoryReadPolicy).toBe('lore_allowed');
        expect(ctx.turnPolicy.astroLevel).toBe('full');
    });

    it('policy selection is per-turn and not tied to raw mode identity', async () => {
        const greet = await router.process('hybrid-greet-2', 'good morning', 'hybrid');
        const tech = await router.process('hybrid-tech-2', 'run diagnostics on the inference service', 'hybrid');
        expect(greet.turnPolicy.policyId).toBe('greeting');
        expect(tech.turnPolicy.policyId).toBe('technical_execution');
    });
});
