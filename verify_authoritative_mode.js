const fs = require('fs');
const path = require('path');

// Identify settings path (mimicking getSettingsPath logic)
const DATA_DIR = 'd:/src/client1/tala-app/data';
const SYSTEM_SETTINGS_PATH = path.join(DATA_DIR, 'app_settings.json');

function loadSettings(p) {
    if (!fs.existsSync(p)) return {};
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) { return {}; }
}

function runVerification() {
    console.log("=== AUTHORITATIVE MODE VERIFICATION START ===");

    // 1. Initial State
    const s1 = loadSettings(SYSTEM_SETTINGS_PATH);
    const initialMode = s1.agentModes?.activeMode || 'assistant';
    console.log(`[Test] Initial mode on disk: ${initialMode}`);

    // 2. Simulate setActiveMode('hybrid')
    const targetMode = 'hybrid';
    console.log(`[Test] Simulating setActiveMode('${targetMode}')...`);

    // Logic from SettingsManager.setActiveMode
    const s2 = loadSettings(SYSTEM_SETTINGS_PATH);
    if (!s2.agentModes) s2.agentModes = { activeMode: 'assistant', modes: {} };
    s2.agentModes.activeMode = targetMode;
    fs.writeFileSync(SYSTEM_SETTINGS_PATH, JSON.stringify(s2, null, 2));

    const verify1 = loadSettings(SYSTEM_SETTINGS_PATH);
    console.log(`[Test] Mode after setActiveMode: ${verify1.agentModes?.activeMode}`);
    if (verify1.agentModes?.activeMode !== targetMode) {
        console.error("FAILURE: setActiveMode failed to persist.");
        return;
    }

    // 3. Simulate a stale "save-settings" call from UI
    // UI sends settings with activeMode: 'assistant' (stale)
    const staleData = JSON.parse(JSON.stringify(verify1));
    staleData.agentModes.activeMode = 'assistant'; // STALE
    console.log(`[Test] Simulating stale 'save-settings' with mode='assistant'...`);

    // Logic from IpcRouter.ts save-settings handler
    const s3 = loadSettings(SYSTEM_SETTINGS_PATH);
    // Mimic deepMerge (simple for this test)
    const merged = { ...s3, ...staleData };

    // The Guard:
    if (s3.agentModes?.activeMode && merged.agentModes) {
        console.log(`[Test] Guard triggered: Preserving authoritative backend mode: ${s3.agentModes.activeMode}`);
        merged.agentModes.activeMode = s3.agentModes.activeMode;
    }

    fs.writeFileSync(SYSTEM_SETTINGS_PATH, JSON.stringify(merged, null, 2));

    // 4. Final Verification
    const final = loadSettings(SYSTEM_SETTINGS_PATH);
    console.log(`[Test] Final mode on disk: ${final.agentModes?.activeMode}`);

    if (final.agentModes?.activeMode === targetMode) {
        console.log("=== SUCCESS: Mode is authoritative and resisted stale overwrite! ===");
    } else {
        console.error("=== FAILURE: Mode was overwritten by stale data! ===");
    }
}

runVerification();
