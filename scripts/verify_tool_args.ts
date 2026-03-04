import { AgentService } from '../electron/services/AgentService';
import path from 'path';
import fs from 'fs';

const logFile = path.join(process.cwd(), 'verify_tool_args_logs.txt');
const log = (msg: string) => {
    console.log(msg);
    fs.appendFileSync(logFile, (typeof msg === 'object' ? JSON.stringify(msg) : String(msg)) + '\r\n');
};

if (fs.existsSync(logFile)) fs.unlinkSync(logFile);

async function runVerification() {
    log('--- Starting Tool Arguments Verification ---');

    try {
        const agent = {} as any;
        Object.setPrototypeOf(agent, AgentService.prototype);

        // Mock dependencies to avoid Electron app issues
        agent.tools = {
            get: (name: string) => ({ execute: async () => `Mock output for ${name}` }),
            hasTool: (name: string) => true
        };

        const testCases = [
            { name: 'Valid JSON', tool: 'shell_run', args: '{"command": "echo hello"}' },
            { name: 'Object/Direct', tool: 'shell_run', args: { command: 'echo hello' } },
            { name: 'Single Quote Repair', tool: 'shell_run', args: "{'command': 'echo hello'}" },
            { name: 'Trailing Comma Repair', tool: 'fs_write_text', args: '{"path": "test.txt", "content": "hello",}' },
            { name: 'Missing Required Field (fs_write_text)', tool: 'fs_write_text', args: '{"path": "test.txt"}', expectedError: 'Missing required argument "content"' },
            { name: 'Missing Required Field (shell_run)', tool: 'shell_run', args: '{}', expectedError: 'Missing required argument "command"' },
            { name: 'Invalid JSON', tool: 'shell_run', args: '{"command": "unclosed', expectedError: 'Invalid tool arguments JSON' }
        ];

        for (const tc of testCases) {
            log(`\nTest: ${tc.name}`);
            try {
                const parsed = (agent as any).parseToolArguments(tc.tool, tc.args);
                log(`  Parsed: ${JSON.stringify(parsed)}`);

                (agent as any).validateToolArguments(tc.tool, parsed);
                log(`  Validated: OK`);

                if (tc.expectedError) {
                    log(`  FAILED: Expected error "${tc.expectedError}" but it passed.`);
                }
            } catch (e: any) {
                if (tc.expectedError && e.message.includes(tc.expectedError)) {
                    log(`  Caught expected error: ${e.message}`);
                } else {
                    log(`  Execution error: ${e.message}`);
                    if (!tc.expectedError) {
                        // Unexpected error
                    }
                }
            }
        }

    } catch (e: any) {
        log('Global execution error: ' + e.message + '\n' + e.stack);
    }
    log('\n--- Verification Completed ---');
}

runVerification();
