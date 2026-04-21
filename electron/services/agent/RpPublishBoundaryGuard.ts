/**
 * RpPublishBoundaryGuard
 *
 * Universal RP publish-boundary ontology leak enforcement.
 *
 * This is the single deterministic gate that inspects every final generated
 * text before it is published or persisted in RP mode. It runs regardless of
 * whether intent detection, routing, or prompt grounding succeeded.
 */

import {
    resolveRpMetaOntologyLeak,
    buildAssistantPersonaPolicyAdaptation,
} from './PersonaIdentityResponseAdapter';
import { resolveIdentityMetaChallenge } from '../../../shared/agent/PersonaIdentityPolicy';

type RpMetaTemplateLeakDetection = {
    isMetaTemplateLeak: boolean;
    matchedCategories: string[];
    reasonCodes: string[];
};

const RP_META_TEMPLATE_PATTERNS: Array<{ category: string; pattern: RegExp; reason: string }> = [
    {
        category: 'meta_template.identity_respond_with',
        pattern: /\b(i am|i'm)\s+tala\b.{0,80}\bi\s+respond\s+with\b/i,
        reason: 'rp_publish_guard.meta_template.identity_respond_with',
    },
    {
        category: 'meta_template.response_format_narration',
        pattern: /\bi\s+respond\s+with\s*(?:\.{2,}|["'*]|a\s+(?:warm|inviting|gentle|soft|playful|mischievous)\b)/i,
        reason: 'rp_publish_guard.meta_template.response_format_narration',
    },
];

function resolveRpMetaTemplateLeak(text: string): RpMetaTemplateLeakDetection {
    const matchedCategories: string[] = [];
    const reasonCodes: string[] = [];
    for (const rule of RP_META_TEMPLATE_PATTERNS) {
        if (rule.pattern.test(text)) {
            matchedCategories.push(rule.category);
            reasonCodes.push(rule.reason);
        }
    }
    return {
        isMetaTemplateLeak: matchedCategories.length > 0,
        matchedCategories,
        reasonCodes,
    };
}

export type RpPublishGuardInput = {
    finalText: string;
    mode: string;
    userMessage: string;
    intent?: string;
    routeSource?: string;
    personaIdentityContext?: {
        characterName?: string;
        worldview?: string;
        roleplayFrame?: string;
    };
    isOperationalRequest?: boolean;
    isSystemKnowledgeRequest?: boolean;
    isFollowupToPersonaConversation?: boolean;
};

export type RpPublishGuardActionTaken = 'passthrough' | 'rewritten' | 'blocked';

export type RpPublishGuardResult = {
    finalText: string;
    actionTaken: RpPublishGuardActionTaken;
    leakDetected: boolean;
    guardFired: boolean;
    matchedMetaCategories: string[];
    reasonCodes: string[];
    adaptationMode: 'passthrough' | 'persona_transform' | 'persona_block' | 'persona_truth_enforced';
    outputChannel?: 'chat' | 'fallback' | 'diff' | 'browser' | 'workspace';
};

export function applyRpFinalOntologyGuard(input: RpPublishGuardInput): RpPublishGuardResult {
    const identityChallengeDetected = resolveIdentityMetaChallenge(input.userMessage);

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

    const ontologyLeak = resolveRpMetaOntologyLeak(input.finalText);
    const templateLeak = resolveRpMetaTemplateLeak(input.finalText);
    const leakDetected = ontologyLeak.isMetaOntologyLeak || templateLeak.isMetaTemplateLeak;
    const matchedMetaCategories = Array.from(new Set([
        ...ontologyLeak.matchedCategories,
        ...templateLeak.matchedCategories,
    ]));
    const leakReasonCodes = [
        ...ontologyLeak.reasonCodes,
        ...templateLeak.reasonCodes,
    ];

    if (!leakDetected) {
        const reasonCodes = ['rp_publish_guard.clean_passthrough'];
        if (identityChallengeDetected) {
            reasonCodes.push('rp_publish_guard.identity_challenge_detected');
        }
        return {
            finalText: input.finalText,
            actionTaken: 'passthrough',
            leakDetected: false,
            guardFired: true,
            matchedMetaCategories: [],
            reasonCodes,
            adaptationMode: 'passthrough',
        };
    }

    // For template-only leaks, force deterministic rewrite through existing persona adapter.
    const adaptationSeed = ontologyLeak.isMetaOntologyLeak
        ? input.finalText
        : 'I am not human. I am an agent.';

    const adapted = buildAssistantPersonaPolicyAdaptation({
        rawContent: adaptationSeed,
        activeMode: input.mode,
        turnIntent: input.intent,
        turnPolicy: 'persona_truth_lock',
        userMessage: input.userMessage,
        personaIdentityContext: input.personaIdentityContext,
        isOperationalRequest: input.isOperationalRequest,
        isSystemKnowledgeRequest: input.isSystemKnowledgeRequest,
        isFollowupToPersonaConversation: input.isFollowupToPersonaConversation,
    });

    const postOntologyLeak = resolveRpMetaOntologyLeak(adapted.content);
    const postTemplateLeak = resolveRpMetaTemplateLeak(adapted.content);
    const postLeakDetected = postOntologyLeak.isMetaOntologyLeak || postTemplateLeak.isMetaTemplateLeak;

    if (postLeakDetected) {
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
            matchedMetaCategories,
            reasonCodes: [
                ...leakReasonCodes,
                ...adapted.reasonCodes,
                ...postOntologyLeak.reasonCodes,
                ...postTemplateLeak.reasonCodes,
                ...safeBlock.reasonCodes,
                ...(identityChallengeDetected ? ['rp_publish_guard.identity_challenge_detected'] : []),
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
        matchedMetaCategories,
        reasonCodes: [
            ...leakReasonCodes,
            ...adapted.reasonCodes,
            ...(identityChallengeDetected ? ['rp_publish_guard.identity_challenge_detected'] : []),
            'rp_publish_guard.rewritten',
        ],
        adaptationMode: adapted.adaptationMode,
        outputChannel: adapted.outputChannel,
    };
}
