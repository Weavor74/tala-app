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
import { ArtifactStore } from './ArtifactStore';
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
import { AutoFixEngine } from './AutoFixEngine';
import { AutoFixProposal } from './AutoFixTypes';

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
    private artifactStore: ArtifactStore;
    private autoFixEngine: AutoFixEngine;

    private git: any = null; // Legacy ref for ToolService capability parity if needed
    private rootDir: string;

    // Temporary memory storage for the UI (Proposals -> CandidatePatches) until UI is fully upgraded to new schemas
    private activePatches: Map<string, CandidatePatch> = new Map();
    private readonly activeTraceRuns: Set<string> = new Set();

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
        this.artifactStore = new ArtifactStore(userDataDir);
        this.reflection = new ReflectionEngine(this.artifactStore);
        this.patchStager = new PatchStagingService(this.dirs, this.protectedRegistry);
        this.validator = new ValidationService(this.safeCmd, this.dirs);
        this.promoter = new PromotionService(rootDir, this.dirs, this.protectedRegistry, this.identityRegistry);
        this.rollbacker = new RollbackService(rootDir, this.dirs);
        this.journal = new ReflectionJournalService(this.dirs);
        this.goals = new GoalService(this.dirs);
        this.queue = new ReflectionQueueService(this.dirs);
        this.intentService = new ReflectionIntentService();
        this.autoFixEngine = new AutoFixEngine({
            artifactStore: this.artifactStore,
            settingsPath: this.settingsPath,
            logsDir: this.dirs.logsDir,
            cacheDir: path.join(userDataDir, 'cache'),
        });

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

    private traceStage(
        runId: string,
        stage:
            | 'trigger_received'
            | 'preconditions_check'
            | 'candidate_collection'
            | 'candidate_screening'
            | 'reflection_context_build'
            | 'proposal_generation'
            | 'proposal_validation'
            | 'proposal_persistence'
            | 'proposal_promotion'
            | 'ready_state'
            | 'cycle_complete'
            | 'cycle_abort'
            | 'cycle_error',
        fields: Record<string, unknown> = {}
    ) {
        const payload = {
            runId,
            stage,
            timestamp: new Date().toISOString(),
            ...fields
        };
        console.log(`[ReflectionTrace] ${Object.entries(payload).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`);
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

    public async triggerReflection(
        activeMode: string = 'engineering',
        options?: { runId?: string; triggerSource?: 'manual' | 'scheduler' | 'startup' | 'goal' | string }
    ): Promise<{ success: boolean; message: string; issueId?: string }> {
        const runId = options?.runId ?? `refl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const triggerSource = options?.triggerSource ?? 'manual';
        const startedAt = Date.now();
        this.traceStage(runId, 'trigger_received', { source: triggerSource, activeMode });
        console.log('[ReflectionService] ── Manual Reflection Triggered ──');

        if (!this.capabilityGating.isActionAllowed('reflection_write', activeMode, false)) {
            this.traceStage(runId, 'preconditions_check', {
                enabled: this.isEnabled,
                activeRun: this.activeTraceRuns.has(runId),
                capabilityAllowed: false,
                schedulerRunning: this.getScheduler().getSchedulerState().isRunning
            });
            this.traceStage(runId, 'cycle_abort', { reason: 'capability_denied' });
            return { success: false, message: `Capability Denied: Active mode '${activeMode}' lacks reflection_write privileges.` };
        }

        try {
            this.activeTraceRuns.add(runId);
            this.traceStage(runId, 'preconditions_check', {
                enabled: this.isEnabled,
                activeRun: true,
                memoryReady: Boolean(this.selfImprovement),
                journalReady: Boolean(this.journal),
                providerReady: true,
                schedulerRunning: this.getScheduler().getSchedulerState().isRunning
            });
            this.scheduler.updateActivityPhase('observing');

            const collectionStartedAt = Date.now();
            const issue = await this.selfImprovement.scanIssue('operator', activeMode);
            this.traceStage(runId, 'candidate_collection', {
                count: issue ? 1 : 0,
                durationMs: Date.now() - collectionStartedAt,
                issueId: issue?.issueId
            });
            if (issue.severity === 'low') {
                this.scheduler.updateActivityPhase('completed', { lastOutcome: 'success', lastSummary: 'No severe anomalies detected.' });
                this.traceStage(runId, 'candidate_screening', { accepted: 0, rejected: 1, reason: 'severity_low' });
                this.traceStage(runId, 'cycle_abort', { reason: 'no_candidates' });
                return { success: false, message: 'No severe anomalies detected in current logs.' };
            }

            this.traceStage(runId, 'candidate_screening', { accepted: 1, rejected: 0, severity: issue.severity });
            this.traceStage(runId, 'reflection_context_build', { success: true, inputs: 1, issueId: issue.issueId });
            this.scheduler.updateActivityPhase('reflecting', { currentIssueId: issue.issueId });

            const proposalStartedAt = Date.now();
            const analyzed = await this.reflection.analyzeIssue(issue);
            this.traceStage(runId, 'proposal_generation', {
                count: analyzed?.selectedHypothesis ? 1 : 0,
                durationMs: Date.now() - proposalStartedAt
            });
            this.traceStage(runId, 'proposal_validation', {
                count: analyzed?.selectedHypothesis ? 1 : 0,
                success: Boolean(analyzed?.selectedHypothesis)
            });
            console.log(`[ReflectionService] Analyzed issue root cause hypothesis: ${analyzed.selectedHypothesis}`);

            const autoFixProposals = await this.autoFixEngine.synthesizeProposals(
                runId,
                issue,
                analyzed?.selectedHypothesis || ''
            );
            this.traceStage(runId, 'proposal_persistence', {
                success: true,
                recordsCreated: 1 + autoFixProposals.length,
                destination: 'reflection-journal.jsonl+auto_fix_proposals',
                autoFixProposalCount: autoFixProposals.length,
            });

            this.scheduler.updateActivityPhase('journaling');

            const persistStartedAt = Date.now();
            await this.journal.writeEntry({
                issueId: issue.issueId,
                eventType: 'hypothesis_selected',
                summary: `Manual Reflection: ${analyzed.selectedHypothesis || 'Potential system anomaly found.'}`,
                evidence: { severity: issue.severity },
                tags: ['orchestration', 'manual_scan'],
                confidence: 0.90
            });
            this.traceStage(runId, 'ready_state', {
                proposalsReady: analyzed?.selectedHypothesis ? 1 : 0,
                promoted: 0,
                autoFixProposalCount: autoFixProposals.length,
                durationMs: Date.now() - persistStartedAt,
            });
            this.traceStage(runId, 'proposal_promotion', {
                count: 0,
                skipped: true,
                reason: 'manual_reflection_stops_before_promotion'
            });

            this.scheduler.updateActivityPhase('completed', { lastOutcome: 'success', lastSummary: 'Manual reflection complete' });
            this.traceStage(runId, 'cycle_complete', {
                durationMs: Date.now() - startedAt,
                issueId: issue.issueId
            });

            // For now, in a non-autonomous environment, we stop at issue identification to allow manual review / patching.
            return { success: true, message: `Analyzed issue: ${analyzed.selectedHypothesis || 'Potential system anomaly found.'}`, issueId: issue.issueId };
        } catch (error: any) {
            console.error('[ReflectionService] Error in manual reflection trigger:', error);
            this.scheduler.updateActivityPhase('failed', { lastOutcome: 'failed', lastError: error.message });
            this.traceStage(runId, 'cycle_error', {
                error: error?.message || 'unknown_error',
                stack: error?.stack
            });
            return { success: false, message: `Failed: ${error.message}` };
        } finally {
            this.activeTraceRuns.delete(runId);
        }
    }

    private async executeQueueItem(queueItemId: string): Promise<{ success: boolean; message: string; issueId?: string }> {
        const runId = queueItemId;
        const queueItems = await this.queue.listAll();
        this.traceStage(runId, 'trigger_received', {
            source: 'scheduler',
            queueItemId,
            queuedCount: queueItems.length
        });
        const item = queueItems.find(i => i.queueItemId === queueItemId);
        if (!item) {
            this.traceStage(runId, 'cycle_abort', { reason: 'queue_item_not_found' });
            return { success: false, message: 'Queue item not found' };
        }

        if (item.type === 'goal' && item.goalId) {
            return await this.executeGoal(item.goalId, runId);
        } else if (item.type === 'manual_scan') {
            const res = await this.triggerReflection('engineering', { runId, triggerSource: 'scheduler' });
            return { success: res.success, message: res.message, issueId: res.issueId };
        }

        this.traceStage(runId, 'cycle_abort', { reason: `unsupported_queue_item_type:${item.type}` });
        return { success: false, message: `Unsupported queue item type: ${item.type}` };
    }

    private async executeGoal(goalId: string, runId: string = `goal_${Date.now()}`): Promise<{ success: boolean; message: string; issueId?: string }> {
        const goal = await this.goals.getGoal(goalId);
        if (!goal) {
            this.traceStage(runId, 'cycle_abort', { reason: 'goal_not_found', goalId });
            return { success: false, message: 'Goal not found' };
        }

        const startedAt = Date.now();
        this.activeTraceRuns.add(runId);
        this.traceStage(runId, 'preconditions_check', {
            enabled: this.isEnabled,
            activeRun: true,
            goalId,
            memoryReady: Boolean(this.selfImprovement),
            journalReady: Boolean(this.journal)
        });

        this.scheduler.updateActivityPhase('observing', { currentGoalId: goalId });
        await this.goals.updateGoalStatus(goalId, 'analyzing');

        try {
            // STEP 1: Scan for issues related to the goal context
            const issue = await this.selfImprovement.scanIssue('goal_execution', 'engineering');
            this.traceStage(runId, 'candidate_collection', { count: 1, issueId: issue.issueId, source: 'goal' });
            issue.title = `Goal Execution: ${goal.title}`;
            issue.symptoms.push(`Driven by Goal: ${goal.description}`);
            this.traceStage(runId, 'candidate_screening', { accepted: 1, rejected: 0, severity: issue.severity });

            await this.goals.linkIssueToGoal(goalId, issue.issueId);
            this.traceStage(runId, 'reflection_context_build', { success: true, inputs: 1, issueId: issue.issueId, goalId });

            this.scheduler.updateActivityPhase('reflecting', { currentIssueId: issue.issueId });

            // STEP 2: Analyze the issue to formulate a hypothesis
            const analyzed = await this.reflection.analyzeIssue(issue);
            this.traceStage(runId, 'proposal_generation', { count: analyzed?.selectedHypothesis ? 1 : 0, issueId: issue.issueId });
            this.traceStage(runId, 'proposal_validation', { count: analyzed?.selectedHypothesis ? 1 : 0, success: Boolean(analyzed?.selectedHypothesis) });
            console.log(`[ReflectionService] Goal ${goalId} analysis hypothesis: ${analyzed.selectedHypothesis}`);
            const autoFixProposals = await this.autoFixEngine.synthesizeProposals(
                runId,
                issue,
                analyzed?.selectedHypothesis || ''
            );

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
            this.traceStage(runId, 'proposal_persistence', {
                success: true,
                recordsCreated: 1 + autoFixProposals.length,
                destination: 'reflection-journal.jsonl',
                goalId
            });
            this.traceStage(runId, 'ready_state', { proposalsReady: analyzed?.selectedHypothesis ? 1 : 0, goalId, autoFixProposalCount: autoFixProposals.length });
            this.traceStage(runId, 'proposal_promotion', { count: 0, skipped: true, reason: 'goal_pipeline_stops_at_hypothesis' });
            this.traceStage(runId, 'cycle_complete', { durationMs: Date.now() - startedAt, issueId: issue.issueId, goalId });

            return { success: true, message: `Successfully executed goal pipeline for: ${goal.title}`, issueId: issue.issueId };

        } catch (e: any) {
            await this.goals.updateGoalStatus(goalId, 'failed');
            this.traceStage(runId, 'cycle_error', { error: e?.message || 'unknown_error', goalId, stack: e?.stack });
            return { success: false, message: `Goal execution failed: ${e.message}` };
        } finally {
            this.activeTraceRuns.delete(runId);
        }
    }

    public async triggerReflectionManually(activeMode?: string): Promise<any> {
        const result = await this.runManualReflectionNow(activeMode || 'engineering', 'manual');
        return {
            success: result.accepted,
            message: result.message,
            runId: result.runId,
            reason: result.reason
        };
    }

    public async runManualReflectionNow(
        activeMode: string = 'engineering',
        source: 'manual' | 'startup' | 'scheduler' = 'manual'
    ): Promise<{ accepted: boolean; runId: string; reason?: string; message: string }> {
        const runId = `rq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const schedulerState = this.scheduler.getSchedulerState();
        const preconditions = {
            enabled: this.isEnabled,
            activeRun: schedulerState.isRunning || Boolean(schedulerState.activeQueueItemId),
            memoryReady: Boolean(this.selfImprovement),
            journalReady: Boolean(this.journal),
            providerReady: true,
            schedulerState: schedulerState.isRunning ? 'running' : 'idle'
        };
        this.traceStage(runId, 'trigger_received', { source, activeMode });
        this.traceStage(runId, 'preconditions_check', preconditions);

        if (!this.isEnabled) {
            this.traceStage(runId, 'cycle_abort', { reason: 'reflection_disabled' });
            return { accepted: false, runId, reason: 'reflection_disabled', message: 'Reflection system is disabled.' };
        }
        if (preconditions.activeRun) {
            this.traceStage(runId, 'cycle_abort', { reason: 'active_run' });
            return { accepted: false, runId, reason: 'active_run', message: 'A reflection run is already active.' };
        }

        const enqueued = await this.queue.enqueue({
            type: 'manual_scan',
            source: 'user',
            priority: 'medium',
            triggerMode: activeMode,
            requestedBy: 'user'
        });
        if (!enqueued) {
            this.traceStage(runId, 'cycle_abort', { reason: 'enqueue_rejected' });
            return { accepted: false, runId, reason: 'enqueue_rejected', message: 'Manual reflection was not enqueued (already running or queued).' };
        }

        const acceptedRunId = enqueued.queueItemId;
        this.traceStage(acceptedRunId, 'trigger_received', { source, accepted: true, queueItemId: acceptedRunId });
        await this.scheduler.tickNow();
        return { accepted: true, runId: acceptedRunId, message: `Manual reflection run ${acceptedRunId} accepted.` };
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
    getAutoFixEngine() { return this.autoFixEngine; }

    public async listAutoFixProposals(): Promise<AutoFixProposal[]> {
        return this.autoFixEngine.listProposals();
    }

    public async autoFixEvaluate(proposalId: string) {
        return this.autoFixEngine.evaluateProposal(proposalId);
    }

    public async autoFixDryRun(proposalId: string) {
        return this.autoFixEngine.dryRunProposal(proposalId);
    }

    public async autoFixRun(proposalId: string) {
        return this.autoFixEngine.runProposal(proposalId);
    }

    public async listAutoFixOutcomes() {
        return this.autoFixEngine.listOutcomes();
    }

    private notifyRenderer(channel: string, data: any) {
        try {
            const windows = BrowserWindow.getAllWindows();
            for (const win of windows) {
                win.webContents.send(channel, data);
            }
        } catch (e) { }
    }
}
