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
     * Registers Electron IPC handlers for the frontend.
     */
    registerIpcHandlers() {
        ipcMain.handle('reflection:get-proposals', async (_, status?: string) => {
            return await this.store.getProposals(status);
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
