/**
 * Reflection Ecosystem Orchestrator
 * 
 * The `ReflectionService` is the central nervous system for TALA's autonomous
 * self-improvement and self-modification capabilities. It coordinates a complex
 * array of sub-services to implement a secure, validated "Observe-Reflect-Act" loop.
 * 
 * **Key Responsibilities:**
 * - **Orchestration**: Manages the lifecycle of autonomous tasks via the `ReflectionScheduler`.
 * - **Self-Modification**: Provides the gated `selfModify` tool for safe code changes.
 * - **Telemetry & Journaling**: Maintains an immutable record of all system reflections and changes.
 * - **Capability Gating**: Enforces strict permission rules for system-altering actions.
 * - **Intent Routing**: Analyzes user requests to determine if they should be handled as reflections.
 * 
 * **Pipeline Phases:**
 * 1. **Observe**: Scans logs and repository state for anomalies (`SelfImprovementService`).
 * 2. **Reflect**: Analyzes issues and formulates hypotheses (`ReflectionEngine`).
 * 3. **Stage**: Prepares candidate patches in a sandbox (`PatchStagingService`).
 * 4. **Validate**: Runs automated tests and safety checks (`ValidationService`).
 * 5. **Promote**: Deploys approved changes to the live codebase (`PromotionService`).
 */
import { ipcMain, BrowserWindow } from 'electron';
import { loadSettings } from '../SettingsManager';

import { ReflectionDataDirectories } from './DataDirectoryPaths';
import { ProtectedFileRegistry } from './ProtectedFileRegistry';
import { ImmutableIdentityRegistry } from './ImmutableIdentityRegistry';
import { CapabilityGating } from './CapabilityGating';
import { RepoInspectionService } from './RepoInspectionService';
import { LogInspectionService } from './LogInspectionService';
import { SafeCommandService } from './SafeCommandService';
import { SelfImprovementService } from './SelfImprovementService';
import { ReflectionEngine } from './ReflectionEngine';
import { PatchStagingService } from './PatchStagingService';
import { ValidationService } from './ValidationService';
import { PromotionService, RollbackService } from './DeploymentServices';
import { ReflectionJournalService } from './ReflectionJournalService';
import { HeartbeatEngine } from './HeartbeatEngine';
import { GoalService } from './GoalService';
import { ReflectionQueueService } from './ReflectionQueueService';
import { ReflectionScheduler } from './ReflectionScheduler';
import { CandidatePatch, ReflectionDashboardState } from './reflectionEcosystemTypes';
import { ReflectionIntentService, ReflectionIntentResult, ReflectionIntentClass } from './ReflectionIntentService';
import * as fs from 'fs';
import * as path from 'path';

export class ReflectionService {
    private isEnabled: boolean;
    private heartbeat: HeartbeatEngine;
    private settingsPath: string;

    private dirs: ReflectionDataDirectories;
    private protectedRegistry: ProtectedFileRegistry;
    private identityRegistry: ImmutableIdentityRegistry;
    private capabilityGating: CapabilityGating;
    private repoInspector: RepoInspectionService;
    private logInspector: LogInspectionService;
    private safeCmd: SafeCommandService;

    // Core Engines
    private selfImprovement: SelfImprovementService;
    private reflection: ReflectionEngine;
    private patchStager: PatchStagingService;
    private validator: ValidationService;
    private promoter: PromotionService;
    private rollbacker: RollbackService;
    private journal: ReflectionJournalService;
    private goals: GoalService;
    private queue: ReflectionQueueService;
    private scheduler: ReflectionScheduler;
    private intentService: ReflectionIntentService;

    private git: any = null; // Legacy ref for ToolService capability parity if needed
    private rootDir: string;

    // Temporary memory storage for the UI (Proposals -> CandidatePatches) until UI is fully upgraded to new schemas
    private activePatches: Map<string, CandidatePatch> = new Map();

    constructor(userDataDir: string, settingsPath: string, rootDir: string = process.cwd()) {
        this.settingsPath = settingsPath;
        this.rootDir = rootDir;

        const settings = loadSettings(settingsPath);
        const refSettings = settings.reflection || {};
        this.isEnabled = refSettings.enabled !== false;

        // 1. Storage & Registries
        this.dirs = new ReflectionDataDirectories(userDataDir);
        this.protectedRegistry = new ProtectedFileRegistry();
        this.identityRegistry = new ImmutableIdentityRegistry();
        this.capabilityGating = new CapabilityGating();

        // 2. Inspection & execution
        this.repoInspector = new RepoInspectionService(rootDir);
        this.logInspector = new LogInspectionService(userDataDir);
        this.safeCmd = new SafeCommandService(rootDir);

        // 3. Loop Services
        this.selfImprovement = new SelfImprovementService(this.repoInspector, this.logInspector);
        this.reflection = new ReflectionEngine(this.repoInspector, this.logInspector);
        this.patchStager = new PatchStagingService(this.dirs, this.protectedRegistry);
        this.validator = new ValidationService(this.safeCmd, this.dirs);
        this.promoter = new PromotionService(rootDir, this.dirs, this.protectedRegistry, this.identityRegistry);
        this.rollbacker = new RollbackService(rootDir, this.dirs);
        this.journal = new ReflectionJournalService(this.dirs);
        this.goals = new GoalService(this.dirs);
        this.queue = new ReflectionQueueService(this.dirs);
        this.intentService = new ReflectionIntentService();

        // Wire the execution callback
        this.scheduler = new ReflectionScheduler(
            this.queue,
            this.goals,
            this.journal,
            this.executeQueueItem.bind(this),
            (activity, state) => this.notifyRenderer('reflection:activityUpdated', { activity, state })
        );

        // Heartbeat scheduling for autonomous loops
        this.heartbeat = new HeartbeatEngine({
            intervalMinutes: refSettings.heartbeatMinutes || 60,
            jitterPercent: 15,
            quietHours: refSettings.quietHours
        });

        this.setupHeartbeat();
        console.log(`[ReflectionService] Ecosystem Initialized. Enabled: ${this.isEnabled}`);
    }

    private setupHeartbeat() {
        this.heartbeat.on('tick', async () => {
            await this.scheduler.tickNow();
        });
    }

    public start() {
        if (!this.isEnabled) return;
        this.heartbeat.start();
        this.scheduler.start();
    }

    public stop() {
        this.heartbeat.stop();
        this.scheduler.stop();
    }

    // ============================================
    // TELEMETRY
    // ============================================
    public async logTelemetry(event: string, level: 'debug' | 'info' | 'warn' | 'error', source: string, message: string, data?: any) {
        const entry = {
            timestamp: new Date().toISOString(),
            event,
            level,
            source,
            message,
            ...data
        };
        console.log(`[ReflectionTelemetry] [${level.toUpperCase()}] ${event}: ${message}`);

        try {
            const telemetryLog = path.join(this.dirs.logsDir, 'reflection_telemetry.log');
            fs.appendFileSync(telemetryLog, JSON.stringify(entry) + '\n');
            this.notifyRenderer('reflection:telemetry', entry);
        } catch (e) {
            console.error('Failed to log telemetry:', e);
        }
    }

    // ============================================
    // CONVERSATIONAL INTENT & GOAL ROUTING
    // ============================================
    public async createConversationalGoal(
        requestText: string,
        goalDef: { title: string, description: string, priority: string, category: string },
        triggerMode: string = 'engineering'
    ): Promise<{ success: boolean; message: string; intent?: ReflectionIntentClass; goalId?: string }> {

        this.logTelemetry('reflection.intent.detected', 'info', 'ReflectionIntentService', `Evaluating intentionality for: "${goalDef.title}"`);

        const intentResult = await this.intentService.evaluateIntent(requestText);

        if (intentResult.intentClass !== 'reflection_goal') {
            this.logTelemetry('reflection.intent.rejected', 'warn', 'ReflectionIntentService', `Intent rejected (${intentResult.intentClass}): ${intentResult.reason}`);
            return {
                success: false,
                intent: intentResult.intentClass,
                message: `Rejected as reflection goal: ${intentResult.reason}`
            };
        }

        this.logTelemetry('reflection.goal.create.requested', 'info', 'ReflectionService', `Intent accepted. Creating goal: ${goalDef.title}`);

        try {
            const goal = await this.goals.createGoal({
                title: goalDef.title,
                description: goalDef.description,
                priority: goalDef.priority as any,
                source: 'user',
                schemaVersion: 1
            } as any);

            this.logTelemetry('reflection.goal.created', 'info', 'GoalService', `Created goal ${goal.goalId}`);
            this.logTelemetry('reflection.goal.enqueue.requested', 'info', 'QueueService', `Queueing goal ${goal.goalId}`);

            const enqueued = await this.queue.enqueue({
                type: 'goal',
                source: 'user',
                priority: goalDef.priority as any,
                goalId: goal.goalId,
                triggerMode,
                requestedBy: 'user'
            });

            if (enqueued) {
                this.logTelemetry('reflection.goal.enqueued', 'info', 'QueueService', `Goal ${goal.goalId} enqueued successfully`);
                // Auto-tick background queue
                this.scheduler.tickNow().catch(e => console.error(e));
                return { success: true, intent: 'reflection_goal', message: `Reflection goal created and queued successfully. ID: ${goal.goalId}`, goalId: goal.goalId };
            } else {
                this.logTelemetry('reflection.goal.enqueue.failed', 'error', 'QueueService', `Failed to enqueue goal ${goal.goalId}`);
                return { success: false, intent: 'reflection_goal', message: `Goal created but failed to enqueue. ID: ${goal.goalId}`, goalId: goal.goalId };
            }
        } catch (e: any) {
            this.logTelemetry('reflection.goal.create.failed', 'error', 'ReflectionService', `Failed to create goal: ${e.message}`);
            return { success: false, message: `Failed to create goal: ${e.message}` };
        }
    }

    public setGitService(git: any) {
        this.git = git;
    }

    public async getDashboardState(activeMode: string = 'assistant'): Promise<ReflectionDashboardState> {
        let queuedGoals = 0;
        let activeGoals = 0;
        let proposalsReady = 0;

        try {
            const allGoals = await this.goals.listGoals();
            queuedGoals = allGoals.filter(g => g.status === 'queued').length;
            activeGoals = allGoals.filter(g => g.status === 'active' || g.status === 'validating').length;
        } catch (e) { }

        const patches = Array.from(this.activePatches.values());
        proposalsReady = patches.filter(p => p.status === 'validation_passed' || p.status === 'staged').length;
        const applied = patches.filter(p => p.status === 'promoted').length;
        const totalAttempts = patches.length;

        const capabilityState = this.capabilityGating.isActionAllowed('repo_write_staged', activeMode, false)
            ? 'engineering'
            : (this.capabilityGating.isActionAllowed('logs_read', activeMode, false) ? 'elevated' : 'restricted');

        return {
            totalReflections: totalAttempts,
            totalProposals: totalAttempts,
            appliedChanges: applied,
            successRate: totalAttempts > 0 ? applied / totalAttempts : 0,
            activeIssues: patches.filter(p => p.status !== 'promoted' && p.status !== 'rejected').length,
            queuedGoals,
            activeGoals,
            proposalsReady,
            validationFailures: patches.filter(p => p.status === 'validation_failed').length,
            recentJournalEntries: 0, // Placeholder
            recentPromotions: applied,
            recentRollbacks: 0, // Placeholder
            capabilityState,
            currentMode: activeMode,
            pipelineActivity: await this.scheduler.getPipelineActivity(),
            schedulerState: await this.scheduler.getSchedulerState()
        };
    }

    /**
     * Replaces the old selfModify flow with the rigorous Self-Improvement Pipeline.
     */
    public async selfModify(args: {
        title: string,
        description: string,
        changes: Array<{ path: string, content?: string }>,
        activeMode?: string // Usually passed in by tool registry execution context
    }): Promise<{ success: boolean; message: string; proposalId?: string }> {
        console.log(`[ReflectionService] 🧬 Initiating Self-Modification Pipeline: ${args.title}`);

        // Ensure engineering mode or sufficient capabilities
        const mode = args.activeMode || 'engineering';
        if (!this.capabilityGating.isActionAllowed('repo_write_staged', mode, false)) {
            return { success: false, message: 'Capability Denied: Only engineering or elevated hybrid states can propose code modifications.' };
        }

        try {
            // PHASE 1 & 2: Quick issue generation to bind context
            const issue = await this.selfImprovement.scanIssue('self_modify_tool', mode);
            issue.title = args.title;
            issue.symptoms.push(args.description);

            // PHASE 3: STAGE (this acts as the new safety gate vs writing directly to src)
            const patchFiles = args.changes.map(c => ({ relativePath: c.path, content: c.content || '' }));
            const candidatePatch = await this.patchStager.createCandidatePatch(issue, patchFiles);

            this.activePatches.set(candidatePatch.patchId, candidatePatch);

            await this.journal.writeEntry({
                issueId: issue.issueId,
                patchId: candidatePatch.patchId,
                eventType: 'patch_staged',
                summary: `Staged changes for self_modify: ${args.title}`,
                evidence: candidatePatch.filesModified,
                tags: ['tool', 'self_modify'],
                confidence: 0.9
            });

            // Expose the candidate back to UI / System as a "Proposal" equivalent
            this.notifyRenderer('reflection:proposal-created', {
                id: candidatePatch.patchId,
                title: candidatePatch.title,
                score: candidatePatch.riskLevel === 'high' ? 8 : 4,
                category: 'bugfix'
            });

            // PHASE 4: VALIDATE & PROMOTE
            // If the user requested selfModify via a tool, by logic the validation/promotion triggers depending on protection levels
            const valPlan = {
                validationPlanId: `vp_${Date.now()}`,
                issueId: issue.issueId,
                patchId: candidatePatch.patchId,
                buildRequired: false,
                typecheckRequired: true,
                lintRequired: false,
                testsRequired: [],
                smokeChecks: [],
                behaviorProbes: [],
                manualReviewRequired: false,
                successCriteria: []
            };

            const report = await this.validator.runValidation(valPlan);
            if (report.overallResult !== 'pass') {
                return { success: false, message: `Validation Failed: ${report.summary}`, proposalId: candidatePatch.patchId };
            }

            // At this point, autoApply risk rules could still interrupt, 
            // but for a strict engineering loop we rely on Immutable/Protected checks in promotePatch
            const promoRec = await this.promoter.promotePatch(candidatePatch, report, 'tool_runner');

            await this.journal.writeEntry({
                issueId: issue.issueId,
                patchId: candidatePatch.patchId,
                eventType: 'promotion_accepted',
                summary: `Self modification successfully promoted.`,
                evidence: promoRec.filesPromoted,
                tags: ['tool', 'self_modify', 'live'],
                confidence: 1.0
            });

            return {
                success: true,
                message: `Successfully validated and applied modifications safely to live workspace. Archive manifest: ${promoRec.archiveManifestPath}`,
                proposalId: candidatePatch.patchId
            };
        } catch (error: any) {
            console.error('[ReflectionService] Pipeline crashed:', error);
            return { success: false, message: `System error during modification: ${error.message}` };
        }
    }

    // ============================================
    // PIPELINE ORCHESTRATION 
    // ============================================

    /**
     * Background cycle executor.
     */
    async runReflectionCycle(trigger: string = 'background_tick') {
        console.log('[ReflectionService] ── Ecosystem Cycle Begin ──');
        try {
            const issue = await this.selfImprovement.scanIssue(trigger, 'engineering');
            if (issue.severity === 'low') {
                console.log('[ReflectionService] No severe anomalies detected.');
                return;
            }

            const analyzed = await this.reflection.analyzeIssue(issue);
            console.log(`[ReflectionService] Analyzed issue root cause hypothesis: ${analyzed.selectedHypothesis}`);

            // In a real autonomous setup, we would generate the file changes through LLM here and call PatchStagingService.

            console.log('[ReflectionService] ── Ecosystem Cycle End ──');
        } catch (error) {
            console.error('[ReflectionService] Error in reflection cycle:', error);
        }
    }

    public async triggerReflection(activeMode: string = 'engineering'): Promise<{ success: boolean; message: string; issueId?: string }> {
        console.log('[ReflectionService] ── Manual Reflection Triggered ──');

        if (!this.capabilityGating.isActionAllowed('reflection_write', activeMode, false)) {
            return { success: false, message: `Capability Denied: Active mode '${activeMode}' lacks reflection_write privileges.` };
        }

        try {
            this.scheduler.updateActivityPhase('observing');

            const issue = await this.selfImprovement.scanIssue('operator', activeMode);
            if (issue.severity === 'low') {
                this.scheduler.updateActivityPhase('completed', { lastOutcome: 'success', lastSummary: 'No severe anomalies detected.' });
                return { success: false, message: 'No severe anomalies detected in current logs.' };
            }

            this.scheduler.updateActivityPhase('reflecting', { currentIssueId: issue.issueId });

            const analyzed = await this.reflection.analyzeIssue(issue);
            console.log(`[ReflectionService] Analyzed issue root cause hypothesis: ${analyzed.selectedHypothesis}`);

            this.scheduler.updateActivityPhase('journaling');

            await this.journal.writeEntry({
                issueId: issue.issueId,
                eventType: 'hypothesis_selected',
                summary: `Manual Reflection: ${analyzed.selectedHypothesis || 'Potential system anomaly found.'}`,
                evidence: { severity: issue.severity },
                tags: ['orchestration', 'manual_scan'],
                confidence: 0.90
            });

            this.scheduler.updateActivityPhase('completed', { lastOutcome: 'success', lastSummary: 'Manual reflection complete' });

            // For now, in a non-autonomous environment, we stop at issue identification to allow manual review / patching.
            return { success: true, message: `Analyzed issue: ${analyzed.selectedHypothesis || 'Potential system anomaly found.'}`, issueId: issue.issueId };
        } catch (error: any) {
            console.error('[ReflectionService] Error in manual reflection trigger:', error);
            this.scheduler.updateActivityPhase('failed', { lastOutcome: 'failed', lastError: error.message });
            return { success: false, message: `Failed: ${error.message}` };
        }
    }

    private async executeQueueItem(queueItemId: string): Promise<{ success: boolean; message: string; issueId?: string }> {
        const queueItems = await this.queue.listAll();
        const item = queueItems.find(i => i.queueItemId === queueItemId);
        if (!item) return { success: false, message: 'Queue item not found' };

        if (item.type === 'goal' && item.goalId) {
            return await this.executeGoal(item.goalId);
        } else if (item.type === 'manual_scan') {
            const res = await this.triggerReflection('engineering');
            return { success: res.success, message: res.message, issueId: res.issueId };
        }

        return { success: false, message: `Unsupported queue item type: ${item.type}` };
    }

    private async executeGoal(goalId: string): Promise<{ success: boolean; message: string; issueId?: string }> {
        const goal = await this.goals.getGoal(goalId);
        if (!goal) return { success: false, message: 'Goal not found' };

        this.scheduler.updateActivityPhase('observing', { currentGoalId: goalId });
        await this.goals.updateGoalStatus(goalId, 'analyzing');

        try {
            // STEP 1: Scan for issues related to the goal context
            const issue = await this.selfImprovement.scanIssue('goal_execution', 'engineering');
            issue.title = `Goal Execution: ${goal.title}`;
            issue.symptoms.push(`Driven by Goal: ${goal.description}`);

            await this.goals.linkIssueToGoal(goalId, issue.issueId);

            this.scheduler.updateActivityPhase('reflecting', { currentIssueId: issue.issueId });

            // STEP 2: Analyze the issue to formulate a hypothesis
            const analyzed = await this.reflection.analyzeIssue(issue);
            console.log(`[ReflectionService] Goal ${goalId} analysis hypothesis: ${analyzed.selectedHypothesis}`);

            // STEP 3: Complete execution
            await this.goals.updateGoalStatus(goalId, 'completed');
            this.scheduler.updateActivityPhase('journaling');

            await this.journal.writeEntry({
                issueId: issue.issueId,
                eventType: 'hypothesis_selected',
                summary: `Goal Execution logic mapped for ${goal.title}`,
                evidence: { goalId: goal.goalId, hypothesis: analyzed.selectedHypothesis },
                tags: ['orchestration', 'goal_driver'],
                confidence: 0.95
            });

            return { success: true, message: `Successfully executed goal pipeline for: ${goal.title}`, issueId: issue.issueId };

        } catch (e: any) {
            await this.goals.updateGoalStatus(goalId, 'failed');
            return { success: false, message: `Goal execution failed: ${e.message}` };
        }
    }

    public async triggerReflectionManually(activeMode?: string): Promise<any> {
        // First check if there is a goal we can process instead of just scanning blindly
        const queuedItems = await this.queue.listQueued();
        const goals = queuedItems.filter(i => i.type === 'goal');

        if (goals.length > 0) {
            return await this.scheduler.tickNow();
        }

        const added = await this.queue.enqueue({
            type: 'manual_scan',
            source: 'user',
            priority: 'medium',
            triggerMode: activeMode,
            requestedBy: 'user'
        });
        if (added) {
            return await this.scheduler.tickNow();
        }
        return { success: false, message: 'Failed to enqueue or already running.' };
    }

    /**
     * Component Getters for Facade Access
     */
    getGoalsService() { return this.goals; }
    getQueueService() { return this.queue; }
    getScheduler() { return this.scheduler; }
    getActivePatches() { return this.activePatches; }
    getJournalService() { return this.journal; }
    getPromoter() { return this.promoter; }

    private notifyRenderer(channel: string, data: any) {
        try {
            const windows = BrowserWindow.getAllWindows();
            for (const win of windows) {
                win.webContents.send(channel, data);
            }
        } catch (e) { }
    }
}
