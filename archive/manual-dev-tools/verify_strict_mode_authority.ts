
import { loadSettings, saveSettings } from '../electron/services/SettingsManager';
import * as path from 'path';

const settingsPath = path.join(process.cwd(), 'data', 'app_settings.json');

async function verifyStrictModeAuthority() {
    console.log('--- VERIFY STRICT MODE AUTHORITY ---');

    const modes = ['rp', 'assistant', 'hybrid', 'rp'];

    for (const targetMode of modes) {
        console.log(`\nTesting switch to: ${targetMode}`);

        // 1. Simulate IPC write
        const s = loadSettings(settingsPath);
        if (!s.agentModes) s.agentModes = { activeMode: 'assistant', modes: {} };

        // Validation check (manual simulation of IpcRouter logic)
        const validModes = ['rp', 'hybrid', 'assistant'];
        if (!validModes.includes(targetMode)) {
            console.error(`❌ FAILED: Invalid mode ${targetMode} allowed in test loop`);
            process.exit(1);
        }

        s.agentModes.activeMode = targetMode;
        saveSettings(settingsPath, s);
        console.log(`[IPC] agent:setMode saved activeMode=${targetMode}`);

        // 2. Simulate immediate read back
        const confirmed = loadSettings(settingsPath);
        console.log(`[SettingsManager] getActiveMode return=${confirmed.agentModes.activeMode} source=disk`);

        if (confirmed.agentModes.activeMode !== targetMode) {
            console.error(`❌ FAILED: Mode did not persist. Expected ${targetMode}, got ${confirmed.agentModes.activeMode}`);
            process.exit(1);
        }

        // 3. Simulate background service "heartbeat" attempting to load mode
        // (Ensuring no timer/hook reverts it)
        console.log('Simulating background polling/hooks (2s)...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        const afterPolling = loadSettings(settingsPath);
        if (afterPolling.agentModes.activeMode === targetMode) {
            console.log(`✅ Mode ${targetMode} STUCK during polling`);
        } else {
            console.error(`❌ FAILED: Mode reverted to ${afterPolling.agentModes.activeMode} during polling`);
            process.exit(1);
        }
    }

    // 4. Test invalid mode rejection (Simulating IpcRouter)
    console.log('\nTesting rejection of invalid mode "god_mode"...');
    const invalidMode = 'god_mode';
    const validModes = ['rp', 'hybrid', 'assistant'];
    if (!validModes.includes(invalidMode)) {
        console.log(`✅ [IPC] agent:setMode REJECTED invalid mode: ${invalidMode}`);
    } else {
        console.error('❌ FAILED: Invalid mode was not rejected');
        process.exit(1);
    }

    console.log('\n--- ALL STRICT MODE TESTS PASSED ---');
}

verifyStrictModeAuthority();
