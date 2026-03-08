import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentService } from '../electron/services/AgentService';
import * as fs from 'fs';
import * as path from 'path';

// Mock Electron app
vi.mock('electron', () => ({
    app: {
        getPath: vi.fn((name) => `C:\\Users\\steve\\AppData\\Local\\Tala\\${name}`)
    }
}));

describe('AgentService Safety and Invariants', () => {
    let agent: any;

    beforeEach(() => {
        agent = new AgentService();
    });

    it('should scrub raw tool JSON leaks from assistant output', () => {
        const rawLeak = 'Hey there! Look at this raw data: {"name": "fs_read_text", "arguments": {"path": "secret.txt"}}. Isn\'t it cool?';
        const scrubbed = agent.scrubRawToolJson(rawLeak);

        expect(scrubbed).toContain('[TECHNICAL ARTIFACT SUPPRESSED]');
        expect(scrubbed).not.toContain('"name": "fs_read_text"');
    });

    it('should force finalizeAssistantContent to scrub leaks in RP mode', () => {
        const mode = 'rp';
        const mockMsg = '{"name": "fs_write_text", "arguments": {"path": "leak.txt", "content": "I am writing in RP!"}}';

        const finalized = agent.finalizeAssistantContent('conversation', mockMsg, 0, false, mode);

        expect(finalized).toContain('[TECHNICAL ARTIFACT SUPPRESSED]');
        expect(finalized).not.toContain('"name": "fs_write_text"');
    });

    it('should not scrub normal text', () => {
        const normalText = 'This is a normal message without any JSON.';
        const result = agent.scrubRawToolJson(normalText);

        expect(result).toBe(normalText);
    });

    it('should handle complex JSON leaks with multiple objects', () => {
        const doubleLeak = 'Call 1: {"name":"a","arguments":{}} and Call 2: {"name":"b","arguments":{}}';
        const scrubbed = agent.scrubRawToolJson(doubleLeak);

        const matches = scrubbed.match(/\[TECHNICAL ARTIFACT SUPPRESSED\]/g);
        expect(matches?.length).toBe(2);
    });
});
