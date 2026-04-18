/**
 * PlanningService.ts — Goal → Plan → Execution handoff lifecycle authority
 *
 * PlanningService is the single authority for:
 *   - goal intake and registration
 *   - deterministic goal analysis (via GoalAnalyzer)
 *   - structured plan construction (via PlanBuilder)
 *   - approval-state handling for plans requiring sign-off
 *   - replan generation with full traceability
 *   - planning state transitions
 *   - execution handoff metadata / signalling
 *
 * PlanningService is NOT the authority for:
 *   - running workflows, invoking tools, or executing LLM calls
 *   - performing operator actions
 *   - mutating canonical memory outside its own planning records
 *   - bypassing PolicyGate, ToolExecutionCoordinator, AgentKernel,
 *     OperatorActionService, or any other existing execution authority
 *
 * Design invariants
 * ─────────────────
 * 1. No execution — PlanningService prepares the handoff; it does not
 *    perform the actual work described in a plan.
 * 2. Traceability — replanning always generates a new versioned plan;
 *    prior plans are preserved in 'superseded' state with bidirectional links.
 * 3. Honest state — blocked analysis produces a blocked plan; no fake readiness.
 * 4. Approval gating — plans requiring approval must reach 'approved' state
 *    before a planning.execution_handoff event is emitted.
 * 5. Telemetry — lifecycle events are emitted for all significant transitions.
 * 6. Observable — getGoal / getPlan / listPlansForGoal expose planning state
 *    without requiring callers to maintain their own copies.
 *
 * Architecture position
 * ─────────────────────
 *   User / Autonomy / Reflection / Operator
 *     → PlanningService.registerGoal(input)
 *       → GoalAnalyzer.analyze(goal, capabilities)
 *         → PlanBuilder.build({ goal, analysis })
 *           → PlanningRepository (goal + plan storage)
 *             → TelemetryBus (lifecycle events)
 *               → Downstream execution authority (WorkflowExecutionService /
 *                 ToolExecutionCoordinator / AgentKernel / OperatorActionService)
 *
 * Usage
 * ─────
 * const svc = PlanningService.getInstance();
 * const goal = await svc.registerGoal({ title: '...', ... });
 * const analysis = await svc.analyzeGoal(goal.id);
 * const plan = await svc.buildPlan(goal.id);
 * if (plan.requiresApproval) await svc.approvePlan(plan.id, 'operator:user-123');
 * await svc.markExecutionStarted(plan.id);
 * await svc.markExecutionCompleted(plan.id);
 */

import { v4 as uuidv4 } from 'uuid';
import { TelemetryBus } from '../telemetry/TelemetryBus';
import { GoalAnalyzer } from './GoalAnalyzer';
import { PlanBuilder } from './PlanBuilder';
import { PlanningRepository } from './PlanningRepository';
import { PlanningEpisodeRepository } from './PlanningEpisodeRepository';
import { PlanningContextBuilder, type PlanningContextRuntimeState } from './PlanningContextBuilder';
import { StrategySelector } from './StrategySelector';
import {
    detectMemoryAuthorityViolationError,
    memoryAuthorityGate,
} from '../memory/MemoryAuthorityGate';
import type {
    PlanGoal,
    PlanGoalSource,
    PlanGoalCategory,
    PlanGoalPriority,
    ExecutionPlan,
    GoalAnalysis,
    PlanningInvocationMetadata,
    ReplanRequest,
    ReplanPolicy,
} from '../../../shared/planning/PlanningTypes';
import type {
    MemoryAuthorityContext,
    MemoryWriteCategory,
    MemoryWriteRequest,
    MemoryWriteSource,
} from '../../../shared/memoryAuthorityTypes';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** Input for registering a new goal. */
export interface RegisterGoalInput {
    title: string;
    description: string;
    source: PlanGoalSource;
    category: PlanGoalCategory;
    priority?: PlanGoalPriority;
    constraints?: string[];
    successCriteria?: string[];
    metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PlanningService errors
// ---------------------------------------------------------------------------

export class PlanningError extends Error {
    constructor(
        message: string,
        public readonly code: string,
    ) {
        super(message);
        this.name = 'PlanningError';
    }
}

// ---------------------------------------------------------------------------
// PlanningService
// ---------------------------------------------------------------------------

export class PlanningService {
    private static _instance: PlanningService | null = null;

    private readonly _repo: PlanningRepository;
    private readonly _episodeRepo: PlanningEpisodeRepository;
    private readonly _contextBuilder: PlanningContextBuilder;
    private readonly _bus: TelemetryBus;

    /**
     * Available capabilities injected by the caller.
     * PlanningService itself does not query the runtime for capabilities;
     * callers (e.g. AgentService/main.ts) inject the current capability set
     * via setAvailableCapabilities() before the first analyzeGoal call.
     */
    private _availableCapabilities: ReadonlySet<string> = new Set();

    /**
     * Optional non-manual capability provider.
     * When registered, analyzeGoal() calls this function first and uses its
     * result in preference to the manually-injected capability set.
     * Allows PlanningService to stay current without explicit calls to
     * setAvailableCapabilities() on every capability change.
     */
    private _capabilityProvider?: () => ReadonlySet<string>;
    private _runtimeStateProvider?: () => PlanningContextRuntimeState;
    private _runtimeState: PlanningContextRuntimeState = {
        inferenceAvailable: true,
        postgresAvailable: true,
        semanticRetrievalAvailable: true,
        networkAvailable: true,
        degradedSubsystems: [],
    };

    /**
     * Replan policy — configures per-goal replan limits and cooldown.
     */
    private _replanPolicy: ReplanPolicy = { maxReplans: 5, cooldownMs: 30_000 };

    /**
     * Per-goal replan count.  Tracks how many times replan() has succeeded
     * for each goal.  Cleared when the singleton is reset.
     */
    private readonly _replanCounts = new Map<string, number>();

    /**
     * Per-goal timestamp of the last successful replan call (Date.now() ms).
     * Used to enforce the cooldown window.
     */
    private readonly _lastReplanAt = new Map<string, number>();
    private readonly _episodeIdsByPlanId = new Map<string, string>();

    private constructor(repo?: PlanningRepository) {
        this._repo = repo ?? new PlanningRepository();
        this._episodeRepo = new PlanningEpisodeRepository();
        this._contextBuilder = new PlanningContextBuilder(this._episodeRepo);
        this._bus = TelemetryBus.getInstance();
    }

    /** Returns the process-wide singleton PlanningService instance. */
    static getInstance(): PlanningService {
        if (!PlanningService._instance) {
            PlanningService._instance = new PlanningService();
        }
        return PlanningService._instance;
    }

    /**
     * Resets the singleton.  Intended for use in tests only.
     * A custom repository may be supplied for full isolation.
     */
    static _resetForTesting(repo?: PlanningRepository): void {
        PlanningService._instance = repo !== undefined
            ? new PlanningService(repo)
            : null;
    }

    /**
     * Updates the set of available runtime capabilities used during analysis.
     * Must be called before analyzeGoal() for accurate missing-capability detection.
     *
     * @param capabilities - Names of capabilities currently available
     *   (e.g. 'rag', 'workflow_engine', 'inference', 'tool_execution').
     */
    setAvailableCapabilities(capabilities: ReadonlySet<string>): void {
        this._availableCapabilities = capabilities;
    }

    /**
     * Registers a non-manual capability provider function.
     *
     * When a provider is registered, analyzeGoal() calls it on every analysis
     * to retrieve the current capability set, rather than relying solely on the
     * last setAvailableCapabilities() snapshot.  This eliminates the need for
     * callers to explicitly refresh capabilities before every analysis.
     *
     * The provider is called synchronously during analyzeGoal().  It must be
     * cheap to call (no I/O, no network), returning the current snapshot of
     * available capability names.
     *
     * @param provider - Zero-argument function returning the current capability set.
     */
    registerCapabilityProvider(provider: () => ReadonlySet<string>): void {
        this._capabilityProvider = provider;
    }

    /**
     * Registers a runtime-state provider for planning-memory strategy selection.
     * Provider output is deterministic and must not perform network I/O.
     */
    registerRuntimeStateProvider(provider: () => PlanningContextRuntimeState): void {
        this._runtimeStateProvider = provider;
    }

    /**
     * Sets a static runtime-state snapshot used when no provider is registered.
     */
    setRuntimeState(state: PlanningContextRuntimeState): void {
        this._runtimeState = { ...state };
    }

    /**
     * Configures the replan policy for this service instance.
     *
     * Replanning beyond maxReplans per goal throws REPLAN_LIMIT_EXCEEDED.
     * Replanning within cooldownMs of the previous replan throws REPLAN_COOLDOWN_ACTIVE.
     *
     * @param policy - Replan limits and cooldown configuration.
     */
    setReplanPolicy(policy: ReplanPolicy): void {
        this._replanPolicy = { ...policy };
    }

    private _normalizePlanningInvocation(
        metadata?: PlanningInvocationMetadata,
    ): PlanningInvocationMetadata {
        return metadata ?? {
            invokedBy: 'system',
            invocationReason: 'legacy_unspecified',
        };
    }

    private _resolveMemoryWriteSource(invocation: PlanningInvocationMetadata): MemoryWriteSource {
        if (invocation.invokedBy === 'agent_kernel') return 'agent_kernel';
        if (invocation.invokedBy === 'planning_loop') return 'planning_loop';
        if (invocation.invokedBy === 'system') return 'system';
        return 'planning_service';
    }

    private _buildMemoryAuthorityContext(
        invocation: PlanningInvocationMetadata,
        goalId?: string,
    ): MemoryAuthorityContext {
        const turnMode = invocation.turnMode;
        const authorityEnvelope = invocation.turnId && turnMode
            ? {
                turnId: invocation.turnId,
                mode: turnMode,
                authorityLevel: invocation.authorityLevel ?? 'none',
                workflowAuthority: turnMode !== 'conversational',
                canCreateDurableState: invocation.authorityLevel === 'full_authority',
                canReplan: turnMode === 'goal_execution',
            }
            : undefined;
        return {
            turnId: invocation.turnId,
            goalId,
            turnMode,
            memoryWriteMode: invocation.memoryWriteMode,
            authorityEnvelope,
            systemAuthority: invocation.invokedBy === 'system',
        };
    }

    private _assertMemoryWriteAllowed(
        category: MemoryWriteCategory,
        invocation: PlanningInvocationMetadata,
        opts: {
            goalId?: string;
            episodeType?: string;
            payload?: Record<string, unknown>;
        },
    ): void {
        const request: MemoryWriteRequest = {
            writeId: `mem-write-${uuidv4()}`,
            category,
            source: this._resolveMemoryWriteSource(invocation),
            turnId: invocation.turnId,
            goalId: opts.goalId,
            episodeType: opts.episodeType,
            payload: opts.payload ?? {},
        };
        const context = this._buildMemoryAuthorityContext(invocation, opts.goalId);
        try {
            memoryAuthorityGate.assertAllowed(request, context);
        } catch (err) {
            if (detectMemoryAuthorityViolationError(err)) {
                throw new PlanningError(
                    `Memory authority denied for ${category}: ${err.decision.reasonCodes.join(',')}`,
                    'MEMORY_AUTHORITY_DENIED',
                );
            }
            throw err;
        }
    }

    private _emitMemoryWriteCompleted(
        category: MemoryWriteCategory,
        invocation: PlanningInvocationMetadata,
        opts: { goalId?: string; payload?: Record<string, unknown> },
    ): void {
        const context = this._buildMemoryAuthorityContext(invocation, opts.goalId);
        this._bus.emit({
            executionId: invocation.turnId ?? opts.goalId ?? `planning-memory-write-${Date.now()}`,
            subsystem: 'memory',
            event: 'memory.write_completed',
            payload: {
                category,
                source: this._resolveMemoryWriteSource(invocation),
                turnId: invocation.turnId,
                goalId: opts.goalId,
                turnMode: context.turnMode,
                memoryWriteMode: context.memoryWriteMode,
                authorityLevel: context.authorityEnvelope?.authorityLevel,
                ...(opts.payload ?? {}),
            },
        });
    }

    // ── Goal management ──────────────────────────────────────────────────────

    /**
     * Registers a new goal and returns the created PlanGoal.
     *
     * Emits: planning.goal_registered
     */
    registerGoal(input: RegisterGoalInput, invocationMetadata?: PlanningInvocationMetadata): PlanGoal {
        const invocation = this._normalizePlanningInvocation(invocationMetadata);
        const now = new Date().toISOString();
        const goal: PlanGoal = {
            id: `goal-${uuidv4()}`,
            correlationId: `corr-${uuidv4()}`,
            title: input.title,
            description: input.description,
            source: input.source,
            category: input.category,
            priority: input.priority ?? 'normal',
            constraints: input.constraints,
            successCriteria: input.successCriteria,
            status: 'registered',
            registeredAt: now,
            updatedAt: now,
            metadata: input.metadata,
            replanCount: 0,
        };

        this._assertMemoryWriteAllowed('goal_state', invocation, {
            goalId: goal.id,
            payload: { goalStatus: goal.status, category: goal.category, source: goal.source },
        });
        this._repo.saveGoal(goal);
        this._emitMemoryWriteCompleted('goal_state', invocation, {
            goalId: goal.id,
            payload: { goalStatus: goal.status },
        });

        this._bus.emit({
            executionId: goal.id,
            subsystem: 'planning',
            event: 'planning.goal_registered',
            payload: {
                goalId: goal.id,
                correlationId: goal.correlationId,
                source: goal.source,
                category: goal.category,
                priority: goal.priority,
            },
        });

        return { ...goal };
    }

    /**
     * Returns the goal with the given id, or undefined.
     */
    getGoal(goalId: string): PlanGoal | undefined {
        return this._repo.getGoal(goalId);
    }

    // ── Analysis ─────────────────────────────────────────────────────────────

    /**
     * Performs deterministic analysis of the given goal and returns a GoalAnalysis.
     *
     * Transitions the goal to 'analyzing' during the call, then back to 'planned'
     * (or 'blocked') after analysis completes.  The GoalAnalysis is returned but
     * not persisted — callers pass it directly to buildPlan().
     *
     * Emits: planning.goal_analyzed  (or planning.plan_blocked when blocked)
     *
     * @throws PlanningError if the goal is not found.
     */
    analyzeGoal(goalId: string, invocationMetadata?: PlanningInvocationMetadata): GoalAnalysis {
        const goal = this._repo.getGoal(goalId);
        if (!goal) {
            throw new PlanningError(`Goal not found: ${goalId}`, 'GOAL_NOT_FOUND');
        }
        const invocation = this._normalizePlanningInvocation(invocationMetadata);

        const start = Date.now();

        // Transition to 'analyzing'
        this._saveGoalStatus(goal, 'analyzing', undefined, invocation);

        const capabilities = this._resolveCapabilities(goalId, goal.correlationId);

        const analysis = GoalAnalyzer.analyze(goal, capabilities);

        const durationMs = Date.now() - start;

        this._bus.emit({
            executionId: goalId,
            subsystem: 'planning',
            event: 'planning.goal_analyzed',
            payload: {
                goalId,
                correlationId: goal.correlationId,
                complexity: analysis.complexity,
                executionStyle: analysis.executionStyle,
                requiresApproval: analysis.requiresApproval,
                blocked: analysis.blockingIssues.length > 0,
                missingCapabilities: analysis.missingCapabilities,
                recommendedPlanner: analysis.recommendedPlanner,
                risk: analysis.risk,
                confidence: analysis.confidence,
                reasonCodes: analysis.reasonCodes,
                durationMs,
            },
        });

        if (analysis.blockingIssues.length > 0) {
            this._saveGoalStatus(goal, 'blocked', analysis.blockingIssues.map(i => `block:${i}`), invocation);
        }

        return analysis;
    }

    // ── Plan building ────────────────────────────────────────────────────────

    /**
     * Builds a structured execution plan for the given goal.
     *
     * Runs analyzeGoal() internally, then calls PlanBuilder.build().
     * The resulting plan is persisted in the repository and the goal status
     * is updated to 'planned'.
     *
     * Emits: planning.plan_created  (or planning.plan_blocked)
     *
     * @throws PlanningError if the goal is not found.
     */
    buildPlan(goalId: string, invocationMetadata?: PlanningInvocationMetadata): ExecutionPlan {
        const goal = this._repo.getGoal(goalId);
        if (!goal) {
            throw new PlanningError(`Goal not found: ${goalId}`, 'GOAL_NOT_FOUND');
        }
        const invocation = this._normalizePlanningInvocation(invocationMetadata);

        const analysis = this.analyzeGoal(goalId, invocation);
        const start = Date.now();
        const capabilities = this._resolveCapabilities(goalId, goal.correlationId);
        const runtimeState = this._resolveRuntimeState(capabilities);
        const { similarityFeatures, biasProfile } = this._contextBuilder.build({
            goal,
            analysis,
            runtime: runtimeState,
        });
        this._bus.emit({
            executionId: goalId,
            subsystem: 'planning',
            event: 'planning.memory_context_built',
            payload: {
                goalId,
                correlationId: goal.correlationId,
                planningInvokedBy: invocation.invokedBy,
                planningInvocationReason: invocation.invocationReason,
                similarEpisodeCount: biasProfile.similarEpisodes.length,
                confidence: biasProfile.confidence,
                reasonCodes: biasProfile.reasonCodes,
                knownFailurePatterns: biasProfile.knownFailurePatterns,
                knownRecoveryPatterns: biasProfile.knownRecoveryPatterns,
            },
        });
        const strategySelection = StrategySelector.select({
            goal,
            analysis,
            biasProfile,
            runtime: runtimeState,
        });
        this._bus.emit({
            executionId: goalId,
            subsystem: 'planning',
            event: 'planning.strategy_selected',
            payload: {
                goalId,
                correlationId: goal.correlationId,
                planningInvokedBy: invocation.invokedBy,
                planningInvocationReason: invocation.invocationReason,
                selectedLane: strategySelection.selectedLane,
                strategyFamily: strategySelection.strategyFamily,
                verificationDepth: strategySelection.verificationDepth,
                retryPosture: strategySelection.retryPosture,
                fallbackPosture: strategySelection.fallbackPosture,
                artifactFirst: strategySelection.artifactFirst,
                confidence: strategySelection.confidence,
                reasonCodes: strategySelection.reasonCodes,
            },
        });

        const builtPlan = PlanBuilder.build({ goal, analysis, strategySelection });
        const plan: ExecutionPlan = {
            ...builtPlan,
            planningInvocation: invocation,
        };
        this._repo.savePlan(plan);

        const durationMs = Date.now() - start;

        const isBlocked = plan.status === 'blocked';
        const eventType = isBlocked ? 'planning.plan_blocked' : 'planning.plan_created';

        // Update goal status
        const newGoalStatus = isBlocked ? 'blocked' : 'planned';
        const freshGoal = this._repo.getGoal(goalId)!;
        this._saveGoalStatus(freshGoal, newGoalStatus, plan.reasonCodes, invocation);

        this._bus.emit({
            executionId: goalId,
            subsystem: 'planning',
            event: eventType,
            payload: {
                goalId,
                correlationId: this._repo.getGoal(goalId)?.correlationId,
                planId: plan.id,
                planningInvokedBy: invocation.invokedBy,
                planningInvocationReason: invocation.invocationReason,
                plannerType: plan.plannerType,
                version: plan.version,
                stageCount: plan.stages.length,
                requiresApproval: plan.requiresApproval,
                approvalState: plan.approvalState,
                status: plan.status,
                estimatedRisk: plan.estimatedRisk,
                handoffType: plan.handoff.type,
                selectedLane: strategySelection.selectedLane,
                strategyFamily: strategySelection.strategyFamily,
                verificationDepth: strategySelection.verificationDepth,
                retryPosture: strategySelection.retryPosture,
                fallbackPosture: strategySelection.fallbackPosture,
                artifactFirst: strategySelection.artifactFirst,
                planningMemoryConfidence: strategySelection.confidence,
                planningMemoryReasonCodes: strategySelection.reasonCodes,
                reasonCodes: plan.reasonCodes,
                durationMs,
            },
        });

        this._assertMemoryWriteAllowed('planning_episode', invocation, {
            goalId: goal.id,
            episodeType: 'planning_episode',
            payload: { planId: plan.id, outcome: plan.status === 'blocked' ? 'blocked' : 'abandoned' },
        });
        const episode = this._episodeRepo.createEpisode({
            goalClass: goal.category,
            requestCategory: goal.category,
            userIntentClass: goal.source,
            executionLane: strategySelection.selectedLane,
            strategyFamily: strategySelection.strategyFamily,
            verificationDepth: strategySelection.verificationDepth,
            retryPosture: strategySelection.retryPosture,
            fallbackPosture: strategySelection.fallbackPosture,
            toolIds: plan.handoff.type === 'tool' ? plan.handoff.steps.map(s => s.toolId) : [],
            workflowIds: plan.handoff.type === 'workflow' ? plan.handoff.invocations.map(w => w.workflowId) : [],
            runtimeConditions: {
                inferenceAvailable: runtimeState.inferenceAvailable,
                postgresAvailable: runtimeState.postgresAvailable,
                semanticRetrievalAvailable: runtimeState.semanticRetrievalAvailable,
                networkAvailable: runtimeState.networkAvailable,
                degradedSubsystems: runtimeState.degradedSubsystems ?? [],
            },
            similarityFeatures,
            outcome: plan.status === 'blocked' ? 'blocked' : 'abandoned',
            failureClass: plan.status === 'blocked' ? 'blocked' : undefined,
            userAccepted: false,
            requiredCorrection: false,
            notes: [`plan:${plan.id}`],
        });
        this._emitMemoryWriteCompleted('planning_episode', invocation, {
            goalId: goal.id,
            payload: { planId: plan.id, episodeId: episode.id },
        });
        this._episodeIdsByPlanId.set(plan.id, episode.id);
        this._bus.emit({
            executionId: goalId,
            subsystem: 'planning',
            event: 'planning.episode_recorded',
            payload: {
                goalId,
                correlationId: goal.correlationId,
                planId: plan.id,
                episodeId: episode.id,
                outcome: episode.outcome,
                strategyFamily: episode.strategyFamily,
            },
        });

        if (plan.status === 'blocked') {
            this._bus.emit({
                executionId: goalId,
                subsystem: 'planning',
                event: 'planning.episode_completed',
                payload: {
                    goalId,
                    correlationId: goal.correlationId,
                    planId: plan.id,
                    episodeId: episode.id,
                    outcome: episode.outcome,
                    failureClass: episode.failureClass,
                },
            });
        }

        return { ...plan };
    }

    // ── Approval ─────────────────────────────────────────────────────────────

    /**
     * Approves a plan that is in 'pending' approval state.
     *
     * Transitions: approvalState pending → approved, status draft → approved.
     * Transitions the goal to 'approved'.
     *
     * Emits: planning.plan_approved
     *
     * @throws PlanningError if the plan is not found, does not require approval,
     *   or is not in a state where approval is valid.
     */
    approvePlan(planId: string, actor: string): ExecutionPlan {
        const plan = this._repo.getPlan(planId);
        if (!plan) {
            throw new PlanningError(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND');
        }
        if (!plan.requiresApproval) {
            throw new PlanningError(
                `Plan ${planId} does not require approval`,
                'APPROVAL_NOT_REQUIRED',
            );
        }
        if (plan.approvalState !== 'pending') {
            throw new PlanningError(
                `Plan ${planId} is not in pending approval state (current: ${plan.approvalState})`,
                'INVALID_APPROVAL_STATE',
            );
        }

        const now = new Date().toISOString();
        const updated: ExecutionPlan = {
            ...plan,
            approvalState: 'approved',
            approvalDecidedAt: now,
            approvalActor: actor,
            status: 'approved',
            updatedAt: now,
            reasonCodes: [...plan.reasonCodes, `approved_by:${actor}`],
        };

        this._repo.savePlan(updated);

        // Transition goal to 'approved'
        const goal = this._repo.getGoal(plan.goalId);
        if (goal) {
            this._saveGoalStatus(goal, 'approved', undefined, plan.planningInvocation);
        }

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.plan_approved',
            payload: {
                goalId: plan.goalId,
                correlationId: goal?.correlationId,
                planId,
                actor,
                approvedAt: now,
            },
        });

        return { ...updated };
    }

    /**
     * Denies a plan that is in 'pending' approval state.
     *
     * Transitions: approvalState pending → denied, status draft → blocked.
     * Transitions the goal to 'blocked'.
     *
     * Emits: planning.plan_denied
     *
     * @throws PlanningError if the plan is not found or is not pending approval.
     */
    denyPlan(planId: string, actor: string, reason: string): ExecutionPlan {
        const plan = this._repo.getPlan(planId);
        if (!plan) {
            throw new PlanningError(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND');
        }
        if (plan.approvalState !== 'pending') {
            throw new PlanningError(
                `Plan ${planId} is not in pending approval state (current: ${plan.approvalState})`,
                'INVALID_APPROVAL_STATE',
            );
        }

        const now = new Date().toISOString();
        const updated: ExecutionPlan = {
            ...plan,
            approvalState: 'denied',
            approvalDecidedAt: now,
            approvalActor: actor,
            denialReason: reason,
            status: 'blocked',
            updatedAt: now,
            reasonCodes: [...plan.reasonCodes, `denied_by:${actor}`, `reason:${reason}`],
        };

        this._repo.savePlan(updated);

        // Transition goal to 'blocked'
        const goal = this._repo.getGoal(plan.goalId);
        if (goal) {
            this._saveGoalStatus(goal, 'blocked', [`operator_denied:${reason}`], plan.planningInvocation);
        }

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.plan_denied',
            payload: {
                goalId: plan.goalId,
                correlationId: goal?.correlationId,
                planId,
                actor,
                reason,
                deniedAt: now,
            },
        });

        return { ...updated };
    }

    // ── Plan access ──────────────────────────────────────────────────────────

    /**
     * Returns the plan with the given id, or undefined.
     */
    getPlan(planId: string): ExecutionPlan | undefined {
        return this._repo.getPlan(planId);
    }

    /**
     * Returns all plans for the given goal, ordered by version ascending.
     */
    listPlansForGoal(goalId: string): ExecutionPlan[] {
        return this._repo.listPlansForGoal(goalId);
    }

    // ── Execution lifecycle ──────────────────────────────────────────────────

    /**
     * Marks that execution has been handed off to the downstream authority.
     *
     * Valid from: status 'ready' or 'approved'.
     * Emits: planning.execution_handoff
     *
     * @throws PlanningError if the plan is not found or not in a valid pre-execution state.
     */
    markExecutionStarted(planId: string): ExecutionPlan {
        const plan = this._repo.getPlan(planId);
        if (!plan) {
            throw new PlanningError(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND');
        }

        const validStatuses: ExecutionPlan['status'][] = ['ready', 'approved'];
        if (!validStatuses.includes(plan.status)) {
            throw new PlanningError(
                `Plan ${planId} cannot start execution from status '${plan.status}' (must be ready or approved)`,
                'INVALID_EXECUTION_STATE',
            );
        }

        // Approval-required plans must be approved before execution
        if (plan.requiresApproval && plan.approvalState !== 'approved') {
            throw new PlanningError(
                `Plan ${planId} requires approval before execution (current approval state: ${plan.approvalState})`,
                'APPROVAL_REQUIRED',
            );
        }

        const now = new Date().toISOString();
        const executionBoundaryId = `exec-${uuidv4()}`;
        const updated: ExecutionPlan = {
            ...plan,
            status: 'executing',
            executionBoundaryId,
            updatedAt: now,
        };

        this._repo.savePlan(updated);

        // Transition goal to 'executing'
        const goal = this._repo.getGoal(plan.goalId);
        if (goal) {
            this._saveGoalStatus(goal, 'executing', undefined, plan.planningInvocation);
        }

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.execution_handoff',
            payload: {
                goalId: plan.goalId,
                correlationId: goal?.correlationId,
                planId,
                executionBoundaryId,
                handoffType: plan.handoff.type,
                plannerType: plan.plannerType,
                version: plan.version,
                startedAt: now,
            },
        });

        return { ...updated };
    }

    /**
     * Marks execution as completed successfully.
     *
     * Valid from: status 'executing'.
     * Emits: planning.plan_completed
     *
     * @throws PlanningError if the plan is not found or not in 'executing' state.
     */
    markExecutionCompleted(planId: string): ExecutionPlan {
        const plan = this._repo.getPlan(planId);
        if (!plan) {
            throw new PlanningError(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND');
        }
        if (plan.status !== 'executing') {
            throw new PlanningError(
                `Plan ${planId} is not in executing state (current: ${plan.status})`,
                'INVALID_EXECUTION_STATE',
            );
        }

        const now = new Date().toISOString();
        const updated: ExecutionPlan = {
            ...plan,
            status: 'completed',
            updatedAt: now,
        };

        this._repo.savePlan(updated);

        const goal = this._repo.getGoal(plan.goalId);
        if (goal) {
            this._saveGoalStatus(goal, 'completed', undefined, plan.planningInvocation);
        }

        // Release per-goal replan tracking when the goal completes
        this._replanCounts.delete(plan.goalId);
        this._lastReplanAt.delete(plan.goalId);

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.plan_completed',
            payload: {
                goalId: plan.goalId,
                correlationId: goal?.correlationId,
                planId,
                version: plan.version,
                completedAt: now,
            },
        });

        const episodeId = this._episodeIdsByPlanId.get(planId);
        if (episodeId) {
            this._assertMemoryWriteAllowed(
                'execution_episode',
                plan.planningInvocation ?? this._normalizePlanningInvocation(),
                {
                    goalId: plan.goalId,
                    episodeType: 'execution_episode',
                    payload: { planId, outcome: 'succeeded' },
                },
            );
            const updatedEpisode = this._episodeRepo.completeEpisode(episodeId, {
                outcome: 'succeeded',
                userAccepted: true,
                requiredCorrection: false,
                durationMs: Math.max(0, Date.now() - new Date(plan.createdAt).getTime()),
            });
            this._emitMemoryWriteCompleted(
                'execution_episode',
                plan.planningInvocation ?? this._normalizePlanningInvocation(),
                {
                    goalId: plan.goalId,
                    payload: { planId, episodeId },
                },
            );
            this._bus.emit({
                executionId: plan.goalId,
                subsystem: 'planning',
                event: 'planning.episode_completed',
                payload: {
                    goalId: plan.goalId,
                    correlationId: goal?.correlationId,
                    planId,
                    episodeId,
                    outcome: updatedEpisode?.outcome ?? 'succeeded',
                    durationMs: updatedEpisode?.durationMs,
                },
            });
        }

        return { ...updated };
    }

    /**
     * Marks execution as failed.
     *
     * Valid from: status 'executing'.
     * Emits: planning.plan_failed
     *
     * @throws PlanningError if the plan is not found or not in 'executing' state.
     */
    markExecutionFailed(planId: string, reason: string): ExecutionPlan {
        const plan = this._repo.getPlan(planId);
        if (!plan) {
            throw new PlanningError(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND');
        }
        if (plan.status !== 'executing') {
            throw new PlanningError(
                `Plan ${planId} is not in executing state (current: ${plan.status})`,
                'INVALID_EXECUTION_STATE',
            );
        }

        const now = new Date().toISOString();
        const updated: ExecutionPlan = {
            ...plan,
            status: 'failed',
            updatedAt: now,
            reasonCodes: [...plan.reasonCodes, `failure:${reason}`],
        };

        this._repo.savePlan(updated);

        const goal = this._repo.getGoal(plan.goalId);
        if (goal) {
            this._saveGoalStatus(goal, 'failed', [`execution_failed:${reason}`], plan.planningInvocation);
        }

        // Release per-goal replan tracking when the goal fails (terminal state)
        this._replanCounts.delete(plan.goalId);
        this._lastReplanAt.delete(plan.goalId);

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.plan_failed',
            payload: {
                goalId: plan.goalId,
                correlationId: goal?.correlationId,
                planId,
                reason,
                version: plan.version,
                failedAt: now,
            },
        });

        const episodeId = this._episodeIdsByPlanId.get(planId);
        if (episodeId) {
            const failureClass = this._classifyFailureReason(reason);
            this._assertMemoryWriteAllowed(
                'execution_episode',
                plan.planningInvocation ?? this._normalizePlanningInvocation(),
                {
                    goalId: plan.goalId,
                    episodeType: 'execution_episode',
                    payload: { planId, outcome: 'failed', failureClass },
                },
            );
            const updatedEpisode = this._episodeRepo.completeEpisode(episodeId, {
                outcome: 'failed',
                failureClass,
                requiredCorrection: true,
                userAccepted: false,
                recoveryAction: 'none',
                durationMs: Math.max(0, Date.now() - new Date(plan.createdAt).getTime()),
            });
            this._emitMemoryWriteCompleted(
                'execution_episode',
                plan.planningInvocation ?? this._normalizePlanningInvocation(),
                {
                    goalId: plan.goalId,
                    payload: { planId, episodeId, failureClass },
                },
            );
            this._bus.emit({
                executionId: plan.goalId,
                subsystem: 'planning',
                event: 'planning.episode_completed',
                payload: {
                    goalId: plan.goalId,
                    correlationId: goal?.correlationId,
                    planId,
                    episodeId,
                    outcome: updatedEpisode?.outcome ?? 'failed',
                    failureClass,
                    reason,
                    durationMs: updatedEpisode?.durationMs,
                },
            });
        }

        return { ...updated };
    }

    // ── Replanning ───────────────────────────────────────────────────────────

    /**
     * Generates a new versioned plan superseding the prior plan.
     *
     * The prior plan is marked 'superseded' with a forward link to the new plan.
     * The new plan carries replannedFromPlanId linking back to the prior plan.
     * No silent overwrite of history — the prior plan record is always preserved.
     *
     * Replan guardrails (configurable via setReplanPolicy):
     *   - REPLAN_LIMIT_EXCEEDED  — too many replans for this goal
     *   - REPLAN_COOLDOWN_ACTIVE — replan too soon after previous replan
     *
     * Emits: planning.replan_requested, planning.plan_superseded, planning.plan_created
     *         (or planning.plan_blocked if the new analysis is also blocked)
     *
     * @throws PlanningError if the goal or prior plan are not found, or if
     *   replan guardrails are triggered.
     */
    replan(request: ReplanRequest, invocationMetadata?: PlanningInvocationMetadata): ExecutionPlan {
        const goal = this._repo.getGoal(request.goalId);
        if (!goal) {
            throw new PlanningError(`Goal not found: ${request.goalId}`, 'GOAL_NOT_FOUND');
        }
        const invocation = this._normalizePlanningInvocation(invocationMetadata);

        const priorPlan = this._repo.getPlan(request.priorPlanId);
        if (!priorPlan) {
            throw new PlanningError(`Prior plan not found: ${request.priorPlanId}`, 'PLAN_NOT_FOUND');
        }

        // ── Replan guardrails ────────────────────────────────────────────────

        const replanCount = this._replanCounts.get(request.goalId) ?? 0;
        if (replanCount >= this._replanPolicy.maxReplans) {
            this._bus.emit({
                executionId: request.goalId,
                subsystem: 'planning',
                event: 'planning.replan_rejected',
                payload: {
                    goalId: request.goalId,
                    correlationId: goal.correlationId,
                    priorPlanId: request.priorPlanId,
                    trigger: request.trigger,
                    rejectionCode: 'REPLAN_LIMIT_EXCEEDED',
                    replanCount,
                    maxReplans: this._replanPolicy.maxReplans,
                },
            });
            throw new PlanningError(
                `Goal ${request.goalId} has exceeded the replan limit (max: ${this._replanPolicy.maxReplans})`,
                'REPLAN_LIMIT_EXCEEDED',
            );
        }

        const lastReplanAt = this._lastReplanAt.get(request.goalId) ?? 0;
        const nowMs = Date.now();
        if (nowMs - lastReplanAt < this._replanPolicy.cooldownMs) {
            const remainingMs = this._replanPolicy.cooldownMs - (nowMs - lastReplanAt);
            this._bus.emit({
                executionId: request.goalId,
                subsystem: 'planning',
                event: 'planning.replan_rejected',
                payload: {
                    goalId: request.goalId,
                    correlationId: goal.correlationId,
                    priorPlanId: request.priorPlanId,
                    trigger: request.trigger,
                    rejectionCode: 'REPLAN_COOLDOWN_ACTIVE',
                    remainingMs,
                    cooldownMs: this._replanPolicy.cooldownMs,
                },
            });
            throw new PlanningError(
                `Goal ${request.goalId} replan cooldown active (${remainingMs}ms remaining)`,
                'REPLAN_COOLDOWN_ACTIVE',
            );
        }

        // ── Replan execution ─────────────────────────────────────────────────

        const now = new Date().toISOString();

        this._bus.emit({
            executionId: request.goalId,
            subsystem: 'planning',
            event: 'planning.replan_requested',
            payload: {
                goalId: request.goalId,
                correlationId: goal.correlationId,
                priorPlanId: request.priorPlanId,
                trigger: request.trigger,
                triggerDetails: request.triggerDetails,
                replanCount: replanCount + 1,
                requestedAt: now,
            },
        });

        // Reset goal status to 'registered' for fresh analysis
        this._saveGoalStatus(goal, 'registered', [`replan_trigger:${request.trigger}`], invocation);

        // Analyse with current capabilities snapshot.
        const capabilities = this._resolveCapabilities(request.goalId, goal.correlationId);
        const analysis = GoalAnalyzer.analyze(
            this._repo.getGoal(request.goalId)!,
            capabilities,
        );
        const runtimeState = this._resolveRuntimeState(capabilities);
        const replanningGoal = this._repo.getGoal(request.goalId)!;
        const { similarityFeatures, biasProfile } = this._contextBuilder.build({
            goal: replanningGoal,
            analysis,
            runtime: runtimeState,
        });
        this._bus.emit({
            executionId: request.goalId,
            subsystem: 'planning',
            event: 'planning.memory_context_built',
            payload: {
                goalId: request.goalId,
                correlationId: goal.correlationId,
                planningInvokedBy: invocation.invokedBy,
                planningInvocationReason: invocation.invocationReason,
                similarEpisodeCount: biasProfile.similarEpisodes.length,
                confidence: biasProfile.confidence,
                reasonCodes: biasProfile.reasonCodes,
                knownFailurePatterns: biasProfile.knownFailurePatterns,
                knownRecoveryPatterns: biasProfile.knownRecoveryPatterns,
            },
        });
        const strategySelection = StrategySelector.select({
            goal: replanningGoal,
            analysis,
            biasProfile,
            runtime: runtimeState,
        });
        this._bus.emit({
            executionId: request.goalId,
            subsystem: 'planning',
            event: 'planning.strategy_selected',
            payload: {
                goalId: request.goalId,
                correlationId: goal.correlationId,
                planningInvokedBy: invocation.invokedBy,
                planningInvocationReason: invocation.invocationReason,
                selectedLane: strategySelection.selectedLane,
                strategyFamily: strategySelection.strategyFamily,
                verificationDepth: strategySelection.verificationDepth,
                retryPosture: strategySelection.retryPosture,
                fallbackPosture: strategySelection.fallbackPosture,
                artifactFirst: strategySelection.artifactFirst,
                confidence: strategySelection.confidence,
                reasonCodes: strategySelection.reasonCodes,
                replannedFromPlanId: priorPlan.id,
            },
        });

        // Build new plan superseding the prior one
        const builtPlan = PlanBuilder.build({
            goal: replanningGoal,
            analysis,
            strategySelection,
            priorPlan,
        });
        const newPlan: ExecutionPlan = {
            ...builtPlan,
            planningInvocation: invocation,
        };
        this._repo.savePlan(newPlan);

        // Mark prior plan as superseded (preserve record, add forward link)
        const supersededPrior: ExecutionPlan = {
            ...priorPlan,
            status: 'superseded',
            supersededByPlanId: newPlan.id,
            updatedAt: now,
        };
        this._repo.savePlan(supersededPrior);

        // Update replan tracking
        this._replanCounts.set(request.goalId, replanCount + 1);
        this._lastReplanAt.set(request.goalId, nowMs);

        // Update goal replanCount
        const freshGoal = this._repo.getGoal(request.goalId)!;
        this._assertMemoryWriteAllowed('goal_state', invocation, {
            goalId: request.goalId,
            payload: { goalStatus: freshGoal.status, replanCount: replanCount + 1 },
        });
        this._repo.saveGoal({ ...freshGoal, replanCount: replanCount + 1 });
        this._emitMemoryWriteCompleted('goal_state', invocation, {
            goalId: request.goalId,
            payload: { replanCount: replanCount + 1 },
        });

        this._bus.emit({
            executionId: request.goalId,
            subsystem: 'planning',
            event: 'planning.plan_superseded',
            payload: {
                goalId: request.goalId,
                correlationId: goal.correlationId,
                supersededPlanId: priorPlan.id,
                newPlanId: newPlan.id,
                trigger: request.trigger,
                supersededAt: now,
            },
        });

        // Emit plan created / blocked event
        const isBlocked = newPlan.status === 'blocked';
        this._bus.emit({
            executionId: request.goalId,
            subsystem: 'planning',
            event: isBlocked ? 'planning.plan_blocked' : 'planning.plan_created',
            payload: {
                goalId: request.goalId,
                correlationId: goal.correlationId,
                planId: newPlan.id,
                version: newPlan.version,
                plannerType: newPlan.plannerType,
                stageCount: newPlan.stages.length,
                requiresApproval: newPlan.requiresApproval,
                approvalState: newPlan.approvalState,
                status: newPlan.status,
                replannedFromPlanId: priorPlan.id,
                reasonCodes: newPlan.reasonCodes,
            },
        });

        // Update goal to 'planned' or 'blocked'
        const freshGoal2 = this._repo.getGoal(request.goalId)!;
        this._saveGoalStatus(freshGoal2, isBlocked ? 'blocked' : 'planned', newPlan.reasonCodes, invocation);

        const priorEpisodeId = this._episodeIdsByPlanId.get(priorPlan.id);
        if (priorEpisodeId) {
            this._assertMemoryWriteAllowed('recovery_episode', invocation, {
                goalId: request.goalId,
                episodeType: 'recovery_episode',
                payload: { priorPlanId: priorPlan.id, newPlanId: newPlan.id, action: 'replan' },
            });
            this._episodeRepo.completeEpisode(priorEpisodeId, {
                outcome: 'abandoned',
                recoveryAction: 'replan',
                requiredCorrection: true,
            });
            this._emitMemoryWriteCompleted('recovery_episode', invocation, {
                goalId: request.goalId,
                payload: { planId: priorPlan.id, episodeId: priorEpisodeId, action: 'replan' },
            });
            this._bus.emit({
                executionId: request.goalId,
                subsystem: 'planning',
                event: 'planning.episode_completed',
                payload: {
                    goalId: request.goalId,
                    correlationId: goal.correlationId,
                    planId: priorPlan.id,
                    episodeId: priorEpisodeId,
                    outcome: 'abandoned',
                    recoveryAction: 'replan',
                },
            });
        }

        this._assertMemoryWriteAllowed('planning_episode', invocation, {
            goalId: request.goalId,
            episodeType: 'planning_episode',
            payload: { planId: newPlan.id, replannedFromPlanId: priorPlan.id, outcome: isBlocked ? 'blocked' : 'abandoned' },
        });
        const episode = this._episodeRepo.createEpisode({
            goalClass: freshGoal2.category,
            requestCategory: freshGoal2.category,
            userIntentClass: freshGoal2.source,
            executionLane: newPlan.selectedLane,
            strategyFamily: newPlan.strategyFamily,
            verificationDepth: newPlan.verificationDepth,
            retryPosture: newPlan.retryPosture,
            fallbackPosture: newPlan.fallbackPosture,
            toolIds: newPlan.handoff.type === 'tool' ? newPlan.handoff.steps.map(s => s.toolId) : [],
            workflowIds: newPlan.handoff.type === 'workflow' ? newPlan.handoff.invocations.map(w => w.workflowId) : [],
            runtimeConditions: {
                inferenceAvailable: runtimeState.inferenceAvailable,
                postgresAvailable: runtimeState.postgresAvailable,
                semanticRetrievalAvailable: runtimeState.semanticRetrievalAvailable,
                networkAvailable: runtimeState.networkAvailable,
                degradedSubsystems: runtimeState.degradedSubsystems ?? [],
            },
            similarityFeatures,
            outcome: isBlocked ? 'blocked' : 'abandoned',
            failureClass: isBlocked ? 'blocked' : undefined,
            notes: [`plan:${newPlan.id}`, `replanned_from:${priorPlan.id}`],
        });
        this._emitMemoryWriteCompleted('planning_episode', invocation, {
            goalId: request.goalId,
            payload: { planId: newPlan.id, episodeId: episode.id, replannedFromPlanId: priorPlan.id },
        });
        this._episodeIdsByPlanId.set(newPlan.id, episode.id);
        this._bus.emit({
            executionId: request.goalId,
            subsystem: 'planning',
            event: 'planning.episode_recorded',
            payload: {
                goalId: request.goalId,
                correlationId: goal.correlationId,
                planId: newPlan.id,
                episodeId: episode.id,
                outcome: episode.outcome,
                strategyFamily: episode.strategyFamily,
            },
        });
        if (isBlocked) {
            this._bus.emit({
                executionId: request.goalId,
                subsystem: 'planning',
                event: 'planning.episode_completed',
                payload: {
                    goalId: request.goalId,
                    correlationId: goal.correlationId,
                    planId: newPlan.id,
                    episodeId: episode.id,
                    outcome: episode.outcome,
                    failureClass: episode.failureClass,
                },
            });
        }

        return { ...newPlan };
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private _resolveCapabilities(goalId: string, correlationId?: string): ReadonlySet<string> {
        let capabilities = this._availableCapabilities;
        if (this._capabilityProvider) {
            try {
                capabilities = this._capabilityProvider();
            } catch (err) {
                this._bus.emit({
                    executionId: goalId,
                    subsystem: 'planning',
                    event: 'planning.capability_provider_error',
                    payload: {
                        goalId,
                        correlationId,
                        error: err instanceof Error ? err.message : String(err),
                        fallback: 'manual_capabilities',
                    },
                });
            }
        }
        return capabilities;
    }

    private _resolveRuntimeState(capabilities: ReadonlySet<string>): PlanningContextRuntimeState {
        let state = this._runtimeState;
        if (this._runtimeStateProvider) {
            try {
                state = this._runtimeStateProvider();
            } catch {
                // keep local fallback snapshot
            }
        }
        const degradedSubsystems = state.degradedSubsystems ?? [];
        return {
            inferenceAvailable: state.inferenceAvailable && capabilities.has('inference'),
            postgresAvailable: state.postgresAvailable && capabilities.has('memory_canonical'),
            semanticRetrievalAvailable:
                state.semanticRetrievalAvailable &&
                (capabilities.has('rag') || capabilities.has('semantic_retrieval')),
            networkAvailable: state.networkAvailable,
            degradedSubsystems,
        };
    }

    private _classifyFailureReason(reason: string): string {
        const text = reason.toLowerCase();
        if (text.includes('timeout')) return 'timeout';
        if (text.includes('policy')) return 'policy_blocked';
        if (text.includes('permission') || text.includes('forbidden')) return 'permission_denied';
        if (text.includes('auth')) return 'auth_required';
        if (text.includes('unreach') || text.includes('network')) return 'dependency_unreachable';
        if (text.includes('invalid')) return 'invalid_input';
        if (text.includes('invariant')) return 'invariant_violation';
        return 'unknown';
    }

    /** Mutates goal status + updatedAt in the repository. */
    private _saveGoalStatus(
        goal: PlanGoal,
        status: PlanGoal['status'],
        reasonCodes?: string[],
        invocationMetadata?: PlanningInvocationMetadata,
    ): void {
        const invocation = this._normalizePlanningInvocation(invocationMetadata);
        this._assertMemoryWriteAllowed('goal_state', invocation, {
            goalId: goal.id,
            payload: { goalStatus: status, reasonCodes: reasonCodes ?? [] },
        });
        const updated: PlanGoal = {
            ...goal,
            status,
            updatedAt: new Date().toISOString(),
            ...(reasonCodes !== undefined && { reasonCodes }),
        };
        this._repo.saveGoal(updated);
        this._emitMemoryWriteCompleted('goal_state', invocation, {
            goalId: goal.id,
            payload: { goalStatus: status },
        });
    }
}
