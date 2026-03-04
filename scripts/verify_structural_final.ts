import { SystemService } from '../electron/services/SystemService';
import { CodeAccessPolicy } from '../electron/services/CodeAccessPolicy';
import { ToolService } from '../electron/services/ToolService';
import path from 'path';
import fs from 'fs';

// Mock Electron app
const mockApp = {
    isPackaged: false,
    getPath: (name: string) => path.join(process.cwd(), 'mock_app_data', name),
    getAppPath: () => process.cwd()
};

// Inject mock into global/module scope if needed (ToolService imports it)
require('electron').app = mockApp;

const logFile = path.join(process.cwd(), 'verify_structural_final_logs.txt');
const log = (msg: string) => {
    console.log(msg);
    fs.appendFileSync(logFile, (typeof msg === 'object' ? JSON.stringify(msg) : String(msg)) + '\r\n');
};

if (fs.existsSync(logFile)) fs.unlinkSync(logFile);

async function runVerification() {
    log('--- Final Structural Verification (with Mocks) ---');

    try {
        const ss = new SystemService();
        const policy = new CodeAccessPolicy({ workspaceRoot: process.cwd() });

        // Mocking ToolService constructor dependencies
        // Actually ToolService L85 is app.getPath('userData')
        // Let's use Object.create to bypass constructor or just provide a minimal working instance
        const tools = Object.create(ToolService.prototype);
        // Manual setup of what getToolDefinitions needs
        (tools as any).registeredTools = new Map();
        // Since we want to test filtering, we need to populate registeredTools
        const coreTools = [
            { name: 'fs_read_text', description: 'desc' },
            { name: 'shell_run', description: 'desc' },
            { name: 'write_file', description: 'legacy' },
            { name: 'terminal_run', description: 'legacy' }
        ];
        coreTools.forEach(t => (tools as any).registeredTools.set(t.name, { definition: { function: { name: t.name, description: t.description } } }));

        // 1. Env Sanitization & User ID Injection
        log('\n1. Env Sanitization:');
        const baseEnv = { PYTHONHOME: '/bad/path', PYTHONPATH: '/bad/lib', TALA_USER_ID: 'uuid-123' };
        const sanitized = ss.getMcpEnv(baseEnv);
        log(`  PYTHONHOME removed: ${!sanitized.PYTHONHOME}`);
        log(`  PYTHONPATH removed: ${!sanitized.PYTHONPATH}`);
        log(`  TALA_USER_ID preserved: ${sanitized.TALA_USER_ID === 'uuid-123'}`);
        log(`  PYTHONNOUSERSITE set: ${sanitized.PYTHONNOUSERSITE === '1'}`);

        // 2. Command Normalization
        log('\n2. Command Normalization:');
        const raw = '  "npm   run    lint"  ';
        const expected = 'npm run lint';
        const normalized = policy.normalizeCommand(raw);
        log(`  Source: [${raw}]`);
        log(`  Result: [${normalized}]`);
        log(`  Match: ${normalized === expected}`);

        // 3. Tool List Filtering
        log('\n3. Tool List Filtering:');
        const defs = tools.getToolDefinitions();
        const legacyNames = ['write_file', 'terminal_run', 'execute_script'];
        const foundLegacy = defs.filter((d: any) => legacyNames.includes(d.function.name));
        const canonicalNames = ['fs_read_text', 'shell_run'];
        const foundCanonical = defs.filter((d: any) => canonicalNames.includes(d.function.name));

        log(`  Found Legacy tools: ${foundLegacy.length} (Expected: 0)`);
        log(`  Found Canonical tools: ${foundCanonical.length} (Expected: 2)`);
        log(`  Canonical IDs: ${foundCanonical.map((d: any) => d.function.name).join(', ')}`);

        // 4. Python Preflight (Simulation/Check)
        log('\n4. Python Preflight:');
        try {
            const info = await ss.detectEnv(process.cwd());
            if (info.pythonPath && info.pythonPath !== 'Not Found') {
                ss.preflightCheck(info.pythonPath);
                log('  Preflight Check: PASSED');
            } else {
                log('  Preflight Check: SKIPPED (Python not found)');
            }
        } catch (e: any) {
            log(`  Preflight Check: FAILED: ${e.message}`);
        }

    } catch (e: any) {
        log('Global execution error: ' + e.message + '\n' + e.stack);
    }
    log('\n--- Verification Completed ---');
}

runVerification();
