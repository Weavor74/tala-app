import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RagService } from '../electron/services/RagService';

class DelayedReadyRagService extends RagService {
    constructor(private readonly readyDelayMs: number) {
        super();
    }

    protected override async establishConnection(): Promise<Client> {
        await new Promise<void>((resolve) => setTimeout(resolve, this.readyDelayMs));
        return { listTools: async () => ({ tools: [] }) } as unknown as Client;
    }
}

describe('RagServiceColdStart', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('enters slow_start and recovers to ready when startup exceeds normal timeout but completes in grace window', async () => {
        vi.useFakeTimers();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const rag = new DelayedReadyRagService(20);

        const startup = rag.ignite('python', 'server.py', {}, { startupTimeoutMs: 15, slowStartGraceMs: 20 });
        await vi.advanceTimersByTimeAsync(16);

        expect(rag.getStartupState()).toBe('slow_start');

        await vi.advanceTimersByTimeAsync(20);
        const result = await startup;

        expect(result.state).toBe('ready');
        expect(result.reason).toBe('slow_start_recovered');
        expect(rag.getReadyStatus()).toBe(true);
        expect(rag.getStartupState()).toBe('ready');
        expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('Ignition failed'), expect.anything());
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('entering slow_start grace period'));
    });

    it('does not emit terminal failure at normal timeout when readiness arrives shortly after', async () => {
        vi.useFakeTimers();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const rag = new DelayedReadyRagService(19);

        const startup = rag.ignite('python', 'server.py', {}, { startupTimeoutMs: 15, slowStartGraceMs: 15 });
        await vi.advanceTimersByTimeAsync(16);
        expect(rag.getStartupState()).toBe('slow_start');

        await vi.advanceTimersByTimeAsync(10);
        const result = await startup;

        expect(result.state).toBe('ready');
        expect(rag.getStartupState()).toBe('ready');
        expect(errorSpy).not.toHaveBeenCalled();
    });
});
