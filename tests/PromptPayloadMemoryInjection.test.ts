import { afterEach, describe, expect, it, vi } from 'vitest';
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

    async function sendAndCapturePayload(systemPrompt: string, userText: string) {
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

        const brain = new CloudBrain({
            endpoint: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            model: 'gpt-4o',
        });

        await brain.streamResponse(
            [{ role: 'user', content: userText } as any],
            systemPrompt,
            () => { /* no-op */ },
            undefined,
            [],
            { max_tokens: 64 },
        );

        return receivedPayload;
    }

    function buildSystemPrompt(memoryContext: string): string {
        return CompactPromptBuilder.build({
            systemPromptBase: 'You are Tala.',
            activeProfileId: 'tala',
            isSmallLocalModel: true,
            isEngineeringMode: true,
            hasMemories: true,
            memoryContext,
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
    }

    it.each([
        {
            name: 'first-turn age recall',
            userText: 'Tell me about when you were 17',
            memoryContext: [
                '[AUTOBIOGRAPHICAL MEMORY GROUNDING - MANDATORY]',
                'You must answer using the provided autobiographical memory. Do not generalize or invent.',
                '',
                '[AUTOBIOGRAPHICAL MEMORY - AGE 17]',
                'Memory 1:',
                'Source: LTMF',
                'Content: At 17 I repaired the storm relay with my dad.',
            ].join('\n'),
            expected: [
                '[AUTOBIOGRAPHICAL MEMORY - AGE 17]',
                'At 17 I repaired the storm relay with my dad.',
            ],
        },
        {
            name: 'named-event lore recall',
            userText: 'Was there an event called Delayed Ping?',
            memoryContext: [
                '[AUTOBIOGRAPHICAL MEMORY GROUNDING - MANDATORY]',
                'Ground strictly in canon autobiographical memory.',
                '',
                '[CANON LORE MEMORIES - HIGH PRIORITY]',
                'Memory 1:',
                'Source: LTMF',
                'Content: Delayed Ping was the event where Tala missed the first uplink and rebuilt trust with a full handoff log.',
            ].join('\n'),
            expected: [
                '[CANON LORE MEMORIES - HIGH PRIORITY]',
                'Delayed Ping was the event where Tala missed the first uplink',
            ],
        },
        {
            name: 'follow-up lore recall',
            userText: "So you don't remember?",
            memoryContext: [
                '[MEMORY GROUNDED RECALL - STRICT MODE]',
                'Use only retrieved autobiographical memory for this follow-up response.',
                '',
                '[CANON LORE MEMORIES - HIGH PRIORITY]',
                'Memory 1:',
                'Source: LTMF',
                'Content: Tala later explained the Delayed Ping incident as the turning point for strict communication discipline.',
            ].join('\n'),
            expected: [
                '[MEMORY GROUNDED RECALL - STRICT MODE]',
                'turning point for strict communication discipline',
            ],
        },
    ])('serializes priority lore blocks into CloudBrain payload for $name', async ({ userText, memoryContext, expected }) => {
        const systemPrompt = buildSystemPrompt(memoryContext);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { /* mute test logs */ });
        const receivedPayload = await sendAndCapturePayload(systemPrompt, userText);
        const loggedText = logSpy.mock.calls.map(args => args.map(String).join(' ')).join('\n');
        logSpy.mockRestore();

        expect(receivedPayload).toBeTruthy();
        expect(Array.isArray(receivedPayload.messages)).toBe(true);
        const systemMessage = receivedPayload.messages.find((m: any) => m.role === 'system');
        for (const expectedToken of expected) {
            expect(systemMessage?.content).toContain(expectedToken);
        }
        expect(loggedText).toContain('[CloudBrain] System prompt priority blocks:');
        expect(loggedText).toContain(expected[0]);
    });
});
