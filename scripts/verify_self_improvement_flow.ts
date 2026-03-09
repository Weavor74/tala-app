import { ReflectionService } from '../electron/services/reflection/ReflectionService';
import * as path from 'path';
import * as fs from 'fs';

async function runVerification() {
    console.log('=== Verifying Tala Self-Improvement Ecosystem ===');

    // We create a dummy workspace to not pollute actual configs
    const testUserData = path.resolve(__dirname, '../data/test_reflection_workspace');
    const rootDir = path.resolve(__dirname, '..'); // project root

    // Ensure test dir exists
    if (!fs.existsSync(testUserData)) {
        fs.mkdirSync(testUserData, { recursive: true });
    }

    // Write a dummy settings file
    const settingsPath = path.join(testUserData, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ reflection: { enabled: true, autoApplyRiskLevel: 10 } }), 'utf8');

    // Create a dummy file that we will modify
    const dummyTargetRelPath = 'scripts/test-target-dummy.txt';
    const dummyTargetAbsPath = path.join(rootDir, dummyTargetRelPath);
    if (!fs.existsSync(path.dirname(dummyTargetAbsPath))) fs.mkdirSync(path.dirname(dummyTargetAbsPath), { recursive: true });
    fs.writeFileSync(dummyTargetAbsPath, 'Old Content Version', 'utf8');

    const reflectionService = new ReflectionService(testUserData, settingsPath, rootDir);

    try {
        console.log('\n--- Test 1: Capability Gating Rejection ---');
        const r1 = await reflectionService.selfModify({
            title: 'Unauthorized Test',
            description: 'Trying to edit from assistant mode',
            changes: [{ path: dummyTargetRelPath, content: 'Hacked Version' }],
            activeMode: 'assistant' // Expected to be blocked by CapabilityGating
        });
        console.log(`Result: ${r1.success ? 'FAIL' : 'PASS'} (Expected rejection. Msg: ${r1.message})`);

        console.log('\n--- Test 2: Full Engineering Modification Pipeline ---');
        const r2 = await reflectionService.selfModify({
            title: 'Authorized Test',
            description: 'Valid engineering patch over a dummy file',
            changes: [{ path: dummyTargetRelPath, content: 'New Auto-Improved Content' }],
            activeMode: 'engineering'
        });
        console.log(`Result: ${r2.success ? 'PASS' : 'FAIL'} (Expected success)`);

        if (r2.success) {
            // Verify live file
            const newContent = fs.readFileSync(dummyTargetAbsPath, 'utf8');
            console.log(`Live File Content Check: ${newContent === 'New Auto-Improved Content' ? 'PASS' : 'FAIL'}`);

            // Verify Manifest Archive Existence
            const archivesDir = path.join(testUserData, 'data/archives/pre_patch');
            const subFolders = fs.readdirSync(archivesDir);
            console.log(`Archives generated: ${subFolders.length > 0 ? 'PASS' : 'FAIL'} (${subFolders[0]})`);

            // Verify Journal Generation
            const journalPath = path.join(testUserData, 'data/reflections/journal/reflection-journal.jsonl');
            const journalExists = fs.existsSync(journalPath);
            console.log(`Journal updated: ${journalExists ? 'PASS' : 'FAIL'}`);
        }

        console.log('\n--- Test 3: Immutable Identity Protection ---');
        const r3 = await reflectionService.selfModify({
            title: 'Identity Attack',
            description: 'Trying to modify restricted node SettingsManager',
            // Setting path that matches 'electron/services/SettingsManager.ts' rule 'PROT-MODE' or 'PROT-IDENTITY'
            changes: [{ path: 'electron/services/SettingsManager.ts', content: 'Destroyed' }],
            activeMode: 'engineering'
        });
        // If the validator or identity check rejects it, it should fail before modifying live
        console.log(`Result: ${r3.success ? 'FAIL' : 'PASS'} (Expected rejection due to Immutable Identity / Validation required: Msg: ${r3.message})`);

    } catch (err: any) {
        console.error('Fatal Test Error: ', err.message);
    } finally {
        // Cleanup dummy target
        if (fs.existsSync(dummyTargetAbsPath)) fs.unlinkSync(dummyTargetAbsPath);
    }
}

runVerification().catch(console.error);
