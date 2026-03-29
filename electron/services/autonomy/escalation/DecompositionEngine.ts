/**
 * DecompositionEngine.ts — Phase 5.1 P5.1D
 *
 * Bounded decomposition engine. Splits a goal that the active model cannot handle
 * in full into a bounded set of independently-safe, verifiable, rollbackable steps.
 *
 * Decomposition strategy (evaluated in order):
 *
 *   1. If goal has multi-file indicators → file_scope decomposition
 *      Each inferred file/scope becomes one step.
 *
 *   2. If goal has high complexity but no multi-file indicators → change_type decomposition
 *      Split by change types: analyze, apply, verify.
 *
 *   3. If goal has repeated failures (recentLocalFailures >= 2) → verification_stage
 *      Split into: prepare, apply, verify, finalize.
 *
 *   4. Fallback → partial_fix decomposition (single reduced-scope step).
 *
 * Safety invariants (always enforced):
 *   - steps.length <= policy.maxStepsPerDecomposition
 *   - depth <= policy.maxDecompositionDepth
 *   - Each step has independent=true, verifiable=true, rollbackable=true
 *   - Returns null when:
 *       * depth >= maxDecompositionDepth (depth exceeded)
 *       * Cannot produce a meaningful decomposition (returns null)
 *
 * Design principle: DETERMINISTIC FIRST — same inputs → same plan.
 * No model calls, no network I/O.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AutonomousGoal } from '../../../../shared/autonomyTypes';
import type {
    TaskCapabilityAssessment,
    DecompositionPlan,
    DecompositionStep,
    DecompositionStepKind,
    EscalationPolicy,
} from '../../../../shared/escalationTypes';

// ─── Estimated tokens per decomposition step ─────────────────────────────────

/** Estimated tokens for a single reduced-scope step. */
const STEP_TOKEN_ESTIMATE = 512;

// ─── File scope extraction keywords ──────────────────────────────────────────

/** Common file extension patterns for scope extraction. */
const FILE_SCOPE_PATTERNS = [
    /\b(\w[\w.-]+\.(ts|js|py|go|rs|json|md|yaml|yml|txt))\b/gi,
    /\b([\w/-]+\.service|[\w/-]+\.test|[\w/-]+\.spec)\b/gi,
];

// ─── Change type labels ───────────────────────────────────────────────────────

const CHANGE_TYPE_STEPS: Array<{ kind: DecompositionStepKind; label: string; scope: string }> = [
    { kind: 'change_type', label: 'Analyze and classify required changes', scope: 'analysis' },
    { kind: 'change_type', label: 'Apply primary code changes', scope: 'apply' },
    { kind: 'change_type', label: 'Verify applied changes', scope: 'verify' },
];

const VERIFICATION_STAGE_STEPS: Array<{ kind: DecompositionStepKind; label: string; scope: string }> = [
    { kind: 'verification_stage', label: 'Prepare scope and validate preconditions', scope: 'prepare' },
    { kind: 'verification_stage', label: 'Apply incremental changes', scope: 'apply' },
    { kind: 'verification_stage', label: 'Verify applied changes pass checks', scope: 'verify' },
    { kind: 'verification_stage', label: 'Finalize and confirm stable state', scope: 'finalize' },
];

// ─── DecompositionEngine ──────────────────────────────────────────────────────

export class DecompositionEngine {
    /**
     * Creates a bounded decomposition plan for a goal the active model cannot handle.
     *
     * Returns null when:
     *   - depth >= maxDecompositionDepth (depth limit exceeded)
     *   - No meaningful decomposition is possible
     *
     * @param goal       The goal to decompose.
     * @param assessment The capability assessment triggering decomposition.
     * @param policy     The active escalation policy.
     * @param depth      Current decomposition depth (0-based; default 0).
     */
    decompose(
        goal: AutonomousGoal,
        assessment: TaskCapabilityAssessment,
        policy: EscalationPolicy,
        depth: number = 0,
    ): DecompositionPlan | null {
        // ── Safety: depth check ────────────────────────────────────────────────
        if (depth >= policy.maxDecompositionDepth) {
            return null;
        }

        const planId = uuidv4();
        const createdAt = new Date().toISOString();
        const maxSteps = policy.maxStepsPerDecomposition;

        // ── Strategy 1: file_scope ─────────────────────────────────────────────
        if (assessment.insufficiencyReasons.includes('multi_file_repair_scope')) {
            const fileScopes = this._extractFileScopes(goal);
            if (fileScopes.length >= 2) {
                const steps = fileScopes
                    .slice(0, maxSteps)
                    .map((scope, i) => this._makeStep(planId, i, 'file_scope',
                        `Process file scope: ${scope}`, scope));
                return this._makePlan(planId, goal.goalId, createdAt, steps, depth + 1,
                    `Decomposed into ${steps.length} file-scoped steps to stay within model context.`);
            }
        }

        // ── Strategy 2: change_type ────────────────────────────────────────────
        if (assessment.insufficiencyReasons.includes('high_complexity_task')) {
            const steps = CHANGE_TYPE_STEPS
                .slice(0, maxSteps)
                .map((s, i) => this._makeStep(planId, i, s.kind, s.label, s.scope));
            return this._makePlan(planId, goal.goalId, createdAt, steps, depth + 1,
                `Decomposed into ${steps.length} change-type stages to reduce per-step complexity.`);
        }

        // ── Strategy 3: verification_stage (repeated failures) ─────────────────
        if (assessment.insufficiencyReasons.includes('repeated_local_failures')
            && assessment.recentLocalFailures >= 2) {
            const steps = VERIFICATION_STAGE_STEPS
                .slice(0, maxSteps)
                .map((s, i) => this._makeStep(planId, i, s.kind, s.label, s.scope));
            return this._makePlan(planId, goal.goalId, createdAt, steps, depth + 1,
                `Decomposed into ${steps.length} verification-stage steps after ${assessment.recentLocalFailures} ` +
                `repeated local failures.`);
        }

        // ── Strategy 4: partial_fix fallback ──────────────────────────────────
        if (assessment.insufficiencyReasons.length > 0) {
            const steps = [
                this._makeStep(planId, 0, 'partial_fix',
                    `Apply partial incremental fix for: ${goal.title}`,
                    goal.subsystemId ?? 'subsystem'),
            ];
            return this._makePlan(planId, goal.goalId, createdAt, steps, depth + 1,
                `Decomposed into a single partial fix step to reduce scope.`);
        }

        // No decomposition possible (shouldn't reach here in normal flow)
        return null;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /**
     * Extracts file/scope identifiers from the goal title and description.
     * Returns deduplicated list.
     */
    private _extractFileScopes(goal: AutonomousGoal): string[] {
        const text = `${goal.title ?? ''} ${goal.description ?? ''}`;
        const found = new Set<string>();

        for (const pattern of FILE_SCOPE_PATTERNS) {
            const matches = text.matchAll(pattern);
            for (const m of matches) {
                found.add(m[1] ?? m[0]);
            }
        }

        // Also include the subsystem ID as a fallback scope
        if (found.size === 0 && goal.subsystemId) {
            found.add(goal.subsystemId);
            found.add(`${goal.subsystemId}-secondary`);
        }

        return [...found];
    }

    private _makeStep(
        planId: string,
        stepIndex: number,
        kind: DecompositionStepKind,
        description: string,
        scopeHint: string,
    ): DecompositionStep {
        return {
            stepId: uuidv4(),
            planId,
            stepIndex,
            kind,
            description,
            scopeHint,
            independent: true,
            verifiable: true,
            rollbackable: true,
            estimatedTokens: STEP_TOKEN_ESTIMATE,
        };
    }

    private _makePlan(
        planId: string,
        goalId: string,
        createdAt: string,
        steps: DecompositionStep[],
        depth: number,
        rationale: string,
    ): DecompositionPlan {
        return {
            planId,
            goalId,
            createdAt,
            steps,
            totalSteps: steps.length,
            depth,
            rationale,
            bounded: true,
        };
    }
}
