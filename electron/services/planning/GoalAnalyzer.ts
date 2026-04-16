/**
 * GoalAnalyzer.ts — Deterministic goal analysis for the Planning subsystem
 *
 * Consumes a PlanGoal and produces a GoalAnalysis describing:
 *   - complexity estimate
 *   - recommended execution style
 *   - whether approval is required
 *   - required and missing capabilities
 *   - blocking issues
 *   - recommended planner
 *   - risk and confidence
 *
 * Design invariants
 * ─────────────────
 * 1. Deterministic — same PlanGoal + same available-capabilities set produces
 *    the same GoalAnalysis output (except analyzedAt timestamp).
 * 2. Pure — analyze() performs no I/O, emits no telemetry, and writes nothing
 *    to DB or settings.
 * 3. Honest — missing capabilities are surfaced explicitly; no fake readiness.
 * 4. Conservative — defaults to deterministic/workflow paths when category
 *    indicates a known operational pattern.
 * 5. Non-authoritative — produces recommendations only; PlanningService,
 *    PolicyGate, and downstream execution authorities remain authoritative.
 *
 * Approval rules (conservative)
 * ─────────────────────────────
 * Approval is required when:
 *   - destructive / high-risk repair is implied (risk >= 'high')
 *   - operator-only actions are implicated (operator stage type present)
 *   - canonical-state-affecting writes outside safe normal paths
 *   - provider assignment / config changes
 *   - goal source is 'autonomy' and risk is not 'low'
 *
 * Execution style selection
 * ─────────────────────────
 * deterministic / workflow — maintenance, diagnostics, release, memory hygiene,
 *                            docs validation, structured repair
 * tool_orchestrated        — governed search + retrieve + summarize, structured
 *                            multi-step tool usage, notebook/artifact flows
 * llm_assisted / hybrid    — novel requests, decomposition requiring synthesis,
 *                            only when deterministic path is unavailable
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    PlanGoal,
    PlanGoalCategory,
    GoalAnalysis,
    GoalComplexity,
    GoalExecutionStyle,
    RecommendedPlanner,
    ApprovalContext,
    ApprovalTrigger,
} from '../../../shared/planning/PlanningTypes';

// ---------------------------------------------------------------------------
// Category → execution style mapping
// ---------------------------------------------------------------------------

/**
 * Preferred execution style per goal category.
 * 'deterministic' categories map to native or workflow-registry planners.
 */
const CATEGORY_EXECUTION_STYLE: Record<PlanGoalCategory, GoalExecutionStyle> = {
    maintenance:  'deterministic',
    diagnostics:  'deterministic',
    release:      'deterministic',
    memory:       'deterministic',
    workflow:     'workflow',
    tooling:      'tool_orchestrated',
    research:     'tool_orchestrated',
    conversation: 'llm_assisted',
};

/**
 * Preferred planner per execution style.
 */
const STYLE_TO_PLANNER: Record<GoalExecutionStyle, RecommendedPlanner> = {
    deterministic:    'native',
    workflow:         'workflow-registry',
    tool_orchestrated:'native',
    llm_assisted:     'llm-plan-builder',
    hybrid:           'llm-plan-builder',
};

// ---------------------------------------------------------------------------
// Complexity heuristics
// ---------------------------------------------------------------------------

/**
 * Estimates complexity from description length and category.
 * Intentionally conservative — prefer 'simple' over 'trivial' when uncertain.
 */
function estimateComplexity(goal: PlanGoal): GoalComplexity {
    const wordCount = goal.description.trim().split(/\s+/).length;
    const constraintCount = goal.constraints?.length ?? 0;
    const criteriaCount = goal.successCriteria?.length ?? 0;
    const weight = wordCount + constraintCount * 5 + criteriaCount * 3;

    if (goal.category === 'maintenance' || goal.category === 'diagnostics') {
        // Structured operational categories stay at most 'moderate'
        if (weight > 80) return 'moderate';
        if (weight > 30) return 'simple';
        return 'trivial';
    }

    if (weight > 200) return 'complex';
    if (weight > 80)  return 'moderate';
    if (weight > 20)  return 'simple';
    return 'trivial';
}

// ---------------------------------------------------------------------------
// Risk heuristics
// ---------------------------------------------------------------------------

/**
 * Estimates execution risk from goal characteristics.
 */
function estimateRisk(goal: PlanGoal, style: GoalExecutionStyle): 'low' | 'medium' | 'high' | 'critical' {
    if (goal.priority === 'critical') return 'critical';

    const descLower = (goal.description + ' ' + (goal.constraints ?? []).join(' ')).toLowerCase();

    const highRiskKeywords = [
        'delete', 'drop', 'destroy', 'overwrite', 'migrate', 'purge',
        'reinstall', 'rebuild', 'reset', 'wipe', 'truncate',
    ];
    const criticalKeywords = [
        'production', 'canonical', 'irreversible', 'hard delete',
    ];

    if (criticalKeywords.some(k => descLower.includes(k))) return 'critical';
    if (highRiskKeywords.some(k => descLower.includes(k))) return 'high';

    if (style === 'llm_assisted' || style === 'hybrid') return 'medium';
    if (goal.priority === 'high') return 'medium';

    return 'low';
}

// ---------------------------------------------------------------------------
// Approval heuristics
// ---------------------------------------------------------------------------

/**
 * Determines whether explicit approval is required for this goal.
 * Returns the reason string and structured ApprovalContext when required.
 */
function requiresApproval(
    goal: PlanGoal,
    risk: ReturnType<typeof estimateRisk>,
    style: GoalExecutionStyle,
): { required: boolean; reason?: string; context?: ApprovalContext } {
    const triggers: ApprovalTrigger[] = [];
    const reasons: string[] = [];

    if (risk === 'critical') {
        triggers.push('critical_risk');
        reasons.push('critical risk level requires operator approval');
    } else if (risk === 'high') {
        triggers.push('high_risk');
        reasons.push('high risk level requires approval before execution');
    }

    if (goal.source === 'autonomy' && risk !== 'low') {
        triggers.push('autonomy_source');
        reasons.push('autonomy-sourced goal with non-trivial risk requires approval');
    }

    if (goal.source === 'operator') {
        triggers.push('operator_source');
        reasons.push('operator-sourced goal requires explicit operator approval');
    }

    if (style === 'llm_assisted' && goal.category !== 'conversation') {
        triggers.push('llm_non_conversation');
        reasons.push('llm-assisted non-conversation goal requires approval');
    }

    const descLower = goal.description.toLowerCase();
    const approvalKeywords = [
        'provider', 'config', 'settings', 'assign', 'credential', 'secret',
        'schema', 'migration', 'canonical write', 'operator action',
    ];
    if (approvalKeywords.some(k => descLower.includes(k))) {
        triggers.push('config_mutation_implied');
        reasons.push('goal description implies provider/config/canonical-state changes');
    }

    if (triggers.length === 0) {
        return { required: false };
    }

    const context: ApprovalContext = {
        triggeredBy: triggers,
        reasons,
        riskLevel: risk,
        mitigations: _suggestMitigations(triggers),
    };

    return {
        required: true,
        reason: reasons[0],
        context,
    };
}

/**
 * Suggests mitigations for known approval triggers.
 * Returns undefined when no specific mitigations are known.
 */
function _suggestMitigations(triggers: ApprovalTrigger[]): string[] | undefined {
    const mitigations: string[] = [];
    if (triggers.includes('critical_risk') || triggers.includes('high_risk')) {
        mitigations.push('reduce scope to lower-risk operations and replan');
    }
    if (triggers.includes('config_mutation_implied')) {
        mitigations.push('remove config/provider/credential changes from goal description');
    }
    if (triggers.includes('autonomy_source')) {
        mitigations.push('convert to user-sourced goal for reduced approval friction');
    }
    return mitigations.length > 0 ? mitigations : undefined;
}

// ---------------------------------------------------------------------------
// Capability requirements
// ---------------------------------------------------------------------------

/** Categories that require RAG to be functional. */
const RAG_REQUIRED_CATEGORIES: PlanGoalCategory[] = ['research', 'conversation'];

/** Categories that require the workflow engine. */
const WORKFLOW_REQUIRED_CATEGORIES: PlanGoalCategory[] = ['workflow', 'maintenance', 'release'];

/** Categories that require the memory subsystem. */
const MEMORY_REQUIRED_CATEGORIES: PlanGoalCategory[] = ['memory', 'maintenance', 'diagnostics'];

/**
 * Derives required capabilities for a goal.
 */
function deriveRequiredCapabilities(goal: PlanGoal, style: GoalExecutionStyle): string[] {
    const caps: Set<string> = new Set();

    if (RAG_REQUIRED_CATEGORIES.includes(goal.category)) caps.add('rag');
    if (WORKFLOW_REQUIRED_CATEGORIES.includes(goal.category)) caps.add('workflow_engine');
    if (MEMORY_REQUIRED_CATEGORIES.includes(goal.category)) caps.add('memory_canonical');

    if (style === 'tool_orchestrated' || style === 'hybrid') caps.add('tool_execution');
    if (style === 'llm_assisted' || style === 'hybrid') caps.add('inference');
    if (style === 'workflow') caps.add('workflow_engine');

    return Array.from(caps);
}

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

/**
 * Estimates analyser confidence (0.0–1.0).
 * Confidence is lower for novel/complex goals with many unknowns.
 */
function estimateConfidence(
    goal: PlanGoal,
    complexity: GoalComplexity,
    missingCapabilities: string[],
    blockingIssues: string[],
): number {
    if (blockingIssues.length > 0) return 0.5;
    if (missingCapabilities.length > 0) return 0.6;

    const baseByComplexity: Record<GoalComplexity, number> = {
        trivial:  0.98,
        simple:   0.92,
        moderate: 0.80,
        complex:  0.65,
    };

    let confidence = baseByComplexity[complexity];

    // Novel categories are less predictable
    if (goal.category === 'conversation' || goal.category === 'research') {
        confidence -= 0.05;
    }

    return Math.max(0.0, Math.min(1.0, confidence));
}

// ---------------------------------------------------------------------------
// GoalAnalyzer
// ---------------------------------------------------------------------------

/**
 * Pure static analyser for PlanGoal objects.
 *
 * Usage:
 *   const analysis = GoalAnalyzer.analyze(goal, availableCapabilities);
 */
export class GoalAnalyzer {
    /**
     * Produces a deterministic GoalAnalysis for the given goal.
     *
     * @param goal - The goal to analyse.
     * @param availableCapabilities - Set of capability names currently available
     *   in the runtime (e.g. 'rag', 'workflow_engine', 'inference').
     *   PlanningService is responsible for providing this from the runtime state.
     * @returns Fully populated GoalAnalysis.  Never throws — errors in analysis
     *   are surfaced as blockingIssues with appropriately low confidence.
     */
    static analyze(goal: PlanGoal, availableCapabilities: ReadonlySet<string> = new Set()): GoalAnalysis {
        const analyzedAt = new Date().toISOString();

        try {
            const complexity = estimateComplexity(goal);
            const style = CATEGORY_EXECUTION_STYLE[goal.category];
            const risk = estimateRisk(goal, style);

            const requiredCapabilities = deriveRequiredCapabilities(goal, style);
            const missingCapabilities = requiredCapabilities.filter(c => !availableCapabilities.has(c));

            const blockingIssues: string[] = [];
            if (missingCapabilities.length > 0) {
                blockingIssues.push(
                    `missing_capabilities: ${missingCapabilities.join(', ')}`
                );
            }

            const approvalResult = requiresApproval(goal, risk, style);
            const recommendedPlanner: RecommendedPlanner = blockingIssues.length > 0
                ? 'operator'
                : STYLE_TO_PLANNER[style];

            const confidence = estimateConfidence(goal, complexity, missingCapabilities, blockingIssues);

            const reasonCodes: string[] = [
                `category:${goal.category}→${style}`,
                `complexity:${complexity}`,
                `risk:${risk}`,
                `planner:${recommendedPlanner}`,
                ...(blockingIssues.length > 0 ? [`blocked:${blockingIssues.length}_issues`] : []),
                ...(approvalResult.required ? ['approval:required'] : ['approval:not_required']),
            ];

            return {
                goalId: goal.id,
                analyzedAt,
                complexity,
                executionStyle: style,
                requiresApproval: approvalResult.required,
                approvalReason: approvalResult.reason,
                approvalContext: approvalResult.context,
                requiredCapabilities,
                missingCapabilities,
                blockingIssues,
                recommendedPlanner,
                confidence,
                risk,
                reasonCodes,
            };
        } catch (err) {
            // Surface analysis errors as blocked with minimal confidence
            const message = err instanceof Error ? err.message : String(err);
            return {
                goalId: goal.id,
                analyzedAt,
                complexity: 'complex',
                executionStyle: 'hybrid',
                requiresApproval: true,
                approvalReason: `analysis_error: ${message}`,
                requiredCapabilities: [],
                missingCapabilities: [],
                blockingIssues: [`analysis_error: ${message}`],
                recommendedPlanner: 'operator',
                confidence: 0.0,
                risk: 'critical',
                reasonCodes: ['analysis_error'],
            };
        }
    }

    /**
     * Generates a stable stage id for tests and deterministic contexts.
     * In production GoalAnalyzer does not generate ids — PlanBuilder does.
     * Exposed here to support test helpers.
     *
     * @internal
     */
    static _generateId(): string {
        return uuidv4();
    }
}
