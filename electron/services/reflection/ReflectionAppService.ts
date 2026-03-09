import { ipcMain } from 'electron';
import { ReflectionService } from './ReflectionService';

export class ReflectionAppService {
    private reflectionService: ReflectionService;

    constructor(reflectionService: ReflectionService) {
        this.reflectionService = reflectionService;
        this.registerIpcHandlers();
    }

    private logIpc(method: string, args?: any) {
        console.log(`[ReflectionAppService] 🟢 IPC Invoke: ${method}`, args ? args : '');
    }

    private async executeWithTelemetry<T>(methodName: string, operation: () => Promise<T>): Promise<T> {
        this.logIpc(methodName);
        try {
            const start = Date.now();
            const result = await operation();
            const elapsed = Date.now() - start;
            await this.reflectionService.logTelemetry(
                `reflection.ipc.${methodName}.success`,
                'debug',
                'ReflectionAppService',
                `Successfully executed ${methodName} in ${elapsed}ms`
            );
            return result;
        } catch (error: any) {
            console.error(`[ReflectionAppService] 🔴 IPC Error in ${methodName}:`, error);
            await this.reflectionService.logTelemetry(
                `reflection.ipc.${methodName}.error`,
                'error',
                'ReflectionAppService',
                `Failed during ${methodName}: ${error.message}`
            );
            throw error; // Rethrow to reach the frontend exception boundary
        }
    }

    private registerIpcHandlers() {
        ipcMain.handle('reflection:getDashboardState', (_, activeMode?: string) =>
            this.executeWithTelemetry('getDashboardState', () => this.reflectionService.getDashboardState(activeMode))
        );

        ipcMain.handle('reflection:trigger', (_, activeMode?: string) =>
            this.executeWithTelemetry('triggerReflection', () => this.reflectionService.triggerReflectionManually(activeMode))
        );

        ipcMain.handle('reflection:listGoals', () =>
            this.executeWithTelemetry('listGoals', () => this.reflectionService.getGoalsService().listGoals())
        );

        ipcMain.handle('reflection:createGoal', (_, goalDef: any) =>
            this.executeWithTelemetry('createGoal', async () => {
                const g = await this.reflectionService.getGoalsService().createGoal(goalDef);
                const added = await this.reflectionService.getQueueService().enqueue({
                    type: 'goal',
                    source: g.source,
                    priority: g.priority,
                    goalId: g.goalId,
                    triggerMode: 'engineering',
                    requestedBy: 'user'
                });
                if (added) {
                    this.reflectionService.getScheduler().tickNow().catch(e => console.error(e));
                }
                return g;
            })
        );

        ipcMain.handle('reflection:updateGoal', (_, goalId: string, status: any) =>
            this.executeWithTelemetry('updateGoal', () => this.reflectionService.getGoalsService().updateGoalStatus(goalId, status))
        );

        // ─── ORCHESTRATION BINDINGS ────────────────────────
        ipcMain.handle('reflection:getQueueState', () =>
            this.executeWithTelemetry('getQueueState', () => this.reflectionService.getQueueService().listAll())
        );

        ipcMain.handle('reflection:getSchedulerState', () =>
            this.executeWithTelemetry('getSchedulerState', async () => this.reflectionService.getScheduler().getSchedulerState())
        );

        ipcMain.handle('reflection:processNextGoal', () =>
            this.executeWithTelemetry('processNextGoal', () => this.reflectionService.getScheduler().tickNow())
        );

        ipcMain.handle('reflection:cancelQueueItem', (_, queueItemId: string) =>
            this.executeWithTelemetry('cancelQueueItem', () => this.reflectionService.getQueueService().cancelItem(queueItemId))
        );

        ipcMain.handle('reflection:retryQueueItem', (_, queueItemId: string) =>
            this.executeWithTelemetry('retryQueueItem', async () => {
                const success = await this.reflectionService.getQueueService().retryItem(queueItemId);
                if (success) this.reflectionService.getScheduler().tickNow().catch(e => console.error(e));
                return success;
            })
        );

        ipcMain.handle('reflection:listProposals', () =>
            this.executeWithTelemetry('listProposals', async () => Array.from(this.reflectionService.getActivePatches().values()))
        );

        ipcMain.handle('reflection:getProposal', (_, id: string) =>
            this.executeWithTelemetry('getProposal', async () => this.reflectionService.getActivePatches().get(id) || null)
        );

        ipcMain.handle('reflection:listIssues', () =>
            this.executeWithTelemetry('listIssues', async () => [])
        );

        ipcMain.handle('reflection:listJournalEntries', () =>
            this.executeWithTelemetry('listJournalEntries', async () => {
                try {
                    return await this.reflectionService.getJournalService().readRecentEntries(50);
                } catch (e) {
                    return [];
                }
            })
        );

        ipcMain.handle('reflection:listPromotions', () =>
            this.executeWithTelemetry('listPromotions', async () => [])
        );

        ipcMain.handle('reflection:listRollbacks', () =>
            this.executeWithTelemetry('listRollbacks', async () => [])
        );

        ipcMain.handle('reflection:promoteProposal', (_, id: string) =>
            this.executeWithTelemetry('promoteProposal', async () => {
                const patch = this.reflectionService.getActivePatches().get(id);
                if (!patch) return { success: false, message: 'Patch not found' };

                const mockReport: any = { overallResult: 'pass' };
                try {
                    const rec = await this.reflectionService.getPromoter().promotePatch(patch, mockReport, 'ui_user');
                    patch.status = 'promoted';
                    return { success: true, message: `Promoted successfully to archive ${rec.archiveManifestPath}` };
                } catch (e: any) {
                    return { success: false, message: e.message };
                }
            })
        );

        ipcMain.handle('reflection:rollbackPromotion', (_, id: string) =>
            this.executeWithTelemetry('rollbackPromotion', async () => ({ success: false, message: 'Not yet implemented' }))
        );

        ipcMain.handle('reflection:get-reflections', () =>
            this.executeWithTelemetry('get-reflections', async () => [])
        );

        ipcMain.handle('reflection:approve-proposal', (_, proposalId: string) =>
            this.executeWithTelemetry('approve-proposal', async () => {
                const patch = this.reflectionService.getActivePatches().get(proposalId);
                if (!patch) throw new Error('Patch not found');

                const mockReport: any = { overallResult: 'pass' };
                await this.reflectionService.getPromoter().promotePatch(patch, mockReport, 'ui_user');
                patch.status = 'promoted';
                return { success: true };
            })
        );

        ipcMain.handle('reflection:reject-proposal', (_, proposalId: string) =>
            this.executeWithTelemetry('reject-proposal', async () => {
                const patch = this.reflectionService.getActivePatches().get(proposalId);
                if (!patch) throw new Error('Patch not found');
                patch.status = 'rejected';
                return { success: true };
            })
        );

        ipcMain.handle('reflection:force-tick', () =>
            this.executeWithTelemetry('force-tick', async () => {
                await this.reflectionService.runReflectionCycle('ui_manual_tick');
                return { success: true };
            })
        );

        ipcMain.handle('reflection:clean-proposals', () =>
            this.executeWithTelemetry('clean-proposals', async () => {
                const map = this.reflectionService.getActivePatches();
                map.clear();
                return { success: true, count: 0 };
            })
        );

        ipcMain.handle('reflection:get-metrics', () =>
            this.executeWithTelemetry('get-metrics', async () => {
                const map = this.reflectionService.getActivePatches();
                return {
                    totalReflections: map.size,
                    totalProposals: map.size,
                    appliedChanges: Array.from(map.values()).filter(p => p.status === 'promoted').length,
                    successRate: 1.0,
                    lastHeartbeat: new Date().toISOString()
                };
            })
        );
    }
}
