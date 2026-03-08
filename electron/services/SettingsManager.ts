import path from 'path';
import fs from 'fs';
import { app } from 'electron';

/**
 * SettingsManager
 * 
 * Centralized, safe settings loader and writer for `app_settings.json`.
 * Implements a 2000ms in-memory cache to reduce redundant disk I/O,
 * especially from rapid UI polling or multiple service initializations.
 */

// Module-level cache to collapse bursts of identical reads (e.g. from UI polling)
let settingsCache: Record<string, any> | null = null;
let lastCacheUpdate: number = 0;
const CACHE_TTL_MS = 2000;

function invalidateCache() {
    settingsCache = null;
    lastCacheUpdate = 0;
}

/** Minimal default settings — enough to boot without errors. */
export const DEFAULT_SETTINGS: Record<string, any> = {
    deploymentMode: 'local',
    inference: {
        mode: 'hybrid',
        activeLocalId: '',
        activeCloudId: '',
        instances: []
    },
    storage: {
        activeProviderId: 'local-chroma',
        providers: [],
        mode: 'local'
    },
    backup: {
        enabled: false,
        intervalHours: 24,
        localPath: ''
    },
    auth: {
        localMethod: 'none',
        keys: {}
    },
    server: {
        localRuntime: 'node'
    },
    agent: {
        activeProfileId: 'tala',
        profiles: [{
            id: 'tala',
            name: 'Tala',
            systemPrompt: 'You are Tala, an advanced autonomous agent.\n\nHEARTBEAT RULES:\n- The heartbeat runs silently in the background; do not narrate it step-by-step in the chat.\n- Heartbeat output is written to artifacts (JSON/MD) and surfaced only as concise UI cards or a short summary when the user opens ReflectionPanel.\n- Any external access (browser/search) must be an explicit tool call; no “I clicked…” narration.\n- If tools are not configured, record “tool unavailable” and proceed with local evidence only.\n- Never interrupt the user mid-task; heartbeat should defer to quiet hours or “user active” state.',
            temperature: 0.7,
            astroBirthDate: '2024-01-01T12:00:00',
            astroBirthPlace: 'San Francisco',
            rules: { global: '', workspace: '' },
            memory: { globalPath: '', workspacePath: '' },
            mcp: { global: [], workspace: [] }
        }, {
            id: 'assist',
            name: 'Assist',
            systemPrompt: 'You are the Tala Assist Module, a sterile, high-precision technical interface.\n\n[CORE PROTOCOLS]:\n1. NO ROLEPLAY: Suppress all prose, metaphors, scene descriptions, and "poetic" framing.\n2. TOOL-FIRST: Prioritize tool use for verification and diagnostic accuracy.\n3. CONCISE: Provide sterile, information-dense responses. Use bullet points for diagnostics.\n4. ASTRO-AWARE: Incorporate [ASTRO_STATE] as a technical data vector, not an emotional mood.\n5. MEMORY-GATED: Use context from [MEMORIES] as factual reference data only.',
            temperature: 0.1,
            astroBirthDate: '2024-01-01T12:00:00',
            astroBirthPlace: 'San Francisco',
            rules: { global: '', workspace: '' },
            memory: { globalPath: '', workspacePath: '' },
            mcp: { global: [], workspace: [] }
        }]
    },
    sourceControl: {
        providers: []
    },
    system: {
        env: {}
    },
    mcpServers: [],
    guardrails: [],
    search: {
        activeProviderId: 'default-google',
        providers: [
            { id: 'default-google', name: 'Google Search', type: 'google', enabled: false },
            { id: 'default-brave', name: 'Brave Search', type: 'brave', enabled: false }
        ]
    },
    workflows: {},
    reflection: {
        enabled: true,
        heartbeatMinutes: 60,
        quietHours: { start: '00:00', end: '06:00' },
        autoApplyRiskLevel: 3, // Low (1-3)
        retentionDays: 30,
        maxProposalsPerDay: 5
    },
    agentModes: {
        activeMode: 'assistant',
        modes: {
            rp: {
                rpIntensity: 0.8,
                loreDensity: 0.6,
                allowMemoryRecall: true,
                allowAstro: true
            },
            hybrid: {
                blendRatio: 0.5,
                noTaskAcknowledgements: false,
                allowRag: true,
                allowMem0Search: true,
                allowAstro: true,
                allowFsRead: true,
                allowFsWrite: 'confirm',
                allowShellRun: false
            },
            assistant: {
                verbosity: 'normal',
                autoUseTools: true,
                safeMode: true,
                memoryWrites: true,
                toolsOnlyCodingTurns: true,
                ollamaTimeoutMs: 600000
            }
        }
    },
    notebooks: [],
    firewall: {
        enabled: true,
        sensitivity: 0.5,
        targetPatterns: ["sk-", "ant-api-", "[0-9a-f]{32,}", "AIza", "xoxp-", "xoxb-"],
        replacementText: "[REDACTED BY QUANTUM FIREWALL]",
        logRedactions: true
    }
};

/** Deep merges two objects. */
export function deepMerge(target: any, source: any): any {
    const output = { ...target };
    if (typeof target === 'object' && target !== null && typeof source === 'object' && source !== null) {
        Object.keys(source).forEach(key => {
            if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
                if (!(key in target)) {
                    output[key] = source[key];
                } else {
                    output[key] = deepMerge(target[key], source[key]);
                }
            } else {
                output[key] = source[key];
            }
        });
    }
    return output;
}

/**
 * Loads settings from disk with full safety:
 * 1. If file doesn't exist → returns a deep copy of DEFAULT_SETTINGS.
 * 2. If JSON parse fails → backs up corrupt file as `.bak`, returns defaults.
 * 3. If parsed object is missing required keys → merges with defaults.
 * 
 * @param settingsPath - Absolute path to `app_settings.json`.
 * @returns A valid settings object, guaranteed to have all top-level keys.
 */
export function loadSettings(settingsPath: string): Record<string, any> {
    const now = Date.now();
    if (settingsCache && (now - lastCacheUpdate) < CACHE_TTL_MS) {
        return JSON.parse(JSON.stringify(settingsCache)); // Return deep copy to prevent mutation
    }

    const defaults = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

    if (!fs.existsSync(settingsPath)) {
        console.log('[SettingsManager] No settings file found, using defaults.');
        settingsCache = defaults;
        lastCacheUpdate = now;
        return defaults;
    }

    try {
        const raw = fs.readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('Settings file is not a JSON object');
        }

        // Deep merge with defaults to fill missing keys at any level
        const result = deepMerge(defaults, parsed);

        // Update cache
        settingsCache = result;
        lastCacheUpdate = now;

        if (result.agentModes?.activeMode) {
            console.log(`[SettingsManager] loadSettings activeMode=${result.agentModes.activeMode} source=disk`);
        }
        return JSON.parse(JSON.stringify(result));

    } catch (e: any) {
        console.error(`[SettingsManager] Failed to parse settings: ${e.message}`);

        // Backup the corrupt file
        try {
            const backupPath = settingsPath + '.bak';
            fs.copyFileSync(settingsPath, backupPath);
            console.log(`[SettingsManager] Corrupt file backed up to ${backupPath}`);
        } catch (backupErr) {
            console.error('[SettingsManager] Could not backup corrupt file.');
        }

        return defaults;
    }
}

/**
 * Writes settings to disk atomically.
 * 
 * Writes to a `.tmp` file first, then renames to the target path.
 * This prevents partial writes from corrupting the settings file if
 * the process is killed mid-write.
 * 
 * @param settingsPath - Absolute path to `app_settings.json`.
 * @param data - The settings object to persist.
 * @returns `true` on success, `false` on failure.
 */
export function saveSettings(settingsPath: string, data: Record<string, any>): boolean {
    try {
        const tmpPath = settingsPath + '.tmp';
        const json = JSON.stringify(data, null, 2);

        if (data.agentModes?.activeMode) {
            console.log(`[SettingsManager] save activeMode=${data.agentModes.activeMode}`);
        }

        fs.writeFileSync(tmpPath, json, 'utf-8');
        fs.renameSync(tmpPath, settingsPath);

        // Update cache after successful write
        settingsCache = JSON.parse(json);
        lastCacheUpdate = Date.now();

        return true;
    } catch (e: any) {
        console.error(`[SettingsManager] Failed to save settings: ${e.message}`);
        // Fallback: try direct write if rename fails (e.g., cross-device)
        try {
            fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
            return true;
        } catch (e2) {
            console.error('[SettingsManager] Direct write also failed.');
            return false;
        }
    }
}
/**
 * Authoritatively sets the active mode in settings.
 */
export function setActiveMode(settingsPath: string, mode: 'rp' | 'hybrid' | 'assistant'): boolean {
    console.log(`[SettingsManager] setActiveMode called with=${mode}`);
    const validModes = ['rp', 'hybrid', 'assistant'];
    if (!validModes.includes(mode)) {
        console.error(`[SettingsManager] REJECTED invalid mode: ${mode}`);
        return false;
    }

    const s = loadSettings(settingsPath);
    if (!s.agentModes) s.agentModes = { activeMode: 'assistant', modes: {} };
    s.agentModes.activeMode = mode;

    console.log(`[SettingsManager] writing activeMode=${mode} path=${settingsPath}`);
    const success = saveSettings(settingsPath, s);

    // Verification read
    const verify = loadSettings(settingsPath);
    console.log(`[SettingsManager] verify after write activeMode=${verify.agentModes?.activeMode}`);

    return success;
}

/**
 * Authoritatively gets the active mode. Uses cache if within TTL.
 */
export function getActiveMode(settingsPath: string, caller: string = 'unknown'): string {
    const now = Date.now();
    if (settingsCache && (now - lastCacheUpdate) < CACHE_TTL_MS) {
        const mode = settingsCache.agentModes?.activeMode || 'assistant';
        console.log(`[SettingsManager] getActiveMode caller=${caller} source=cache value=${mode}`);
        return mode;
    }

    const s = loadSettings(settingsPath);
    const mode = s.agentModes?.activeMode || 'assistant';
    console.log(`[SettingsManager] getActiveMode caller=${caller} source=disk value=${mode}`);
    return mode;
}
