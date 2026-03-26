/**
 * SelfModelScanner.ts — Component Inventory Scanner
 *
 * Phase 1 Self-Model Foundation
 *
 * Returns a curated inventory of known Tala components. This is a lightweight
 * static scanner that describes the main subsystems without runtime introspection.
 * Future phases can add dynamic filesystem scanning.
 */

import type { SelfModelComponent } from '../../../shared/selfModelTypes';

export class SelfModelScanner {
    private static readonly KNOWN_COMPONENTS: SelfModelComponent[] = [
        {
            id: 'agent-service',
            label: 'Agent Service',
            layer: 'main',
            responsibilities: [
                'Orchestrates turn-level inference pipeline',
                'Assembles context for each turn',
                'Routes mode selection (assistant/hybrid/RP)',
                'Coordinates memory, tools, and reflection hooks',
            ],
            ownedBy: 'AgentService',
            path: 'electron/services/AgentService.ts',
        },
        {
            id: 'inference-service',
            label: 'Inference Service',
            layer: 'main',
            responsibilities: [
                'Manages provider registry and fallback ordering',
                'Executes local and remote inference requests',
                'Reports provider health and degradation state',
                'Handles streaming token delivery',
            ],
            ownedBy: 'InferenceService',
            path: 'electron/services/InferenceService.ts',
        },
        {
            id: 'memory-service',
            label: 'Memory Service',
            layer: 'main',
            responsibilities: [
                'Persists and retrieves conversation memory',
                'Manages short-term and long-term memory stores',
                'Scores memory salience and access frequency',
                'Handles habit reinforcement patterns',
            ],
            ownedBy: 'MemoryService',
            path: 'electron/services/MemoryService.ts',
        },
        {
            id: 'reflection-service',
            label: 'Reflection Service',
            layer: 'main',
            responsibilities: [
                'Runs periodic reflection pipeline cycles',
                'Manages goal queue and proposal generation',
                'Writes journal entries and telemetry events',
                'Schedules and executes reflection workers',
            ],
            ownedBy: 'ReflectionService',
            path: 'electron/services/reflection/ReflectionService.ts',
        },
        {
            id: 'soul-service',
            label: 'Soul & Identity Service',
            layer: 'main',
            responsibilities: [
                'Maintains Tala core identity state and values',
                'Evaluates decisions against ethical frameworks',
                'Generates narrative continuity logs',
                'Manages behavioral boundary enforcement',
            ],
            ownedBy: 'SoulService',
            path: 'electron/services/soul/SoulService.ts',
        },
        {
            id: 'maintenance-service',
            label: 'Self-Maintenance Service',
            layer: 'main',
            responsibilities: [
                'Detects runtime degradation and provider failures',
                'Evaluates maintenance policy decisions',
                'Executes safe auto-recovery actions',
                'Reports diagnostics and active issues',
            ],
            ownedBy: 'SelfMaintenanceService',
            path: 'electron/services/SelfMaintenanceService.ts',
        },
        {
            id: 'mcp-service',
            label: 'MCP Tool Service',
            layer: 'main',
            responsibilities: [
                'Manages MCP server lifecycle and registration',
                'Routes tool invocation requests to correct server',
                'Enforces capability gating per active mode',
                'Reports tool availability and health',
            ],
            ownedBy: 'McpService',
            path: 'electron/services/McpService.ts',
        },
        {
            id: 'ipc-router',
            label: 'IPC Router',
            layer: 'main',
            responsibilities: [
                'Central registry for all ipcMain.handle channels',
                'Enforces IPC channel uniqueness invariant',
                'Provides diagnostic listing of all registered channels',
            ],
            ownedBy: 'IpcRouter',
            path: 'electron/services/IpcRouter.ts',
        },
        {
            id: 'preload-bridge',
            label: 'Preload Context Bridge',
            layer: 'renderer',
            responsibilities: [
                'Exposes whitelisted IPC functions to renderer via window.tala',
                'Enforces contextBridge security boundary',
                'Prevents raw ipcRenderer exposure',
            ],
            ownedBy: 'preload',
            path: 'electron/preload.ts',
        },
        {
            id: 'settings-manager',
            label: 'Settings Manager',
            layer: 'main',
            responsibilities: [
                'Reads and writes application and workspace settings',
                'Merges global and workspace-scoped configuration',
                'Validates settings schema on load',
            ],
            ownedBy: 'SettingsManager',
            path: 'electron/services/SettingsManager.ts',
        },
    ];

    scan(): SelfModelComponent[] {
        return SelfModelScanner.KNOWN_COMPONENTS;
    }
}
