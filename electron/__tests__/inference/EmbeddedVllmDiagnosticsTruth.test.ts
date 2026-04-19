import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkEmbeddedVllmAvailability } from '../../services/inference/InferenceProviderRegistry';

vi.mock('http', () => {
    function get(_url: string, _opts: unknown, _cb?: (res: unknown) => void) {
        const req = {
            on: (event: string, handler: (error: Error) => void) => {
                if (event === 'error') {
                    setTimeout(() => handler(new Error('ECONNREFUSED')), 0);
                }
                return req;
            },
            destroy: () => req,
        };
        return req;
    }

    return { default: { get }, get };
});

vi.mock('https', () => ({ default: { get: vi.fn() }, get: vi.fn() }));

describe('EmbeddedVllmDiagnosticsTruth', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get');

    afterEach(() => {
        platformSpy.mockReset();
    });

    it('does not report missing uvloop on Windows as an install instruction or opaque blocker', async () => {
        platformSpy.mockReturnValue('win32');

        const result = await checkEmbeddedVllmAvailability(8000, 'qwen2.5:3b');

        expect(result.reachable).toBe(false);
        expect(result.error).toBeTruthy();
        expect(result.error?.toLowerCase()).not.toContain('install uvloop');
        expect(result.error).toMatch(/standard asyncio|Windows runtime|not required/i);
    });
});
