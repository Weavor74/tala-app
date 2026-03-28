/**
 * ExecutionAppService.ts — Phase 3 P3I
 *
 * IPC handler registry for the controlled execution layer.
 *
 * Follows the ReflectionAppService pattern exactly:
 * - All handlers registered in registerIpcHandlers().
 * - All calls wrapped in executeWithTelemetry() for uniform error logging.
 *
 * IPC namespace: execution:*
 *
 * Handlers:
 *   execution:startRun               — start a controlled execution
 *   execution:startDryRun            — start a dry-run (zero mutations)
 *   execution:getRunStatus           — get run record by ID
 *   execution:listRuns               — list recent runs
 *   execution:abortRun               — abort an active run
 *   execution:getAuditLog            — read per-run audit JSONL
 *   execution:getDashboardState      — full dashboard KPIs + active run
 *   execution:recordManualCheck      — record a manual verification check
 *   execution:listPromotedProposals  — list proposals ready for execution
 */

import { ipcMain } from 'electron';
import type {
    ExecutionStartRequest,
    ExecutionAbortRequest,
} from '../../../shared/executionTypes';
import type { SafeChangeProposal } from '../../../shared/reflectionPlanTypes';
import { ExecutionOrchestrator } from './ExecutionOrchestrator';
import { telemetry } from '../TelemetryService';

// ─── ExecutionAppService ──────────────────────────────────────────────────────

export class ExecutionAppService {
    constructor(private readonly orchestrator: ExecutionOrchestrator) {
        this.registerIpcHandlers();
    }

    // ── IPC logging helper (mirrors ReflectionAppService) ──────────────────────

    private logIpc(method: string, args?: unknown): void {
        console.log(`[ExecutionAppService] 🟢 IPC Invoke: ${method}`, args ?? '');
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
                'execution',
                `execution.ipc.${methodName}.success`,
                'debug',
                'ExecutionAppService',
                `Successfully executed ${methodName} in ${elapsed}ms`,
            );
            return result;
        } catch (error: any) {
            console.error(`[ExecutionAppService] 🔴 IPC Error in ${methodName}:`, error);
            telemetry.operational(
                'execution',
                `execution.ipc.${methodName}.error`,
                'error',
                'ExecutionAppService',
                `Failed during ${methodName}: ${error.message}`,
            );
            throw error;
        }
    }

    // ── IPC handlers ────────────────────────────────────────────────────────────

    private registerIpcHandlers(): void {
        ipcMain.handle('execution:startRun', (_, request: ExecutionStartRequest) =>
            this.executeWithTelemetry('startRun', () =>
                this.orchestrator.start({ ...request, dryRun: false }),
            ),
        );

        ipcMain.handle('execution:startDryRun', (_, request: ExecutionStartRequest) =>
            this.executeWithTelemetry('startDryRun', () =>
                this.orchestrator.start({ ...request, dryRun: true }),
            ),
        );

        ipcMain.handle('execution:getRunStatus', (_, executionId: string) =>
            this.executeWithTelemetry('getRunStatus', async () => {
                const execution = this.orchestrator.getRunStatus(executionId);
                return { execution, found: execution !== null };
            }),
        );

        ipcMain.handle('execution:listRuns', (_, windowMs?: number) =>
            this.executeWithTelemetry('listRuns', async () => {
                const executions = this.orchestrator.listRecentRuns(windowMs);
                return { executions, total: executions.length };
            }),
        );

        ipcMain.handle('execution:abortRun', (_, request: ExecutionAbortRequest) =>
            this.executeWithTelemetry('abortRun', async () => {
                const aborted = this.orchestrator.abortRun(request.executionId, request.reason);
                return { aborted };
            }),
        );

        ipcMain.handle('execution:getAuditLog', (_, executionId: string) =>
            this.executeWithTelemetry('getAuditLog', async () =>
                this.orchestrator.getAuditLog(executionId),
            ),
        );

        ipcMain.handle('execution:getDashboardState', (_, promotedProposalsReady?: number) =>
            this.executeWithTelemetry('getDashboardState', async () =>
                this.orchestrator.getDashboardState(promotedProposalsReady ?? 0),
            ),
        );

        ipcMain.handle(
            'execution:recordManualCheck',
            (_, executionId: string, passed: boolean, notes?: string) =>
                this.executeWithTelemetry('recordManualCheck', async () => {
                    const recorded = this.orchestrator.recordManualCheck(executionId, passed, notes);
                    return { recorded };
                }),
        );
    }
}
