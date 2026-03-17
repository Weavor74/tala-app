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

export type IntentClass = 'greeting' | 'technical' | 'narrative' | 'coding' | 'lore' | 'action' | 'mixed' | 'browser' | 'unknown';

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
        /(how|why|what|when|where|can|could|help|explain|fix|debug|error|issue|bug|code|script|api|function|tool|terminal|file|path)/i,
        /(install|run|deploy|build|compile|test|verify)/i,
        /(memory|router|system|context|agent|model|inference)/i
    ];

    private static readonly LORE_PATTERNS = [
        /(lore|history|world|story|character|relationship|past|background|setting|universe|backstory)/i,
        /(who\s+are\s+you|tell\s+me\s+about|what\s+is\s+the)/i
    ];

    public static classify(input: string): Intent {
        const text = input.trim().toLowerCase();

        // 1. Detect individual intent signals
        const hasGreeting = this.GREETING_PATTERNS.some(p => p.test(text.replace(/(\s+)?(baby|love|dear|sweetie|friend|tala|tally)$/i, '')));
        const hasTechnical = this.TECHNICAL_PATTERNS.some(p => p.test(text));
        const hasLore = this.LORE_PATTERNS.some(p => p.test(text));
        const hasBrowser = this.BROWSER_PATTERNS.some(p => p.test(text));

        // 2. Browser intent takes high precedence — it is explicit and unambiguous
        if (hasBrowser) {
            console.log(`[IntentClassifier] Browser intent detected.`);
            return {
                class: 'browser',
                confidence: 0.95,
                subsystem: 'browser',
                precedenceLog: 'Browser pattern matched'
            };
        }

        // 3. Precedence Logic (Mixed Intent)
        if (hasGreeting && (hasTechnical || hasLore)) {
            const primarySubstantive = hasTechnical ? 'technical' : 'lore';
            console.log(`[IntentClassifier] Mixed intent detected. Content overrides greeting. Primary: ${primarySubstantive}`);
            return {
                class: 'mixed',
                confidence: 0.9,
                subsystem: primarySubstantive,
                precedenceLog: `Content(${primarySubstantive}) > Greeting`
            };
        }

        // 4. Single Intent Resolution
        if (hasGreeting) {
            return { class: 'greeting', confidence: 0.95 };
        }

        if (hasTechnical) {
            return { class: 'technical', confidence: 0.85 };
        }

        if (hasLore) {
            return { class: 'lore', confidence: 0.85 };
        }

        return { class: 'unknown', confidence: 0.5 };
    }
}
