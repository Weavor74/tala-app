import { AgentService } from '../electron/services/AgentService';
import * as fs from 'fs';
import * as path from 'path';

// Mock Electron app
(global as any).app = {
    getPath: (name: string) => `C:\\Users\\steve\\AppData\\Local\\Tala\\${name}`
};

async function testJsonSuppression() {
    console.log('--- Testing JSON Leak Suppression ---');
    const agent = new AgentService() as any;

    const rawLeak = 'Hey there! Look at this raw data: {"name": "fs_read_text", "arguments": {"path": "secret.txt"}}. Isn\'t it cool?';

    // Test direct scrubRawToolJson
    const scrubbed = agent.scrubRawToolJson(rawLeak);
    console.log('Original Header:', rawLeak.slice(0, 50));
    console.log('Scrubbed Result:', scrubbed);

    if (scrubbed.includes('[TECHNICAL ARTIFACT SUPPRESSED]') && !scrubbed.includes('"name": "fs_read_text"')) {
        console.log('✅ JSON Leak Suppression working correctly.');
    } else {
        console.error('❌ JSON Leak Suppression FAILED.');
        process.exit(1);
    }
}

async function testRpInvariants() {
    console.log('\n--- Testing RP Invariants ---');
    const agent = new AgentService() as any;

    // Force mode to RP
    const mode = 'rp';
    const mockMsg = { role: 'assistant', content: '{"name": "fs_write_text", "arguments": {"path": "leak.txt", "content": "I am writing in RP!"}}' };

    // Test finalizeAssistantContent in RP mode
    const finalized = agent.finalizeAssistantContent('conversation', mockMsg.content, 0, false, mode);
    console.log('Finalized RP message:', finalized);

    if (finalized.includes('[TECHNICAL ARTIFACT SUPPRESSED]')) {
        console.log('✅ RP Mode auto-scrubs raw JSON leaks.');
    } else {
        console.error('❌ RP Mode FAILED to scrub raw JSON leaks.');
        process.exit(1);
    }
}

async function runTests() {
    try {
        await testJsonSuppression();
        await testRpInvariants();
        console.log('\nALL VERIFICATION TESTS PASSED');
    } catch (e) {
        console.error('Tests failed with error:', e);
        process.exit(1);
    }
}

runTests();
