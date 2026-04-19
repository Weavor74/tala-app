/**
 * RpPublishBoundaryGuard
 *
 * Universal RP publish-boundary ontology leak enforcement.
 *
 * This is the single deterministic gate that inspects every final generated
 * text before it is published or persisted in RP mode.  It runs regardless of
 * whether intent detection, routing, or prompt grounding succeeded.
 *
 * Design invariants:
 * - Pure function: no side-effects, no telemetry.  The caller (AgentKernel)
 *   emits telemetry based on the returned result.
 * - mode !== 'rp'  → immediate passthrough (assistant / hybrid unaffected).
 * - mode === 'rp'  → detect leaks, rewrite deterministically, fail-safe block.
 * - Exactly-once per publish path: the guard is called once in
 *   _enforceRpPersonaTruthBeforePublication and nowhere else.
 */

import {
    resolveRpMetaOntologyLeak,
    buildAssistantPersonaPolicyAdaptation,
} from './PersonaIdentityResponseAdapter';

// ─── Public types ─────────────────────────────────────────────────────────────

export type RpPublishGuardInput = {
    /** Final generated text to inspect. */
    finalText: string;
    /** Resolved execution mode for this turn. */
    mode: string;
    /** The user message that triggered this turn (used to build persona reply). */
    userMessage: string;
    /** Resolved turn intent (optional — guard runs even without it). */
    intent?: string;
    /** Source that produced this response (e.g. 'router', 'self_knowledge'). */
    routeSource?: string;
    /** Persona identity context for character-accurate rewrites. */
    personaIdentityContext?: {
        characterName?: string;
        worldview?: string;
        roleplayFrame?: string;
    };
    /** Whether the turn was detected as an operational/system request. */
    isOperationalRequest?: boolean;
    /** Whether the turn was detected as a self-knowledge request. */
    isSystemKnowledgeRequest?: boolean;
    /** Whether this is a follow-up to an ongoing persona conversation. */
    isFollowupToPersonaConversation?: boolean;
};

export type RpPublishGuardActionTaken = 'passthrough' | 'rewritten' | 'blocked';

export type RpPublishGuardResult = {
    /** The final text to publish — either unchanged or the persona-safe replacement. */
    finalText: string;
    /** What the guard did to the content. */
    actionTaken: RpPublishGuardActionTaken;
    /** Whether an ontology leak was detected in the input text. */
    leakDetected: boolean;
    /**
     * Whether the guard actually evaluated for leaks (true whenever mode === 'rp',
     * false when mode !== 'rp' and the guard short-circuited).
     */
    guardFired: boolean;
    /** Leak pattern categories that matched (empty when no leak). */
    matchedMetaCategories: string[];
    /** Structured reason codes for diagnostics. */
    reasonCodes: string[];
    /** The adaptation mode produced by the persona policy layer. */
    adaptationMode: 'passthrough' | 'persona_transform' | 'persona_block' | 'persona_truth_enforced';
    /**
     * The output channel recommended by the persona policy layer.
     * Undefined when the guard did not fire (mode != rp) — callers should
     * fall back to the original channel in that case.
     */
    outputChannel?: 'chat' | 'fallback' | 'diff' | 'browser' | 'workspace';
};

// ─── Guard implementation ────────────────────────────────────────────────────

/**
 * Inspect `input.finalText` in RP mode and return a persona-safe replacement
 * if any assistant/meta ontology leakage is detected.
 *
 * Callers must emit telemetry based on the returned result — this function is
 * intentionally side-effect-free.
 */
export function applyRpFinalOntologyGuard(input: RpPublishGuardInput): RpPublishGuardResult {
    // ── Non-RP: immediate passthrough ────────────────────────────────────────
    if (input.mode !== 'rp') {
        return {
            finalText: input.finalText,
            actionTaken: 'passthrough',
            leakDetected: false,
            guardFired: false,
            matchedMetaCategories: [],
            reasonCodes: ['rp_publish_guard.mode_not_rp'],
            adaptationMode: 'passthrough',
        };
    }

    // ── Leak detection ───────────────────────────────────────────────────────
    const leakDetection = resolveRpMetaOntologyLeak(input.finalText);

    if (!leakDetection.isMetaOntologyLeak) {
        return {
            finalText: input.finalText,
            actionTaken: 'passthrough',
            leakDetected: false,
            guardFired: true,
            matchedMetaCategories: [],
            reasonCodes: ['rp_publish_guard.clean_passthrough'],
            adaptationMode: 'passthrough',
        };
    }

    // ── Rewrite ──────────────────────────────────────────────────────────────
    const adapted = buildAssistantPersonaPolicyAdaptation({
        rawContent: input.finalText,
        activeMode: input.mode,
        turnIntent: input.intent,
        turnPolicy: 'persona_truth_lock',
        userMessage: input.userMessage,
        personaIdentityContext: input.personaIdentityContext,
        isOperationalRequest: input.isOperationalRequest,
        isSystemKnowledgeRequest: input.isSystemKnowledgeRequest,
        isFollowupToPersonaConversation: input.isFollowupToPersonaConversation,
    });

    // ── Post-rewrite safety check ────────────────────────────────────────────
    const postLeak = resolveRpMetaOntologyLeak(adapted.content);

    if (postLeak.isMetaOntologyLeak) {
        // The persona policy layer produced a reply that still leaks ontology
        // (e.g. it used one of the "hedge" phrases that are also blocked).
        // Force a second pass with a known-bad input to guarantee a clean reply.
        const safeBlock = buildAssistantPersonaPolicyAdaptation({
            rawContent: 'I am not human. I am an agent.',
            activeMode: input.mode,
            turnIntent: input.intent,
            turnPolicy: 'persona_truth_lock',
            userMessage: input.userMessage,
            personaIdentityContext: input.personaIdentityContext,
            isOperationalRequest: input.isOperationalRequest,
            isSystemKnowledgeRequest: input.isSystemKnowledgeRequest,
            isFollowupToPersonaConversation: input.isFollowupToPersonaConversation,
        });
        return {
            finalText: safeBlock.content,
            actionTaken: 'blocked',
            leakDetected: true,
            guardFired: true,
            matchedMetaCategories: leakDetection.matchedCategories,
            reasonCodes: [
                ...leakDetection.reasonCodes,
                ...adapted.reasonCodes,
                ...safeBlock.reasonCodes,
                'rp_publish_guard.blocked_residual_post_rewrite',
            ],
            adaptationMode: 'persona_truth_enforced',
            outputChannel: safeBlock.outputChannel,
        };
    }

    return {
        finalText: adapted.content,
        actionTaken: 'rewritten',
        leakDetected: true,
        guardFired: true,
        matchedMetaCategories: leakDetection.matchedCategories,
        reasonCodes: [
            ...leakDetection.reasonCodes,
            ...adapted.reasonCodes,
            'rp_publish_guard.rewritten',
        ],
        adaptationMode: adapted.adaptationMode,
        outputChannel: adapted.outputChannel,
    };
}
