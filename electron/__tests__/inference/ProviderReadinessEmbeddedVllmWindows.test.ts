import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkEmbeddedVllmAvailability } from '../../services/inference/InferenceProviderRegistry';

vi.mock('http', () => {
    function get(_url: string, _opts: unknown, cb?: (res: any) => void) {
        const response = {
            statusCode: 200,
            on: (event: string, handler: (...args: any[]) => void) => {
                if (event === 'data') {
                    setTimeout(() => handler(Buffer.from(JSON.stringify({ data: [{ id: 'qwen2.5:3b' }] }))), 0);
                }
                if (event === 'end') {
                    setTimeout(() => handler(), 1);
                }
                return response;
            },
            resume: () => undefined,
        };

        if (cb) {
            setTimeout(() => cb(response), 0);
        }

        const req = {
            on: (_event: string, _handler: (...args: any[]) => void) => req,
            destroy: () => req,
        };
        return req;
    }

    return { default: { get }, get };
});

vi.mock('https', () => ({ default: { get: vi.fn() }, get: vi.fn() }));

describe('ProviderReadinessEmbeddedVllmWindows', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get');

    afterEach(() => {
        platformSpy.mockReset();
    });

    it('does not mark provider unavailable solely due to uvloop absence when endpoint is reachable', async () => {
        platformSpy.mockReturnValue('win32');

        const result = await checkEmbeddedVllmAvailability(8000, 'fallback-model');

        expect(result.reachable).toBe(true);
        expect(result.status).toBe('ready');
        expect(result.health).toBe('healthy');
        expect(result.models).toContain('qwen2.5:3b');
        expect(result.error).toBeUndefined();
    });
});
