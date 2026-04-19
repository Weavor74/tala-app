import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it, vi } from 'vitest';
import { RagService } from '../electron/services/RagService';

class SlowThenReadyRagService extends RagService {
    constructor(private readonly delayMs: number) {
        super();
    }

    protected override async establishConnection(): Promise<Client> {
        await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
        return { listTools: async () => ({ tools: [] }) } as unknown as Client;
    }
}

describe('StartupDiagnosticsTruth', () => {
    it('surfaces deterministic starting/slow_start/ready transitions without contradictory terminal failure', async () => {
        vi.useFakeTimers();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const rag = new SlowThenReadyRagService(20);

        expect(rag.getStartupState()).toBe('not_started');

        const startup = rag.ignite('python', 'server.py', {}, { startupTimeoutMs: 15, slowStartGraceMs: 20 });
        expect(rag.getStartupState()).toBe('starting');

        await vi.advanceTimersByTimeAsync(16);
        expect(rag.getStartupState()).toBe('slow_start');

        await vi.advanceTimersByTimeAsync(20);
        const result = await startup;
        expect(result.state).toBe('ready');
        expect(rag.getStartupState()).toBe('ready');
        expect(rag.getLastStartupResult()?.state).toBe('ready');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('entering slow_start grace period'));
        expect(errorSpy).not.toHaveBeenCalled();

        vi.useRealTimers();
    });
});
