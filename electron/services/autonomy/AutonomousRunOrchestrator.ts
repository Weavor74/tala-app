/**
 * AutonomousRunOrchestrator.ts — Phase 4 P4E / Phase 5 P5 integration
 *
 * Main autonomous improvement loop coordinator.
 *
 * Architecture:
 *   GoalDetection → Prioritization → Selection → PolicyGate
 *     → [Phase 5: AdaptiveValueScoring → StrategySelection → AdaptivePolicyGate]
 *     → SafeChangePlanner.plan()          (Phase 2)
 *     → SafeChangePlanner.promoteProposal()
 *     → GovernanceAppService.evaluateForProposal()   (Phase 3.5)
 *     → [immediate if self-authorized | governance_pending if human needed]
 *     → ExecutionOrchestrator.start()    (Phase 3)
 *     → OutcomeLearningRegistry.record()
 *     → [Phase 5: SubsystemProfileRegistry.update()]
 *     → AutonomyDashboardBridge.maybeEmit()
 *
 * Safety invariants enforced here:
 *  1. One active run per subsystem (via AutonomyBudgetManager)
 *  2. One active run globally by default
 *  3. Cooldown applied after failure/rollback/governance block
 *  4. Budget capped per period
 *  5. No recursion: _cycleRunning flag prevents re-entrant cycles
 *  6. Every run is persisted (AutonomyAuditService)
 *  7. OutcomeLearningRegistry always called (finally block)
 *  8. Governance is mandatory — no execution without authorized decision
 *  9. No direct code mutation — all changes go through planning pipeline
 * 10. Phase 5 adaptive services are optional; Phase 4 behavior is the fallback
 * 11. Phase 4D (AutonomyPolicyGate) block is never overridden by Phase 5 gate
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    AutonomousGoal,
    AutonomousRun,
    AutonomousRunMilestone,
    AutonomousRunMilestoneName,
    AutonomousRunStatus,
    AttemptOutcome,
    AutonomyPolicy,
} from '../../../shared/autonomyTypes';
import type { SafeChangePlanner } from '../reflection/SafeChangePlanner';
import type { GovernanceAppService } from '../governance/GovernanceAppService';
import type { ExecutionOrchestrator } from '../execution/ExecutionOrchestrator';
import type { PlanTriggerInput } from '../../../shared/reflectionPlanTypes';
import { GoalDetectionEngine } from './GoalDetectionEngine';
import { GoalPrioritizationEngine } from './GoalPrioritizationEngine';
import { AutonomyPolicyGate } from './AutonomyPolicyGate';
import { AutonomyBudgetManager } from './AutonomyBudgetManager';
import { AutonomyCooldownRegistry } from './AutonomyCooldownRegistry';
import { OutcomeLearningRegistry } from './OutcomeLearningRegistry';
import { AutonomyAuditService } from './AutonomyAuditService';
import { AutonomyTelemetryStore } from './AutonomyTelemetryStore';
import { AutonomyDashboardBridge } from './AutonomyDashboardBridge';
import { telemetry } from '../TelemetryService';
import { TelemetryBus } from '../telemetry/TelemetryBus';
import { ExecutionStateStore } from '../kernel/ExecutionStateStore';
import { createExecutionRequest } from '../../../shared/runtime/ExecutionRuntimeFactory';
// ── Phase 4.3: Recovery Pack services (optional, injected via setRecoveryPackServices) ──
import type { RecoveryPackRegistry } from './recovery/RecoveryPackRegistry';
import type { RecoveryPackMatcher } from './recovery/RecoveryPackMatcher';
import type { RecoveryPackPlannerAdapter } from './recovery/RecoveryPackPlannerAdapter';
import type { RecoveryPackOutcomeTracker } from './recovery/RecoveryPackOutcomeTracker';
import type { RecoveryPackDashboardState, RecoveryPackExecutionOutcome } from '../../../shared/recoveryPackTypes';
// ── Phase 5: Adaptive Intelligence Layer services (optional, injected via setAdaptiveServices) ──
import type { SubsystemProfileRegistry } from './adaptive/SubsystemProfileRegistry';
import type { GoalValueScoringEngine } from './adaptive/GoalValueScoringEngine';
import type { StrategySelectionEngine } from './adaptive/StrategySelectionEngine';
import type { AdaptivePolicyGate } from './adaptive/AdaptivePolicyGate';
import type {
    AdaptiveDashboardState,
    AdaptiveKpis,
    AdaptivePolicyDecision,
    StrategySelectionResult,
    GoalValueScore,
} from '../../../shared/adaptiveTypes';
import { DEFAULT_ADAPTIVE_THRESHOLDS } from '../../../shared/adaptiveTypes';
// ── Phase 5.1: Escalation & Decomposition services (optional, injected via setEscalationServices) ──
import type { ModelCapabilityEvaluator } from './escalation/ModelCapabilityEvaluator';
import type { EscalationPolicyEngine } from './escalation/EscalationPolicyEngine';
import type { DecompositionEngine } from './escalation/DecompositionEngine';
import type { ExecutionStrategySelector } from './escalation/ExecutionStrategySelector';
import type { EscalationAuditTracker } from './escalation/EscalationAuditTracker';
import type { DecompositionOutcomeTracker } from './escalation/DecompositionOutcomeTracker';
import type {
    EscalationPolicy,
    EscalationDashboardState,
    EscalationKpis,
    ExecutionStrategyDecision,
    TaskCapabilityAssessment,
    DecompositionPlan,
} from '../../../shared/escalationTypes';
import { DEFAULT_ESCALATION_POLICY } from '../../../shared/escalationTypes';
import { policyGate, PolicyDeniedError } from '../policy/PolicyGate';

// ─── Poll timeouts ────────────────────────────────────────────────────────────

// How long to wait for governance to resolve after self-authorization attempt
const GOVERNANCE_POLL_INTERVAL_MS = 2_000;
const GOVERNANCE_POLL_TIMEOUT_MS = 30_000;  // 30 seconds for self-auth path
// How long to wait for execution to reach a terminal state
const EXECUTION_POLL_INTERVAL_MS = 2_000;
const EXECUTION_POLL_TIMEOUT_MS = 5 * 60_000; // 5 minutes

// ─── AutonomousRunOrchestrator ─────────────────────────────────────────────────

export class AutonomousRunOrchestrator {
    private cycleTimer: NodeJS.Timeout | null = null;
    private _cycleRunning = false;

    // In-memory goal registry (keyed by goalId)
    private activeGoals: Map<string, AutonomousGoal> = new Map();
    // In-memory run registry (keyed by runId)
    private activeRuns: Map<string, AutonomousRun> = new Map();

    private readonly detectionEngine: GoalDetectionEngine;
    private readonly prioritizationEngine: GoalPrioritizationEngine;
    private readonly policyGate: AutonomyPolicyGate;
    readonly budgetManager: AutonomyBudgetManager;
    private readonly cooldownRegistry: AutonomyCooldownRegistry;
    readonly learningRegistry: OutcomeLearningRegistry;
    private readonly auditService: AutonomyAuditService;
    private readonly telemetryStore: AutonomyTelemetryStore;
    readonly dashboardBridge: AutonomyDashboardBridge;

    // ── Phase 4.3: Recovery Pack services (optional) ──────────────────────────
    private _packRegistry: RecoveryPackRegistry | undefined;
    private _packMatcher: RecoveryPackMatcher | undefined;
    private _packPlannerAdapter: RecoveryPackPlannerAdapter | undefined;
    private _packOutcomeTracker: RecoveryPackOutcomeTracker | undefined;

    // ── Phase 5: Adaptive Intelligence Layer services (optional) ─────────────
    private _adaptiveProfileRegistry: SubsystemProfileRegistry | undefined;
    private _adaptiveValueScorer: GoalValueScoringEngine | undefined;
    private _adaptiveStrategyEngine: StrategySelectionEngine | undefined;
    private _adaptiveGate: AdaptivePolicyGate | undefined;
    // In-memory logs for dashboard (capped at 20 entries, most-recent first)
    private _recentValueScores: GoalValueScore[] = [];
    private _recentStrategySelections: StrategySelectionResult[] = [];
    private _recentAdaptiveDecisions: AdaptivePolicyDecision[] = [];

    // ── Phase 5.1: Escalation & Decomposition services (optional) ────────────
    private _capabilityEvaluator: ModelCapabilityEvaluator | undefined;
    private _escalationPolicyEngine: EscalationPolicyEngine | undefined;
    private _decompositionEngine: DecompositionEngine | undefined;
    private _strategySelector: ExecutionStrategySelector | undefined;
    private _escalationAuditTracker: EscalationAuditTracker | undefined;
    private _decompositionOutcomeTracker: DecompositionOutcomeTracker | undefined;
    private _escalationPolicy: EscalationPolicy = DEFAULT_ESCALATION_POLICY;
    // In-memory dashboard logs (capped at 20 entries, most-recent first)
    private _recentAssessments: TaskCapabilityAssessment[] = [];
    private _recentStrategyDecisions: ExecutionStrategyDecision[] = [];
    private _recentDecompositionPlans: DecompositionPlan[] = [];

    // ── Phase 5.5: Repair Campaign services (optional) ────────────────────────
    private _campaignPlanner: import('./campaigns/RepairCampaignPlanner').RepairCampaignPlanner | undefined;
    private _campaignRegistry: import('./campaigns/RepairCampaignRegistry').RepairCampaignRegistry | undefined;
    private _campaignCoordinator: import('./campaigns/RepairCampaignCoordinator').RepairCampaignCoordinator | undefined;

    // ── Phase 5.6: Harmonization services (optional) ──────────────────────────
    private _harmonizationCoordinator: import('./harmonization/HarmonizationCoordinator').HarmonizationCoordinator | undefined;

    // ── Phase 6: Cross-System Intelligence services (optional) ────────────────
    private _crossSystemCoordinator: import('./crossSystem/CrossSystemCoordinator').CrossSystemCoordinator | undefined;

    // ── Phase 6.1: Strategy Routing services (optional) ───────────────────────
    private _strategyRoutingEngine: import('./crossSystem/StrategyRoutingEngine').StrategyRoutingEngine | undefined;
    private _strategyRoutingOutcomeTracker: import('./crossSystem/StrategyRoutingOutcomeTracker').StrategyRoutingOutcomeTracker | undefined;

    // ── Shared runtime execution state tracking ────────────────────────────────
    /** In-memory ExecutionState store for cross-seam lifecycle tracking. Mirrors AgentKernel.stateStore. */
    private readonly _stateStore: ExecutionStateStore = new ExecutionStateStore();

    /** Exposes the ExecutionStateStore so observers (e.g. tests, dashboards) can query autonomy run states. */
    get stateStore(): ExecutionStateStore {
        return this._stateStore;
    }

    constructor(
        private readonly dataDir: string,
        private readonly safePlanner: SafeChangePlanner,
        private readonly governanceAppService: GovernanceAppService,
        private readonly executionOrchestrator: ExecutionOrchestrator,
        private activePolicy: AutonomyPolicy,
    ) {
        this.budgetManager = new AutonomyBudgetManager();
        this.cooldownRegistry = new AutonomyCooldownRegistry(dataDir);
        this.learningRegistry = new OutcomeLearningRegistry(dataDir);
        this.auditService = new AutonomyAuditService(dataDir);
        this.telemetryStore = new AutonomyTelemetryStore(dataDir);
        this.dashboardBridge = new AutonomyDashboardBridge();
        this.policyGate = new AutonomyPolicyGate(
            this.budgetManager,
            this.cooldownRegistry,
            this.learningRegistry,
        );
        this.prioritizationEngine = new GoalPrioritizationEngine(
            this.learningRegistry,
            this.cooldownRegistry,
            this.budgetManager,
        );

        this.detectionEngine = new GoalDetectionEngine(
            {
                listRecentExecutionRuns: (w) => executionOrchestrator.listRecentRuns(w),
                listGovernanceDecisions: (f) => governanceAppService.listDecisions(f),
                listReflectionGoals: () => this._listReflectionGoals(),
                getActiveGoalFingerprints: () => {
                    const fingerprints = new Set<string>();
                    for (const g of this.activeGoals.values()) {
                        const nonTerminal = g.status !== 'succeeded' &&
                            g.status !== 'failed' &&
                            g.status !== 'rolled_back' &&
                            g.status !== 'suppressed' &&
                            g.status !== 'expired';
                        if (nonTerminal) fingerprints.add(g.dedupFingerprint);
                    }
                    return fingerprints;
                },
            },
            (candidates) => this._onCandidatesDetected(candidates),
        );

        this.telemetryStore.startAutoFlush();
        this._recoverStaleRuns();

        // Load persisted goals into memory
        const persisted = this.auditService.listGoals();
        for (const g of persisted) {
            this.activeGoals.set(g.goalId, g);
        }
        const persistedRuns = this.auditService.listRuns();
        for (const r of persistedRuns) {
            this.activeRuns.set(r.runId, r);
        }
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────────

    /**
     * Injects optional Phase 4.3 recovery pack services.
     *
     * Must be called after construction but before start().
     * When not called, the orchestrator behaves identically to Phase 4.2.
     */
    setRecoveryPackServices(
        registry: RecoveryPackRegistry,
        matcher: RecoveryPackMatcher,
        adapter: RecoveryPackPlannerAdapter,
        tracker: RecoveryPackOutcomeTracker,
    ): void {
        this._packRegistry = registry;
        this._packMatcher = matcher;
        this._packPlannerAdapter = adapter;
        this._packOutcomeTracker = tracker;
    }

    /**
     * Returns the recovery pack dashboard state, or null if pack services are not active.
     */
    getRecoveryPackDashboardState(): RecoveryPackDashboardState | null {
        if (!this._packOutcomeTracker) return null;
        return this._packOutcomeTracker.getDashboardState();
    }

    /**
     * Injects optional Phase 5 adaptive intelligence services.
     *
     * Must be called after construction and after setRecoveryPackServices() (if used).
     * When not called, the orchestrator uses Phase 4 prioritization and pack selection only.
     * All services must be provided together; partial injection is not supported.
     */
    setAdaptiveServices(
        profileRegistry: SubsystemProfileRegistry,
        valueScorer: GoalValueScoringEngine,
        strategyEngine: StrategySelectionEngine,
        adaptiveGate: AdaptivePolicyGate,
    ): void {
        this._adaptiveProfileRegistry = profileRegistry;
        this._adaptiveValueScorer = valueScorer;
        this._adaptiveStrategyEngine = strategyEngine;
        this._adaptiveGate = adaptiveGate;
        // Wire up profile registry to the prioritization engine for blended confidence
        this.prioritizationEngine.setProfileRegistry(profileRegistry);
    }

    /**
     * Returns the Phase 5 adaptive dashboard state, or null if adaptive services are not active.
     */
    getAdaptiveDashboardState(): AdaptiveDashboardState | null {
        if (!this._adaptiveProfileRegistry) return null;

        const profiles = this._adaptiveProfileRegistry.listAll();
        const recentValueScores = [...this._recentValueScores];
        const recentPolicyDecisions = [...this._recentAdaptiveDecisions];
        const recentStrategySelections = [...this._recentStrategySelections];

        // Compute KPIs from in-memory logs
        const avgValueScore = recentValueScores.length > 0
            ? Math.round(recentValueScores.reduce((s, v) => s + v.valueScore, 0) / recentValueScores.length)
            : 0;
        const avgSuccessProbability = recentValueScores.length > 0
            ? Math.round(recentValueScores.reduce((s, v) => s + v.successProbability, 0) / recentValueScores.length * 100) / 100
            : 0;
        const packSelections = recentStrategySelections.filter(s => s.strategy === 'recovery_pack').length;
        const packSelectionRate = recentStrategySelections.length > 0
            ? Math.round(packSelections / recentStrategySelections.length * 100) / 100
            : 0;
        const deferCount = recentPolicyDecisions.filter(d => d.action === 'defer').length;
        const suppressCount = recentPolicyDecisions.filter(d => d.action === 'suppress').length;
        const escalateCount = recentPolicyDecisions.filter(d => d.action === 'escalate').length;
        const totalDecisions = recentPolicyDecisions.length;
        const deferRate = totalDecisions > 0 ? Math.round(deferCount / totalDecisions * 100) / 100 : 0;
        const suppressRate = totalDecisions > 0 ? Math.round(suppressCount / totalDecisions * 100) / 100 : 0;
        const escalateRate = totalDecisions > 0 ? Math.round(escalateCount / totalDecisions * 100) / 100 : 0;
        const oscillatingSubsystemCount = profiles.filter(p => p.oscillationDetected).length;

        const kpis: AdaptiveKpis = {
            avgValueScore,
            avgSuccessProbability,
            packSelectionRate,
            deferRate,
            suppressRate,
            escalateRate,
            oscillatingSubsystemCount,
        };

        return {
            computedAt: new Date().toISOString(),
            recentValueScores,
            recentPolicyDecisions,
            recentStrategySelections,
            subsystemProfiles: profiles,
            kpis,
        };
    }

    /**
     * Returns subsystem adaptive profiles, or empty array if adaptive layer not active.
     */
    getAdaptiveSubsystemProfiles(): import('../../../shared/adaptiveTypes').SubsystemProfile[] {
        return this._adaptiveProfileRegistry?.listAll() ?? [];
    }

    /**
     * Injects optional Phase 5.1 escalation and decomposition services.
     *
     * Must be called after construction and after setAdaptiveServices() (if used).
     * When not called, the orchestrator skips capability evaluation and proceeds with
     * the standard execution pipeline (Phase 4 / Phase 5 behavior unchanged).
     * All six services must be provided together; partial injection is not supported.
     *
     * @param evaluator          Evaluates whether the active model can handle a goal.
     * @param policyEngine       Applies escalation policy to assessment results.
     * @param decompositionEngine Creates bounded decomposition plans.
     * @param strategySelector   Selects the final execution strategy.
     * @param auditTracker       Records escalation audit events.
     * @param outcomeTracker     Tracks decomposition plan outcomes.
     * @param policy             Escalation policy override (uses DEFAULT_ESCALATION_POLICY if omitted).
     */
    setEscalationServices(
        evaluator: ModelCapabilityEvaluator,
        policyEngine: EscalationPolicyEngine,
        decompositionEngine: DecompositionEngine,
        strategySelector: ExecutionStrategySelector,
        auditTracker: EscalationAuditTracker,
        outcomeTracker: DecompositionOutcomeTracker,
        policy?: EscalationPolicy,
    ): void {
        this._capabilityEvaluator = evaluator;
        this._escalationPolicyEngine = policyEngine;
        this._decompositionEngine = decompositionEngine;
        this._strategySelector = strategySelector;
        this._escalationAuditTracker = auditTracker;
        this._decompositionOutcomeTracker = outcomeTracker;
        if (policy) this._escalationPolicy = policy;
    }

    // ── Phase 5.5: Campaign services ────────────────────────────────────────────

    /**
     * Injects optional Phase 5.5 repair campaign services.
     *
     * Must be called after construction and after setEscalationServices() (if used).
     * When not called, single-step autonomous runs proceed as in Phase 5.1.
     * All three services must be provided together; partial injection is not supported.
     */
    setCampaignServices(
        planner: import('./campaigns/RepairCampaignPlanner').RepairCampaignPlanner,
        registry: import('./campaigns/RepairCampaignRegistry').RepairCampaignRegistry,
        coordinator: import('./campaigns/RepairCampaignCoordinator').RepairCampaignCoordinator,
    ): void {
        this._campaignPlanner = planner;
        this._campaignRegistry = registry;
        this._campaignCoordinator = coordinator;
    }

    /**
     * Returns the Phase 5.5 campaign dashboard state, or null if campaign services are not active.
     */
    getCampaignDashboardState(): import('../../../shared/repairCampaignTypes').CampaignDashboardState | null {
        return this._campaignCoordinator?.getDashboardState() ?? null;
    }

    // ── Phase 5.6: Harmonization services ────────────────────────────────────────

    /**
     * Injects optional Phase 5.6 harmonization services.
     *
     * Must be called after setCampaignServices() (if used).
     * When not called, harmonization detection is inactive.
     */
    setHarmonizationServices(
        coordinator: import('./harmonization/HarmonizationCoordinator').HarmonizationCoordinator,
    ): void {
        this._harmonizationCoordinator = coordinator;
    }

    /**
     * Returns the Phase 5.6 harmonization dashboard state, or null if not active.
     */
    getHarmonizationDashboardState(): import('../../../shared/harmonizationTypes').HarmonizationDashboardState | null {
        return this._harmonizationCoordinator?.getDashboardState() ?? null;
    }

    /**
     * Executes one harmonization step through the planning → governance → execution pipeline.
     * Called by HarmonizationCoordinator via the step executor callback.
     * Preserves all Phase 2 / 3.5 / 3 safety gates.
     */
    async executeHarmonizationStep(
        filePath: string,
        campaign: import('../../../shared/harmonizationTypes').HarmonizationCampaign,
        metadata: import('../../../shared/harmonizationTypes').HarmonizationProposalMetadata,
    ): Promise<import('./harmonization/HarmonizationCoordinator').HarmonizationStepExecutionResult> {
        try {
            const planInput = this._buildHarmonizationStepPlanInput(filePath, campaign, metadata);

            const planResponse = await this.safePlanner.plan(planInput);
            if (!planResponse) {
                return {
                    executionRunId: `no-proposal-${Date.now()}`,
                    executionSucceeded: false,
                    rollbackTriggered: false,
                    failureReason: 'SafeChangePlanner did not produce a response for harmonization step',
                };
            }

            // Poll for the actual SafeChangeProposal produced by this plan run
            let proposal = this.safePlanner.listProposals(4 * 60 * 60 * 1000)
                .find(p => p.runId === planResponse.runId);
            if (!proposal) {
                for (let i = 0; i < 9 && !proposal; i++) {
                    await this._delay(50);
                    proposal = this.safePlanner.listProposals(4 * 60 * 60 * 1000)
                        .find(p => p.runId === planResponse.runId);
                }
            }

            if (!proposal) {
                return {
                    executionRunId: `no-proposal-${Date.now()}`,
                    executionSucceeded: false,
                    rollbackTriggered: false,
                    failureReason: 'Planning completed but no proposal was generated for harmonization step',
                };
            }

            this.safePlanner.promoteProposal(proposal.proposalId);

            const govDecision = this.governanceAppService.evaluateForProposal(proposal);
            if (!govDecision.executionAuthorized) {
                return {
                    executionRunId: `gov-blocked-${Date.now()}`,
                    executionSucceeded: false,
                    rollbackTriggered: false,
                    failureReason: `Governance blocked harmonization step: ${govDecision.blockReason ?? 'not authorized'}`,
                };
            }

            const execResponse = await this.executionOrchestrator.start({
                proposalId: proposal.proposalId,
                authorizedBy: 'user_explicit',
                dryRun: false,
            });

            if (execResponse.blocked) {
                return {
                    executionRunId: `exec-blocked-${Date.now()}`,
                    executionSucceeded: false,
                    rollbackTriggered: false,
                    failureReason: `Execution blocked: ${execResponse.message}`,
                };
            }

            const terminalStatus = await this._waitForExecution(execResponse.executionId);
            const succeeded = terminalStatus === 'succeeded';
            const rolledBack = terminalStatus === 'rolled_back';

            return {
                executionRunId: execResponse.executionId,
                executionSucceeded: succeeded,
                rollbackTriggered: rolledBack,
                failureReason: succeeded ? undefined : `Execution ended with status: ${terminalStatus}`,
            };
        } catch (err: any) {
            return {
                executionRunId: `error-${Date.now()}`,
                executionSucceeded: false,
                rollbackTriggered: false,
                failureReason: err.message ?? 'Harmonization step execution threw unexpectedly',
            };
        }
    }

    // ─── Phase 6: Cross-System Intelligence ──────────────────────────────────

    /**
     * Injects optional Phase 6 cross-system intelligence services.
     *
     * Must be called after setHarmonizationServices() (if used).
     * When not called, cross-system intelligence is inactive.
     */
    setCrossSystemServices(
        coordinator: import('./crossSystem/CrossSystemCoordinator').CrossSystemCoordinator,
    ): void {
        this._crossSystemCoordinator = coordinator;
    }

    /**
     * Returns the Phase 6 cross-system dashboard state, or null if not active.
     */
    getCrossSystemDashboardState(): import('../../../shared/crossSystemTypes').CrossSystemDashboardState | null {
        return this._crossSystemCoordinator?.getDashboardState() ?? null;
    }

    // ─── Phase 6.1: Strategy Routing ──────────────────────────────────────────

    /**
     * Injects optional Phase 6.1 strategy routing services.
     *
     * Must be called after setCrossSystemServices() (if used).
     * When not called, strategy routing is inactive.
     */
    setStrategyRoutingServices(
        engine: import('./crossSystem/StrategyRoutingEngine').StrategyRoutingEngine,
        outcomeTracker: import('./crossSystem/StrategyRoutingOutcomeTracker').StrategyRoutingOutcomeTracker,
    ): void {
        this._strategyRoutingEngine = engine;
        this._strategyRoutingOutcomeTracker = outcomeTracker;
    }

    /**
     * Returns the Phase 6.1 strategy routing dashboard state, or null if not active.
     */
    getStrategyRoutingDashboardState(): import('../../../shared/strategyRoutingTypes').StrategyRoutingDashboardState | null {
        return this._strategyRoutingEngine?.getDashboardState() ?? null;
    }

    /**
     * Processes the strategy routing queue: picks up 'eligible' routing decisions
     * and materializes them into actual goals or campaigns through the existing
     * planning → governance → execution / campaign pipelines.
     *
     * This is called from runCycleOnce() after candidate detection.
     * No-op when strategy routing services are not active.
     */
    async processStrategyRoutingQueue(): Promise<void> {
        if (!this._strategyRoutingEngine) return;

        const eligible = this._strategyRoutingEngine.listDecisions({ status: ['eligible'] });
        if (eligible.length === 0) return;

        for (const decision of eligible) {
            try {
                await this._materializeRoutingDecision(decision);
            } catch (err: any) {
                telemetry.operational(
                    'autonomy',
                    'operational',
                    'warn',
                    'AutonomousRunOrchestrator',
                    `[P6.1] Materialization failed for routing decision ` +
                    `${decision.routingDecisionId}: ${err.message}`,
                );
            }
        }
    }

    /**
     * Materializes a single eligible routing decision into a goal or campaign.
     * Routes through the existing planning / governance / execution / campaign pipelines.
     * No special bypass path exists.
     */
    private async _materializeRoutingDecision(
        decision: import('../../../shared/strategyRoutingTypes').StrategyRoutingDecision,
    ): Promise<void> {
        if (!this._strategyRoutingEngine) return;

        const { routingTargetType } = decision;

        switch (routingTargetType) {
            case 'autonomous_goal': {
                const goalId = this._injectStrategyRoutingGoal(decision);
                if (goalId) {
                    this._strategyRoutingEngine.markRouted(decision.routingDecisionId, {
                        actionType: 'autonomous_goal',
                        actionId: goalId,
                        createdAt: new Date().toISOString(),
                        status: 'pending',
                    });
                    telemetry.operational(
                        'autonomy',
                        'operational',
                        'info',
                        'AutonomousRunOrchestrator',
                        `[P6.1] strategy_routed_to_goal: routingDecisionId=${decision.routingDecisionId} goalId=${goalId}`,
                    );
                }
                break;
            }

            case 'repair_campaign': {
                const campaignId = await this._injectStrategyRepairCampaign(decision);
                if (campaignId) {
                    this._strategyRoutingEngine.markRouted(decision.routingDecisionId, {
                        actionType: 'repair_campaign',
                        actionId: campaignId,
                        createdAt: new Date().toISOString(),
                        status: 'active',
                    });
                    telemetry.operational(
                        'autonomy',
                        'operational',
                        'info',
                        'AutonomousRunOrchestrator',
                        `[P6.1] strategy_routed_to_campaign: routingDecisionId=${decision.routingDecisionId} campaignId=${campaignId}`,
                    );
                }
                break;
            }

            case 'harmonization_campaign': {
                const hCampaignId = await this._injectStrategyHarmonizationCampaign(decision);
                if (hCampaignId) {
                    this._strategyRoutingEngine.markRouted(decision.routingDecisionId, {
                        actionType: 'harmonization_campaign',
                        actionId: hCampaignId,
                        createdAt: new Date().toISOString(),
                        status: 'active',
                    });
                    telemetry.operational(
                        'autonomy',
                        'operational',
                        'info',
                        'AutonomousRunOrchestrator',
                        `[P6.1] strategy_routed_to_campaign: routingDecisionId=${decision.routingDecisionId} hCampaignId=${hCampaignId}`,
                    );
                }
                break;
            }

            default:
                // human_review and deferred are already persisted by the engine — no action needed
                break;
        }
    }

    /**
     * Injects a strategy-routing-sourced autonomous goal into the normal goal pipeline.
     *
     * The goal enters at 'scored' status with 'high' priority tier and passes through
     * the standard AutonomyPolicyGate → SafeChangePlanner → Governance → Execution path.
     * No bypass exists.
     *
     * Returns the goalId, or null if the goal was not created (e.g. duplicate fingerprint).
     */
    private _injectStrategyRoutingGoal(
        decision: import('../../../shared/strategyRoutingTypes').StrategyRoutingDecision,
    ): string | null {
        // Dedup: prevent the same routing decision from creating the goal twice
        const fingerprint = `strategy-routing-${decision.clusterId}-${decision.routingDecisionId}`;
        const alreadyExists = [...this.activeGoals.values()].some(
            g => g.dedupFingerprint === fingerprint,
        );
        if (alreadyExists) {
            telemetry.operational(
                'autonomy',
                'operational',
                'debug',
                'AutonomousRunOrchestrator',
                `[P6.1] Duplicate fingerprint — skipping goal injection for routing decision ${decision.routingDecisionId}`,
            );
            return null;
        }

        const goalId = `goal-${uuidv4()}`;
        const now = new Date().toISOString();

        const goal: import('../../../shared/autonomyTypes').AutonomousGoal = {
            goalId,
            createdAt: now,
            updatedAt: now,
            source: 'strategy_routing',
            subsystemId: this._extractSubsystemFromDecision(decision),
            title: `[Strategy Routing] ${decision.strategyKind} — ${decision.scopeSummary.slice(0, 80)}`,
            description: decision.rationale,
            status: 'scored',
            priorityTier: 'high',
            priorityScore: {
                total: 70,
                severityWeight: 20,
                recurrenceWeight: 15,
                subsystemImportanceWeight: 12,
                confidenceWeight: 12,
                governanceLikelihoodWeight: 5,
                rollbackConfidenceWeight: 6,
                executionCostPenalty: 0,
                protectedPenalty: 0,
            },
            autonomyEligible: false, // set by policyGate.evaluate()
            attemptCount: 0,
            humanReviewRequired: false,
            sourceContext: {
                kind: 'generic',
                detail: `strategy_routing:${decision.routingDecisionId}:cluster:${decision.clusterId}`,
            },
            dedupFingerprint: fingerprint,
        };

        this.activeGoals.set(goalId, goal);
        this.auditService.saveGoal(goal);
        this.auditService.appendAuditRecord(
            'goal_created',
            `[P6.1 Strategy Routing] Goal created from routing decision ${decision.routingDecisionId}`,
            { goalId, subsystemId: goal.subsystemId },
        );

        telemetry.operational(
            'autonomy',
            'operational',
            'info',
            'AutonomousRunOrchestrator',
            `[P6.1] Goal injected from strategy routing: goalId=${goalId} ` +
            `subsystem=${goal.subsystemId} routingDecisionId=${decision.routingDecisionId}`,
        );

        // Queue for execution via the standard pipeline on next cycle
        this._selectAndExecuteGoal(goal);

        return goalId;
    }

    /**
     * Creates a RepairCampaign from a strategy routing decision.
     * Uses the existing RepairCampaignPlanner + RepairCampaignCoordinator pipeline.
     * No bypass of existing campaign safety guards.
     *
     * Returns the campaignId, or null if the campaign could not be created.
     */
    private async _injectStrategyRepairCampaign(
        decision: import('../../../shared/strategyRoutingTypes').StrategyRoutingDecision,
    ): Promise<string | null> {
        if (!this._campaignPlanner || !this._campaignCoordinator) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'AutonomousRunOrchestrator',
                `[P6.1] Cannot inject repair campaign — campaign services not active.`,
            );
            return null;
        }

        const subsystem = this._extractSubsystemFromDecision(decision);
        const label = `[Strategy Campaign] ${decision.strategyKind} — ${decision.scopeSummary.slice(0, 60)}`;
        const goalId = `strategy-goal-${decision.routingDecisionId}`;

        // Build using 'repair_template' fallback with bounded step count
        // Cap at 4 steps (matches STRATEGY_ROUTING_BOUNDS.MAX_STRATEGY_CAMPAIGN_STEPS)
        const maxSteps = 4;

        // Try to build from the first available template; fall back to manual 1-step plan
        const templates = this._campaignPlanner.listTemplates();
        let campaign = null;
        if (templates.length > 0) {
            campaign = this._campaignPlanner.buildFromTemplate(
                templates[0].templateId,
                goalId,
                subsystem,
                { maxSteps },
            );
        }

        if (!campaign) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'AutonomousRunOrchestrator',
                `[P6.1] RepairCampaignPlanner could not build campaign for routing decision ${decision.routingDecisionId}`,
            );
            return null;
        }

        // Override label to carry strategy routing provenance
        (campaign as any).label = label;

        this._campaignRegistry?.save(campaign);
        const activated = this._campaignCoordinator.activateCampaign(campaign.campaignId);
        if (!activated) return null;

        return campaign.campaignId;
    }

    /**
     * Creates a HarmonizationCampaign from a strategy routing decision.
     * No harmonization campaigns are created if the harmonization coordinator is unavailable.
     * Returns the campaignId, or null if the campaign could not be created.
     */
    private async _injectStrategyHarmonizationCampaign(
        decision: import('../../../shared/strategyRoutingTypes').StrategyRoutingDecision,
    ): Promise<string | null> {
        if (!this._harmonizationCoordinator) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'AutonomousRunOrchestrator',
                `[P6.1] Cannot inject harmonization campaign — harmonization services not active.`,
            );
            return null;
        }

        telemetry.operational(
            'autonomy',
            'operational',
            'info',
            'AutonomousRunOrchestrator',
            `[P6.1] Harmonization campaign routing deferred to harmonization scan loop ` +
            `for routing decision ${decision.routingDecisionId}. ` +
            `The scan loop will detect drift and create the campaign automatically.`,
        );

        // The harmonization coordinator creates campaigns from its own drift-scan loop.
        // Strategy routing surfaces the intent; the scan loop materializes it.
        // Return the routing decision ID as a placeholder so the action reference is set.
        return `harmonization-deferred-${decision.routingDecisionId}`;
    }

    /**
     * Extracts the primary subsystem ID from a routing decision.
     * Falls back to 'unknown' when no cluster subsystem data is available.
     */
    private _extractSubsystemFromDecision(
        decision: import('../../../shared/strategyRoutingTypes').StrategyRoutingDecision,
    ): string {
        // The scopeSummary usually starts with subsystem info; use clusterId as fallback key
        return `cross-system-${decision.clusterId.slice(-8)}`;
    }

    /**
     * Ingests a cross-system signal from any subsystem.
     * No-op when Phase 6 services are not active.
     * Called from the run pipeline's finally block and from harmonization/campaign hooks.
     */
    ingestCrossSystemSignal(
        signal: import('../../../shared/crossSystemTypes').CrossSystemSignal,
    ): void {
        this._crossSystemCoordinator?.ingestSignal(signal);
    }

    /**
     * Executes a single campaign step through the existing planning → governance → execution pipeline.
     *
     * This is the bridge between the campaign layer and the existing execution gates.
     * It is called by the RepairCampaignCoordinator via the step executor callback.
     *
     * All Phase 2 / 3.5 / 3 safety gates are preserved — this method is a thin
     * wrapper that constructs a PlanTriggerInput from the step and delegates to
     * the existing planning, governance, and execution path.
     *
     * Returns a CampaignStepExecutionResult describing what happened.
     */
    async executeCampaignStep(
        step: import('../../../shared/repairCampaignTypes').CampaignStep,
        campaign: import('../../../shared/repairCampaignTypes').RepairCampaign,
    ): Promise<import('./campaigns/CampaignCheckpointEngine').CampaignStepExecutionResult> {
        try {
            // Build a PlanTriggerInput from the campaign step
            const planInput = this._buildCampaignStepPlanInput(step, campaign);

            // Phase 2: Plan
            const planResponse = await this.safePlanner.plan(planInput);
            if (!planResponse) {
                return {
                    executionRunId: `no-proposal-${Date.now()}`,
                    executionSucceeded: false,
                    rollbackTriggered: false,
                    failureReason: 'SafeChangePlanner did not produce a response for this campaign step',
                };
            }

            // Poll for the actual SafeChangeProposal produced by this plan run
            let proposal = this.safePlanner.listProposals(4 * 60 * 60 * 1000)
                .find(p => p.runId === planResponse.runId);
            if (!proposal) {
                for (let i = 0; i < 9 && !proposal; i++) {
                    await this._delay(50);
                    proposal = this.safePlanner.listProposals(4 * 60 * 60 * 1000)
                        .find(p => p.runId === planResponse.runId);
                }
            }

            if (!proposal) {
                return {
                    executionRunId: `no-proposal-${Date.now()}`,
                    executionSucceeded: false,
                    rollbackTriggered: false,
                    failureReason: 'Planning completed but no proposal was generated for this campaign step',
                };
            }

            // Phase 2: Promote proposal
            this.safePlanner.promoteProposal(proposal.proposalId);

            // Phase 3.5: Governance evaluation
            const govDecision = this.governanceAppService.evaluateForProposal(proposal);
            if (!govDecision.executionAuthorized) {
                return {
                    executionRunId: `gov-blocked-${Date.now()}`,
                    executionSucceeded: false,
                    rollbackTriggered: false,
                    failureReason: `Governance blocked campaign step: ${govDecision.blockReason ?? 'not authorized'}`,
                };
            }

            // Phase 3: Execute
            const execResponse = await this.executionOrchestrator.start({
                proposalId: proposal.proposalId,
                authorizedBy: 'user_explicit',
                dryRun: false,
            });

            if (execResponse.blocked) {
                return {
                    executionRunId: `exec-blocked-${Date.now()}`,
                    executionSucceeded: false,
                    rollbackTriggered: false,
                    failureReason: `Execution blocked: ${execResponse.message}`,
                };
            }

            const executionRunId = execResponse.executionId;

            // Poll for terminal state (reuse existing _waitForExecution)
            const terminalStatus = await this._waitForExecution(executionRunId);
            const succeeded = terminalStatus === 'succeeded';
            const rolledBack = terminalStatus === 'rolled_back';

            return {
                executionRunId,
                executionSucceeded: succeeded,
                rollbackTriggered: rolledBack,
                failureReason: succeeded ? undefined : `Execution ended with status: ${terminalStatus}`,
            };
        } catch (err: any) {
            return {
                executionRunId: `error-${Date.now()}`,
                executionSucceeded: false,
                rollbackTriggered: false,
                failureReason: err.message ?? 'Campaign step execution threw unexpectedly',
            };
        }
    }

    /**
     * Builds a PlanTriggerInput from a campaign step.
     */
    private _buildCampaignStepPlanInput(
        step: import('../../../shared/repairCampaignTypes').CampaignStep,
        campaign: import('../../../shared/repairCampaignTypes').RepairCampaign,
    ): PlanTriggerInput {
        return {
            subsystemId: step.targetSubsystem,
            issueType: 'campaign_step_repair',
            normalizedTarget: step.scopeHint || step.targetSubsystem,
            severity: 'medium',
            description: `[Campaign step] ${step.label} ` +
                `(campaign: ${campaign.label}, step ${step.order + 1}/${campaign.steps.length})`,
            planningMode: 'standard',
            sourceGoalId: campaign.goalId,
            isManual: false,
        };
    }

    /**
     * Builds a PlanTriggerInput from a harmonization step.
     * Used by executeHarmonizationStep().
     */
    private _buildHarmonizationStepPlanInput(
        filePath: string,
        campaign: import('../../../shared/harmonizationTypes').HarmonizationCampaign,
        metadata: import('../../../shared/harmonizationTypes').HarmonizationProposalMetadata,
    ): PlanTriggerInput {
        return {
            subsystemId: campaign?.scope?.targetSubsystem ?? 'harmonization',
            issueType: 'harmonization_step',
            normalizedTarget: filePath,
            severity: 'low',
            description:
                `[Harmonization step] Converge ${filePath} to canon rule: ` +
                `${metadata.intendedConvergence.slice(0, 120)} ` +
                `(rule: ${metadata.ruleId}, campaign: ${metadata.campaignId})`,
            planningMode: 'standard',
            sourceGoalId: metadata.campaignId,
            isManual: false,
        };
    }

    /**
     * Returns the Phase 5.1 escalation dashboard state, or null if escalation services are not active.
     */
    getEscalationDashboardState(): EscalationDashboardState | null {
        if (!this._escalationAuditTracker || !this._decompositionOutcomeTracker) return null;

        const auditCounts = this._escalationAuditTracker.getCountByKind();
        const decompKpis = this._decompositionOutcomeTracker.getKpis();

        const kpis: EscalationKpis = {
            totalAssessments: this._recentAssessments.length,
            totalCapableAssessments: this._recentAssessments.filter(a => a.canHandle).length,
            totalIncapableAssessments: this._recentAssessments.filter(a => !a.canHandle).length,
            totalEscalationRequests: auditCounts.get('escalation_requested') ?? 0,
            totalEscalationsAllowed: auditCounts.get('escalation_allowed') ?? 0,
            totalEscalationsDenied: auditCounts.get('escalation_denied') ?? 0,
            totalDecompositions: decompKpis.total,
            totalDecompositionsSucceeded: decompKpis.succeeded + decompKpis.partial,
            totalDecompositionsFailed: decompKpis.failed,
            totalDeferredByEscalation: this._recentStrategyDecisions.filter(d => d.strategy === 'defer').length,
            totalHumanEscalations: this._recentStrategyDecisions.filter(d => d.strategy === 'escalate_human').length,
        };

        return {
            computedAt: new Date().toISOString(),
            kpis,
            recentAssessments: [...this._recentAssessments],
            recentStrategyDecisions: [...this._recentStrategyDecisions],
            recentDecompositionPlans: [...this._recentDecompositionPlans],
            recentDecompositionResults: this._decompositionOutcomeTracker.getRecent(20),
            recentAuditRecords: this._escalationAuditTracker.getRecent(50),
            activeDecompositions: this._decompositionOutcomeTracker.getActiveCount(),
            policy: { ...this._escalationPolicy },
        };
    }

    start(cycleIntervalMs = 5 * 60 * 1000): void {
        this.detectionEngine.start(cycleIntervalMs);
    }

    stop(): void {
        this.detectionEngine.stop();
        if (this.cycleTimer) {
            clearInterval(this.cycleTimer);
            this.cycleTimer = null;
        }
        this.telemetryStore.stopAutoFlush();
    }

    // ── Manual trigger (IPC + testing) ─────────────────────────────────────────

    /**
     * Manually triggers one detection+scoring+execution cycle.
     * Safe to call from tests and from the IPC handler.
     */
    async runCycleOnce(): Promise<void> {
        if (this._cycleRunning) {
            telemetry.operational(
                'autonomy',
                'autonomy_run_failed',
                'warn',
                'AutonomousRunOrchestrator',
                'runCycleOnce skipped: cycle already running',
            );
            return;
        }

        this._cycleRunning = true;
        try {
            // 1. Detect candidates
            const candidates = await this.detectionEngine.runOnce();

            // 2. Phase 6.1: Process strategy routing queue (non-fatal)
            try {
                await this.processStrategyRoutingQueue();
            } catch (routingErr: any) {
                telemetry.operational(
                    'autonomy',
                    'operational',
                    'warn',
                    'AutonomousRunOrchestrator',
                    `[P6.1] processStrategyRoutingQueue failed (non-fatal): ${routingErr.message}`,
                );
            }

            if (candidates.length === 0) return;

            this._onCandidatesDetected(candidates);
        } finally {
            this._cycleRunning = false;
        }
    }

    // ── Dashboard data ──────────────────────────────────────────────────────────

    getDashboardState(): import('../../../shared/autonomyTypes').AutonomyDashboardState {
        const allRuns = [...this.activeRuns.values()].sort(
            (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        );
        const allGoals = [...this.activeGoals.values()].sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
        const learningRecords = this.learningRegistry.listAll();
        const recentTelemetry = this.telemetryStore.getRecentEvents(50);
        const budgetUsed = this.budgetManager.getUsedThisPeriod(this.activePolicy.budget);

        const state = this.dashboardBridge.emitFull(
            allRuns, allGoals, learningRecords, recentTelemetry,
            this.activePolicy, budgetUsed,
        );

        // ── Phase 4.3: Augment with recovery pack summaries ──────────────────
        if (this._packOutcomeTracker) {
            const allPacks = this._packRegistry?.getAll() ?? [];
            state.recoveryPackSummaries = allPacks.map(pack =>
                this._packOutcomeTracker!.getOutcomeSummary(pack.packId),
            );
        }

        // ── Phase 5: Augment with adaptive state ─────────────────────────────
        const adaptiveState = this.getAdaptiveDashboardState();
        if (adaptiveState) {
            state.adaptiveState = adaptiveState;
        }

        // ── Phase 5.1: Augment with escalation state ──────────────────────────
        const escalationState = this.getEscalationDashboardState();
        if (escalationState) {
            state.escalationState = escalationState;
        }

        // ── Phase 5.5: Augment with campaign state ────────────────────────────
        const campaignState = this.getCampaignDashboardState();
        if (campaignState) {
            state.campaignState = campaignState;
        }

        // ── Phase 5.6: Augment with harmonization state ───────────────────────
        const harmonizationState = this.getHarmonizationDashboardState();
        if (harmonizationState) {
            (state as any).harmonizationState = harmonizationState;
        }

        // ── Phase 6.1: Augment with strategy routing state ────────────────────
        const strategyRoutingState = this.getStrategyRoutingDashboardState();
        if (strategyRoutingState) {
            state.strategyRoutingState = strategyRoutingState;
        }

        return state;
    }

    listGoals(): AutonomousGoal[] {
        return [...this.activeGoals.values()].sort(
            (a, b) => b.priorityScore.total - a.priorityScore.total,
        );
    }

    getGoal(goalId: string): AutonomousGoal | null {
        return this.activeGoals.get(goalId) ?? null;
    }

    listRuns(windowMs?: number): AutonomousRun[] {
        return this.auditService.listRuns(windowMs);
    }

    getRun(runId: string): AutonomousRun | null {
        return this.activeRuns.get(runId) ?? this.auditService.loadRun(runId);
    }

    getAuditLog(goalId: string): import('./AutonomyAuditService').AutonomyAuditRecord[] {
        return this.auditService.readAuditLog(goalId);
    }

    // ── Policy management ───────────────────────────────────────────────────────

    setGlobalEnabled(enabled: boolean): void {
        this.activePolicy = { ...this.activePolicy, globalAutonomyEnabled: enabled };
        this.auditService.appendAuditRecord('global_autonomy_toggled',
            `Global autonomy ${enabled ? 'enabled' : 'disabled'}`,
        );
        telemetry.operational(
            'autonomy',
            'operational',
            'info',
            'AutonomousRunOrchestrator',
            `Global autonomy ${enabled ? 'enabled' : 'disabled'} by operator`,
        );
    }

    getPolicy(): AutonomyPolicy {
        return { ...this.activePolicy };
    }

    updatePolicy(policy: AutonomyPolicy): void {
        this.activePolicy = policy;
        this.auditService.appendAuditRecord('policy_updated', 'Autonomy policy updated by operator');
    }

    clearCooldown(subsystemId: string, patternKey: string): boolean {
        const cleared = this.cooldownRegistry.clearCooldown(subsystemId, patternKey);
        if (cleared) {
            this.auditService.appendAuditRecord(
                'cooldown_cleared_by_operator',
                `Cooldown manually cleared for ${subsystemId}`,
                { subsystemId },
            );
        }
        return cleared;
    }

    // ── Candidate intake ────────────────────────────────────────────────────────

    private _onCandidatesDetected(candidates: import('../../../shared/autonomyTypes').GoalCandidate[]): void {
        const newCandidates = candidates.filter(c => !c.isDuplicate);
        if (newCandidates.length === 0) return;

        // Score all candidates
        const scoredGoals = this.prioritizationEngine.score(newCandidates, this.activePolicy);

        // Register goals and persist
        for (const goal of scoredGoals) {
            this.activeGoals.set(goal.goalId, goal);
            this.auditService.saveGoal(goal);
            this.auditService.appendAuditRecord('goal_created',
                `Goal '${goal.title}' created (tier: ${goal.priorityTier}, score: ${goal.priorityScore.total})`,
                { goalId: goal.goalId, subsystemId: goal.subsystemId },
            );
            this.telemetryStore.record('goal_scored',
                `Goal '${goal.title}' scored ${goal.priorityScore.total} (${goal.priorityTier})`,
                { goalId: goal.goalId, subsystemId: goal.subsystemId },
            );
        }

        // Select the best eligible goal for this cycle
        const eligible = scoredGoals.filter(g => g.status === 'scored' && g.priorityTier !== 'suppressed');
        if (eligible.length === 0) return;

        const selected = eligible[0]; // Highest-scored non-suppressed goal
        this._selectAndExecuteGoal(selected);
    }

    private _selectAndExecuteGoal(goal: AutonomousGoal): void {
        // Update goal status
        this._updateGoal(goal.goalId, { status: 'selected' });
        this.telemetryStore.record('goal_selected',
            `Goal '${goal.title}' selected for autonomous execution`,
            { goalId: goal.goalId, subsystemId: goal.subsystemId },
        );

        // Policy gate evaluation
        const policyDecision = this.policyGate.evaluate(goal, this.activePolicy);
        this._updateGoal(goal.goalId, { policyDecisionId: policyDecision.decisionId });

        this.auditService.appendAuditRecord(
            policyDecision.permitted ? 'policy_approved' : 'policy_blocked',
            policyDecision.rationale,
            { goalId: goal.goalId, subsystemId: goal.subsystemId },
        );

        this.telemetryStore.record(
            policyDecision.permitted ? 'policy_approved' : 'policy_blocked',
            policyDecision.rationale,
            { goalId: goal.goalId, subsystemId: goal.subsystemId, data: { decisionId: policyDecision.decisionId } },
        );

        if (!policyDecision.permitted) {
            const newStatus = policyDecision.requiresHumanReview ? 'policy_blocked' : 'suppressed';
            this._updateGoal(goal.goalId, {
                status: newStatus,
                humanReviewRequired: policyDecision.requiresHumanReview,
            });
            return;
        }

        // Mark goal as policy-approved
        this._updateGoal(goal.goalId, { status: 'policy_approved', autonomyEligible: true });

        // ── Phase 5: Adaptive Intelligence Layer (optional) ───────────────────
        // Applied AFTER P4D permit. Never overrides a P4D block.
        let adaptiveStrategyResult: StrategySelectionResult | undefined;

        if (this._adaptiveValueScorer && this._adaptiveStrategyEngine && this._adaptiveGate
            && this._adaptiveProfileRegistry) {
            try {
                const profile = this._adaptiveProfileRegistry.get(goal.subsystemId);

                // Get pack match for strategy selection (reuse existing pack matching logic)
                const attemptCounts = this._packOutcomeTracker
                    ? this._packOutcomeTracker.getAttemptCountsForGoal(goal.goalId)
                    : new Map<string, number>();
                const packMatchResult = this._packMatcher
                    ? this._packMatcher.match(
                        goal,
                        this.activePolicy.hardBlockedSubsystems,
                        attemptCounts,
                    )
                    : undefined;

                const valueScore = this._adaptiveValueScorer.score(
                    goal, profile, packMatchResult,
                );
                const strategyResult = this._adaptiveStrategyEngine.select(
                    goal, valueScore, profile, packMatchResult, DEFAULT_ADAPTIVE_THRESHOLDS,
                );
                const adaptiveDecision = this._adaptiveGate.evaluate(
                    goal, policyDecision, valueScore, strategyResult, profile,
                    DEFAULT_ADAPTIVE_THRESHOLDS,
                );

                // Track in in-memory log (capped at 20, newest first)
                this._recentValueScores = [valueScore, ...this._recentValueScores].slice(0, 20);
                this._recentStrategySelections = [strategyResult, ...this._recentStrategySelections].slice(0, 20);
                this._recentAdaptiveDecisions = [adaptiveDecision, ...this._recentAdaptiveDecisions].slice(0, 20);

                this.telemetryStore.record('goal_scored',
                    `[Adaptive] ${goal.title}: valueScore=${valueScore.valueScore}, ` +
                    `strategy=${strategyResult.strategy}, decision=${adaptiveDecision.action}`,
                    { goalId: goal.goalId, subsystemId: goal.subsystemId, data: {
                        valueScore: valueScore.valueScore,
                        strategy: strategyResult.strategy,
                        action: adaptiveDecision.action,
                        reasonCodes: adaptiveDecision.reasonCodes,
                    } },
                );
                this.auditService.appendAuditRecord(
                    'policy_approved',
                    `[P5 Adaptive] decision=${adaptiveDecision.action}: ${adaptiveDecision.reason}`,
                    { goalId: goal.goalId, subsystemId: goal.subsystemId },
                );

                if (adaptiveDecision.action !== 'proceed') {
                    // defer → keep goal as 'scored' for next cycle
                    // suppress → mark suppressed
                    // escalate → mark as policy_blocked, route to human review
                    let newStatus: import('../../../shared/autonomyTypes').GoalStatus;
                    let humanReviewRequired = false;

                    if (adaptiveDecision.action === 'escalate') {
                        newStatus = 'policy_blocked';
                        humanReviewRequired = true;
                    } else if (adaptiveDecision.action === 'suppress') {
                        newStatus = 'suppressed';
                    } else {
                        // defer: reset to scored so the goal is eligible next cycle
                        newStatus = 'scored';
                    }

                    this._updateGoal(goal.goalId, { status: newStatus, humanReviewRequired });
                    return;
                }

                // Proceed — pass strategy result to the pipeline for informed pack selection
                adaptiveStrategyResult = strategyResult;

            } catch (err: any) {
                // Adaptive layer errors must never block the pipeline
                telemetry.operational(
                    'autonomy',
                    'operational',
                    'warn',
                    'AutonomousRunOrchestrator',
                    `[P5 Adaptive] Error in adaptive layer for goal ${goal.goalId}: ${err.message}. ` +
                    `Falling back to Phase 4 behavior.`,
                );
                // adaptiveStrategyResult stays undefined → Phase 4 pack selection used
            }
        }
        // ── End Phase 5 ────────────────────────────────────────────────────────

        // ── Phase 5.1: Model Escalation & Bounded Decomposition (optional) ────
        // Applied AFTER Phase 5 adaptive gate (proceed). Never overrides a Phase 5 block.
        // Errors in this layer must never block the pipeline — fallback to proceed_local.
        if (this._capabilityEvaluator && this._escalationPolicyEngine
            && this._decompositionEngine && this._strategySelector
            && this._escalationAuditTracker && this._decompositionOutcomeTracker) {
            try {
                // Count recent local failures for this goal from the learning registry
                const recentFailures = this._getRecentFailuresForSubsystem(goal.subsystemId);

                // Assess whether the active model can handle this goal
                const assessment = this._capabilityEvaluator.evaluate(
                    goal,
                    recentFailures,
                    this._escalationPolicy,
                );

                // Track assessment in dashboard log (capped at 20, newest first)
                this._recentAssessments = [assessment, ...this._recentAssessments].slice(0, 20);

                this._escalationAuditTracker.record(
                    goal.goalId, 'capability_assessed',
                    assessment.rationale,
                    undefined,
                    { canHandle: assessment.canHandle, reasons: assessment.insufficiencyReasons },
                );

                if (!assessment.canHandle) {
                    // Evaluate escalation policy
                    const recentEscalationCount = this._escalationAuditTracker.getRecentEscalationCount(
                        60 * 60 * 1000, // 1-hour window
                    );
                    const cooldownActive = this._decompositionOutcomeTracker.isCooldownActive(
                        goal.subsystemId,
                    );

                    const { decision: escalationDecision, request } =
                        this._escalationPolicyEngine.evaluate(
                            assessment,
                            this._escalationPolicy,
                            recentEscalationCount,
                            cooldownActive,
                        );

                    if (request) {
                        this._escalationAuditTracker.record(
                            goal.goalId, 'escalation_requested',
                            request.rationale,
                            undefined,
                            { requestId: request.requestId },
                        );
                    }

                    this._escalationAuditTracker.record(
                        goal.goalId,
                        escalationDecision.escalationAllowed ? 'escalation_allowed' : 'escalation_denied',
                        escalationDecision.rationale,
                    );

                    // Build decomposition plan (only if policy allows; cooldown respected inside engine)
                    const decompositionPlan = !cooldownActive
                        ? this._decompositionEngine.decompose(
                            goal, assessment, this._escalationPolicy, 0,
                        )
                        : null;

                    if (decompositionPlan) {
                        this._escalationAuditTracker.record(
                            goal.goalId, 'decomposition_planned',
                            decompositionPlan.rationale,
                            undefined,
                            { planId: decompositionPlan.planId, steps: decompositionPlan.totalSteps },
                        );
                        this._recentDecompositionPlans = [decompositionPlan, ...this._recentDecompositionPlans].slice(0, 20);
                    }

                    // Select execution strategy
                    const strategyDecision = this._strategySelector.select(
                        assessment, escalationDecision, decompositionPlan, this._escalationPolicy,
                    );

                    // Track strategy decision
                    this._recentStrategyDecisions = [strategyDecision, ...this._recentStrategyDecisions].slice(0, 20);
                    this._escalationAuditTracker.record(
                        goal.goalId, 'strategy_selected',
                        strategyDecision.reason,
                        undefined,
                        { strategy: strategyDecision.strategy, reasonCodes: strategyDecision.reasonCodes },
                    );

                    this.telemetryStore.record(
                        'goal_scored',
                        `[P5.1 Escalation] ${goal.title}: strategy=${strategyDecision.strategy}. ` +
                        strategyDecision.reason,
                        { goalId: goal.goalId, subsystemId: goal.subsystemId, data: {
                            strategy: strategyDecision.strategy,
                            reasonCodes: strategyDecision.reasonCodes,
                            canHandle: assessment.canHandle,
                        } },
                    );
                    this.auditService.appendAuditRecord(
                        'policy_approved',
                        `[P5.1 Escalation] strategy=${strategyDecision.strategy}: ${strategyDecision.reason}`,
                        { goalId: goal.goalId, subsystemId: goal.subsystemId },
                    );

                    if (strategyDecision.strategy !== 'proceed_local') {
                        if (strategyDecision.strategy === 'escalate_human'
                            || strategyDecision.strategy === 'escalate_remote') {
                            // Route to human review (escalate_remote also goes through human approval
                            // unless requireHumanApprovalForRemote=false, which is off by default)
                            this._updateGoal(goal.goalId, {
                                status: 'policy_blocked',
                                humanReviewRequired: true,
                            });
                            this._escalationAuditTracker.record(
                                goal.goalId, 'fallback_applied',
                                `Goal routed to human review via strategy '${strategyDecision.strategy}'.`,
                            );
                        } else if (strategyDecision.strategy === 'defer') {
                            // Re-queue for next cycle
                            this._updateGoal(goal.goalId, { status: 'scored' });
                            this._escalationAuditTracker.record(
                                goal.goalId, 'fallback_applied',
                                `Goal deferred to next cycle by escalation layer.`,
                            );
                        } else if (strategyDecision.strategy === 'decompose_local'
                            && decompositionPlan) {
                            // Execute decomposition — use first step scope as plan hint
                            this._decompositionOutcomeTracker.startPlan(
                                decompositionPlan, goal.subsystemId,
                            );
                            this._escalationAuditTracker.record(
                                goal.goalId, 'decomposition_started',
                                `Decomposition plan ${decompositionPlan.planId} started ` +
                                `(${decompositionPlan.totalSteps} steps).`,
                                undefined,
                                { planId: decompositionPlan.planId },
                            );
                            // Execute first step's scope as the primary pipeline run
                            const firstStepHint = decompositionPlan.steps[0]?.scopeHint;
                            const currentGoal = this.activeGoals.get(goal.goalId)!;
                            this._executeGoalPipeline(
                                currentGoal,
                                policyDecision.decisionId,
                                adaptiveStrategyResult,
                                decompositionPlan,
                                firstStepHint,
                            ).catch(err => {
                                telemetry.operational(
                                    'autonomy',
                                    'autonomy_run_failed',
                                    'error',
                                    'AutonomousRunOrchestrator',
                                    `[P5.1] Unhandled error in decomposition pipeline for goal ` +
                                    `${goal.goalId}: ${err.message}`,
                                );
                            });
                            return;
                        }
                        return;
                    }
                    // strategy === 'proceed_local': continue to standard pipeline despite insufficiency
                }
            } catch (err: any) {
                // Escalation layer errors must NEVER block the main pipeline
                telemetry.operational(
                    'autonomy',
                    'operational',
                    'warn',
                    'AutonomousRunOrchestrator',
                    `[P5.1 Escalation] Error in escalation layer for goal ${goal.goalId}: ${err.message}. ` +
                    `Falling back to standard execution.`,
                );
            }
        }
        // ── End Phase 5.1 ─────────────────────────────────────────────────────

        // Execute asynchronously (fire-and-forget with error capture)
        this._executeGoalPipeline(
            this.activeGoals.get(goal.goalId)!, policyDecision.decisionId, adaptiveStrategyResult,
        ).catch(err => {
            telemetry.operational(
                'autonomy',
                'autonomy_run_failed',
                'error',
                'AutonomousRunOrchestrator',
                `Unhandled error in pipeline for goal ${goal.goalId}: ${err.message}`,
                );
            });
    }

    // ── Execution pipeline ──────────────────────────────────────────────────────

    private async _executeGoalPipeline(
        goal: AutonomousGoal,
        policyDecisionId: string,
        adaptiveStrategyResult?: StrategySelectionResult,
        decompositionPlan?: DecompositionPlan,
        decompositionScopeHint?: string,
    ): Promise<void> {
        const cycleId = uuidv4();
        const runId = uuidv4();
        const run: AutonomousRun = {
            runId,
            goalId: goal.goalId,
            cycleId,
            startedAt: new Date().toISOString(),
            status: 'running',
            subsystemId: goal.subsystemId,
            policyDecisionId,
            milestones: [],
            // ── Phase 5.1: Link to decomposition plan when executing under decomposition ──
            decompositionPlanId: decompositionPlan?.planId,
            decompositionStepIndex: decompositionPlan ? 0 : undefined,
            // ── Runtime Execution Vocabulary ──
            executionId: runId,
            runtimeExecutionType: 'autonomy_task',
            runtimeExecutionOrigin: 'autonomy_engine',
        };
        // Capture numeric start time from run.startedAt as the single source of truth
        // for duration tracking — mirrors KernelExecutionMeta.startedAt (Date.now()).
        const startedAtMs = Date.parse(run.startedAt);

        this.activeRuns.set(run.runId, run);
        this.budgetManager.recordRunStart(run.runId, goal.subsystemId);

        // ── Register with ExecutionStateStore for cross-seam lifecycle tracking ──
        this._stateStore.beginExecution(
            createExecutionRequest({
                executionId: run.runId,
                type: 'autonomy_task',
                origin: 'autonomy_engine',
                mode: 'system',
                actor: 'autonomy_engine',
                input: { goalId: goal.goalId, subsystemId: goal.subsystemId },
            }),
            'AutonomousRunOrchestrator',
        );

        // ── TelemetryBus: execution lifecycle (mirrors AgentKernel schema) ──────
        const intakePayload = { type: 'autonomy_task', origin: 'autonomy_engine', mode: 'system' } as const;
        TelemetryBus.getInstance().emit({
            executionId: run.runId,
            subsystem: 'kernel',
            event: 'execution.created',
            phase: 'intake',
            payload: intakePayload,
        });
        TelemetryBus.getInstance().emit({
            executionId: run.runId,
            subsystem: 'kernel',
            event: 'execution.accepted',
            phase: 'intake',
            payload: intakePayload,
        });

        this._addMilestone(run, 'run_started');
        this.auditService.saveRun(run);
        this.auditService.appendAuditRecord('run_started',
            `Autonomous run started for goal '${goal.title}'`,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this.telemetryStore.record('run_started',
            `Run ${run.runId} started for goal '${goal.title}'`,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this._updateGoal(goal.goalId, { status: 'planning', executionRunId: undefined });

        this._emitDashboard('run_started', run);

        try {
            // ── Phase 2: Safe Change Planning ────────────────────────────────────
            this._updateRunStatus(run, 'planning');
            this._addMilestone(run, 'planning_started');
            this.telemetryStore.record('planning_started',
                `Planning started for goal '${goal.title}'`,
                { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
            );

            const planInput: PlanTriggerInput = await this._buildPlanInput(goal, run, adaptiveStrategyResult, decompositionScopeHint);

            const planResponse = await this.safePlanner.plan(planInput);

            if (planResponse.status === 'cooldown_blocked' || planResponse.status === 'failed') {
                this._failRun(run, goal, `Planning ${planResponse.status}: ${planResponse.message}`);
                return;
            }

            run.planRunId = planResponse.runId;
            this.auditService.saveRun(run);

            // Poll for the proposal produced by this run (up to 500ms in 50ms increments)
            let proposal = this.safePlanner.listProposals(4 * 60 * 60 * 1000)
                .find(p => p.runId === planResponse.runId);
            if (!proposal) {
                for (let i = 0; i < 9 && !proposal; i++) {
                    await this._delay(50);
                    proposal = this.safePlanner.listProposals(4 * 60 * 60 * 1000)
                        .find(p => p.runId === planResponse.runId);
                }
            }

            if (!proposal) {
                this._failRun(run, goal, 'Planning completed but no proposal was generated');
                return;
            }

            run.proposalId = proposal.proposalId;
            this._addMilestone(run, 'proposal_created');
            this.auditService.saveRun(run);

            this.telemetryStore.record('proposal_created',
                `Proposal ${proposal.proposalId} created`,
                { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
            );

            // ── Phase 2: Promote proposal ─────────────────────────────────────────
            if (proposal.status === 'draft' || proposal.status === 'classified') {
                const promoted = this.safePlanner.promoteProposal(proposal.proposalId);
                if (!promoted) {
                    this._failRun(run, goal, `Could not promote proposal ${proposal.proposalId} (status: ${proposal.status})`);
                    return;
                }
            }

            // ── Phase 3.5: Governance evaluation ─────────────────────────────────
            this._addMilestone(run, 'governance_submitted');
            this.auditService.appendAuditRecord('governance_submitted',
                `Governance evaluation triggered for proposal ${proposal.proposalId}`,
                { goalId: goal.goalId, runId: run.runId },
            );

            // evaluateForProposal is also called automatically by the onProposalPromoted callback
            // in main.ts, but we call it here explicitly to ensure it exists.
            const govDecision = this.governanceAppService.evaluateForProposal(
                this.safePlanner.listProposals(4 * 60 * 60 * 1000)
                    .find(p => p.proposalId === proposal.proposalId) ?? proposal,
            );

            run.governanceDecisionId = govDecision.decisionId;
            this.auditService.saveRun(run);

            // Check governance outcome
            if (govDecision.status === 'blocked' || govDecision.status === 'rejected') {
                this._governanceBlockedRun(run, goal, `Governance ${govDecision.status}: ${govDecision.blockReason ?? 'policy blocked'}`);
                return;
            }

            if (!govDecision.executionAuthorized) {
                // Governance requires human approval — move to governance_pending
                // Do NOT proceed; surface in dashboard for human action.
                this._updateRunStatus(run, 'governance_pending');
                this._updateGoal(goal.goalId, { status: 'governance_pending', governanceDecisionId: govDecision.decisionId });
                this.auditService.saveRun(run);
                this.telemetryStore.record('governance_submitted',
                    `Run ${run.runId} awaiting human governance approval`,
                    { goalId: goal.goalId, runId: run.runId },
                );
                this._emitDashboard('governance_resolved', run);
                // Run stays in governance_pending — will be resumed when governance approves
                return;
            }

            // Governance self-authorized → proceed
            this._addMilestone(run, 'governance_resolved', 'self_authorized');
            this._emitDashboard('governance_resolved', run);

            // ── Phase 3: Controlled Execution ─────────────────────────────────────
            this._updateRunStatus(run, 'executing');
            this._addMilestone(run, 'execution_started');
            this._updateGoal(goal.goalId, { status: 'executing' });

            this.telemetryStore.record('execution_started',
                `Execution started for proposal ${proposal.proposalId}`,
                { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
            );
            this._emitDashboard('execution_started', run);

            // --- POLICY GATE: autonomy action pre-check ---
            // Fires after governance approval, before controlled execution starts.
            // PolicyDeniedError propagates to the outer catch; the run is failed there.
            policyGate.assertSideEffect({
                actionKind: 'autonomy_action',
                executionId: run.runId,
                executionType: 'autonomy_task',
                executionOrigin: 'autonomy_engine',
                executionMode: 'system',
                targetSubsystem: 'autonomy',
                mutationIntent: 'execute',
            });

            const execResponse = await this.executionOrchestrator.start({
                proposalId: proposal.proposalId,
                // 'user_explicit' is the only value accepted by ExecutionStartRequest.
                // In the autonomy pipeline this represents that Tala (acting as the operator)
                // has explicitly authorized this run through the governance gate above.
                authorizedBy: 'user_explicit',
                dryRun: false,
            });

            if (execResponse.blocked) {
                this._failRun(run, goal, `Execution blocked: ${execResponse.message}`);
                return;
            }

            run.executionRunId = execResponse.executionId;
            this.auditService.saveRun(run);

            // Poll for execution terminal state
            const terminalStatus = await this._waitForExecution(execResponse.executionId);
            this._addMilestone(run, 'execution_completed', terminalStatus);
            this._emitDashboard('execution_completed', run);

            const outcome = this._outcomeFromExecutionStatus(terminalStatus);
            this._addMilestone(run, 'outcome_recorded');
            this.auditService.appendAuditRecord('outcome_recorded',
                `Execution outcome: ${terminalStatus}`,
                { goalId: goal.goalId, runId: run.runId },
            );

            // Apply outcome to run and goal
            const finalRunStatus = this._runStatusFromOutcome(outcome);
            this._updateRunStatus(run, finalRunStatus);
            run.completedAt = new Date().toISOString();
            this._updateGoal(goal.goalId, { status: finalRunStatus as any });
            this.auditService.saveRun(run);

            // Apply cooldown for non-success outcomes
            if (outcome === 'rolled_back') {
                this.cooldownRegistry.recordCooldown(goal.subsystemId, goal.dedupFingerprint, 'rollback', this.activePolicy.budget);
                this.telemetryStore.record('cooldown_applied', `Rollback cooldown applied for ${goal.subsystemId}`,
                    { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId });
            } else if (outcome === 'failed') {
                this.cooldownRegistry.recordCooldown(goal.subsystemId, goal.dedupFingerprint, 'execution_failure', this.activePolicy.budget);
            }

            this._addMilestone(run, outcome === 'succeeded' ? 'run_completed' : 'run_failed');
            this._emitDashboard(outcome === 'succeeded' ? 'run_completed' : 'run_failed', run);

        } catch (err: any) {
            // PolicyDeniedError is not an execution failure — re-throw so callers
            // know the action was blocked by policy rather than by an internal error.
            if (err instanceof PolicyDeniedError) throw err;
            this._abortRun(run, goal, `Unhandled error: ${err.message}`);
        } finally {
            // Always record learning and release budget slot
            const finalGoal = this.activeGoals.get(goal.goalId)!;
            const finalRun = this.activeRuns.get(run.runId)!;
            const outcome = this._outcomeFromRunStatus(finalRun.status);

            // ── TelemetryBus: terminal lifecycle event (mirrors AgentKernel schema) ──
            const durationMs = Date.now() - startedAtMs;
            if (outcome === 'succeeded') {
                // Advance state to 'finalizing' before sealing (mirrors AgentKernel.finalizeExecution)
                this._stateStore.advancePhase(run.runId, 'finalizing', 'finalizing');
                TelemetryBus.getInstance().emit({
                    executionId: run.runId,
                    subsystem: 'kernel',
                    event: 'execution.finalizing',
                    phase: 'finalizing',
                    payload: { type: 'autonomy_task', origin: 'autonomy_engine', mode: 'system', durationMs },
                });
                TelemetryBus.getInstance().emit({
                    executionId: run.runId,
                    subsystem: 'kernel',
                    event: 'execution.completed',
                    phase: 'finalizing',
                    payload: { type: 'autonomy_task', origin: 'autonomy_engine', mode: 'system', durationMs },
                });
                this._stateStore.completeExecution(run.runId);
            } else {
                const failureReason = finalRun.failureReason ?? finalRun.abortReason ?? outcome;
                TelemetryBus.getInstance().emit({
                    executionId: run.runId,
                    subsystem: 'kernel',
                    event: 'execution.failed',
                    phase: 'failed',
                    payload: {
                        type: 'autonomy_task',
                        origin: 'autonomy_engine',
                        mode: 'system',
                        failureReason,
                    },
                });
                this._stateStore.failExecution(run.runId, failureReason);
            }

            const learningRecord = this.learningRegistry.record(finalGoal, finalRun, outcome);
            this._updateGoal(goal.goalId, { learningRecordId: learningRecord.recordId });

            this.telemetryStore.record('outcome_learned',
                `Learning recorded for pattern ${goal.dedupFingerprint}: ${outcome}`,
                { goalId: goal.goalId, runId: run.runId },
            );
            this.auditService.appendAuditRecord('outcome_recorded',
                `Learning record created: ${learningRecord.recordId}`,
                { goalId: goal.goalId, runId: run.runId },
            );

            // ── Phase 4.3: Record recovery pack outcome if a pack was used ─────
            if (this._packOutcomeTracker && finalRun.recoveryPackId) {
                const packOutcome = this._packOutcomeFromRunOutcome(outcome);
                this._packOutcomeTracker.record(
                    finalRun.recoveryPackId,
                    finalGoal,
                    finalRun,
                    packOutcome,
                );
                this.telemetryStore.record('recovery_pack_outcome_recorded',
                    `Recovery pack ${finalRun.recoveryPackId} outcome '${packOutcome}' recorded`,
                    { goalId: goal.goalId, runId: run.runId },
                );
            }

            // ── Phase 5: Update subsystem adaptive profile (feedback loop) ────
            if (this._adaptiveProfileRegistry) {
                // Determine strategy actually used (pack if recoveryPackId set, else standard)
                const strategyUsed = adaptiveStrategyResult?.strategy
                    ?? (finalRun.recoveryPackId ? 'recovery_pack' : 'standard_planning');
                this._adaptiveProfileRegistry.update(
                    goal.subsystemId,
                    outcome,
                    strategyUsed,
                    finalRun.recoveryPackId,
                );
            }

            // ── Phase 5.1: Record decomposition step outcome (feedback loop) ──
            if (this._decompositionOutcomeTracker && decompositionPlan) {
                const step = decompositionPlan.steps[0];
                if (step) {
                    const stepOutcome: import('../../../shared/escalationTypes').DecompositionStepOutcome =
                        outcome === 'succeeded' ? 'succeeded'
                        : outcome === 'rolled_back' ? 'rolled_back'
                        : 'failed';
                    this._decompositionOutcomeTracker.recordStep(
                        decompositionPlan.planId,
                        step,
                        stepOutcome,
                        finalRun.executionRunId,
                        finalRun.failureReason,
                    );
                    const result = this._decompositionOutcomeTracker.finalizePlan(
                        decompositionPlan.planId,
                        this._escalationPolicy.decompositionCooldownMs,
                    );
                    if (result && this._escalationAuditTracker) {
                        this._escalationAuditTracker.record(
                            goal.goalId,
                            result.overallOutcome === 'failed'
                                ? 'decomposition_failed'
                                : 'decomposition_completed',
                            result.rationale,
                            run.runId,
                            { planId: decompositionPlan.planId, outcome: result.overallOutcome },
                        );
                    }
                    this.telemetryStore.record(
                        'outcome_learned',
                        `[P5.1] Decomposition ${decompositionPlan.planId} outcome: ${result?.overallOutcome ?? 'unknown'}`,
                        { goalId: goal.goalId, runId: run.runId },
                    );
                }
            }

            this.budgetManager.recordRunEnd(run.runId);
        }
    }

    // ── Governance-pending resume ───────────────────────────────────────────────

    /**
     * Called when a governance decision resolves (human approval).
     * Resumes runs that are in 'governance_pending' state.
     */
    async checkPendingGovernanceRuns(): Promise<void> {
        const pendingRuns = [...this.activeRuns.values()].filter(r => r.status === 'governance_pending');

        for (const run of pendingRuns) {
            if (!run.proposalId) continue;

            const decision = this.governanceAppService.getDecision(run.proposalId);
            if (!decision) continue;

            if (decision.executionAuthorized) {
                await this._resumeGovernancePendingRun(run);
            } else if (decision.status === 'blocked' || decision.status === 'rejected') {
                const goal = this.activeGoals.get(run.goalId);
                if (goal) this._governanceBlockedRun(run, goal, `Governance ${decision.status}`);
            }
        }
    }

    private async _resumeGovernancePendingRun(run: AutonomousRun): Promise<void> {
        if (!run.proposalId) return;
        const goal = this.activeGoals.get(run.goalId);
        if (!goal) return;

        this._updateRunStatus(run, 'executing');
        this._addMilestone(run, 'governance_resolved', 'human_approved');
        this._emitDashboard('governance_resolved', run);
        this._updateGoal(goal.goalId, { status: 'executing' });

        try {
            const execResponse = await this.executionOrchestrator.start({
                proposalId: run.proposalId,
                authorizedBy: 'user_explicit',
                dryRun: false,
            });

            if (execResponse.blocked) {
                this._failRun(run, goal, `Execution blocked after governance approval: ${execResponse.message}`);
                return;
            }

            run.executionRunId = execResponse.executionId;
            this.auditService.saveRun(run);

            const terminalStatus = await this._waitForExecution(execResponse.executionId);
            const outcome = this._outcomeFromExecutionStatus(terminalStatus);
            const finalRunStatus = this._runStatusFromOutcome(outcome);
            this._updateRunStatus(run, finalRunStatus);
            run.completedAt = new Date().toISOString();
            this._updateGoal(goal.goalId, { status: finalRunStatus as any });
            this.auditService.saveRun(run);
        } finally {
            const finalRun = this.activeRuns.get(run.runId)!;
            const outcome = this._outcomeFromRunStatus(finalRun.status);
            this.learningRegistry.record(goal, finalRun, outcome);
            this.budgetManager.recordRunEnd(run.runId);
            // ── Phase 4.3.1: Record recovery pack outcome on resume path ──────
            if (this._packOutcomeTracker && finalRun.recoveryPackId) {
                const packOutcome = this._packOutcomeFromRunOutcome(outcome);
                this._packOutcomeTracker.record(
                    finalRun.recoveryPackId,
                    goal,
                    finalRun,
                    packOutcome,
                );
                this.telemetryStore.record('recovery_pack_outcome_recorded',
                    `Recovery pack ${finalRun.recoveryPackId} outcome '${packOutcome}' recorded (resume path)`,
                    { goalId: goal.goalId, runId: run.runId },
                );
            }
        }
    }

    // ── Run state helpers ───────────────────────────────────────────────────────

    private _failRun(run: AutonomousRun, goal: AutonomousGoal, reason: string): void {
        run.failureReason = reason;
        this._updateRunStatus(run, 'failed');
        run.completedAt = new Date().toISOString();
        this._updateGoal(goal.goalId, { status: 'failed' });
        this.auditService.saveRun(run);
        this.auditService.appendAuditRecord('run_failed', reason,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this.telemetryStore.record('execution_failed', reason,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this.cooldownRegistry.recordCooldown(goal.subsystemId, goal.dedupFingerprint, 'execution_failure', this.activePolicy.budget);
        this._addMilestone(run, 'run_failed', reason);
        this._emitDashboard('run_failed', run);
    }

    private _governanceBlockedRun(run: AutonomousRun, goal: AutonomousGoal, reason: string): void {
        run.failureReason = reason;
        this._updateRunStatus(run, 'governance_blocked');
        run.completedAt = new Date().toISOString();
        this._updateGoal(goal.goalId, {
            status: 'governance_blocked',
            humanReviewRequired: true,
        });
        this.auditService.saveRun(run);
        this.auditService.appendAuditRecord('governance_resolved', reason,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this.telemetryStore.record('governance_blocked', reason,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this.cooldownRegistry.recordCooldown(goal.subsystemId, goal.dedupFingerprint, 'governance_block', this.activePolicy.budget);
        this._addMilestone(run, 'run_aborted', 'governance_blocked');
        this._emitDashboard('run_aborted', run);
    }

    private _abortRun(run: AutonomousRun, goal: AutonomousGoal, reason: string): void {
        run.abortReason = reason;
        this._updateRunStatus(run, 'aborted');
        run.completedAt = new Date().toISOString();
        this._updateGoal(goal.goalId, { status: 'failed' });
        this.auditService.saveRun(run);
        this.auditService.appendAuditRecord('run_aborted', reason,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this.telemetryStore.record('execution_failed', reason,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this._addMilestone(run, 'run_aborted', reason);
        this._emitDashboard('run_aborted', run);
    }

    private _updateRunStatus(run: AutonomousRun, status: AutonomousRunStatus): void {
        run.status = status;
        this.activeRuns.set(run.runId, run);
    }

    private _updateGoal(goalId: string, updates: Partial<AutonomousGoal>): void {
        const goal = this.activeGoals.get(goalId);
        if (!goal) return;
        const updated = { ...goal, ...updates, updatedAt: new Date().toISOString() };
        this.activeGoals.set(goalId, updated);
        this.auditService.saveGoal(updated);
    }

    private _addMilestone(
        run: AutonomousRun,
        name: AutonomousRunMilestoneName,
        detail?: string,
    ): void {
        const milestone: AutonomousRunMilestone = {
            name,
            reachedAt: new Date().toISOString(),
            detail,
        };
        run.milestones.push(milestone);
        this.activeRuns.set(run.runId, run);
    }

    private _emitDashboard(milestone: AutonomousRunMilestoneName, _run: AutonomousRun): void {
        const allRuns = [...this.activeRuns.values()];
        const allGoals = [...this.activeGoals.values()];
        const learningRecords = this.learningRegistry.listAll();
        const recentTelemetry = this.telemetryStore.getRecentEvents(50);
        const budgetUsed = this.budgetManager.getUsedThisPeriod(this.activePolicy.budget);

        this.dashboardBridge.maybeEmit(
            milestone, allRuns, allGoals, learningRecords, recentTelemetry,
            this.activePolicy, budgetUsed,
        );
    }

    // ── Execution polling ───────────────────────────────────────────────────────

    private async _waitForExecution(executionId: string): Promise<string> {
        const TERMINAL = new Set([
            'succeeded', 'rolled_back', 'aborted', 'execution_blocked',
        ]);
        const deadline = Date.now() + EXECUTION_POLL_TIMEOUT_MS;

        while (Date.now() < deadline) {
            await this._delay(EXECUTION_POLL_INTERVAL_MS);
            const run = this.executionOrchestrator.getRunStatus(executionId);
            if (!run) return 'aborted';
            if (TERMINAL.has(run.status)) return run.status;
        }

        return 'aborted'; // Timeout
    }

    // ── Recovery ────────────────────────────────────────────────────────────────

    private _recoverStaleRuns(): void {
        const runs = this.auditService.listRuns();
        const NON_TERMINAL = new Set<AutonomousRunStatus>([
            'pending', 'running', 'planning', 'governance_pending', 'executing',
        ]);

        for (const run of runs) {
            if (NON_TERMINAL.has(run.status)) {
                if (run.status === 'governance_pending') {
                    // Keep these — they are awaiting human review
                    this.activeRuns.set(run.runId, run);
                    continue;
                }
                // Stale active run — mark as aborted
                run.status = 'aborted';
                run.abortReason = 'stale_on_startup';
                run.completedAt = new Date().toISOString();
                this.auditService.saveRun(run);
                this.activeRuns.set(run.runId, run);

                telemetry.operational(
                    'autonomy',
                    'operational',
                    'warn',
                    'AutonomousRunOrchestrator',
                    `Stale run ${run.runId} recovered as aborted on startup`,
                );
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    private _delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private _severityForTier(tier: string): 'low' | 'medium' | 'high' | 'critical' {
        switch (tier) {
            case 'critical': return 'critical';
            case 'high':     return 'high';
            case 'medium':   return 'medium';
            default:         return 'low';
        }
    }

    private _outcomeFromExecutionStatus(status: string): AttemptOutcome {
        switch (status) {
            case 'succeeded':    return 'succeeded';
            case 'rolled_back':  return 'rolled_back';
            case 'aborted':      return 'aborted';
            default:             return 'failed';
        }
    }

    private _outcomeFromRunStatus(status: AutonomousRunStatus): AttemptOutcome {
        switch (status) {
            case 'succeeded':         return 'succeeded';
            case 'rolled_back':       return 'rolled_back';
            case 'governance_blocked': return 'governance_blocked';
            case 'policy_blocked':    return 'policy_blocked';
            case 'aborted':           return 'aborted';
            case 'governance_pending': return 'aborted'; // Not yet resolved
            default:                  return 'failed';
        }
    }

    private _runStatusFromOutcome(outcome: AttemptOutcome): AutonomousRunStatus {
        switch (outcome) {
            case 'succeeded':   return 'succeeded';
            case 'rolled_back': return 'rolled_back';
            default:            return 'failed';
        }
    }

    /**
     * Returns legacy SelfImprovementGoal records for stale-goal detection.
     *
     * NOTE: SafeChangePlanner does not expose legacy SelfImprovementGoal records.
     * Stale reflection-goal detection is intentionally not implemented in the
     * current phase. The GoalDetectionEngine handles this gracefully by receiving
     * an empty array and producing zero candidates from this source.
     *
     * Future: wire to a GoalService if one is introduced that persists goals
     * independently of the planning run registry.
     */
    private async _listReflectionGoals(): Promise<any[]> {
        return [];
    }

    // ── Phase 4.3: Recovery Pack helpers ─────────────────────────────────────────

    /**
     * Builds the PlanTriggerInput for a goal.
     *
     * Attempts recovery pack matching first (if pack services are available).
     * On a successful match, the pack adapter produces a bounded, scoped input.
     * On no match, adapter error, or missing pack services, falls back to the
     * standard PlanTriggerInput construction.
     *
     * Phase 5 enhancement:
     *   If adaptiveStrategyResult is provided and strategy === 'standard_planning',
     *   pack matching is skipped and standard planning is used directly.
     *   If strategy === 'recovery_pack' with a selectedPackId, that pack is preferred.
     *
     * SAFETY: If any exception occurs during pack matching or adaptation,
     * the exception is caught and logged, and standard planning proceeds.
     * Recovery packs must never block or crash the planning pipeline.
     */
    private async _buildPlanInput(
        goal: AutonomousGoal,
        run: AutonomousRun,
        adaptiveStrategyResult?: StrategySelectionResult,
        decompositionScopeHint?: string,
    ): Promise<PlanTriggerInput> {
        const standardInput: PlanTriggerInput = {
            subsystemId: goal.subsystemId,
            issueType: goal.source,
            normalizedTarget: goal.subsystemId,
            severity: this._severityForTier(goal.priorityTier),
            // ── Phase 5.1: Narrow description to decomposition scope when executing under a plan ──
            description: decompositionScopeHint
                ? `[Decomposed scope: ${decompositionScopeHint}] ${goal.description}`
                : goal.description,
            planningMode: 'standard',
            sourceGoalId: goal.goalId,
            isManual: false,
        };

        // ── Phase 5: Adaptive strategy hint ──────────────────────────────────
        // If adaptive layer decided 'standard_planning', skip pack matching.
        if (adaptiveStrategyResult?.strategy === 'standard_planning') {
            this.telemetryStore.record('recovery_pack_fallback',
                `[P5 Adaptive] Standard planning selected — skipping pack matching for goal ${goal.goalId}`,
                { goalId: goal.goalId, runId: run.runId },
            );
            return standardInput;
        }

        if (!this._packMatcher || !this._packPlannerAdapter || !this._packRegistry) {
            return standardInput;
        }

        try {
            // Get per-pack attempt counts for this goal to enforce maxAttemptsPerGoal
            const attemptCounts = this._packOutcomeTracker
                ? this._packOutcomeTracker.getAttemptCountsForGoal(goal.goalId)
                : new Map<string, number>();

            const matchResult = this._packMatcher.match(
                goal,
                this.activePolicy.hardBlockedSubsystems,
                attemptCounts,
            );

            this.telemetryStore.record('recovery_pack_match_attempted',
                `Pack match for goal ${goal.goalId}: ${matchResult.selectedPackId ?? 'no_match'}`,
                { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
            );

            if (matchResult.fallbackToStandardPlanning || !matchResult.selectedPackId) {
                this.telemetryStore.record('recovery_pack_fallback',
                    `No pack matched for goal ${goal.goalId} — using standard planning. ${matchResult.rationale}`,
                    { goalId: goal.goalId, runId: run.runId },
                );
                return standardInput;
            }

            const pack = this._packRegistry.getById(matchResult.selectedPackId);
            if (!pack) {
                this.telemetryStore.record('recovery_pack_rejected',
                    `Pack ${matchResult.selectedPackId} was selected but not found in registry — rejected.`,
                    { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
                );
                return standardInput;
            }

            const adaptedInput = this._packPlannerAdapter.buildPlanInput(goal, pack, matchResult);
            if (!adaptedInput) {
                this.telemetryStore.record('recovery_pack_rejected',
                    `Pack ${pack.packId} adapter returned null — pack rejected, falling back to standard planning.`,
                    { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
                );
                return standardInput;
            }

            // Pack match succeeded — record on run for audit and dashboard
            run.recoveryPackId = pack.packId;
            run.recoveryPackMatchStrength = matchResult.selectedMatchStrength;
            this.auditService.saveRun(run);

            this.telemetryStore.record('recovery_pack_matched',
                `Pack ${pack.packId} (${matchResult.selectedMatchStrength}) used for goal ${goal.goalId}`,
                { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
            );
            this.auditService.appendAuditRecord('run_started',
                `Recovery pack ${pack.packId} v${pack.version} matched (${matchResult.selectedMatchStrength})`,
                { goalId: goal.goalId, runId: run.runId },
            );

            return adaptedInput;

        } catch (err: any) {
            // Exception in pack layer → log and fall back to standard planning
            this.telemetryStore.record('recovery_pack_fallback',
                `Exception in recovery pack matching: ${err.message} — falling back to standard planning.`,
                { goalId: goal.goalId, runId: run.runId },
            );
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'AutonomousRunOrchestrator',
                `Recovery pack matching threw an error for goal ${goal.goalId}: ${err.message}`,
            );
            return standardInput;
        }
    }

    /**
     * Maps an AttemptOutcome to a RecoveryPackExecutionOutcome.
     * Only outcomes that can occur when a pack is used are returned.
     */
    private _packOutcomeFromRunOutcome(outcome: AttemptOutcome): RecoveryPackExecutionOutcome {
        switch (outcome) {
            case 'succeeded':         return 'succeeded';
            case 'rolled_back':       return 'rolled_back';
            case 'governance_blocked': return 'governance_blocked';
            case 'aborted':           return 'aborted';
            default:                  return 'failed';
        }
    }

    /**
     * Returns the count of recent failed runs for the given subsystem.
     * Used by Phase 5.1 ModelCapabilityEvaluator to assess repeated local failures.
     * Looks at completed runs in the last 4 hours.
     */
    private _getRecentFailuresForSubsystem(subsystemId: string): number {
        const windowMs = 4 * 60 * 60 * 1000; // 4 hours
        const cutoff = Date.now() - windowMs;
        return [...this.activeRuns.values()].filter(r =>
            r.subsystemId === subsystemId
            && (r.status === 'failed' || r.status === 'rolled_back' || r.status === 'aborted')
            && new Date(r.startedAt).getTime() >= cutoff,
        ).length;
    }
}

