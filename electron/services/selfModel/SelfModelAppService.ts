/**
 * SelfModelAppService.ts — IPC Handler Registration for Self-Model
 *
 * Phase 1 Self-Model Foundation
 *
 * Registers the 11 selfModel:* IPC handlers that expose the self-model
 * system to the renderer process. Follows the same pattern as
 * ReflectionAppService: constructor-registered handlers with telemetry wrapping.
 */

import { ipcMain } from 'electron';
import { telemetry } from '../TelemetryService';
import type { SelfModelRefreshService } from './SelfModelRefreshService';
import type { SelfModelQueryService } from './SelfModelQueryService';

export class SelfModelAppService {
    constructor(
        private refreshService: SelfModelRefreshService,
        private queryService: SelfModelQueryService,
    ) {
        this.registerIpcHandlers();
    }

    private logIpc(method: string, args?: any) {
        console.log(`[SelfModelAppService] 🟢 IPC Invoke: ${method}`, args !== undefined ? args : '');
    }

    private async executeWithTelemetry<T>(methodName: string, operation: () => Promise<T>): Promise<T> {
        this.logIpc(methodName);
        try {
            const start = Date.now();
            const result = await operation();
            const elapsed = Date.now() - start;
            telemetry.operational(
                'self_model' as any,
                `selfModel.ipc.${methodName}.success` as any,
                'debug',
                'SelfModelAppService',
                `Successfully executed ${methodName} in ${elapsed}ms`,
            );
            return result;
        } catch (error: any) {
            console.error(`[SelfModelAppService] 🔴 IPC Error in ${methodName}:`, error);
            telemetry.operational(
                'self_model' as any,
                `selfModel.ipc.${methodName}.error` as any,
                'error',
                'SelfModelAppService',
                `Failed during ${methodName}: ${error.message}`,
            );
            throw error;
        }
    }

    private registerIpcHandlers() {
        ipcMain.handle('selfModel:init', () =>
            this.executeWithTelemetry('init', () => this.refreshService.init()),
        );

        ipcMain.handle('selfModel:refresh', () =>
            this.executeWithTelemetry('refresh', () => this.refreshService.refresh()),
        );

        ipcMain.handle('selfModel:getRefreshStatus', () =>
            this.executeWithTelemetry('getRefreshStatus', async () => ({
                initialized: this.refreshService.isInitialized(),
                lastResult: this.refreshService.getLastRefreshResult(),
            })),
        );

        ipcMain.handle('selfModel:getSnapshot', () =>
            this.executeWithTelemetry('getSnapshot', async () => this.queryService.getSnapshot()),
        );

        ipcMain.handle('selfModel:getInvariants', (_, filter?: any) =>
            this.executeWithTelemetry('getInvariants', async () => this.queryService.queryInvariants(filter)),
        );

        ipcMain.handle('selfModel:getCapabilities', (_, filter?: any) =>
            this.executeWithTelemetry('getCapabilities', async () => this.queryService.queryCapabilities(filter)),
        );

        ipcMain.handle('selfModel:getArchitectureSummary', () =>
            this.executeWithTelemetry('getArchitectureSummary', async () => this.queryService.getArchitectureSummary()),
        );

        ipcMain.handle('selfModel:getComponents', () =>
            this.executeWithTelemetry('getComponents', async () => this.queryService.getComponents()),
        );

        ipcMain.handle('selfModel:getOwnershipMap', () =>
            this.executeWithTelemetry('getOwnershipMap', async () => this.queryService.getOwnershipMap()),
        );

        ipcMain.handle('selfModel:queryInvariant', (_, filter?: any) =>
            this.executeWithTelemetry('queryInvariant', async () => this.queryService.queryInvariants(filter)),
        );

        ipcMain.handle('selfModel:queryCapability', (_, filter?: any) =>
            this.executeWithTelemetry('queryCapability', async () => this.queryService.queryCapabilities(filter)),
        );
    }
}
