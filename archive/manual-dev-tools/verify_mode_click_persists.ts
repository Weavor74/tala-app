
import { loadSettings, saveSettings, getSettingsPath } from '../electron/services/SettingsManager';
import * as path from 'path';
import * as fs from 'fs';

// Mock path for settings
const settingsPath = path.join(process.cwd(), 'data', 'app_settings.json');

function verifyModePersistence() {
    console.log('--- VERIFY MODE CLICK PERSISTS ---');

    // 1. Initial State
    const s1 = loadSettings(settingsPath);
    console.log('Initial mode:', s1.agentModes?.activeMode || 'assistant');

    // 2. Set to RP
    console.log('Setting mode to rp...');
    if (!s1.agentModes) s1.agentModes = { activeMode: 'assistant', modes: {} };
    s1.agentModes.activeMode = 'rp';
    saveSettings(settingsPath, s1);

    // 3. Verify immediate reload
    const s2 = loadSettings(settingsPath);
    console.log('Mode after save:', s2.agentModes.activeMode);

    if (s2.agentModes.activeMode !== 'rp') {
        console.error('❌ FAILED: Mode did not persist after save');
        process.exit(1);
    }

    // 4. Simulate a background "refresh" that might overwrite (like loadSettings being called elsewhere)
    console.log('Simulating background read...');
    const s3 = loadSettings(settingsPath);
    if (s3.agentModes.activeMode === 'rp') {
        console.log('✅ SUCCESS: Mode remained rp after background read');
    } else {
        console.error('❌ FAILED: Mode reverted to', s3.agentModes.activeMode);
        process.exit(1);
    }

    console.log('--- VERIFICATION COMPLETE ---');
}

verifyModePersistence();
