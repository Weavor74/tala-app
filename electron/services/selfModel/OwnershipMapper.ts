/**
 * OwnershipMapper.ts — Component Ownership Map
 *
 * Phase 1 Self-Model Foundation
 *
 * Provides a static mapping from known Tala subsystems to their ownership
 * entries, describing which component owns each subsystem, its layer, and
 * its primary source file.
 */

import type { OwnershipEntry, ComponentLayer } from '../../../shared/selfModelTypes';

export class OwnershipMapper {
    private static readonly OWNERSHIP_MAP: OwnershipEntry[] = [
        {
            componentId: 'agent-service',
            subsystem: 'AgentService',
            layer: 'main',
            primaryFile: 'electron/services/AgentService.ts',
        },
        {
            componentId: 'inference-service',
            subsystem: 'InferenceService',
            layer: 'main',
            primaryFile: 'electron/services/InferenceService.ts',
        },
        {
            componentId: 'memory-service',
            subsystem: 'MemoryService',
            layer: 'main',
            primaryFile: 'electron/services/MemoryService.ts',
        },
        {
            componentId: 'reflection-service',
            subsystem: 'ReflectionService',
            layer: 'main',
            primaryFile: 'electron/services/reflection/ReflectionService.ts',
        },
        {
            componentId: 'self-maintenance-service',
            subsystem: 'SelfMaintenanceService',
            layer: 'main',
            primaryFile: 'electron/services/SelfMaintenanceService.ts',
        },
        {
            componentId: 'soul-service',
            subsystem: 'SoulService',
            layer: 'main',
            primaryFile: 'electron/services/soul/SoulService.ts',
        },
        {
            componentId: 'ipc-router',
            subsystem: 'IpcRouter',
            layer: 'main',
            primaryFile: 'electron/services/IpcRouter.ts',
        },
        {
            componentId: 'mcp-service',
            subsystem: 'McpService',
            layer: 'main',
            primaryFile: 'electron/services/McpService.ts',
        },
        {
            componentId: 'telemetry-service',
            subsystem: 'TelemetryService',
            layer: 'shared',
            primaryFile: 'electron/services/TelemetryService.ts',
        },
        {
            componentId: 'settings-manager',
            subsystem: 'SettingsManager',
            layer: 'main',
            primaryFile: 'electron/services/SettingsManager.ts',
        },
    ];

    getAll(): OwnershipEntry[] {
        return OwnershipMapper.OWNERSHIP_MAP;
    }

    getBySubsystem(subsystem: string): OwnershipEntry[] {
        return OwnershipMapper.OWNERSHIP_MAP.filter(e => e.subsystem === subsystem);
    }
}
