import type { ExecutionPlan } from '../../../shared/planning/PlanningTypes';
import type { TurnMode } from '../../../shared/turnArbitrationTypes';
import type {
    IterationContinuationRule,
    IterationDecisionReasonCode,
    IterationPolicyResolution,
    IterationWorthinessClass,
    LoopPermission,
    ReplanAllowance,
} from '../../../shared/planning/IterationPolicyTypes';
import { IterationPolicyTuningRepository } from './IterationPolicyTuningRepository';

export interface IterationPolicyResolverInput {
    goal: string;
    turnMode?: TurnMode;
    operatorMode?: 'chat' | 'goal' | 'auto';
    authorityLevel?: 'none' | 'lightweight' | 'full_authority';
    recoveryMode?: boolean;
    autonomousMode?: boolean;
    sideEffectSensitive?: boolean;
    approvalGranted?: boolean;
    callerMaxIterations?: number;
    plan: ExecutionPlan;
}

function classifyTaskClass(input: IterationPolicyResolverInput): IterationWorthinessClass {
    const text = input.goal.toLowerCase();
    const stages = Array.isArray(input.plan.stages) ? input.plan.stages : [];
    const stageTypes = new Set(stages.map((stage) => stage.type));
    const handoffType = (input.plan as { handoff?: { type?: string } }).handoff?.type;

    if (input.turnMode === 'conversational' || input.operatorMode === 'chat') {
        return 'conversational_explanation';
    }
    if (input.recoveryMode) return 'recovery_repair';
    if (input.autonomousMode) return 'autonomous_maintenance';
    if (
        input.sideEffectSensitive ||
        input.plan.estimatedRisk === 'high' ||
        input.plan.estimatedRisk === 'critical' ||
        input.plan.requiresApproval
    ) {
        return 'operator_sensitive';
    }
    if (stageTypes.has('verify') && /(verify|validated?|assert|check)/.test(text)) {
        return 'retrieval_summarize_verify';
    }
    if (/(retrieve|search|find|lookup|query|summari[sz]e)/.test(text)) {
        return 'retrieval_summarize';
    }
    if (/(notebook|notes)/.test(text) || stageTypes.has('write')) {
        return 'notebook_synthesis';
    }
    if (/(artifact|report|document|draft|assemble|synthesis)/.test(text) || stageTypes.has('finalize')) {
        return 'artifact_assembly';
    }
    if (handoffType === 'tool' || stageTypes.has('tool')) {
        return 'tool_multistep';
    }
    if (handoffType === 'workflow' || stageTypes.has('workflow')) {
        return 'workflow_execution';
    }
    return 'general_goal_execution';
}

export function resolveIterationDoctrineDefaults(taskClass: IterationWorthinessClass): {
    maxIterations: number;
    replanAllowance: ReplanAllowance;
    continuationRule: IterationContinuationRule;
    reason: IterationDecisionReasonCode;
} {
    switch (taskClass) {
        case 'conversational_explanation':
            return {
                maxIterations: 1,
                replanAllowance: 'none',
                continuationRule: 'never',
                reason: 'iteration_policy.conversational_non_looping',
            };
        case 'retrieval_summarize':
            return {
                maxIterations: 2,
                replanAllowance: 'bounded',
                continuationRule: 'if_incomplete',
                reason: 'iteration_policy.retrieval_summary',
            };
        case 'retrieval_summarize_verify':
            return {
                maxIterations: 3,
                replanAllowance: 'bounded',
                continuationRule: 'if_verification_gap',
                reason: 'iteration_policy.retrieval_summary_verify',
            };
        case 'notebook_synthesis':
            return {
                maxIterations: 2,
                replanAllowance: 'bounded',
                continuationRule: 'if_incomplete',
                reason: 'iteration_policy.notebook_synthesis',
            };
        case 'artifact_assembly':
            return {
                maxIterations: 2,
                replanAllowance: 'bounded',
                continuationRule: 'if_incomplete',
                reason: 'iteration_policy.artifact_assembly',
            };
        case 'tool_multistep':
            return {
                maxIterations: 2,
                replanAllowance: 'bounded',
                continuationRule: 'if_recoverable',
                reason: 'iteration_policy.tool_multistep',
            };
        case 'workflow_execution':
            return {
                maxIterations: 2,
                replanAllowance: 'bounded',
                continuationRule: 'if_recoverable',
                reason: 'iteration_policy.workflow_execution',
            };
        case 'recovery_repair':
            return {
                maxIterations: 3,
                replanAllowance: 'bounded',
                continuationRule: 'if_recoverable',
                reason: 'iteration_policy.recovery_budget_applied',
            };
        case 'autonomous_maintenance':
            return {
                maxIterations: 2,
                replanAllowance: 'bounded',
                continuationRule: 'if_recoverable',
                reason: 'iteration_policy.autonomous_maintenance_bounded',
            };
        case 'operator_sensitive':
            return {
                maxIterations: 1,
                replanAllowance: 'none',
                continuationRule: 'never',
                reason: 'iteration_policy.operator_sensitive_capped',
            };
        case 'general_goal_execution':
        default:
            return {
                maxIterations: 2,
                replanAllowance: 'bounded',
                continuationRule: 'if_recoverable',
                reason: 'iteration_policy.default_single_pass',
            };
    }
}

export class IterationPolicyResolver {
    constructor(
        private readonly _tuningRepo: IterationPolicyTuningRepository = IterationPolicyTuningRepository.getInstance(),
    ) {}

    resolve(input: IterationPolicyResolverInput): IterationPolicyResolution {
        const taskClass = classifyTaskClass(input);
        const defaults = resolveIterationDoctrineDefaults(taskClass);
        const reasonCodes: IterationDecisionReasonCode[] = [defaults.reason];

        let maxIterations = defaults.maxIterations;
        let replanAllowance = defaults.replanAllowance;
        let continuationRule = defaults.continuationRule;
        let policySource: 'baseline' | 'promoted_override' | 'stale_active_override' = 'baseline';
        let tunedOverrideActive = false;
        let loopPermission: LoopPermission = 'allowed';
        let approvalRequirement: 'not_required' | 'required_above_iteration_threshold' | 'required_for_all_additional_iterations' = 'not_required';
        let approvalRequiredAboveIteration: number | undefined;

        const governedOverride = this._tuningRepo.getActiveOverride(taskClass);
        const override = governedOverride?.adjustment;
        if (override && governedOverride) {
            if (taskClass === 'recovery_repair') {
                reasonCodes.push('iteration_policy.tuned_override_ignored_recovery_precedence');
            } else {
                if (typeof override.maxIterations === 'number' && override.maxIterations > 0) {
                    maxIterations = override.maxIterations;
                }
                if (override.replanAllowance) {
                    replanAllowance = override.replanAllowance;
                }
                policySource = governedOverride.lifecycleState === 'active_stale'
                    ? 'stale_active_override'
                    : 'promoted_override';
                tunedOverrideActive = true;
                reasonCodes.push('iteration_policy.tuned_override_applied');
            }
        }

        let safetyCapped = false;
        if (input.plan.estimatedRisk === 'high' || input.plan.estimatedRisk === 'critical') {
            maxIterations = 1;
            replanAllowance = 'none';
            continuationRule = 'never';
            safetyCapped = true;
            reasonCodes.push('iteration_policy.high_risk_capped');
        }

        if (taskClass === 'operator_sensitive') {
            maxIterations = 1;
            replanAllowance = 'none';
            continuationRule = 'never';
            approvalRequirement = 'required_above_iteration_threshold';
            approvalRequiredAboveIteration = 1;
            reasonCodes.push('iteration_policy.approval_required_for_additional_iterations');
            if (input.approvalGranted !== true) {
                loopPermission = 'blocked_by_approval';
            }
            safetyCapped = true;
        }

        if (safetyCapped && tunedOverrideActive) {
            reasonCodes.push('iteration_policy.tuned_override_ignored_by_safety_cap');
        }

        if (input.callerMaxIterations && input.callerMaxIterations > 0) {
            maxIterations = safetyCapped ? Math.min(maxIterations, input.callerMaxIterations) : input.callerMaxIterations;
            reasonCodes.push('iteration_policy.caller_cap_applied');
        }

        if (replanAllowance === 'bounded') {
            reasonCodes.push('iteration_policy.replan_allowed');
        } else {
            reasonCodes.push('iteration_policy.replan_not_allowed');
        }

        return {
            profile: {
                taskClass,
                maxIterations,
                replanAllowance,
                continuationRule,
                loopPermission,
                approvalRequirement,
                approvalRequiredAboveIteration,
                verificationDepth: input.plan.verificationDepth,
                recoveryBudgetApplied: taskClass === 'recovery_repair' ? maxIterations : undefined,
                policySource,
                tunedOverrideActive,
                reasonCodes,
            },
            budget: {
                maxIterations,
                iterationsUsed: 0,
                remainingIterations: maxIterations,
                replansUsed: 0,
                replanAllowance,
                approvalRequirement,
                approvalRequiredAboveIteration,
                approvalGranted: input.approvalGranted,
                reasonCodes,
            },
        };
    }
}
