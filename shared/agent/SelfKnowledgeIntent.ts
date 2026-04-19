export type SelfKnowledgeAspect =
    | 'identity'
    | 'capabilities'
    | 'tools'
    | 'architecture'
    | 'systems'
    | 'memory'
    | 'filesystem'
    | 'permissions'
    | 'runtime_mode'
    | 'limits'
    | 'invariants'
    | 'unknown';

export type SelfKnowledgeDecision = {
    isSelfKnowledgeRequest: boolean;
    confidence: number;
    reasonCodes: string[];
    requestedAspects: SelfKnowledgeAspect[];
    requestedScope: 'broad' | 'specific';
};

const GREETING_ONLY_PATTERN = /^(hi|hello|hey|yo|good (morning|afternoon|evening)|how are you|what's up)[!. ]*$/i;
const SELF_REFERENCE_PATTERN = /\b(you|your|tala|yourself)\b/i;
const QUESTION_PATTERN = /\?|\b(what|which|who|can|do|are|is)\b/i;
const KNOWLEDGE_QUERY_PATTERN =
    /\b(what can you do|what do you know about yourself|what are your systems|what tools do you have|what are your capabilities|what is your architecture|what mode are you in|what files can you access|what are your limits|what are you allowed to do right now|can you|are you human|not human|are you an ai|are you a program|are you an agent)\b/i;
const SELF_KNOWLEDGE_CONTEXT_PATTERN =
    /\b(your systems|your capabilities|your tools|your architecture|your memory|your files|your permissions|your limits|about yourself|right now)\b/i;
const ACTION_REQUEST_PATTERN =
    /\b(read|open|inspect|check|search|list|modify|edit|update|create|write|append|change)\b/i;
const FOLLOWUP_INSPECTION_PATTERN =
    /\b(did you|have you)\s+(read|open|inspect|check|search|list|update|edit|modify)\b/i;

const ASPECT_RULES: Array<{ aspect: SelfKnowledgeAspect; pattern: RegExp }> = [
    { aspect: 'identity', pattern: /\b(who are you|what are you|identity|human|ai|agent|program|model)\b/i },
    { aspect: 'capabilities', pattern: /\b(capabilit(?:y|ies)|what can you do)\b/i },
    { aspect: 'tools', pattern: /\b(tool|tools|registry)\b/i },
    { aspect: 'architecture', pattern: /\b(architecture|design|how.*built|component)\b/i },
    { aspect: 'systems', pattern: /\b(system|systems|subsystem|runtime)\b/i },
    { aspect: 'memory', pattern: /\b(memory|remember|mem0|canonical)\b/i },
    { aspect: 'filesystem', pattern: /\b(file|files|filesystem|workspace|root directory|readme|docs)\b/i },
    { aspect: 'permissions', pattern: /\b(permission|allowed|allow|blocked|deny|authorized|can you|edit your|modify your|update your)\b/i },
    { aspect: 'runtime_mode', pattern: /\b(mode|right now|this turn|current turn)\b/i },
    { aspect: 'limits', pattern: /\b(limit|cannot|can't|unable|restriction)\b/i },
    { aspect: 'invariants', pattern: /\b(invariant|doctrine|constraint|non-negotiable)\b/i },
];

function resolveAspects(text: string): SelfKnowledgeAspect[] {
    const aspects = new Set<SelfKnowledgeAspect>();
    for (const rule of ASPECT_RULES) {
        if (rule.pattern.test(text)) {
            aspects.add(rule.aspect);
        }
    }
    if (aspects.size === 0) aspects.add('unknown');
    return [...aspects];
}

function resolveScope(text: string, aspects: SelfKnowledgeAspect[]): 'broad' | 'specific' {
    const broadPattern = /\b(what can you do|what do you know about yourself|what are your systems|tell me about yourself|capabilities)\b/i;
    if (broadPattern.test(text) || aspects.length >= 3) return 'broad';
    return 'specific';
}

export function resolveSelfKnowledgeRequest(input: {
    text: string;
    mode?: string;
}): SelfKnowledgeDecision {
    const text = (input.text ?? '').trim();
    if (!text) {
        return {
            isSelfKnowledgeRequest: false,
            confidence: 0,
            reasonCodes: ['self_knowledge.empty_text'],
            requestedAspects: ['unknown'],
            requestedScope: 'specific',
        };
    }

    if (GREETING_ONLY_PATTERN.test(text)) {
        return {
            isSelfKnowledgeRequest: false,
            confidence: 0,
            reasonCodes: ['self_knowledge.greeting_only_rejected'],
            requestedAspects: ['unknown'],
            requestedScope: 'specific',
        };
    }

    const aspects = resolveAspects(text);
    const scope = resolveScope(text, aspects);
    const reasonCodes: string[] = [];
    let score = 0;

    if (SELF_REFERENCE_PATTERN.test(text)) {
        score += 1;
        reasonCodes.push('self_knowledge.self_reference');
    }
    if (QUESTION_PATTERN.test(text)) {
        score += 1;
        reasonCodes.push('self_knowledge.question_form');
    }
    if (KNOWLEDGE_QUERY_PATTERN.test(text)) {
        score += 2;
        reasonCodes.push('self_knowledge.capability_query_language');
    }
    if (SELF_KNOWLEDGE_CONTEXT_PATTERN.test(text)) {
        score += 1;
        reasonCodes.push('self_knowledge.context_marker');
    }
    if (aspects.some((aspect) => aspect !== 'unknown')) {
        score += 2;
        reasonCodes.push('self_knowledge.aspect_detected');
    }

    const hasStrongQuestionSignal =
        KNOWLEDGE_QUERY_PATTERN.test(text)
        || SELF_KNOWLEDGE_CONTEXT_PATTERN.test(text)
        || (QUESTION_PATTERN.test(text) && SELF_REFERENCE_PATTERN.test(text));
    const imperativeActionWithoutQuestion = ACTION_REQUEST_PATTERN.test(text) && !QUESTION_PATTERN.test(text);
    const followupInspectionRequest = FOLLOWUP_INSPECTION_PATTERN.test(text);
    const isSelfKnowledgeRequest = score >= 4
        && hasStrongQuestionSignal
        && !imperativeActionWithoutQuestion
        && !followupInspectionRequest;
    if (!isSelfKnowledgeRequest) {
        if (followupInspectionRequest) {
            reasonCodes.push('self_knowledge.rejected_followup_inspection_request');
        } else if (imperativeActionWithoutQuestion) {
            reasonCodes.push('self_knowledge.rejected_imperative_action_request');
        } else if (!hasStrongQuestionSignal) {
            reasonCodes.push('self_knowledge.rejected_missing_question_signal');
        } else {
            reasonCodes.push('self_knowledge.threshold_not_met');
        }
    }

    return {
        isSelfKnowledgeRequest,
        confidence: Math.max(0, Math.min(1, score / 5)),
        reasonCodes,
        requestedAspects: aspects,
        requestedScope: scope,
    };
}

export const detectSelfKnowledgeRequest = resolveSelfKnowledgeRequest;
