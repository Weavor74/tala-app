import { describe, expect, it } from 'vitest';
import { RagService } from '../electron/services/RagService';

describe('RagServiceReadinessTruth', () => {
    it('process ready but client disconnected is not searchable', async () => {
        const rag = new RagService() as any;
        rag.processReady = true;
        rag.clientConnected = false;
        rag.toolsListed = false;
        rag.client = null;

        const result = await rag.searchStructuredDetailed('hello');
        expect(result.status).toBe('degraded');
        expect(result.reasonCode).toBe('client_not_connected');
        expect(result.results).toEqual([]);
    });

    it('searchStructured swallows raw Not connected errors and returns empty', async () => {
        const rag = new RagService() as any;
        rag.processReady = true;
        rag.clientConnected = true;
        rag.toolsListed = true;
        rag.client = {
            callTool: async () => {
                throw new Error('Not connected');
            },
        };

        const result = await rag.searchStructuredDetailed('hello');
        expect(result.status).toBe('degraded');
        expect(result.reasonCode).toBe('search_unavailable');
        expect(result.results).toEqual([]);
    });
});

