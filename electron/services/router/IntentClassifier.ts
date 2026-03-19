/**
 * IntentClassifier - Decision Support / Cognitive Utility
 * 
 * This module provides heuristic-based intent classification for user queries.
 * It is used by the `TalaContextRouter` to determine the high-level goal of a turn,
 * which in turn influences memory weightings, tool gating, and response style.
 * 
 * **Classification Strategy:**
 * - **Heuristic Pattern Matching**: Uses regex-based signals to detect intent.
 * - **Precedence Overrides**: Content-rich signals (technical, lore) override simple greetings.
 * - **Mixed Intent Resolution**: Identifies when a query spans multiple categories and selects a primary.
 * 
 * **System Impact:**
 * - Determines if memory retrieval is bypassed (e.g., for greetings).
 * - Influences the `ModePolicyEngine` on which tools are allowed for the current turn.
 */

export type IntentClass = 'greeting' | 'technical' | 'narrative' | 'coding' | 'lore' | 'action' | 'mixed' | 'browser' | 'social' | 'unknown';

/**
 * Structured result of an intent classification operation.
 */
export interface Intent {
    /** The primary category of the user's query. */
    class: IntentClass;
    /** Confidence score (0.0 to 1.0) based on signal strength. */
    confidence: number;
    /** The specific subsystem relevant to the intent (e.g., 'technical' or 'lore'). */
    subsystem?: string;
    /** Debug log explanation for how the classification was reached. */
    precedenceLog?: string;
}

export class IntentClassifier {
    private static readonly GREETING_PATTERNS = [
        /^(hi|hello|hey|greetings|yo|morning|afternoon|evening|hola|bonjour)/i,
        /^(good\s+)?(morning|afternoon|evening|night|day)/i,
        /^(howdy|sup|hiya)/i
    ];

    private static readonly BROWSER_PATTERNS = [
        // Explicit browser/navigation verbs
        /\b(browse|browsing|navigate|navigating|open\s+(url|site|website|page|browser|workspace\s+browser)|go\s+to|visit|load\s+(page|site|url|website))\b/i,
        // Web search / form interaction
        /\b(search\s+(google|bing|web|for)|click\s+(the|a|on)?|type\s+(into|in|text|into\s+the)|fill\s+(in|the|a|form)|scroll\s+(the\s+)?(page|down|up)|press\s+(enter|escape|key))\b/i,
        // URL detection
        /https?:\/\//i,
        // Domain shortcuts
        /\b(google\.com|bing\.com|wikipedia\.org|youtube\.com|github\.com|stackoverflow\.com)\b/i,
        // Workspace browser references
        /\b(workspace\s+browser|built-in\s+browser|in\s+the\s+browser|browser\s+tab|web\s+page|webpage|website|web\s+search)\b/i,
        // Page interaction keywords
        /\b(click\s+result|5th\s+result|first\s+result|search\s+box|search\s+field|text\s+field|submit\s+the|submit\s+search)\b/i,
    ];

    private static readonly TECHNICAL_PATTERNS = [
        // Operational / technical task verbs and nouns.
        // Generic question words (how, why, what, where, can, help) are intentionally excluded
        // to prevent social/conversational queries from being misclassified as technical.
        /(fix|debug|error|issue|bug|code|script|api|function|tool|terminal|file|path|repo|codebase|settings|config|configuration|explain)/i,
        // Deployment / execution verbs — also used as the OPERATIONAL_VERB_PATTERNS check
        /(install|run|deploy|build|compile|test|verify)/i,
        // System / architecture nouns — 'memory' excluded (too ambiguous; personal use is common)
        /(router|system|context|agent|model|inference)/i,
    ];

    /**
     * Operational verb patterns used to distinguish a genuine technical task from a lore/personal
     * query that incidentally matches a technical noun (e.g. "tell me about the router" is lore,
     * but "build and deploy the router" is technical). This is a named alias for TECHNICAL_PATTERNS[1]
     * so the index dependency is explicit and stable.
     */
    private static readonly OPERATIONAL_VERB_PATTERNS = [
        /(install|run|deploy|build|compile|test|verify)/i,
    ];

    private static readonly LORE_PATTERNS = [
        /(lore|history|world|story|character|relationship|past|background|\bsetting\b|universe|backstory)/i,
        /(who\s+are\s+you|tell\s+me\s+about|what\s+is\s+the)/i,
        // Autobiographical / personal-memory queries — grounded recall, not technical lookup
        /(do\s+you\s+remember|remember\s+when|childhood|your\s+favorite|personal\s+histor)/i,
        // Extended autobiographical markers: age references, life history, memory follow-ups
        /(when\s+you\s+were|at\s+(age\s+)?\d+\s*(years?\s*old)?|growing\s+up|what\s+were\s+you|your\s+life|your\s+memory|have\s+a\s+memory|back\s+then)/i,
        // Follow-up lore references: queries that confirm or challenge a prior autobiographical turn
        /(you\s+(don'?t|do\s+not)\s+(have|remember|recall)|can'?t\s+(recall|remember)(\s+that)?|don'?t\s+you\s+remember)/i,
    ];

    // Social / affectionate signals — high-confidence social context that should not be
    // overridden by weak technical matches when no operational verb is present.
    private static readonly SOCIAL_PATTERNS = [
        /\b(baby|love|dear|sweetie|honey|darling|miss\s+you|happy\s+(you|to)|glad\s+(you|to)|how\s+are\s+you|how\s+have\s+you\s+been)\b/i,
        /\b(i\s+(love|miss|need|want)\s+you|you\s+mean|feeling|emotions?|affection)\b/i,
    ];

    public static classify(input: string): Intent {
        const text = input.trim().toLowerCase();

        // 1. Detect individual intent signals
        const hasGreeting = this.GREETING_PATTERNS.some(p => p.test(text.replace(/(\s+)?(baby|love|dear|sweetie|friend|tala|tally)$/i, '')));
        const hasTechnical = this.TECHNICAL_PATTERNS.some(p => p.test(text));
        const hasLore = this.LORE_PATTERNS.some(p => p.test(text));
        const hasBrowser = this.BROWSER_PATTERNS.some(p => p.test(text));
        const hasSocial = this.SOCIAL_PATTERNS.some(p => p.test(text));

        // 2. Browser intent takes high precedence — it is explicit and unambiguous
        if (hasBrowser) {
            console.log(`[IntentClassifier] intent=browser confidence=0.95`);
            return {
                class: 'browser',
                confidence: 0.95,
                subsystem: 'browser',
                precedenceLog: 'Browser pattern matched'
            };
        }

        // 3. Social signals override weak technical matches when no operational verb is present.
        // A prompt that is strongly affectionate or relational and lacks clear technical task verbs
        // should not be classified as technical.
        // Exception: when the prompt also contains a strong lore/autobiographical signal, the
        // substantive request overrides the social opener — retrieval must not be suppressed.
        if (hasSocial && !hasTechnical && !hasLore) {
            const baseClass = hasGreeting ? 'greeting' : 'social';
            console.log(`[IntentClassifier] intent=${baseClass} confidence=0.92 reason=social_override`);
            return {
                class: baseClass,
                confidence: 0.92,
                subsystem: 'social',
                precedenceLog: 'Social(affectionate/relational) > Technical (no operational verb)'
            };
        }

        // 4. Precedence Logic (Mixed Intent)
        // greeting + technical → mixed/technical (retrieval runs, technical domain)
        // greeting + lore → lore with greeting tone (retrieval runs, autobiographical domain)
        if (hasGreeting && hasTechnical) {
            console.log(`[IntentClassifier] intent=mixed/technical confidence=0.9 reason=content_overrides_greeting`);
            return {
                class: 'mixed',
                confidence: 0.9,
                subsystem: 'technical',
                precedenceLog: 'Content(technical) > Greeting'
            };
        }
        if (hasGreeting && hasLore) {
            console.log(`[IntentClassifier] intent=lore tone=greeting confidence=0.9 reason=autobiographical_request_overrode_social_opener`);
            return {
                class: 'lore',
                confidence: 0.9,
                subsystem: 'lore',
                precedenceLog: 'Lore > Greeting (autobiographical opener)'
            };
        }

        // 5. Single Intent Resolution
        if (hasGreeting) {
            console.log(`[IntentClassifier] intent=greeting confidence=0.95`);
            return { class: 'greeting', confidence: 0.95 };
        }

        if (hasLore) {
            // Lore/autobiographical content: if technical also fires, prefer lore when the prompt
            // reads as a personal/narrative request with no explicit deployment/execution verb.
            const hasOperationalVerb = this.OPERATIONAL_VERB_PATTERNS.some(p => p.test(text));
            if (hasTechnical && !hasOperationalVerb) {
                console.log(`[IntentClassifier] intent=lore confidence=0.88 reason=autobiographical_preferred_over_weak_technical`);
                return {
                    class: 'lore',
                    confidence: 0.88,
                    subsystem: 'lore',
                    precedenceLog: 'Lore > Technical (no operational verb in lore-primary prompt)'
                };
            }
        }

        if (hasTechnical) {
            console.log(`[IntentClassifier] intent=technical confidence=0.85`);
            return { class: 'technical', confidence: 0.85 };
        }

        if (hasLore) {
            console.log(`[IntentClassifier] intent=lore confidence=0.85`);
            return { class: 'lore', confidence: 0.85 };
        }

        console.log(`[IntentClassifier] intent=unknown confidence=0.5 reason=no_signal_matched`);
        return { class: 'unknown', confidence: 0.5 };
    }
}
