import { McpService } from '../electron/services/McpService';
import { CodeControlService } from '../electron/services/CodeControlService';
import { CodeAccessPolicy } from '../electron/services/CodeAccessPolicy';
import { FileService } from '../electron/services/FileService';
import { TerminalService } from '../electron/services/TerminalService';
import { SystemService } from '../electron/services/SystemService';
import path from 'path';

async function runVerification() {
    console.log('--- Starting Structural Correction Verification ---');

    const policy = new CodeAccessPolicy({ workspaceRoot: process.cwd() });

    // 1. Test Normalization & Prefix Matching
    console.log('Test: Normalization & Prefix Matching...');
    const tests = [
        { raw: '  npm run lint  ', valid: true, expected: 'npm run lint' },
        { raw: '"git status"', valid: true, expected: 'git status' },
        { raw: 'python --version', valid: true, expected: 'python --version' },
        { raw: 'powershell rm -rf', valid: false, error: 'destructive' },
        { raw: '   ', valid: false, error: 'empty' }
    ];

    for (const t of tests) {
        const norm = policy.normalizeCommand(t.raw);
        const v = policy.validateCommand(norm);
        const pass = (v.ok === t.valid);
        console.log(`  [${t.raw}] -> [${norm}] | Valid: ${v.ok} | Result: ${pass ? 'OK' : 'FAIL'} ${v.error || ''}`);
        if (!pass) process.exit(1);
    }

    // 2. Verify Execution Routing
    const fileService = new FileService();
    const terminalService = new TerminalService();
    const codeControl = new CodeControlService(fileService as any, terminalService as any, policy);

    console.log('Test: CodeControlService execution routing and policy enforcement...');
    try {
        const result: any = await codeControl.shellRun('  npm -v  ');
        console.log(`  npm -v -> ok: ${result.ok}, stdout: ${result.stdout ? 'CAPTURED' : 'EMPTY'}`);
    } catch (e: any) {
        console.log('  FAIL:', e.message);
        process.exit(1);
    }

    // 3. Verify TerminalService policy delegation
    console.log('Test: TerminalService policy delegation...');
    terminalService.setPolicy(policy);
    // @ts-ignore
    const isAllowed = terminalService.isAllowed('npm start');
    console.log(`  Terminal check 'npm start': ${isAllowed ? 'PASS' : 'FAIL'}`);
    if (!isAllowed) process.exit(1);

    console.log('--- Verification Completed Successfully ---');
}

runVerification().catch(err => {
    console.error('CRITICAL FAIL:', err);
    process.exit(1);
});
