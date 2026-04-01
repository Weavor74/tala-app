/**
 * StrategyRoutingAppService.ts — Phase 6.1 IPC App Service
 *
 * Registers IPC handlers for the strategyRouting:* namespace.
 *
 * Follows the CrossSystemAppService / CampaignAppService pattern exactly:
 * - All handlers registered in registerIpcHandlers().
 * - All calls wrapped in executeWithTelemetry() for uniform error logging.
 *
 * IPC namespace: strategyRouting:*
 *
 * Handlers:
 *   strategyRouting:getDashboardState  — StrategyRoutingDashboardState
 *   strategyRouting:listDecisions      — StrategyRoutingDecision[]
 *   strategyRouting:getDecision        — StrategyRoutingDecision | null
 *   strategyRouting:listOutcomes       — StrategyRoutingOutcomeRecord[]
 */

import { ipcMain } from 'electron';
import type { StrategyRoutingEngine } from './crossSystem/StrategyRoutingEngine';
import type { StrategyRoutingOutcomeTracker } from './crossSystem/StrategyRoutingOutcomeTracker';
import type { StrategyRoutingDecisionId } from '../../../shared/strategyRoutingTypes';
import { telemetry } from '../TelemetryService';

// ─── StrategyRoutingAppService ────────────────────────────────────────────────

export class StrategyRoutingAppService {
    constructor(
        private readonly engine: StrategyRoutingEngine,
        private readonly outcomeTracker: StrategyRoutingOutcomeTracker,
    ) {
        this.registerIpcHandlers();
    }

    // ── IPC logging helper ────────────────────────────────────────────────────

    private logIpc(method: string, args?: unknown): void {
        console.log(`[StrategyRoutingAppService] 🔀 IPC Invoke: ${method}`, args ?? '');
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
                'StrategyRoutingAppService',
                `Successfully executed ${methodName} in ${elapsed}ms`,
            );
            return result;
        } catch (error: any) {
            console.error(`[StrategyRoutingAppService] 🔴 IPC Error in ${methodName}:`, error);
            telemetry.operational(
                'autonomy',
                'operational',
                'error',
                'StrategyRoutingAppService',
                `Failed during ${methodName}: ${error.message}`,
            );
            throw error;
        }
    }

    // ── IPC handlers ──────────────────────────────────────────────────────────

    private registerIpcHandlers(): void {

        // ── strategyRouting:getDashboardState ─────────────────────────────────
        ipcMain.handle('strategyRouting:getDashboardState', () =>
            this.executeWithTelemetry('getDashboardState', async () =>
                this.engine.getDashboardState(),
            ),
        );

        // ── strategyRouting:listDecisions ─────────────────────────────────────
        ipcMain.handle('strategyRouting:listDecisions', () =>
            this.executeWithTelemetry('listDecisions', async () =>
                this.engine.listDecisions(),
            ),
        );

        // ── strategyRouting:getDecision ───────────────────────────────────────
        ipcMain.handle('strategyRouting:getDecision', (_, id: StrategyRoutingDecisionId) =>
            this.executeWithTelemetry('getDecision', async () =>
                this.engine.getDecision(id),
            ),
        );

        // ── strategyRouting:listOutcomes ──────────────────────────────────────
        ipcMain.handle('strategyRouting:listOutcomes', () =>
            this.executeWithTelemetry('listOutcomes', async () =>
                this.outcomeTracker.listOutcomes(),
            ),
        );
    }
}
