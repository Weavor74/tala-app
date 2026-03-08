export type IntentClass = 'greeting' | 'technical' | 'narrative' | 'coding' | 'lore' | 'action' | 'mixed' | 'unknown';

export interface Intent {
    class: IntentClass;
    confidence: number;
    subsystem?: string;
    precedenceLog?: string;
}

export class IntentClassifier {
    private static readonly GREETING_PATTERNS = [
        /^(hi|hello|hey|greetings|yo|morning|afternoon|evening|hola|bonjour)/i,
        /^(good\s+)?(morning|afternoon|evening|night|day)/i,
        /^(howdy|sup|hiya)/i
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

        // 2. Precedence Logic (Mixed Intent)
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

        // 3. Single Intent Resolution
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
