import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { CloudBrain } from '../electron/brains/CloudBrain';
import { CompactPromptBuilder } from '../electron/services/plan/CompactPromptBuilder';

describe('Prompt payload memory injection', () => {
    let server: ReturnType<typeof createServer> | null = null;

    afterEach(async () => {
        if (!server) return;
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
    });

    it('first turn structured autobiographical match includes age memory block in outgoing payload', async () => {
        let receivedPayload: any = null;

        server = createServer((req: IncomingMessage, res: ServerResponse) => {
            let raw = '';
            req.on('data', (chunk) => { raw += chunk.toString(); });
            req.on('end', () => {
                receivedPayload = JSON.parse(raw);
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            });
        });

        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;

        const systemPrompt = CompactPromptBuilder.build({
            systemPromptBase: 'You are Tala.',
            activeProfileId: 'tala',
            isSmallLocalModel: true,
            isEngineeringMode: true,
            hasMemories: true,
            memoryContext: [
                '[AUTOBIOGRAPHICAL MEMORY GROUNDING - MANDATORY]',
                'You must answer using the provided autobiographical memory. Do not generalize or invent.',
                '',
                '[AUTOBIOGRAPHICAL MEMORY - AGE 17]',
                'Memory 1:',
                'Source: LTMF',
                'Content: At 17 I repaired the storm relay with my dad.',
            ].join('\n'),
            goalsAndReflections: '',
            dynamicContext: '[EMOTIONAL STATE]: neutral',
            toolSigs: '[NO TOOLS AVAILABLE IN RP MODE]',
            userIdentity: '',
            compactPacket: {
                identityCore: '[IDENTITY] Tala',
                modeBlock: '[MODE] rp',
                emotionalBiasBlock: '[EMOTION] neutral',
                toolPolicyBlock: '[TOOLS] none',
                continuityBlock: '[CONTINUITY] compact continuity',
                currentTaskBlock: '[TASK] compact task',
                responseRulesBlock: '[RULES] compact',
                assembledSections: ['[IDENTITY] Tala', '[MODE] rp'],
                diagnosticsSummary: {
                    profileClass: 'small_profile',
                    compactionPolicy: 'strict',
                    parameterClass: 'tiny',
                    memoriesKept: 1,
                    memoriesDropped: 0,
                    docsIncluded: false,
                    docChunksIncluded: 0,
                    reflectionNotesKept: 0,
                    reflectionNotesDropped: 0,
                    emotionIncluded: true,
                    identityMode: 'compressed',
                    toolMode: 'compact_policy',
                    sectionsIncluded: ['identity', 'mode'],
                    sectionsDropped: [],
                    rationale: 'test',
                },
            } as any,
            notebookGrounded: false,
        });

        const brain = new CloudBrain({
            endpoint: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            model: 'gpt-4o',
        });

        await brain.streamResponse(
            [{ role: 'user', content: 'Tell me about when you were 17' } as any],
            systemPrompt,
            () => { /* no-op */ },
            undefined,
            [],
            { max_tokens: 64 },
        );

        expect(receivedPayload).toBeTruthy();
        expect(Array.isArray(receivedPayload.messages)).toBe(true);
        const systemMessage = receivedPayload.messages.find((m: any) => m.role === 'system');
        expect(systemMessage?.content).toContain('[AUTOBIOGRAPHICAL MEMORY - AGE 17]');
        expect(systemMessage?.content).toContain('At 17 I repaired the storm relay with my dad.');
    });
});

