import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RagService } from '../electron/services/RagService';

class FailingRagService extends RagService {
    protected override async establishConnection(): Promise<Client> {
        throw new Error('spawn_failed');
    }
}

describe('RagServiceHardFailure', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('transitions deterministically to failed when startup cannot establish connection', async () => {
        vi.useFakeTimers();
        const rag = new FailingRagService();

        const result = await rag.ignite('python', 'server.py', {}, { startupTimeoutMs: 15, slowStartGraceMs: 20 });

        expect(result.state).toBe('failed');
        expect(result.reason).toContain('spawn_failed');
        expect(rag.getReadyStatus()).toBe(false);
        expect(rag.getStartupState()).toBe('failed');
    });
});
