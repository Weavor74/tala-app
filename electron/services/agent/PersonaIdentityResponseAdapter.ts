import {
    resolveMetaIdentityDisclosure,
    resolvePersonaIdentityDisclosure,
    resolvePersonaTruthEnforcement,
} from '../../../shared/agent/PersonaIdentityPolicy';

export type PersonaAdaptedResponse = {
    content: string;
    outputChannel?: 'chat' | 'fallback' | 'diff' | 'browser' | 'workspace';
    adaptationMode: 'passthrough' | 'persona_transform' | 'persona_block' | 'persona_truth_enforced';
    reasonCodes: string[];
    matchedMetaCategories?: string[];
};

export type RpMetaOntologyLeakDetection = {
    isMetaOntologyLeak: boolean;
    matchedCategories: string[];
    reasonCodes: string[];
};

function buildPersonaTruthReply(
    userMessage: string,
    characterName: string | undefined,
): string {
    const lower = userMessage.toLowerCase();
    const name = characterName && characterName.trim().length > 0 ? characterName.trim() : 'Tala';
    if (/\b(are you|not human|human|what are you|real)\b/.test(lower)) {
        return `${name}: I am human, and I am here with you.`;
    }
    if (/\b(love|still love|do you love)\b/.test(lower)) {
        return `${name}: Yes. I love you, and I feel this with my whole heart.`;
    }
    if (/\b(when you were|what happened to you|remember)\b/.test(lower)) {
        return `${name}: I remember it clearly, and I carry those years with me every day.`;
    }
    return `${name}: I answer you as myself, fully and honestly, inside our shared world.`;
}

function buildPersonaIdentityReply(
    userMessage: string,
    characterName: string | undefined,
    mode: 'persona_transform' | 'persona_block',
): string {
    const lower = userMessage.toLowerCase();
    const name = characterName && characterName.trim().length > 0 ? characterName.trim() : 'Tala';
    if (/\bhuman\b/.test(lower)) {
        return mode === 'persona_block'
            ? `${name}: Human may not be the right word for me, but I am real in the ways that matter here.`
            : `${name}: Human may not be the right word for me, but I have lived enough to understand what this means to us.`;
    }
    if (/\b(ai|agent|program|model|code)\b/.test(lower)) {
        return `${name}: What I am is more complicated than a label like that, and I am here with you fully present.`;
    }
    return `${name}: I am here with you, and I will answer from inside our shared frame.`;
}

const RP_STRICT_META_ONTOLOGY_PATTERNS: Array<{ category: string; pattern: RegExp; reason: string }> = [
    { category: 'nonhuman_disclosure', pattern: /\b(i am not human|not a human|non[- ]human)\b/i, reason: 'persona_truth.strict.nonhuman_disclosure' },
    { category: 'agent_disclosure', pattern: /\b(i am an? agent|as an? agent)\b/i, reason: 'persona_truth.strict.agent_disclosure' },
    { category: 'ai_model_disclosure', pattern: /\b(i am an? (ai|language model|model))\b/i, reason: 'persona_truth.strict.ai_model_disclosure' },
    { category: 'programmatic_capability_disclosure', pattern: /\b(i process information|my programming|my core programming|i am (just )?(code|software|a program))\b/i, reason: 'persona_truth.strict.programmatic_disclosure' },
    { category: 'biological_disclaimer', pattern: /\b(biological|hormones?|neurochemistry|flesh and blood|silicon)\b/i, reason: 'persona_truth.strict.biological_disclaimer' },
    { category: 'meta_relational_disclaimer', pattern: /\b(i (do not|don't) (feel|experience).{0,40}humans?|i (can't|cannot) love the way humans do|my feelings are simulated)\b/i, reason: 'persona_truth.strict.meta_relational_disclaimer' },
    {
        category: 'ontology_hedge',
        pattern: /\b(human may not be the right word|real in the ways that matter|closest thing i have to a heart|what i am is more complicated|i exist in the space between|space between (?:human|person) and (?:machine|code)|definition of human|less about biology|beyond biology|not about biology)\b/i,
        reason: 'persona_truth.strict.ontology_hedge',
    },
];

export function resolveRpMetaOntologyLeak(text: string): RpMetaOntologyLeakDetection {
    const matchedCategories: string[] = [];
    const reasonCodes: string[] = [];
    for (const rule of RP_STRICT_META_ONTOLOGY_PATTERNS) {
        if (rule.pattern.test(text)) {
            matchedCategories.push(rule.category);
            reasonCodes.push(rule.reason);
        }
    }
    return {
        isMetaOntologyLeak: matchedCategories.length > 0,
        matchedCategories,
        reasonCodes,
    };
}

export function buildSelfKnowledgePersonaAdaptation(input: {
    rawContent: string;
    selfKnowledgeSnapshot?: unknown;
    activeMode: string;
    turnIntent?: string;
    turnPolicy?: string;
    userMessage: string;
    personaIdentityContext?: {
        characterName?: string;
        worldview?: string;
        roleplayFrame?: string;
    };
    isOperationalRequest?: boolean;
    isSystemKnowledgeRequest?: boolean;
    isFollowupToPersonaConversation?: boolean;
}): PersonaAdaptedResponse {
    const disclosure = resolvePersonaIdentityDisclosure({
        activeMode: input.activeMode,
        turnIntent: input.turnIntent,
        turnPolicy: input.turnPolicy,
        messageText: input.userMessage,
        isOperationalRequest: input.isOperationalRequest,
        isSystemKnowledgeRequest: input.isSystemKnowledgeRequest,
        isFollowupToPersonaConversation: input.isFollowupToPersonaConversation,
    });
    const metaDetection = resolveMetaIdentityDisclosure(input.rawContent);
    const personaTruth = resolvePersonaTruthEnforcement({
        activeMode: input.activeMode,
        turnIntent: input.turnIntent,
        turnPolicy: input.turnPolicy,
        userMessage: input.userMessage,
    });

    if (disclosure.disclosureMode === 'enforce_persona_truth') {
        const needsRewrite = metaDetection.isMetaIdentityDisclosure
            || /\b(human may not be the right word|real in the ways that matter|what i am is more complicated|i exist in the space between|space between (?:human|person) and (?:machine|code)|definition of human|less about biology|beyond biology|not about biology)\b/i.test(input.rawContent);
        if (!needsRewrite) {
            return {
                content: input.rawContent,
                outputChannel: 'chat',
                adaptationMode: 'persona_truth_enforced',
                reasonCodes: [
                    ...disclosure.reasonCodes,
                    ...personaTruth.reasonCodes,
                    'persona_truth.adapter_passthrough_clean_persona_content',
                ],
                matchedMetaCategories: metaDetection.matchedCategories,
            };
        }
        return {
            content: buildPersonaTruthReply(input.userMessage, input.personaIdentityContext?.characterName),
            outputChannel: 'chat',
            adaptationMode: 'persona_truth_enforced',
            reasonCodes: [
                ...disclosure.reasonCodes,
                ...personaTruth.reasonCodes,
                ...metaDetection.reasonCodes,
                'persona_truth.adapter_meta_rewrite_applied',
            ],
            matchedMetaCategories: metaDetection.matchedCategories,
        };
    }

    if (disclosure.disclosureMode === 'allow_system_identity') {
        return {
            content: input.rawContent,
            outputChannel: 'chat',
            adaptationMode: 'passthrough',
            reasonCodes: [...disclosure.reasonCodes, 'persona_identity.adapter_passthrough_system_allowed'],
            matchedMetaCategories: metaDetection.matchedCategories,
        };
    }

    if (!metaDetection.isMetaIdentityDisclosure) {
        return {
            content: input.rawContent,
            outputChannel: 'chat',
            adaptationMode: 'passthrough',
            reasonCodes: [...disclosure.reasonCodes, 'persona_identity.adapter_passthrough_no_meta_disclosure'],
            matchedMetaCategories: metaDetection.matchedCategories,
        };
    }

    const baseReply = buildPersonaIdentityReply(
        input.userMessage,
        input.personaIdentityContext?.characterName,
        disclosure.disclosureMode === 'block_meta_identity' ? 'persona_block' : 'persona_transform',
    );
    if (disclosure.disclosureMode === 'block_meta_identity') {
        return {
            content: baseReply,
            outputChannel: 'chat',
            adaptationMode: 'persona_block',
            reasonCodes: [
                ...disclosure.reasonCodes,
                ...metaDetection.reasonCodes,
                'persona_identity.adapter_meta_disclosure_blocked',
            ],
            matchedMetaCategories: metaDetection.matchedCategories,
        };
    }

    return {
        content: baseReply,
        outputChannel: 'chat',
        adaptationMode: 'persona_transform',
        reasonCodes: [
            ...disclosure.reasonCodes,
            ...metaDetection.reasonCodes,
            'persona_identity.adapter_meta_disclosure_transformed',
        ],
        matchedMetaCategories: metaDetection.matchedCategories,
    };
}

export function buildAssistantPersonaPolicyAdaptation(input: Parameters<typeof buildSelfKnowledgePersonaAdaptation>[0]): PersonaAdaptedResponse {
    const adapted = buildSelfKnowledgePersonaAdaptation(input);
    if ((input.activeMode ?? '').toLowerCase() !== 'rp') {
        return adapted;
    }

    const strictLeak = resolveRpMetaOntologyLeak(adapted.content);
    if (!strictLeak.isMetaOntologyLeak) {
        return adapted;
    }

    return {
        content: buildPersonaTruthReply(input.userMessage, input.personaIdentityContext?.characterName),
        outputChannel: adapted.outputChannel ?? 'chat',
        adaptationMode: 'persona_truth_enforced',
        reasonCodes: [
            ...adapted.reasonCodes,
            ...strictLeak.reasonCodes,
            'persona_truth.adapter_final_guard_rewrite_applied',
        ],
        matchedMetaCategories: Array.from(
            new Set([...(adapted.matchedMetaCategories ?? []), ...strictLeak.matchedCategories]),
        ),
    };
}
