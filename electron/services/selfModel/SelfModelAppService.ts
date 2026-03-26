/**
 * SelfModelAppService — Phase 1G
 *
 * IPC registration for the self-model surface.
 * Follows the exact pattern of ReflectionAppService.ts:
 * - Uses ipcMain.handle()
 * - All handlers wrapped with executeWithTelemetry()
 * - Registered in the constructor via registerIpcHandlers()
 *
 * IPC channels (namespace: selfModel:):
 *   selfModel:getMeta          — returns SelfModelMeta
 *   selfModel:getIndex         — returns SystemInventoryIndex (or null)
 *   selfModel:getOwnershipMap  — returns OwnershipMap (or null)
 *   selfModel:getInvariants    — returns InvariantRegistry data
 *   selfModel:getCapabilities  — returns CapabilityRegistry data
 *   selfModel:refresh          — triggers refresh, returns SelfModelMeta
 *   selfModel:checkStaleness   — returns SelfModelHealthStatus string
 *   selfModel:queryOwnership   — accepts { target: string }, returns OwnershipQueryResult
 *   selfModel:queryInvariants  — accepts { subsystemId: string }, returns InvariantRecord[]
 *   selfModel:queryBlastRadius — accepts { target: string }, returns BlastRadiusResult
 *   selfModel:explainOwnership — accepts { target: string }, returns string
 *
 * NOTE: This file is registered in IPC_REGISTRATION_FILES in
 * electron/__tests__/IpcChannelUniqueness.test.ts.
 */

import { ipcMain } from 'electron';
import { telemetry } from '../TelemetryService';
import type { SelfModelRefreshService } from './SelfModelRefreshService';

export class SelfModelAppService {
    private readonly refresh: SelfModelRefreshService;

    constructor(refreshService: SelfModelRefreshService) {
        this.refresh = refreshService;
    }

    public registerIpcHandlers(): void {
        // ─── Meta / status ──────────────────────────────────────────────────────

        ipcMain.handle('selfModel:getMeta', () =>
            this._exec('getMeta', () => Promise.resolve(this.refresh.getLastMeta()))
        );

        ipcMain.handle('selfModel:checkStaleness', () =>
            this._exec('checkStaleness', () => Promise.resolve(this.refresh.checkStaleness()))
        );

        // ─── Artifact read ──────────────────────────────────────────────────────

        ipcMain.handle('selfModel:getIndex', () =>
            this._exec('getIndex', () => Promise.resolve(this.refresh.getLastIndex()))
        );

        ipcMain.handle('selfModel:getOwnershipMap', () =>
            this._exec('getOwnershipMap', () => Promise.resolve(this.refresh.getLastOwnershipMap()))
        );

        ipcMain.handle('selfModel:getInvariants', () =>
            this._exec('getInvariants', () => Promise.resolve(this.refresh.getInvariantRegistry().getData()))
        );

        ipcMain.handle('selfModel:getCapabilities', () =>
            this._exec('getCapabilities', () => Promise.resolve(this.refresh.getCapabilityRegistry().getData()))
        );

        // ─── Refresh ────────────────────────────────────────────────────────────

        ipcMain.handle('selfModel:refresh', (_event, force?: boolean) =>
            this._exec('refresh', () => this.refresh.refresh(force ?? false))
        );

        // ─── Queries ────────────────────────────────────────────────────────────

        ipcMain.handle('selfModel:queryOwnership', (_event, args: { target: string }) =>
            this._exec('queryOwnership', async () => {
                const qs = this.refresh.getQueryService();
                if (!qs) return { error: 'Query service not initialized' };
                const result = qs.findOwningSubsystem(args?.target ?? '');
                telemetry.debug('self_model', 'self_model_query_executed', 'SelfModelAppService', `Ownership query: ${args?.target}`);
                return result;
            })
        );

        ipcMain.handle('selfModel:queryInvariants', (_event, args: { subsystemId: string }) =>
            this._exec('queryInvariants', async () => {
                const qs = this.refresh.getQueryService();
                if (!qs) return [];
                const result = qs.getInvariantsForSubsystem(args?.subsystemId ?? '');
                telemetry.debug('self_model', 'self_model_query_executed', 'SelfModelAppService', `Invariants query: ${args?.subsystemId}`);
                return result;
            })
        );

        ipcMain.handle('selfModel:queryBlastRadius', (_event, args: { target: string }) =>
            this._exec('queryBlastRadius', async () => {
                const qs = this.refresh.getQueryService();
                if (!qs) return { error: 'Query service not initialized' };
                const result = qs.explainBlastRadius(args?.target ?? '');
                telemetry.debug('self_model', 'self_model_query_executed', 'SelfModelAppService', `Blast radius query: ${args?.target}`);
                return result;
            })
        );

        ipcMain.handle('selfModel:explainOwnership', (_event, args: { target: string }) =>
            this._exec('explainOwnership', async () => {
                const qs = this.refresh.getQueryService();
                if (!qs) return 'Query service not initialized';
                const result = qs.explainOwnership(args?.target ?? '');
                telemetry.debug('self_model', 'self_model_query_executed', 'SelfModelAppService', `Explain ownership: ${args?.target}`);
                return result;
            })
        );
    }

    // ─── Execution wrapper ─────────────────────────────────────────────────────

    private async _exec<T>(methodName: string, operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[SelfModelAppService] IPC error in ${methodName}:`, msg);
            telemetry.operational(
                'self_model',
                'self_model_refresh_failed',
                'error',
                'SelfModelAppService',
                `IPC ${methodName} failed: ${msg}`,
                'failure',
            );
            throw error;
        }
    }
}
