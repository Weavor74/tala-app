import { ipcMain, BrowserWindow } from 'electron';
import { ArtifactStore } from './ArtifactStore';
import { HeartbeatEngine } from './HeartbeatEngine';
import { ReflectionEngine } from './ReflectionEngine';
import { ProposalEngine } from './ProposalEngine';
import { RiskEngine } from './RiskEngine';
import { ApplyEngine } from './ApplyEngine';
import { RollbackEngine } from './RollbackEngine';
import { ChangeProposal, ReflectionMetrics } from './types';

import { loadSettings } from '../SettingsManager';

/**
 * ReflectionService
 * 
 * Orchestrates the TALA Reflection System backend. Registers IPC handlers
 * and manages the lifecycle of the Heartbeat and Reflection engines.
 * 
 * **Safe Leash Mode**: When `autoApplyRiskLevel` is 0, ALL proposals
 * require manual user approval via the Reflection Panel UI.
 */
export class ReflectionService {
    private store: ArtifactStore;
    private heartbeat: HeartbeatEngine;
    private reflection: ReflectionEngine;
    private proposals: ProposalEngine;
    private risk: RiskEngine;
    private apply: ApplyEngine;
    private rollback: RollbackEngine;
    private git: any = null;
    private settingsPath: string;
    private isEnabled: boolean;

    constructor(userDataDir: string, settingsPath: string) {
        this.store = new ArtifactStore(userDataDir);
        this.reflection = new ReflectionEngine(this.store);
        this.proposals = new ProposalEngine(settingsPath);
        this.apply = new ApplyEngine(this.store);
        this.rollback = new RollbackEngine(userDataDir);
        this.settingsPath = settingsPath;

        const settings = loadSettings(settingsPath);
        const refSettings = settings.reflection || {};

        this.isEnabled = refSettings.enabled !== false; // Default: enabled
        const autoApplyLevel = refSettings.autoApplyRiskLevel ?? 0; // Default: safe leash (0 = never auto-apply)

        // Pass settings-driven threshold and governance limits to RiskEngine
        const changeBudget = refSettings.changeBudgetPerDay ?? 5;
        this.risk = new RiskEngine(autoApplyLevel, changeBudget, userDataDir);

        // Default heartbeat options (can be overridden by settings)
        this.heartbeat = new HeartbeatEngine({
            intervalMinutes: refSettings.heartbeatMinutes || 60,
            jitterPercent: 15,
            quietHours: refSettings.quietHours
        });

        this.setupHeartbeat();

        console.log(`[ReflectionService] Initialized — enabled: ${this.isEnabled}, autoApplyLevel: ${autoApplyLevel}, changeBudget: ${changeBudget}/day, interval: ${refSettings.heartbeatMinutes || 60}m`);
    }

    private setupHeartbeat() {
        this.heartbeat.on('tick', async () => {
            await this.runReflectionCycle();
        });
    }

    async start() {
        if (!this.isEnabled) {
            console.log('[ReflectionService] Heartbeat DISABLED by settings. Skipping start.');
            return;
        }
        console.log('[ReflectionService] Starting heartbeat on safe leash...');
        this.heartbeat.start();
    }

    async stop() {
        this.heartbeat.stop();
        console.log('[ReflectionService] Heartbeat stopped.');
    }

    /**
     * Injects the GitService dependency.
     */
    public setGitService(git: any) {
        this.git = git;
    }

    /**
     * Direct entry point for the self_modify tool.
     * Proposes a change, creates a branch, applies it, and commits if successful.
     */
    async selfModify(args: {
        title: string,
        description: string,
        changes: any[],
        category?: any,
        riskScore?: number
    }): Promise<{ success: boolean; message: string; proposalId?: string }> {
        if (!this.git) {
            return { success: false, message: 'Git capability not available. Self-modification requires an active Git workspace.' };
        }

        const proposalId = `selffix_${Math.random().toString(36).substring(7)}`;
        const branchName = `tala/self-modify/${proposalId}`;

        try {
            console.log(`[ReflectionService] 🧬 Initiating Self-Modification: ${args.title}`);

            // 1. Create a logical proposal object
            const proposal: ChangeProposal = {
                id: proposalId,
                reflectionId: 'manual_tool_invocation',
                category: args.category || 'bugfix',
                title: args.title,
                description: args.description,
                risk: {
                    score: (args.riskScore ?? 5) as any,
                    reasoning: 'Self-modification requested via tool.'
                },
                changes: args.changes,
                rollbackPlan: `Git checkout previous branch and delete ${branchName}`,
                status: 'pending'
            };

            // 2. Risk Assessment (Gate)
            const assessment = await this.risk.assess(proposal);
            if (!assessment.canAutoApply) {
                // If it fails auto-apply, we save it and wait for manual approval
                await this.store.saveProposal(proposal);
                this.notifyRenderer('reflection:proposal-created', {
                    id: proposal.id,
                    title: proposal.title,
                    score: assessment.finalScore,
                    category: proposal.category
                });
                return {
                    success: false,
                    message: `Risk level (${assessment.finalScore}) or safety gates require manual approval for this modification. View the proposal in the Reflection Panel.`,
                    proposalId
                };
            }

            // 3. Prepare Workspace (Git)
            const originalBranch = await this.git.getCurrentBranch();
            await this.git.createBranch(branchName);

            // 4. Apply Changes
            const outcome = await this.apply.apply(proposal);

            if (!outcome.success) {
                // Rollback Git
                await this.git.checkout(originalBranch);
                await this.git.deleteBranch(branchName);
                return { success: false, message: `Failed to apply changes: ${outcome.error}` };
            }

            // 5. Verification (Simple check for now, can be expanded)
            // If the app is still running and this code executed, it's a good sign.
            // Future: Run 'npm test' or similar here.

            // 6. Finalize (Commit)
            for (const change of args.changes) {
                await this.git.stage(change.path);
            }
            await this.git.commit(`[Tala Self-Modify] ${args.title}\n\n${args.description}`);

            return {
                success: true,
                message: `Successfully applied and committed modification to branch ${branchName}.`,
                proposalId
            };

        } catch (error: any) {
            console.error('[ReflectionService] Self-modification crashed:', error);
            // Attempt cleanup
            try {
                const current = await this.git.getCurrentBranch();
                if (current === branchName) {
                    await this.git.checkout('main'); // Fallback
                }
            } catch { }
            return { success: false, message: `System error during modification: ${error.message}` };
        }
    }

    /**
     * Executes a full reflection cycle: Capture -> Analyze -> Propose -> Gate -> Apply/Wait.
     */
    async runReflectionCycle() {
        try {
            console.log('[ReflectionService] ── Reflection Cycle Begin ──');
            const event = await this.reflection.runCycle();
            if (!event) {
                console.log('[ReflectionService] No actionable evidence. Cycle skipped.');
                return;
            }

            const proposals = await this.proposals.generateProposals(event);
            console.log(`[ReflectionService] Generated ${proposals.length} proposal(s).`);

            for (const proposal of proposals) {
                const assessment = await this.risk.assess(proposal);

                // Save proposal for UI tracking
                await this.store.saveProposal(proposal);

                // Auto-apply logic (gated by settings-driven threshold)
                if (assessment.canAutoApply) {
                    console.log(`[ReflectionService] ✅ Auto-applying proposal ${proposal.id} (score: ${assessment.finalScore})`);
                    await this.apply.apply(proposal);
                    this.risk.recordChanges(proposal.changes.length);
                } else {
                    console.log(`[ReflectionService] 🔒 Proposal ${proposal.id} requires user approval (score: ${assessment.finalScore}, threshold: requires manual).`);
                    // Notify the frontend that a proposal needs attention
                    this.notifyRenderer('reflection:proposal-created', {
                        id: proposal.id,
                        title: proposal.title,
                        score: assessment.finalScore,
                        category: proposal.category
                    });
                }
            }
            console.log('[ReflectionService] ── Reflection Cycle End ──');
        } catch (error) {
            console.error('[ReflectionService] Error in reflection cycle:', error);
        }
    }

    /**
     * Cleans up proposals based on status.
     */
    async cleanupProposals(status?: 'applied' | 'rejected' | 'failed'): Promise<{ success: boolean; count: number }> {
        try {
            console.log(`[ReflectionService] Cleaning up proposals with status: ${status || 'all completed/failed'}...`);
            let totalDeleted = 0;

            if (status) {
                totalDeleted = await this.store.deleteProposalsByStatus(status);
            } else {
                // Batch clean all terminal statuses
                totalDeleted += await this.store.deleteProposalsByStatus('applied');
                totalDeleted += await this.store.deleteProposalsByStatus('rejected');
                totalDeleted += await this.store.deleteProposalsByStatus('failed');
            }

            console.log(`[ReflectionService] Cleaned up ${totalDeleted} proposal(s).`);
            return { success: true, count: totalDeleted };
        } catch (error) {
            console.error('[ReflectionService] Error during proposal cleanup:', error);
            return { success: false, count: 0 };
        }
    }

    /**
     * Registers Electron IPC handlers for the frontend.
     */
    registerIpcHandlers() {
        ipcMain.handle('reflection:get-proposals', async (_, status?: string) => {
            return await this.store.getProposals(status);
        });

        ipcMain.handle('reflection:get-reflections', async () => {
            return await this.store.getReflections();
        });

        ipcMain.handle('reflection:approve-proposal', async (_, proposalId: string) => {
            const proposals = await this.store.getProposals();
            const proposal = proposals.find(p => p.id === proposalId);
            if (!proposal) throw new Error('Proposal not found');

            return await this.apply.apply(proposal);
        });

        ipcMain.handle('reflection:reject-proposal', async (_, proposalId: string) => {
            const proposals = await this.store.getProposals();
            const proposal = proposals.find(p => p.id === proposalId);
            if (!proposal) throw new Error('Proposal not found');

            proposal.status = 'rejected';
            await this.store.saveProposal(proposal);
            return { success: true };
        });

        ipcMain.handle('reflection:force-tick', async () => {
            console.log('[ReflectionService] 🔧 Manual tick requested via IPC.');
            await this.runReflectionCycle();
            return { success: true };
        });

        ipcMain.handle('reflection:get-metrics', async (): Promise<ReflectionMetrics> => {
            const outcomes = this.store.getOutcomes();
            const applied = outcomes.filter(o => o.success).length;
            const total = outcomes.length;

            return {
                totalReflections: this.store.getReflectionCount(),
                totalProposals: this.store.getProposalCount(),
                appliedChanges: applied,
                successRate: total > 0 ? applied / total : 1.0,
                lastHeartbeat: new Date().toISOString()
            };
        });

        ipcMain.handle('reflection:clean-proposals', async (_, status?: 'applied' | 'rejected' | 'failed') => {
            return await this.cleanupProposals(status);
        });
    }

    /**
     * Sends a notification to all renderer processes (BrowserWindows).
     */
    private notifyRenderer(channel: string, data: any) {
        try {
            const windows = BrowserWindow.getAllWindows();
            for (const win of windows) {
                win.webContents.send(channel, data);
            }
        } catch (e) {
            console.error('[ReflectionService] Failed to notify renderer:', e);
        }
    }
}
