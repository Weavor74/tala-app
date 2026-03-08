"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntentClassifier = void 0;
var IntentClassifier = /** @class */ (function () {
    function IntentClassifier() {
    }
    IntentClassifier.classify = function (input) {
        var text = input.trim().toLowerCase();
        // 1. Detect individual intent signals
        var hasGreeting = this.GREETING_PATTERNS.some(function (p) { return p.test(text.replace(/(\s+)?(baby|love|dear|sweetie|friend|tala|tally)$/i, '')); });
        var hasTechnical = this.TECHNICAL_PATTERNS.some(function (p) { return p.test(text); });
        var hasLore = this.LORE_PATTERNS.some(function (p) { return p.test(text); });
        // 2. Precedence Logic (Mixed Intent)
        if (hasGreeting && (hasTechnical || hasLore)) {
            var primarySubstantive = hasTechnical ? 'technical' : 'lore';
            console.log("[IntentClassifier] Mixed intent detected. Content overrides greeting. Primary: ".concat(primarySubstantive));
            return {
                class: 'mixed',
                confidence: 0.9,
                subsystem: primarySubstantive,
                precedenceLog: "Content(".concat(primarySubstantive, ") > Greeting")
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
    };
    IntentClassifier.GREETING_PATTERNS = [
        /^(hi|hello|hey|greetings|yo|morning|afternoon|evening|hola|bonjour)/i,
        /^(good\s+)?(morning|afternoon|evening|night|day)/i,
        /^(howdy|sup|hiya)/i
    ];
    IntentClassifier.TECHNICAL_PATTERNS = [
        /(how|why|what|when|where|can|could|help|explain|fix|debug|error|issue|bug|code|script|api|function|tool|terminal|file|path)/i,
        /(install|run|deploy|build|compile|test|verify)/i,
        /(memory|router|system|context|agent|model|inference)/i
    ];
    IntentClassifier.LORE_PATTERNS = [
        /(lore|history|world|story|character|relationship|past|background|setting|universe|backstory)/i,
        /(who\s+are\s+you|tell\s+me\s+about|what\s+is\s+the)/i
    ];
    return IntentClassifier;
}());
exports.IntentClassifier = IntentClassifier;
