import path from 'path';
import fs from 'fs';
import { app } from 'electron';

/**
 * High-Integrity Settings Management Engine.
 * 
 * The `SettingsManager` provides atomic, cached, and deep-merged I/O for the 
 * application's `app_settings.json` file. It ensures that the system always 
 * has a valid configuration, even in the event of disk corruption or 
 * partial writes.
 * 
 * **Key Features:**
 * - **Atomic Writes**: Uses a `.tmp` swap strategy to prevent file corruption.
 * - **Burst-Resistant Cache**: Implements a short-TTL memory cache to collapse 
 *   redundant reads from the UI or concurrent services.
 * - **Deep Schema Merging**: Automatically fills missing keys with system 
 *   defaults during load.
 * - **Auto-Recovery**: Detects JSON corruption, backs up the damaged file to 
 *   `.bak`, and restores factory defaults.
 */

// Module-level cache to collapse bursts of identical reads (e.g. from UI polling).
// TTL governs full-settings consumers (loadSettings). getActiveMode uses presence-only
// check because mode is only mutated via setActiveMode, which always refreshes the cache.
let settingsCache: Record<string, any> | null = null;
let lastCacheUpdate: number = 0;
const CACHE_TTL_MS = 30000; // 30 s – reduces steady-state disk reads from every 2 s to every 30 s

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
        preferredProviderId: 'auto',
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
    },
    promptAudit: {
        enabled: true,
        level: 'summary',
        logToConsole: true,
        logToFile: true,
        previewChars: 1200,
        maxFullInlineChars: 12000
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
 * Securely loads the application configuration.
 * 
 * **Load Sequence:**
 * 1. **Cache Check**: Returns a deep copy from memory if within TTL.
 * 2. **Disk Read**: Synchronously reads the JSON file.
 * 3. **Validation**: verifies the top-level structure.
 * 4. **Merge**: Deep-merges disk values over `DEFAULT_SETTINGS` to ensure 
 *    newly-added schema keys are present.
 * 5. **Error Recovery**: Transparently handles corruption by reverting to defaults.
 * 
 * @param settingsPath - The absolute filesystem path to the settings file.
 * @returns A guaranteed-valid settings object.
 */
export function loadSettings(settingsPath: string, caller: string = 'unknown'): Record<string, any> {
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
 * Atomically persists the application configuration.
 * 
 * **Write Strategy:**
 * To prevent partial-write corruption, this method writes to a temporary file 
 * and then performs an atomic rename. If the rename fails (e.g., across 
 * partitions), it falls back to a direct write with a retry.
 * 
 * @param settingsPath - Target absolute path to `app_settings.json`.
 * @param data - The configuration object to save.
 * @returns `true` if saved successfully.
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

    // Verification read – uses cache (saveSettings just refreshed it) so no extra disk I/O.
    const verifiedMode = getActiveMode(settingsPath, 'setActiveMode.verify');
    console.log(`[SettingsManager] verify after write activeMode=${verifiedMode}`);

    return success;
}

/**
 * Authoritatively gets the active mode.
 *
 * Uses a presence-only cache check: because the only mutation path is
 * `setActiveMode → saveSettings`, which always refreshes `settingsCache`,
 * TTL-based invalidation is unnecessary for mode reads and generates log
 * spam on every UI poll.  A first-call lazy load from disk is still performed
 * when the cache is cold (startup, or after explicit `invalidateCache()`).
 */
export function getActiveMode(settingsPath: string, caller: string = 'unknown'): string {
    // If cache is populated, read it directly – mode cannot change without
    // going through setActiveMode which keeps the cache up to date.
    if (settingsCache) {
        return settingsCache.agentModes?.activeMode || 'assistant';
    }

    // Cold cache – load from disk once, which will warm the cache.
    const s = loadSettings(settingsPath, caller);
    const mode = s.agentModes?.activeMode || 'assistant';
    console.log(`[SettingsManager] getActiveMode caller=${caller} source=disk value=${mode}`);
    return mode;
}

/**
 * Forces a full reload from disk, bypassing the TTL cache.
 *
 * Use this only when an external process may have modified `app_settings.json`
 * and you need the latest values immediately (e.g. an explicit IPC refresh
 * command or a file-watch callback).  Normal steady-state reads should use
 * `getActiveMode()` or `loadSettings()` instead.
 */
export function refreshSettingsFromDisk(settingsPath: string, caller: string = 'unknown'): Record<string, any> {
    invalidateCache();
    console.log(`[SettingsManager] refreshSettingsFromDisk caller=${caller}`);
    return loadSettings(settingsPath, caller);
}
