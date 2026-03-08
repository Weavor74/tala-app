import fs from 'fs';
import path from 'path';
import os from 'os';

// Mocking loadSettings and settings structure for verification
const settingsPath = path.join(os.homedir(), 'AppData', 'Roaming', 'tala-app', 'app_settings.json');

function verifySettings() {
    console.log(`Checking settings at: ${settingsPath}`);
    if (!fs.existsSync(settingsPath)) {
        console.error("Settings file not found!");
        return;
    }

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

    // Check Phase 1: Schema
    if (!settings.agentModes) {
        console.error("FAILED: agentModes key missing in settings.");
    } else {
        console.log("PASSED: agentModes key exists.");
        console.log(`Active Mode: ${settings.agentModes.activeMode}`);
    }

    // Check Phase 1: Default Configs
    const modes = ['rp', 'hybrid', 'assistant'];
    modes.forEach(mode => {
        if (settings.agentModes.modes[mode]) {
            console.log(`PASSED: Config found for mode: ${mode}`);
        } else {
            console.error(`FAILED: Config missing for mode: ${mode}`);
        }
    });

    // Verification of specific default values
    if (settings.agentModes.modes.assistant.toolsOnlyCodingTurns === true) {
        console.log("PASSED: Default assistant config correct (toolsOnlyCodingTurns: true)");
    } else {
        console.error("FAILED: Default assistant config mismatch.");
    }
}

verifySettings();
