
import fs from 'fs';
import path from 'path';
import { loadSettings, saveSettings } from './electron/services/SettingsManager';

const settingsPath = path.join(process.env.APPDATA || '', 'tala-app', 'app_settings.json');

console.log('--- BACKEND MODE PERSISTENCE VERIFICATION ---');
console.log('Settings Path:', settingsPath);

// 1. Initial State
let settings = loadSettings(settingsPath);
console.log('Initial activeMode:', settings.agentModes?.activeMode);

// 2. Simulate Mode Change
const testMode = 'hybrid';
console.log('Setting mode to:', testMode);
if (!settings.agentModes) settings.agentModes = { activeMode: 'assistant', modes: {} };
settings.agentModes.activeMode = testMode;
saveSettings(settingsPath, settings);

// 3. Verify on disk
const raw = fs.readFileSync(settingsPath, 'utf-8');
const parsed = JSON.parse(raw);
console.log('Mode on disk:', parsed.agentModes?.activeMode);

// 4. Verify via loadSettings
const reloaded = loadSettings(settingsPath);
console.log('Reloaded activeMode:', reloaded.agentModes?.activeMode);

if (reloaded.agentModes?.activeMode === testMode) {
    console.log('SUCCESS: Backend persistence is working correctly.');
} else {
    console.log('FAILURE: Backend persistence failed.');
}
