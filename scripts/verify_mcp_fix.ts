import { McpService } from '../electron/services/McpService';
import { CodeControlService } from '../electron/services/CodeControlService';
import { CodeAccessPolicy } from '../electron/services/CodeAccessPolicy';
import { FileService } from '../electron/services/FileService';
import { TerminalService } from '../electron/services/TerminalService';
import { SystemService } from '../electron/services/SystemService';
import path from 'path';

async function runVerification() {
    console.log('--- Starting MCP Fix Verification ---');

    const systemService = new SystemService();
    const mcp = new McpService(systemService);
    const bundlePy = path.join(process.cwd(), 'bin', 'python-win', 'python.exe');
    mcp.setPythonPath(bundlePy);

    // 1. Verify CodeControlService blank command rejection
    const policy = new CodeAccessPolicy({ workspaceRoot: process.cwd() });
    const fileService = new FileService();
    const terminalService = new TerminalService();
    const codeControl = new CodeControlService(fileService as any, terminalService as any, policy);

    console.log('Test: Rejection of empty command...');
    try {
        await codeControl.shellRun('   ');
        console.log('FAIL: Empty command was not rejected');
    } catch (e: any) {
        console.log('PASS: Rejection of empty command:', e.message === 'Command cannot be empty' ? 'OK' : 'FAIL', e.message);
    }

    // 2. Verify Preflight Check
    console.log('Test: Preflight check on bundled python...');
    try {
        systemService.preflightCheck(bundlePy);
        console.log('Result: PASS');
    } catch (e: any) {
        console.log('Result: FAIL (Expected if bundlePy missing, but check ran):', e.message);
    }

    // 3. Verify Path Resolution
    console.log('Test: Shared Path Resolution...');
    const resolvedPath = systemService.resolveMcpPythonPath({}, { pythonPath: bundlePy } as any);
    console.log('Resolved Path:', resolvedPath === bundlePy ? 'PASS' : 'FAIL', resolvedPath);

    console.log('--- Verification Completed ---');
}

runVerification().catch(console.error);
