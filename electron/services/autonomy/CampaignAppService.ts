/**
 * CampaignAppService.ts — Phase 5.5 P5.5H
 *
 * IPC handler registry for the repair campaign layer.
 *
 * Follows the AutonomyAppService / ExecutionAppService pattern exactly:
 * - All handlers registered in registerIpcHandlers().
 * - All calls wrapped in executeWithTelemetry() for uniform error logging.
 *
 * IPC namespace: campaign:*
 *
 * Handlers:
 *   campaign:getDashboardState     — CampaignDashboardState
 *   campaign:listCampaigns         — RepairCampaign[]
 *   campaign:getCampaign           — RepairCampaign | null
 *   campaign:listOutcomes          — CampaignOutcomeSummary[]
 *   campaign:deferCampaign         — { deferred: true }
 *   campaign:abortCampaign         — { aborted: true }
 *   campaign:resumeCampaign        — { resumed: true }
 */

import { ipcMain } from 'electron';
import type { RepairCampaignId } from '../../../shared/repairCampaignTypes';
import type { RepairCampaignCoordinator } from './campaigns/RepairCampaignCoordinator';
import type { RepairCampaignRegistry } from './campaigns/RepairCampaignRegistry';
import type { CampaignOutcomeTracker } from './campaigns/CampaignOutcomeTracker';
import { telemetry } from '../TelemetryService';

// ─── CampaignAppService ───────────────────────────────────────────────────────

export class CampaignAppService {
    constructor(
        private readonly coordinator: RepairCampaignCoordinator,
        private readonly registry: RepairCampaignRegistry,
        private readonly outcomeTracker: CampaignOutcomeTracker,
    ) {
        this.registerIpcHandlers();
    }

    // ── IPC logging helper ──────────────────────────────────────────────────────

    private logIpc(method: string, args?: unknown): void {
        console.log(`[CampaignAppService] 🛠️ IPC Invoke: ${method}`, args ?? '');
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
                'CampaignAppService',
                `Successfully executed ${methodName} in ${elapsed}ms`,
            );
            return result;
        } catch (error: any) {
            console.error(`[CampaignAppService] 🔴 IPC Error in ${methodName}:`, error);
            telemetry.operational(
                'autonomy',
                'operational',
                'error',
                'CampaignAppService',
                `Failed during ${methodName}: ${error.message}`,
            );
            throw error;
        }
    }

    // ── IPC handlers ────────────────────────────────────────────────────────────

    private registerIpcHandlers(): void {

        // ── campaign:getDashboardState ──────────────────────────────────────────
        ipcMain.handle('campaign:getDashboardState', () =>
            this.executeWithTelemetry('getDashboardState', async () =>
                this.coordinator.getDashboardState(),
            ),
        );

        // ── campaign:listCampaigns ──────────────────────────────────────────────
        ipcMain.handle('campaign:listCampaigns', () =>
            this.executeWithTelemetry('listCampaigns', async () =>
                this.registry.getAll(),
            ),
        );

        // ── campaign:getCampaign ────────────────────────────────────────────────
        ipcMain.handle('campaign:getCampaign', (_, campaignId: RepairCampaignId) =>
            this.executeWithTelemetry('getCampaign', async () =>
                this.registry.getById(campaignId),
            ),
        );

        // ── campaign:listOutcomes ───────────────────────────────────────────────
        ipcMain.handle('campaign:listOutcomes', (_, windowMs?: number) =>
            this.executeWithTelemetry('listOutcomes', async () =>
                this.outcomeTracker.listOutcomes(windowMs),
            ),
        );

        // ── campaign:deferCampaign ──────────────────────────────────────────────
        ipcMain.handle('campaign:deferCampaign', (_, campaignId: RepairCampaignId) =>
            this.executeWithTelemetry('deferCampaign', async () => {
                const deferred = this.coordinator.deferCampaign(campaignId, 'Deferred by operator via dashboard');
                return { deferred };
            }),
        );

        // ── campaign:abortCampaign ──────────────────────────────────────────────
        ipcMain.handle('campaign:abortCampaign', (_, campaignId: RepairCampaignId) =>
            this.executeWithTelemetry('abortCampaign', async () => {
                const aborted = this.coordinator.abortCampaign(campaignId, 'Aborted by operator via dashboard');
                return { aborted };
            }),
        );

        // ── campaign:resumeCampaign ─────────────────────────────────────────────
        ipcMain.handle('campaign:resumeCampaign', (_, campaignId: RepairCampaignId) =>
            this.executeWithTelemetry('resumeCampaign', async () => {
                const resumed = this.coordinator.resumeCampaign(campaignId);
                return { resumed };
            }),
        );
    }
}
