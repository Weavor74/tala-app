import { AgentService } from '../electron/services/AgentService';
import path from 'path';
import fs from 'fs';

const logFile = path.join(process.cwd(), 'verify_logs_v2.txt');
const log = (msg: string) => {
    console.log(msg);
    fs.appendFileSync(logFile, (typeof msg === 'object' ? JSON.stringify(msg) : String(msg)) + '\r\n');
};

if (fs.existsSync(logFile)) fs.unlinkSync(logFile);

// Mock Brain
const mockBrain = {
    streamResponse: async (messages: any[], system: string, onToken: any, signal: any, tools: any, options: any) => {
        log(`[MockBrain] system prompt length: ${system.length}`);
        log(`[MockBrain] system prompt snippet: ${system.substring(0, 100)}...`);

        const lastMsg = messages[messages.length - 1].content.toLowerCase();

        if (system.includes('tool_calls') && system.includes('JSON object ONLY')) {
            log('  [MockBrain] Simulating Envelope Mode response...');
            return {
                content: '{ "tool_calls": [{ "name": "shell_run", "arguments": { "command": "echo Hello from Envelope" } }] }',
                toolCalls: [],
                metadata: { usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }
            };
        }

        if (lastMsg.includes('create a script')) {
            log('  [MockBrain] Simulating narration-only response for coding task...');
            return {
                content: "I'll create that for you.",
                toolCalls: [],
                metadata: { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
            };
        }

        return { content: "Hello", toolCalls: [], metadata: { usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } } };
    }
};

const mockTools = {
    getToolDefinitions: () => [
        { name: 'fs_write_text', parameters: {} },
        { name: 'shell_run', parameters: {} }
    ],
    getToolSignatures: () => "fs_write_text(path, content)\nshell_run(command)",
    executeTool: async (name: string, args: any) => {
        log(`  [MockTool] Executed ${name} with: ${JSON.stringify(args)}`);
        return "Command output";
    }
};

async function runVerification() {
    log('--- Starting Hardened Gate V2 (Deep Injection) ---');

    // Create a dummy settings file so loadSettings doesn't crash
    const dummySettingsDir = path.join(process.cwd(), 'tmp_userdata');
    if (!fs.existsSync(dummySettingsDir)) fs.mkdirSync(dummySettingsDir, { recursive: true });
    const dummySettingsPath = path.join(dummySettingsDir, 'app_settings.json');
    fs.writeFileSync(dummySettingsPath, JSON.stringify({
        inference: { instances: [], activeLocalId: '' },
        agent: { activeMode: 'assist' }
    }));

    try {
        const agent = {} as any;
        Object.setPrototypeOf(agent, AgentService.prototype);

        agent.brain = mockBrain;
        agent.tools = mockTools;
        agent.chatHistory = [];
        agent.settingsPath = dummySettingsPath;
        agent.goals = { generatePromptSummary: () => "Mocked Goals" };
        agent.getReflectionSummary = () => "Mocked Reflections";
        agent.getAstroState = async () => "Mocked Astro State";
        agent.estimateTokens = (text: string) => text.length / 4;
        agent.truncateHistory = (msg: any) => msg;
        agent.saveSession = () => { };
        agent.newSession = () => { agent.activeSessionId = 'test-session'; };

        (AgentService as any).MAX_AGENT_ITERATIONS = 5;

        log('\nTest: Coding prompt triggers Envelope Mode and succeeds');
        const userMsg = "Create a script in scripts/test.ts";
        // chat(userMessage, onToken, onEvent, images)
        const result = await agent.chat(userMsg, (token: string) => { }, (evt: any) => { }, []);
        log('Final Result: ' + result);

    } catch (e: any) {
        log('Execution error: ' + e.message + '\n' + e.stack);
    }
    log('\n--- Verification Completed ---');
}

runVerification();
