import { describe, expect, it } from 'vitest';
import { normalizeAssistantOutput } from '../electron/services/kernel/AgentKernel';

describe('AgentKernel assistant output normalization seam', () => {
    it('normalizes legacy string output to chat channel', () => {
        expect(normalizeAssistantOutput('legacy response')).toEqual({
            content: 'legacy response',
            outputChannel: 'chat',
        });
    });

    it('preserves structured output metadata', () => {
        expect(
            normalizeAssistantOutput({
                content: 'structured response',
                artifactId: 'artifact-1',
                outputChannel: 'workspace',
            }),
        ).toEqual({
            content: 'structured response',
            artifactId: 'artifact-1',
            outputChannel: 'workspace',
        });
    });
});

