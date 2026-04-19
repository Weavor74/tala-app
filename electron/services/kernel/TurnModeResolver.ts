import fs from 'fs';
import type { RuntimeExecutionMode } from '../../../shared/runtime/executionTypes';

export type AgentMode = RuntimeExecutionMode | string;

export type TurnModeResolution = {
    resolvedMode: AgentMode;
    source: 'settings_manager' | 'ipc_override' | 'session_state' | 'default_fallback';
    reasonCodes: string[];
    settingsVersion?: number;
    sessionId?: string;
    turnId?: string;
};

export type SettingsManagerLike = {
    settingsPath: string;
    refreshSettingsFromDisk: (settingsPath: string, caller?: string) => Record<string, any>;
};

export type SessionStateLike = {
    getModeForSession?: (sessionId: string) => AgentMode | undefined;
};

const VALID_AGENT_MODES = new Set<string>(['assistant', 'hybrid', 'rp']);

function normalizeMode(mode: unknown): AgentMode | null {
    if (typeof mode !== 'string') return null;
    const normalized = mode.trim().toLowerCase();
    return VALID_AGENT_MODES.has(normalized) ? normalized : null;
}

function readSettingsVersion(settingsPath: string): number | undefined {
    try {
        return Math.trunc(fs.statSync(settingsPath).mtimeMs);
    } catch {
        return undefined;
    }
}

export async function resolveModeForTurn(input: {
    turnId: string;
    sessionId?: string;
    requestedMode?: AgentMode | null;
    settingsManager: SettingsManagerLike;
    sessionState?: SessionStateLike;
}): Promise<TurnModeResolution> {
    const reasonCodes: string[] = [];
    const requestedMode = normalizeMode(input.requestedMode);
    const settingsVersion = readSettingsVersion(input.settingsManager.settingsPath);

    try {
        const settings = input.settingsManager.refreshSettingsFromDisk(
            input.settingsManager.settingsPath,
            'TurnModeResolver.resolveModeForTurn',
        );
        const settingsMode = normalizeMode(settings?.agentModes?.activeMode);
        if (settingsMode) {
            reasonCodes.push('turn_mode.settings_manager_mode_resolved');
            if (requestedMode && requestedMode !== settingsMode) {
                reasonCodes.push('turn_mode.requested_mode_mismatch_ignored');
            }
            return {
                resolvedMode: settingsMode,
                source: 'settings_manager',
                reasonCodes,
                settingsVersion,
                sessionId: input.sessionId,
                turnId: input.turnId,
            };
        }
        reasonCodes.push('turn_mode.settings_mode_missing_or_invalid');
    } catch {
        reasonCodes.push('turn_mode.settings_refresh_failed');
    }

    const sessionMode = input.sessionId
        ? normalizeMode(input.sessionState?.getModeForSession?.(input.sessionId))
        : null;
    if (sessionMode) {
        reasonCodes.push('turn_mode.session_state_fallback_used');
        return {
            resolvedMode: sessionMode,
            source: 'session_state',
            reasonCodes,
            settingsVersion,
            sessionId: input.sessionId,
            turnId: input.turnId,
        };
    }

    if (requestedMode) {
        reasonCodes.push('turn_mode.ipc_override_fallback_used');
        return {
            resolvedMode: requestedMode,
            source: 'ipc_override',
            reasonCodes,
            settingsVersion,
            sessionId: input.sessionId,
            turnId: input.turnId,
        };
    }

    reasonCodes.push('turn_mode.default_fallback_hybrid');
    return {
        resolvedMode: 'hybrid',
        source: 'default_fallback',
        reasonCodes,
        settingsVersion,
        sessionId: input.sessionId,
        turnId: input.turnId,
    };
}

