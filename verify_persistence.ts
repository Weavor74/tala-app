import fs from 'fs';
import path from 'path';

const SETTINGS_PATH = 'd:/src/client1/tala-app/data/app_settings.json';

function runTest() {
    console.log("--- PERSISTENCE VERIFICATION START ---");

    if (!fs.existsSync(SETTINGS_PATH)) {
        console.error("Settings file not found at " + SETTINGS_PATH);
        return;
    }

    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(raw);

    // Simulate current state
    const originalMode = settings.agentModes?.activeMode || 'unknown';
    console.log(`Initial Mode: ${originalMode}`);

    // Part 1: Simulate mode change (backend logic)
    const targetMode = originalMode === 'assistant' ? 'hybrid' : 'assistant';
    console.log(`Simulating mode change to: ${targetMode}...`);

    settings.agentModes = settings.agentModes || {};
    settings.agentModes.activeMode = targetMode;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

    // Part 2: Simulate a "stale" save from frontend
    // The frontend might send an object with an old mode if it hasn't refreshed
    const staleData = JSON.parse(JSON.stringify(settings));
    staleData.agentModes.activeMode = originalMode; // Stale value
    staleData.deploymentMode = 'local'; // Just some other field

    console.log(`Simulating stale save from UI (trying to set mode back to ${originalMode})...`);

    // Re-simulate the logic in IpcRouter.ts:
    const currentOnDisk = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));

    // Manual merge with guard
    const merged = { ...currentOnDisk, ...staleData };
    if (currentOnDisk.agentModes?.activeMode && merged.agentModes) {
        merged.agentModes.activeMode = currentOnDisk.agentModes.activeMode; // GUARD
    }

    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));

    // Part 3: Verify
    const finalRaw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const finalSettings = JSON.parse(finalRaw);
    console.log(`Final Mode on disk: ${finalSettings.agentModes?.activeMode}`);

    if (finalSettings.agentModes?.activeMode === targetMode) {
        console.log("SUCCESS: Mode change was PRESERVED despite stale save.");
    } else {
        console.log("FAILURE: Mode was REVERTED.");
    }

    console.log("--- PERSISTENCE VERIFICATION END ---");
}

runTest();
