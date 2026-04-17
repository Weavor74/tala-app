/**
 * PlanningLoopAuthorityRouter.ts — Execution authority routing classifier
 *
 * Deterministic, stateless classifier that decides whether a runtime request
 * requires PlanningLoopService authority or may proceed via a trivially-allowed
 * direct path.
 *
 * This is the single decision point implementing the routing doctrine:
 *
 *   routeWork(request) =>
 *     if (isTrivialDirectWork(request)) trivial_direct_allowed
 *     else planning_loop_required
 *
 * Design invariants
 * ─────────────────
 * 1. Deterministic — same inputs always produce the same classification.
 * 2. Stateless — no I/O, no DB, no network, no LLM calls.
 * 3. Conservative — when ambiguous, defaults to `non_trivial` / `planning_loop_required`.
 * 4. Typed — all decisions are fully typed PlanningLoopRoutingDecision records.
 * 5. Inspectable — reason codes explain every classification decision.
 *
 * Trivial allowlist
 * ─────────────────
 * Only the following are classified as trivially direct:
 *   - Greeting patterns (hi, hello, hey, good morning/evening, etc.)
 *   - Acknowledgement patterns (ok, thanks, got it, sounds good, etc.)
 *   - Very short messages (≤ TRIVIAL_MAX_CHARS) with no tool signals
 *
 * Everything else defaults to `planning_loop_required`.
 */

import type {
    WorkComplexityClassification,
    ExecutionAuthorityClassification,
    NonTrivialWorkReasonCode,
    PlanningLoopRoutingDecision,
    DegradedExecutionReason,
    DegradedExecutionDecision,
} from '../../../shared/planning/executionAuthorityTypes';

// ─── Thresholds and patterns ──────────────────────────────────────────────────

/**
 * Messages shorter than or equal to this character count may qualify as trivial.
 * Messages exceeding this are always classified as non-trivial.
 */
const TRIVIAL_MAX_CHARS = 80;

/**
 * Message length at or above which we add `message_length_exceeds_trivial_threshold`.
 */
const NON_TRIVIAL_LENGTH_THRESHOLD = 200;

/**
 * Greeting patterns that are trivially direct.
 * All lowercase. Matched against the lowercased, trimmed message.
 */
const GREETING_PATTERNS: RegExp[] = [
    /^(hi|hello|hey|howdy|greetings|good\s*(morning|afternoon|evening|night|day)|what'?s up|sup|yo)[\s!?.]*$/i,
];

/**
 * Acknowledgement patterns that are trivially direct.
 */
const ACK_PATTERNS: RegExp[] = [
    /^(ok|okay|got it|thanks|thank you|ty|thx|sure|sounds good|alright|great|perfect|noted|understood|cool|nice|awesome|cheers|no problem|np)[\s!?.]*$/i,
];

/**
 * Tool/workflow/execution signals that mark a request as non-trivial.
 * Matched case-insensitively against the full message.
 */
const TOOL_SIGNAL_PATTERNS: RegExp[] = [
    // File operations
    /\b(read|write|create|delete|rename|move|copy|list|open|save|edit)\s+(a\s+)?(file|folder|dir(ectory)?|document|code|script)/i,
    /\b(fs_|file\s*system|filesystem)\b/i,
    // Code operations
    /\b(run|execute|compile|build|lint|test|deploy|install|uninstall)\b/i,
    // Search / retrieval
    /\b(search|find|look\s*up|retrieve|query|fetch|get|read)\b/i,
    // Memory operations
    /\b(remember|recall|memory|memorize|store|forget|update.*memory|save.*memory)\b/i,
    // Workflow / tool mentions
    /\b(workflow|tool|function|script|command|terminal|shell|bash|python|node)\b/i,
    // Artifact generation
    /\b(generate|create|write|produce|make|build|draft)\b/i,
    // External I/O
    /\b(http|url|api|endpoint|web|browser|email|send|download|upload)\b/i,
    // Notebook / summarize
    /\b(notebook|summarize|summarise|analyze|analyse|explain|describe|compare|evaluate|assess)\b/i,
    // Multi-step keywords
    /\b(then|after\s+that|next|first|second|third|step\s*\d|and\s+then)\b/i,
];

/**
 * Outcome-seeking action verbs that classify a request as non-trivial.
 */
const ACTION_VERB_PATTERNS: RegExp[] = [
    /\b(implement|refactor|fix|debug|resolve|update|upgrade|migrate|convert|transform|process|compute|calculate|generate|produce|analyze|plan|design|architect)\b/i,
];

// ─── PlanningLoopAuthorityRouter ──────────────────────────────────────────────

/**
 * Stateless, deterministic execution authority classifier.
 *
 * Call `classify(message)` to get a fully typed `PlanningLoopRoutingDecision`.
 * Call `isTrivialDirectWork(message)` for a simple boolean check.
 */
export class PlanningLoopAuthorityRouter {

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Classifies the given user message and returns a fully typed routing decision.
     *
     * This is the canonical routing entry point.  All routing logic is encapsulated
     * here — callers should not implement their own trivial/non-trivial heuristics.
     *
     * @param message - The user message or goal string to classify.
     * @returns A PlanningLoopRoutingDecision with full reason codes and classification.
     */
    static classify(message: string): PlanningLoopRoutingDecision {
        const trimmed = (message ?? '').trim();
        const reasonCodes: NonTrivialWorkReasonCode[] = [];

        // ── Length gate ─────────────────────────────────────────────────────
        if (trimmed.length > NON_TRIVIAL_LENGTH_THRESHOLD) {
            reasonCodes.push('message_length_exceeds_trivial_threshold');
        }

        // ── Trivial greeting / ack check ────────────────────────────────────
        // Short messages that match greeting or ack patterns only are trivial.
        if (trimmed.length <= TRIVIAL_MAX_CHARS && reasonCodes.length === 0) {
            if (
                GREETING_PATTERNS.some(p => p.test(trimmed)) ||
                ACK_PATTERNS.some(p => p.test(trimmed))
            ) {
                return {
                    complexity: 'trivial',
                    classification: 'trivial_direct_allowed',
                    requiresLoop: false,
                    reasonCodes: [],
                    summary: 'trivial greeting or acknowledgement; direct path allowed',
                };
            }
        }

        // ── Tool/workflow signal detection ──────────────────────────────────
        if (TOOL_SIGNAL_PATTERNS.some(p => p.test(trimmed))) {
            reasonCodes.push('tool_signal_detected');
        }

        // ── Action verb detection ────────────────────────────────────────────
        if (ACTION_VERB_PATTERNS.some(p => p.test(trimmed))) {
            reasonCodes.push('outcome_seeking_action_verb_detected');
        }

        // ── Conservative default for anything over trivial threshold ────────
        // Any message exceeding TRIVIAL_MAX_CHARS that isn't a greeting/ack
        // is non-trivial by default.
        if (trimmed.length > TRIVIAL_MAX_CHARS && reasonCodes.length === 0) {
            reasonCodes.push('conservative_default');
        }

        // ── Very short messages with no signals ─────────────────────────────
        // These are short but couldn't be confirmed as trivial. Still non-trivial
        // by conservative default.
        if (reasonCodes.length === 0) {
            reasonCodes.push('conservative_default');
        }

        const complexity: WorkComplexityClassification = 'non_trivial';
        const classification: ExecutionAuthorityClassification = 'planning_loop_required';

        return {
            complexity,
            classification,
            requiresLoop: true,
            reasonCodes,
            summary: `non-trivial work detected; planning loop required (${reasonCodes.join(', ')})`,
        };
    }

    /**
     * Returns true if the message may proceed via the trivially-allowed direct path.
     *
     * Convenience wrapper around classify() for simple boolean checks.
     *
     * @param message - The user message or goal string to classify.
     */
    static isTrivialDirectWork(message: string): boolean {
        return PlanningLoopAuthorityRouter.classify(message).classification === 'trivial_direct_allowed';
    }

    /**
     * Classifies a degraded-execution situation and returns an explicit typed decision.
     *
     * Called whenever a non-trivial work request cannot be honoured by the normal
     * PlanningLoopService path (loop unavailable, plan blocked, etc.).
     *
     * Replaces silent "fall through to direct" fallback with a deterministic, typed,
     * auditable policy record.  Callers MUST:
     *   1. Emit a `planning.degraded_execution_decision` telemetry event with the decision.
     *   2. Respect `directAllowed`: if false, halt execution; if true, proceed on direct
     *      path as an explicitly doctrined exception.
     *
     * ┌────────────────────────────┬────────────────────────────┬─────────────────────────────────────────────────────────────┐
     * │ reason                     │ directAllowed              │ doctrine                                                    │
     * ├────────────────────────────┼────────────────────────────┼─────────────────────────────────────────────────────────────┤
     * │ loop_unavailable           │ true                       │ chat_continuity: loop not ready; direct path preserves UX   │
     * │ capability_unregistered    │ false                      │ no_capability: no executor; direct forbidden                │
     * │ plan_blocked               │ true                       │ chat_continuity: plan blocked; direct response allowed      │
     * │ policy_blocked             │ false                      │ policy_blocked: gate denied; direct execution forbidden      │
     * └────────────────────────────┴────────────────────────────┴─────────────────────────────────────────────────────────────┘
     *
     * @param reason     - The degraded execution reason code.
     * @param context    - Caller context (used for `detectedIn` field).
     */
    static classifyDegradedExecution(
        reason: DegradedExecutionReason,
        context: { detectedIn: string },
    ): DegradedExecutionDecision {
        const detectedAt = new Date().toISOString();
        const { detectedIn } = context;

        switch (reason) {
            case 'loop_unavailable':
                return {
                    reason,
                    directAllowed: true,
                    degradedModeCode: 'degraded_direct_allowed',
                    doctrine: 'chat_continuity: PlanningLoopService not yet initialised; ' +
                        'direct path permitted to preserve user-facing responsiveness. ' +
                        'Emit telemetry; do not silence.',
                    detectedIn,
                    detectedAt,
                };

            case 'plan_blocked':
                return {
                    reason,
                    directAllowed: true,
                    degradedModeCode: 'degraded_direct_allowed',
                    doctrine: 'chat_continuity: planning returned plan_blocked; ' +
                        'direct response allowed so the user receives feedback. ' +
                        'Emit telemetry; do not silence.',
                    detectedIn,
                    detectedAt,
                };

            case 'capability_unregistered':
                return {
                    reason,
                    directAllowed: false,
                    degradedModeCode: 'degraded_execution_blocked',
                    doctrine: 'no_capability: loop initialised but no executor registered ' +
                        'for the requested work type. Direct execution is forbidden; ' +
                        'surface the failure explicitly.',
                    detectedIn,
                    detectedAt,
                };

            case 'policy_blocked':
                return {
                    reason,
                    directAllowed: false,
                    degradedModeCode: 'degraded_execution_blocked',
                    doctrine: 'policy_blocked: PolicyGate denied execution. ' +
                        'Direct execution is forbidden; the denial must be respected.',
                    detectedIn,
                    detectedAt,
                };
        }
    }
}
