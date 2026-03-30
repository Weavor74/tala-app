/**
 * CrossSystemAppService.ts — Phase 6 IPC App Service
 *
 * Registers IPC handlers for the crossSystem:* namespace.
 *
 * Follows the CampaignAppService / AutonomyAppService pattern exactly:
 * - All handlers registered in registerIpcHandlers().
 * - All calls wrapped in executeWithTelemetry() for uniform error logging.
 *
 * IPC namespace: crossSystem:*
 *
 * Handlers:
 *   crossSystem:getDashboardState   — CrossSystemDashboardState
 *   crossSystem:getClusters         — IncidentCluster[]
 *   crossSystem:getCluster          — IncidentCluster | null
 *   crossSystem:getRootCauses       — RootCauseHypothesis[]
 *   crossSystem:getRecentDecisions  — StrategyDecisionRecord[]
 *   crossSystem:recordOutcome       — { recorded: true } (outcomeId, clusterId, succeeded, notes)
 */

import { ipcMain } from 'electron';
import type { ClusterId } from '../../../shared/crossSystemTypes';
import type { CrossSystemCoordinator } from './crossSystem/CrossSystemCoordinator';
import { telemetry } from '../TelemetryService';

// ─── CrossSystemAppService ────────────────────────────────────────────────────

export class CrossSystemAppService {
    constructor(private readonly coordinator: CrossSystemCoordinator) {
        this.registerIpcHandlers();
    }

    // ── IPC logging helper ──────────────────────────────────────────────────────

    private logIpc(method: string, args?: unknown): void {
        console.log(`[CrossSystemAppService] 🔬 IPC Invoke: ${method}`, args ?? '');
    }

    private async executeWithTelemetry<T>(
        methodName: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        this.logIpc(methodName);
        try {
            const start = Date.now();
            const result = await operation();
            const elapsed = Date.now() - start;
            telemetry.operational(
                'autonomy',
                'operational',
                'debug',
                'CrossSystemAppService',
                `Successfully executed ${methodName} in ${elapsed}ms`,
            );
            return result;
        } catch (error: any) {
            console.error(`[CrossSystemAppService] 🔴 IPC Error in ${methodName}:`, error);
            telemetry.operational(
                'autonomy',
                'operational',
                'error',
                'CrossSystemAppService',
                `Failed during ${methodName}: ${error.message}`,
            );
            throw error;
        }
    }

    // ── IPC handlers ────────────────────────────────────────────────────────────

    private registerIpcHandlers(): void {

        // ── crossSystem:getDashboardState ───────────────────────────────────────
        ipcMain.handle('crossSystem:getDashboardState', () =>
            this.executeWithTelemetry('getDashboardState', async () =>
                this.coordinator.getDashboardState(),
            ),
        );

        // ── crossSystem:getClusters ─────────────────────────────────────────────
        ipcMain.handle('crossSystem:getClusters', () =>
            this.executeWithTelemetry('getClusters', async () =>
                this.coordinator.getOpenClusters(),
            ),
        );

        // ── crossSystem:getCluster ──────────────────────────────────────────────
        ipcMain.handle('crossSystem:getCluster', (_, clusterId: ClusterId) =>
            this.executeWithTelemetry('getCluster', async () =>
                this.coordinator.getCluster(clusterId),
            ),
        );

        // ── crossSystem:getRootCauses ───────────────────────────────────────────
        ipcMain.handle('crossSystem:getRootCauses', (_, clusterId: ClusterId) =>
            this.executeWithTelemetry('getRootCauses', async () =>
                this.coordinator.getRootCauses(clusterId),
            ),
        );

        // ── crossSystem:getRecentDecisions ──────────────────────────────────────
        ipcMain.handle('crossSystem:getRecentDecisions', (_, windowMs?: number) =>
            this.executeWithTelemetry('getRecentDecisions', async () =>
                this.coordinator.getRecentDecisions(windowMs),
            ),
        );

        // ── crossSystem:recordOutcome ───────────────────────────────────────────
        ipcMain.handle(
            'crossSystem:recordOutcome',
            (_, outcomeId: string, clusterId: string, succeeded: boolean, notes: string) =>
                this.executeWithTelemetry('recordOutcome', async () => {
                    this.coordinator.recordOutcome(outcomeId, clusterId, succeeded, notes);
                    return { recorded: true };
                }),
        );
    }
}
