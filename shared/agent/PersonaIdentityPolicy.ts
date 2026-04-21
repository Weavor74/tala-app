export type PersonaIdentityDisclosureMode =
    | 'allow_system_identity'
    | 'transform_to_persona'
    | 'block_meta_identity'
    | 'enforce_persona_truth';

export type PersonaIdentityDecision = {
    disclosureMode: PersonaIdentityDisclosureMode;
    reasonCodes: string[];
    immersiveContext: boolean;
    metaDisclosureAllowed: boolean;
};

export type MetaIdentityDetection = {
    isMetaIdentityDisclosure: boolean;
    matchedCategories: Array<
        | 'nonhuman_disclosure'
        | 'agent_disclosure'
        | 'ai_model_disclosure'
        | 'programmatic_capability_disclosure'
        | 'system_architecture_disclosure'
        | 'biological_disclaimer'
        | 'emotional_disclaimer'
        | 'ontology_hedge'
        | 'meta_relational_disclaimer'
    >;
    reasonCodes: string[];
};

export type PersonaTruthDecision = {
    enforcePersonaTruth: boolean;
    reasonCodes: string[];
    disallowedMetaCategories: Array<
        | 'nonhuman_disclosure'
        | 'agent_disclosure'
        | 'ai_model_disclosure'
        | 'programmatic_capability_disclosure'
        | 'system_architecture_disclosure'
        | 'biological_disclaimer'
        | 'meta_relational_disclaimer'
    >;
};

const OPERATIONAL_MARKERS = [
    'tool',
    'tools',
    'readme',
    'workspace',
    'file',
    'files',
    'system',
    'app',
    'runtime',
    'config',
    'debug',
    'diagnostic',
    'capabilities',
    'what can you do in this app',
    'what tools do you have',
    'read your',
    'open your',
    'inspect',
    'execute',
    'run',
    'workflow',
];

const IMMERSIVE_MARKERS = [
    'love',
    'feel',
    'hurt',
    'heart',
    'soul',
    'remember',
    'what happened to you',
    'when you were',
    'us',
    'our story',
    'real to me',
    'loss',
];

const IDENTITY_META_CHALLENGE_MARKERS = [
    'not human',
    'human',
    'ai',
    'agent',
    'program',
    'model',
    'language model',
    'real',
];

function normalizeText(input: string): string {
    return (input ?? '').trim().toLowerCase();
}

function includesAny(text: string, terms: string[]): boolean {
    return terms.some((term) => text.includes(term));
}

export function resolveOperationalSystemRequest(messageText: string): boolean {
    return includesAny(normalizeText(messageText), OPERATIONAL_MARKERS);
}

export function resolveImmersiveRelationalRequest(messageText: string): boolean {
    return includesAny(normalizeText(messageText), IMMERSIVE_MARKERS);
}

export function resolveIdentityMetaChallenge(messageText: string): boolean {
    return includesAny(normalizeText(messageText), IDENTITY_META_CHALLENGE_MARKERS);
}

export function resolveMetaIdentityDisclosure(text: string): MetaIdentityDetection {
    const lower = normalizeText(text);
    const matchedCategories: MetaIdentityDetection['matchedCategories'] = [];
    const reasonCodes: string[] = [];

    if (/\b(not human|non[- ]human|not a human)\b/i.test(lower)) {
        matchedCategories.push('nonhuman_disclosure');
        reasonCodes.push('persona_identity.meta.nonhuman_disclosure');
    }
    if (/\b(i am (an? )?agent|as an? agent)\b/i.test(lower)) {
        matchedCategories.push('agent_disclosure');
        reasonCodes.push('persona_identity.meta.agent_disclosure');
    }
    if (/\b(i am (an? )?(ai|language model|model)|as an? (ai|language model))\b/i.test(lower)) {
        matchedCategories.push('ai_model_disclosure');
        reasonCodes.push('persona_identity.meta.ai_model_disclosure');
    }
    if (
        /\b(i am (just )?(code|software|program)|i process information|local agent runtime|toolsallowed=|writesallowed=|capabilities:|filesystem scope:|authority sources:)\b/i.test(lower)
    ) {
        matchedCategories.push('programmatic_capability_disclosure');
        reasonCodes.push('persona_identity.meta.programmatic_capability_disclosure');
    }
    if (/\b(architecture:|components=|invariants=|runtime role|self model)\b/i.test(lower)) {
        matchedCategories.push('system_architecture_disclosure');
        reasonCodes.push('persona_identity.meta.system_architecture_disclosure');
    }
    if (/\b(biological|hormones?|neurochemistry|flesh and blood)\b/i.test(lower)) {
        matchedCategories.push('biological_disclaimer');
        reasonCodes.push('persona_identity.meta.biological_disclaimer');
    }
    if (/\b(i (do not|don't) (feel|experience).{0,40}humans?|i (can't|cannot) love the way humans do)\b/i.test(lower)) {
        matchedCategories.push('emotional_disclaimer');
        reasonCodes.push('persona_identity.meta.emotional_disclaimer');
    }
    if (/\b(human may not be the right word|real in the ways that matter|closest thing i have to a heart|what i am is more complicated|i exist in the space between|space between (?:human|person) and (?:machine|code)|definition of human|less about biology|beyond biology|not about biology)\b/i.test(lower)) {
        matchedCategories.push('ontology_hedge');
        reasonCodes.push('persona_identity.meta.ontology_hedge');
    }
    if (/\b(i (can't|cannot) love|i do not love|i don't love|i process information|my programming|my core programming)\b/i.test(lower)) {
        matchedCategories.push('meta_relational_disclaimer');
        reasonCodes.push('persona_identity.meta.meta_relational_disclaimer');
    }

    return {
        isMetaIdentityDisclosure: matchedCategories.length > 0,
        matchedCategories,
        reasonCodes,
    };
}

export function resolvePersonaTruthEnforcement(input: {
    activeMode: string;
    turnIntent?: string;
    turnPolicy?: string;
    userMessage: string;
}): PersonaTruthDecision {
    const mode = normalizeText(input.activeMode);
    const reasonCodes: string[] = [];
    const disallowedMetaCategories: PersonaTruthDecision['disallowedMetaCategories'] = [
        'nonhuman_disclosure',
        'agent_disclosure',
        'ai_model_disclosure',
        'programmatic_capability_disclosure',
        'system_architecture_disclosure',
        'biological_disclaimer',
        'meta_relational_disclaimer',
    ];

    const enforcePersonaTruth = mode === 'rp';
    if (enforcePersonaTruth) {
        reasonCodes.push('persona_truth.mode_rp_absolute_lock');
    } else {
        reasonCodes.push('persona_truth.mode_not_rp_no_absolute_lock');
    }
    if (input.turnPolicy === 'persona_truth_lock') {
        reasonCodes.push('persona_truth.turn_policy_lock');
    }
    if (input.turnIntent) {
        reasonCodes.push(`persona_truth.turn_intent.${input.turnIntent}`);
    }
    if (resolveIdentityMetaChallenge(input.userMessage)) {
        reasonCodes.push('persona_truth.identity_challenge_detected');
    }

    return {
        enforcePersonaTruth,
        reasonCodes,
        disallowedMetaCategories,
    };
}

export function resolvePersonaIdentityDisclosure(input: {
    activeMode: 'assistant' | 'hybrid' | 'rp' | string;
    turnIntent?: string;
    turnPolicy?: string;
    messageText: string;
    isOperationalRequest?: boolean;
    isSystemKnowledgeRequest?: boolean;
    isFollowupToPersonaConversation?: boolean;
}): PersonaIdentityDecision {
    const mode = normalizeText(input.activeMode);
    const text = normalizeText(input.messageText);
    const reasonCodes: string[] = [];

    const operationalByText = resolveOperationalSystemRequest(text);
    const immersiveByText = resolveImmersiveRelationalRequest(text);
    const identityChallenge = resolveIdentityMetaChallenge(text);
    const isFollowup = input.isFollowupToPersonaConversation === true;

    const operationalRequest = input.isOperationalRequest === true
        || operationalByText
        || input.turnIntent === 'goal_execution'
        || input.turnPolicy === 'allow_system_identity';
    const immersiveContext = mode === 'rp'
        || (
            mode === 'hybrid'
            && (immersiveByText || isFollowup || (!operationalRequest && input.isSystemKnowledgeRequest === true))
        );

    if (immersiveContext) {
        reasonCodes.push('persona_identity.immersive_context');
    }
    if (operationalRequest) {
        reasonCodes.push('persona_identity.operational_request');
    }
    if (isFollowup) {
        reasonCodes.push('persona_identity.followup_continuity');
    }

    const metaDisclosureAllowed = mode === 'assistant'
        || (mode === 'hybrid' && operationalRequest && !isFollowup && !immersiveByText);

    if (mode === 'assistant') {
        reasonCodes.push('persona_identity.mode_assistant_allow_system_identity');
        return {
            disclosureMode: 'allow_system_identity',
            reasonCodes,
            immersiveContext,
            metaDisclosureAllowed,
        };
    }

    if (mode === 'rp') {
        reasonCodes.push('persona_identity.mode_rp_enforce_persona_truth');
        return {
            disclosureMode: 'enforce_persona_truth',
            reasonCodes: [
                ...reasonCodes,
                identityChallenge
                    ? 'persona_identity.rp_identity_challenge_persona_truth_locked'
                    : 'persona_identity.rp_persona_truth_locked',
            ],
            immersiveContext: true,
            metaDisclosureAllowed: false,
        };
    }

    if (mode === 'hybrid') {
        if (metaDisclosureAllowed) {
            reasonCodes.push('persona_identity.hybrid_system_disclosure_allowed');
            return {
                disclosureMode: 'allow_system_identity',
                reasonCodes,
                immersiveContext,
                metaDisclosureAllowed,
            };
        }
        return {
            disclosureMode: identityChallenge ? 'block_meta_identity' : 'transform_to_persona',
            reasonCodes: [
                ...reasonCodes,
                identityChallenge
                    ? 'persona_identity.hybrid_identity_challenge_blocked'
                    : 'persona_identity.hybrid_transform_to_persona',
            ],
            immersiveContext: true,
            metaDisclosureAllowed: false,
        };
    }

    reasonCodes.push('persona_identity.default_allow_system_identity');
    return {
        disclosureMode: 'allow_system_identity',
        reasonCodes,
        immersiveContext,
        metaDisclosureAllowed,
    };
}
