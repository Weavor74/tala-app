
import { loadSettings, saveSettings } from '../electron/services/SettingsManager';
import * as path from 'path';

const settingsPath = path.join(process.cwd(), 'data', 'app_settings.json');

async function verifyModeSticks() {
    console.log('--- VERIFY RP MODE STICKS ---');

    // 1. Set to RP
    const s = loadSettings(settingsPath);
    if (!s.agentModes) s.agentModes = { activeMode: 'assistant', modes: {} };
    s.agentModes.activeMode = 'rp';
    saveSettings(settingsPath, s);
    console.log('Mode set to rp');

    // 2. Simulate background polling (normally 5s or 10s)
    console.log('Waiting 2 seconds to simulate background polling...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 3. Trigger a "health loop" style reload
    console.log('Triggering settings reload...');
    const reloaded = loadSettings(settingsPath);

    if (reloaded.agentModes.activeMode === 'rp') {
        console.log('✅ SUCCESS: Mode remained rp after polling simulation');
    } else {
        console.error('❌ FAILED: Mode reverted to', reloaded.agentModes.activeMode);
        process.exit(1);
    }
}

verifyModeSticks();
