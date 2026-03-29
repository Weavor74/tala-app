/**
 * AutonomyAppService.ts — Phase 4 P4G
 *
 * IPC handler registry for the autonomous self-improvement layer.
 *
 * Follows the ExecutionAppService / GovernanceAppService pattern exactly:
 * - All handlers registered in registerIpcHandlers().
 * - All calls wrapped in executeWithTelemetry() for uniform error logging.
 *
 * IPC namespace: autonomy:*
 *
 * Handlers:
 *   autonomy:getDashboardState     — full AutonomyDashboardState
 *   autonomy:listGoals             — AutonomousGoal[]
 *   autonomy:getGoal               — AutonomousGoal | null
 *   autonomy:listRuns              — AutonomousRun[]
 *   autonomy:getRun                — AutonomousRun | null
 *   autonomy:runCycleOnce          — trigger manual detection cycle
 *   autonomy:setGlobalEnabled      — enable/disable autonomy globally
 *   autonomy:getPolicy             — AutonomyPolicy
 *   autonomy:updatePolicy          — update autonomy policy
 *   autonomy:getAuditLog           — AutonomyAuditRecord[] for a goal
 *   autonomy:getLearningRecords    — LearningRecord[]
 *   autonomy:clearCooldown         — operator override to clear cooldown
 *   autonomy:checkPendingRuns      — check for governance-resolved pending runs
 */

import { ipcMain } from 'electron';
import type { AutonomyPolicy } from '../../../shared/autonomyTypes';
import { AutonomousRunOrchestrator } from './AutonomousRunOrchestrator';
import { telemetry } from '../TelemetryService';

// ─── AutonomyAppService ───────────────────────────────────────────────────────

export class AutonomyAppService {
    constructor(private readonly orchestrator: AutonomousRunOrchestrator) {
        this.registerIpcHandlers();
    }

    // ── IPC logging helper ──────────────────────────────────────────────────────

    private logIpc(method: string, args?: unknown): void {
        console.log(`[AutonomyAppService] 🤖 IPC Invoke: ${method}`, args ?? '');
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
                'AutonomyAppService',
                `Successfully executed ${methodName} in ${elapsed}ms`,
            );
            return result;
        } catch (error: any) {
            console.error(`[AutonomyAppService] 🔴 IPC Error in ${methodName}:`, error);
            telemetry.operational(
                'autonomy',
                'operational',
                'error',
                'AutonomyAppService',
                `Failed during ${methodName}: ${error.message}`,
            );
            throw error;
        }
    }

    // ── IPC handlers ────────────────────────────────────────────────────────────

    private registerIpcHandlers(): void {

        // ── autonomy:getDashboardState ──────────────────────────────────────────
        ipcMain.handle('autonomy:getDashboardState', () =>
            this.executeWithTelemetry('getDashboardState', async () =>
                this.orchestrator.getDashboardState(),
            ),
        );

        // ── autonomy:listGoals ──────────────────────────────────────────────────
        ipcMain.handle('autonomy:listGoals', () =>
            this.executeWithTelemetry('listGoals', async () =>
                this.orchestrator.listGoals(),
            ),
        );

        // ── autonomy:getGoal ────────────────────────────────────────────────────
        ipcMain.handle('autonomy:getGoal', (_, goalId: string) =>
            this.executeWithTelemetry('getGoal', async () =>
                this.orchestrator.getGoal(goalId),
            ),
        );

        // ── autonomy:listRuns ───────────────────────────────────────────────────
        ipcMain.handle('autonomy:listRuns', (_, windowMs?: number) =>
            this.executeWithTelemetry('listRuns', async () =>
                this.orchestrator.listRuns(windowMs),
            ),
        );

        // ── autonomy:getRun ─────────────────────────────────────────────────────
        ipcMain.handle('autonomy:getRun', (_, runId: string) =>
            this.executeWithTelemetry('getRun', async () =>
                this.orchestrator.getRun(runId),
            ),
        );

        // ── autonomy:runCycleOnce ───────────────────────────────────────────────
        ipcMain.handle('autonomy:runCycleOnce', () =>
            this.executeWithTelemetry('runCycleOnce', async () => {
                await this.orchestrator.runCycleOnce();
                return { triggered: true };
            }),
        );

        // ── autonomy:setGlobalEnabled ───────────────────────────────────────────
        ipcMain.handle('autonomy:setGlobalEnabled', (_, enabled: boolean) =>
            this.executeWithTelemetry('setGlobalEnabled', async () => {
                this.orchestrator.setGlobalEnabled(enabled);
                return { enabled };
            }),
        );

        // ── autonomy:getPolicy ──────────────────────────────────────────────────
        ipcMain.handle('autonomy:getPolicy', () =>
            this.executeWithTelemetry('getPolicy', async () =>
                this.orchestrator.getPolicy(),
            ),
        );

        // ── autonomy:updatePolicy ───────────────────────────────────────────────
        ipcMain.handle('autonomy:updatePolicy', (_, policy: AutonomyPolicy) =>
            this.executeWithTelemetry('updatePolicy', async () => {
                this.orchestrator.updatePolicy(policy);
                return { updated: true };
            }),
        );

        // ── autonomy:getAuditLog ────────────────────────────────────────────────
        ipcMain.handle('autonomy:getAuditLog', (_, goalId: string) =>
            this.executeWithTelemetry('getAuditLog', async () =>
                this.orchestrator.getAuditLog(goalId),
            ),
        );

        // ── autonomy:getLearningRecords ─────────────────────────────────────────
        ipcMain.handle('autonomy:getLearningRecords', () =>
            this.executeWithTelemetry('getLearningRecords', async () =>
                this.orchestrator.learningRegistry.listAll(),
            ),
        );

        // ── autonomy:clearCooldown ──────────────────────────────────────────────
        ipcMain.handle('autonomy:clearCooldown',
            (_, subsystemId: string, patternKey: string) =>
                this.executeWithTelemetry('clearCooldown', async () => {
                    const cleared = this.orchestrator.clearCooldown(subsystemId, patternKey);
                    return { cleared };
                }),
        );

        // ── autonomy:checkPendingRuns ───────────────────────────────────────────
        ipcMain.handle('autonomy:checkPendingRuns', () =>
            this.executeWithTelemetry('checkPendingRuns', async () => {
                await this.orchestrator.checkPendingGovernanceRuns();
                return { checked: true };
            }),
        );

        // ── autonomy:getRecoveryPackDashboardState ─────────────────────────────
        // Phase 4.3 P4.3G: Returns the full recovery pack dashboard state.
        // Returns null when the recovery pack layer is not active.
        ipcMain.handle('autonomy:getRecoveryPackDashboardState', () =>
            this.executeWithTelemetry('getRecoveryPackDashboardState', async () =>
                this.orchestrator.getRecoveryPackDashboardState(),
            ),
        );
    }
}
