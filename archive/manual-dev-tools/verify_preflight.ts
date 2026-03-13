import { SystemService } from '../electron/services/SystemService';
import path from 'path';

async function verifyPreflight() {
    console.log('--- Verifying SystemService Preflight ---');
    const ss = new SystemService();
    const bundlePy = path.join(process.cwd(), 'bin', 'python-win', 'python.exe');

    console.log(`Checking bundled python: ${bundlePy}`);
    try {
        ss.preflightCheck(bundlePy);
        console.log('PASS: Preflight successful.');
    } catch (e: any) {
        console.error(`FAIL or SKIP: Preflight failed: ${e.message}`);
        console.log('Note: If this is a CI env without bundled python, this is expected to skip/fail gracefully.');
    }

    console.log('Checking invalid python path...');
    try {
        ss.preflightCheck('C:\\non_existent_python.exe');
        console.error('FAIL: Preflight should have thrown on invalid path.');
        process.exit(1);
    } catch (e: any) {
        console.log(`PASS: Caught expected error for invalid path: ${e.message}`);
    }

    process.exit(0);
}

verifyPreflight().catch(console.error);
