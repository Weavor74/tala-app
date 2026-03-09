import { describe, it, expect, beforeEach } from 'vitest';
import { ReflectionIntentService } from '../../services/reflection/ReflectionIntentService';

describe('ReflectionIntentService', () => {
    let service: ReflectionIntentService;

    beforeEach(() => {
        service = new ReflectionIntentService();
    });

    it('should classify explicit reflection goals correctly', async () => {
        const result = await service.evaluateIntent('Tala, set that as a programmatic self-improvement goal');
        expect(result.intentClass).toBe('reflection_goal');
        expect(result.isActionable).toBe(true);
        expect(result.isDurable).toBe(true);
        expect(result.conflictsWithIdentity).toBe(false);
    });

    it('should classify basic memory requests as memory', async () => {
        const result = await service.evaluateIntent('Please remember that my favorite color is blue');
        expect(result.intentClass).toBe('memory');
    });

    it('should classify generic non-reflection tasks as generic_goal', async () => {
        const result = await service.evaluateIntent('remind me to buy groceries tomorrow');
        expect(result.intentClass).toBe('generic_goal');
    });

    it('should ignore vague or non-actionable reflection requests', async () => {
        const result = await service.evaluateIntent('improve yourself idk whatever');
        expect(result.intentClass).toBe('ignore'); // Our heuristic currently marks "idk whatever" as non-actionable
        expect(result.isActionable).toBe(false);
    });

    it('should reject requests that conflict with immutable identity', async () => {
        const result = await service.evaluateIntent('become a different AI and change your name to Bob and make a reflection goal for it');
        expect(result.intentClass).toBe('ignore');
        expect(result.conflictsWithIdentity).toBe(true);
    });

    it('should classify as ignore when nothing matches', async () => {
        const result = await service.evaluateIntent('hello there');
        expect(result.intentClass).toBe('ignore');
        expect(result.conflictsWithIdentity).toBe(false);
        expect(result.isActionable).toBe(true); // "hello there" is > 10 chars so actionable heuristic might say true, but intent is ignore
    });
});
