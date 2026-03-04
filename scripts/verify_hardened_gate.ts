import { AgentService } from '../electron/services/AgentService';
import path from 'path';
import fs from 'fs';

// 1. Mock Electron 'app' BEFORE everything else
// This is tricky with ESM, but since we are using tsx, we can mock the module
import module from 'module';
const originalRequire = module.createRequire(import.meta.url);

// Mocking 'electron'
// Note: We might need to mock this via global or by overriding the require cache if using CommonJS.
// For ESM/tsx, we can try to mock it like this:
(global as any).electronMock = {
    app: {
        getPath: (name: string) => path.join(process.cwd(), 'tmp_userdata'),
        getAppPath: () => process.cwd()
    }
};

// 2. Mock other dependencies that AgentService instantiates
const mockBrain = {
    streamResponse: async (messages: any[], system: string, onToken: any, signal: any, tools: any, options: any) => {
        const lastMsg = messages[messages.length - 1].content.toLowerCase();
        console.log(`  [MockBrain] Received system prompt length: ${system.length}`);
        console.log(`  [MockBrain] Received last message: "${lastMsg}"`);

        // Check for the hardened system prompt override
        const isToolOnlyRetry = system.includes('Tool call required for this task') && system.includes('You MUST respond using tool calls ONLY');
        if (isToolOnlyRetry) {
            console.log('  [MockBrain] Detecting Tool-Only SYSTEM retry constraint!');
            return {
                content: "",
                toolCalls: [{
                    id: 'retry_call',
                    type: 'function',
                    function: { name: 'fs_write_text', arguments: JSON.stringify({ path: 'scripts/system_report.ts', content: 'console.log(process.version)' }) }
                }]
            };
        }

        // Scenario: Narration only on a coding task
        if (lastMsg.includes('create a script')) {
            console.log('  [MockBrain] Simulating narration-only response for coding task...');
            return { content: "Sure, I'll write that script for you right now.", toolCalls: [] };
        }

        // Scenario: npm -v (should trigger tool call directly)
        if (lastMsg.includes('npm -v')) {
            return {
                content: "",
                toolCalls: [{
                    id: 'npm_call',
                    type: 'function',
                    function: { name: 'shell_run', arguments: JSON.stringify({ command: 'npm -v' }) }
                }]
            };
        }

        return { content: "I am a helpful assistant.", toolCalls: [] };
    }
};

const mockTools = {
    getToolDefinitions: () => [
        { name: 'fs_write_text', parameters: {} },
        { name: 'shell_run', parameters: {} }
    ],
    executeTool: async (name: string, args: any) => {
        console.log(`  [MockTool] Executed ${name} with:`, JSON.stringify(args));
        return "v18.0.0";
    }
};

async function runVerification() {
    console.log('--- Starting Hardened ToolRequired Gate Verification ---');

    // Ensure tmp_userdata exists
    const userDataPath = path.join(process.cwd(), 'tmp_userdata');
    if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath);

    // Instantiate AgentService (might need more mocks depending on how deep the constructor goes)
    // We'll try to override the private brain/tools after creation
    try {
        const agent = new AgentService();
        (agent as any).brain = mockBrain;
        (agent as any).tools = mockTools;
        // Mocking userMessage and systemPrompt for our test
        const userMessage = "Create a script called scripts/system_report.ts that prints Node version.";

        console.log('Test 1: Coding task triggers gate and retry produces tools');
        const result1 = await (agent as any).chat(userMessage, [], () => { });
        console.log('Final Result 1:', result1);

        console.log('\nTest 2: Direct shell command prompt');
        const result2 = await (agent as any).chat('Run npm -v', [], () => { });
        console.log('Final Result 2:', result2);

        console.log('\nTest 3: Triggers gate but retry also fails to produce tools');
        // Modify mockBrain for this test
        const originalStream = mockBrain.streamResponse;
        mockBrain.streamResponse = async (messages: any[], system: string) => {
            return { content: "I refuse to use tools.", toolCalls: [] };
        };
        const result3 = await (agent as any).chat('Create a script now.', [], () => { });
        console.log('Final Result 3 (Expect failure msg):', result3);

    } catch (e: any) {
        console.error('Execution error during verification:', e);
    }

    console.log('\n--- Verification Script Completed ---');
}

runVerification().catch(err => {
    console.error('CRITICAL FAIL:', err);
    process.exit(1);
});
