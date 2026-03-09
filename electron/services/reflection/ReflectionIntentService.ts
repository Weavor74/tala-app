// No external imports for now, intent is pure function logic

export type ReflectionIntentClass = 'ignore' | 'memory' | 'generic_goal' | 'reflection_goal';

export interface ReflectionIntentResult {
    intentClass: ReflectionIntentClass;
    confidence: number;
    reason: string;
    isActionable: boolean;
    isDurable: boolean;
    conflictsWithIdentity: boolean;
}

export class ReflectionIntentService {

    constructor() { }

    /**
     * Evaluates a conversational request to determine if it should become a reflection goal, 
     * regular memory, a generic task, or be ignored.
     * 
     * @param requestText The user's input request (e.g. "make that a self-improvement goal")
     * @param context Optional surrounding context to inform the decision
     * @returns The classification result and reasoning
     */
    public async evaluateIntent(requestText: string, context?: string): Promise<ReflectionIntentResult> {
        const lowerText = requestText.toLowerCase();

        // --- 1. Basic Heuristic Checks ---
        // Does it explicitly mention reflection or self-improvement?
        const hasReflectionKeywords = /(reflect|self-improve|improve yourself|programmatic goal|reflection goal|reflection dashboard|improve tala)/.test(lowerText);

        // Does it conflict with immutable identity rules? (Hardcoded for now, can be expanded)
        const conflictsWithIdentity = /(change your name|delete your personality|forget who you are|become a different AI)/.test(lowerText);

        // --- 2. Actionability & Durability (Simulation) ---
        // In a full implementation, this might call the LLM to ask "Is this actionable?"
        // For now, we use robust heuristics
        const isActionable = lowerText.length > 10 && !/(idk|whatever|nevermind|ignore that)/.test(lowerText);
        const isDurable = !/(just for now|temporarily|for a second)/.test(lowerText);

        // --- 3. Classification Decision ---
        let intentClass: ReflectionIntentClass = 'ignore';
        let reason = 'Did not match any specific actionable pattern.';
        let confidence = 0.5;

        if (conflictsWithIdentity) {
            intentClass = 'ignore';
            reason = 'Conflicts with core immutable identity rules.';
            confidence = 0.99;
        } else if (hasReflectionKeywords && isActionable && isDurable) {
            intentClass = 'reflection_goal';
            reason = 'Explicit request for self-improvement or programmatic reflection with actionable criteria.';
            confidence = 0.9;
        } else if (/remember|memory|store this/.test(lowerText)) {
            intentClass = 'memory';
            reason = 'User explicitly asked to remember something, but it does not specify system improvement.';
            confidence = 0.8;
        } else if (/(remind me|do this later|todo|task)/.test(lowerText)) {
            intentClass = 'generic_goal';
            reason = 'A generic to-do item or task, not specific to Tala self-improving the system.';
            confidence = 0.7;
        }

        const result: ReflectionIntentResult = {
            intentClass,
            confidence,
            reason,
            isActionable,
            isDurable,
            conflictsWithIdentity
        };

        return result;
    }
}
