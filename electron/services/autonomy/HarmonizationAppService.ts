/**
 * HarmonizationAppService.ts — Phase 5.6 P5.6F
 *
 * IPC handler registry for the harmonization layer.
 *
 * Follows the CampaignAppService / AutonomyAppService pattern exactly:
 * - All handlers registered in registerIpcHandlers().
 * - All calls wrapped in executeWithTelemetry() for uniform error logging.
 *
 * IPC namespace: harmonization:*
 *
 * Handlers:
 *   harmonization:getDashboardState    — HarmonizationDashboardState
 *   harmonization:listDriftRecords     — HarmonizationDriftRecord[]
 *   harmonization:listCanonRules       — HarmonizationCanonRule[]
 *   harmonization:getCanonRule         — HarmonizationCanonRule | null
 *   harmonization:listCampaigns        — HarmonizationCampaign[]
 *   harmonization:getCampaign          — HarmonizationCampaign | null
 *   harmonization:listOutcomes         — HarmonizationOutcomeRecord[]
 *   harmonization:deferCampaign        — { deferred: true }
 *   harmonization:abortCampaign        — { aborted: true }
 *   harmonization:resumeCampaign       — { resumed: true }
 */

import { ipcMain } from 'electron';
import type { HarmonizationCampaignId, HarmonizationRuleId } from '../../../shared/harmonizationTypes';
import type { HarmonizationCoordinator } from './harmonization/HarmonizationCoordinator';
import type { HarmonizationCanonRegistry } from './harmonization/HarmonizationCanonRegistry';
import type { HarmonizationOutcomeTracker } from './harmonization/HarmonizationOutcomeTracker';
import { telemetry } from '../TelemetryService';

// ─── HarmonizationAppService ──────────────────────────────────────────────────

export class HarmonizationAppService {
    constructor(
        private readonly coordinator: HarmonizationCoordinator,
        private readonly canonRegistry: HarmonizationCanonRegistry,
        private readonly outcomeTracker: HarmonizationOutcomeTracker,
    ) {
        this.registerIpcHandlers();
    }

    // ── IPC logging helper ──────────────────────────────────────────────────────

    private logIpc(method: string, args?: unknown): void {
        console.log(`[HarmonizationAppService] 🔧 IPC Invoke: ${method}`, args ?? '');
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
                'HarmonizationAppService',
                `Successfully executed ${methodName} in ${elapsed}ms`,
            );
            return result;
        } catch (error: any) {
            console.error(`[HarmonizationAppService] 🔴 IPC Error in ${methodName}:`, error);
            telemetry.operational(
                'autonomy',
                'operational',
                'error',
                'HarmonizationAppService',
                `Failed during ${methodName}: ${error.message}`,
            );
            throw error;
        }
    }

    // ── IPC handlers ────────────────────────────────────────────────────────────

    private registerIpcHandlers(): void {

        // ── harmonization:getDashboardState ────────────────────────────────────
        ipcMain.handle('harmonization:getDashboardState', () =>
            this.executeWithTelemetry('getDashboardState', async () =>
                this.coordinator.getDashboardState(),
            ),
        );

        // ── harmonization:listDriftRecords ─────────────────────────────────────
        ipcMain.handle('harmonization:listDriftRecords', () =>
            this.executeWithTelemetry('listDriftRecords', async () =>
                this.coordinator.getAll()
                    .filter(c => c.status === 'draft' || c.status === 'active')
                    .map(c => c.driftId),
            ),
        );

        // ── harmonization:listCanonRules ───────────────────────────────────────
        ipcMain.handle('harmonization:listCanonRules', () =>
            this.executeWithTelemetry('listCanonRules', async () =>
                this.canonRegistry.getAll(),
            ),
        );

        // ── harmonization:getCanonRule ─────────────────────────────────────────
        ipcMain.handle('harmonization:getCanonRule', (_, ruleId: HarmonizationRuleId) =>
            this.executeWithTelemetry('getCanonRule', async () =>
                this.canonRegistry.getById(ruleId),
            ),
        );

        // ── harmonization:listCampaigns ────────────────────────────────────────
        ipcMain.handle('harmonization:listCampaigns', () =>
            this.executeWithTelemetry('listCampaigns', async () =>
                this.coordinator.getAll(),
            ),
        );

        // ── harmonization:getCampaign ──────────────────────────────────────────
        ipcMain.handle('harmonization:getCampaign', (_, campaignId: HarmonizationCampaignId) =>
            this.executeWithTelemetry('getCampaign', async () =>
                this.coordinator.getCampaign(campaignId),
            ),
        );

        // ── harmonization:listOutcomes ─────────────────────────────────────────
        ipcMain.handle('harmonization:listOutcomes', (_, windowMs?: number) =>
            this.executeWithTelemetry('listOutcomes', async () =>
                this.outcomeTracker.listOutcomes(windowMs),
            ),
        );

        // ── harmonization:deferCampaign ────────────────────────────────────────
        ipcMain.handle('harmonization:deferCampaign', (_, campaignId: HarmonizationCampaignId) =>
            this.executeWithTelemetry('deferCampaign', async () => {
                const deferred = this.coordinator.deferCampaign(campaignId, 'Deferred by operator via dashboard');
                return { deferred };
            }),
        );

        // ── harmonization:abortCampaign ────────────────────────────────────────
        ipcMain.handle('harmonization:abortCampaign', (_, campaignId: HarmonizationCampaignId) =>
            this.executeWithTelemetry('abortCampaign', async () => {
                const aborted = this.coordinator.abortCampaign(campaignId, 'Aborted by operator via dashboard');
                return { aborted };
            }),
        );

        // ── harmonization:resumeCampaign ───────────────────────────────────────
        ipcMain.handle('harmonization:resumeCampaign', (_, campaignId: HarmonizationCampaignId) =>
            this.executeWithTelemetry('resumeCampaign', async () => {
                const resumed = this.coordinator.resumeCampaign(campaignId);
                return { resumed };
            }),
        );
    }
}
