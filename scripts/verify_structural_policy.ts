import { CodeControlService } from '../electron/services/CodeControlService';
import { CodeAccessPolicy } from '../electron/services/CodeAccessPolicy';
import path from 'path';

// Mocking dependencies that cause ERR_REQUIRE_ESM in tsx environment
class MockFileService { setPolicy() { } }
class MockTerminalService { setPolicy() { } }

async function runVerification() {
    console.log('--- Starting Structural Correction (Policy Only) Verification ---');

    const policy = new CodeAccessPolicy({ workspaceRoot: process.cwd() });

    // 1. Test Normalization & Prefix Matching
    console.log('Test: Normalization & Prefix Matching...');
    const tests = [
        { raw: '  npm run lint  ', valid: true, expected: 'npm run lint' },
        { raw: '"git status"', valid: true, expected: 'git status' },
        { raw: "'npm install'", valid: true, expected: 'npm install' },
        { raw: 'npm    run    lint', valid: true, expected: 'npm run lint' },
        { raw: 'python --version', valid: true, expected: 'python --version' },
        { raw: 'powershell rm -rf', valid: false, error: 'destructive' },
        { raw: 'rm -rf /', valid: false, error: 'destructive' },
        { raw: 'npm run lint && rm -rf /', valid: false, error: 'destructive' },
        { raw: '   ', valid: false, error: 'empty' },
        { raw: '""', valid: false, error: 'empty' }
    ];

    for (const t of tests) {
        const norm = policy.normalizeCommand(t.raw);
        const v = policy.validateCommand(norm);
        const pass = (v.ok === t.valid);
        console.log(`  [${t.raw}] -> [${norm}] | Valid: ${v.ok} | Result: ${pass ? 'OK' : 'FAIL'} ${v.error || ''}`);
        if (!pass) process.exit(1);
    }

    // 2. Verify Execution Routing
    const codeControl = new CodeControlService(new MockFileService() as any, new MockTerminalService() as any, policy);

    console.log('Test: CodeControlService execution routing and policy enforcement...');
    try {
        const result: any = await codeControl.shellRun('  npm -v  ');
        console.log(`  npm -v -> ok: ${result.ok}, stdout: ${result.stdout ? 'CAPTURED' : 'EMPTY'}`);
        if (!result.ok) {
            console.log('  FAIL: Execution failed:', result.error);
            process.exit(1);
        }
    } catch (e: any) {
        console.log('  FAIL:', e.message);
        process.exit(1);
    }

    console.log('--- Verification Completed Successfully ---');
}

runVerification().catch(err => {
    console.error('CRITICAL FAIL:', err);
    process.exit(1);
});
