/// <reference types="node" />
/**
 * simulate_turn_fs_write_text.ts
 *
 * Simulates intent detection and suppression for an explicit tool call.
 */

(function runTests() {
    function detectToolIntent(userMessage: string): string {
        const TOOL_TOKEN_PATTERN = /\b(fs_write_text|fs_read_text|fs_list|shell_run|write_file|read_file|list_files|terminal_run|execute_command)\b/i;
        const FILE_PATH_PATTERN = /\b[a-zA-Z0-9_\-/]+\.(ts|js|json|txt|md|py|tsx|jsx|yml|yaml|sh|css|html|env|toml|ini)\b/i;
        if (FILE_PATH_PATTERN.test(userMessage) || TOOL_TOKEN_PATTERN.test(userMessage)) {
            return 'coding';
        }
        return 'conversation';
    }

    function finalizeAssistantContent(intent: string, raw: string, executedToolCount: number, hasPendingCalls: boolean): string {
        if (intent === 'coding' && (executedToolCount > 0 || hasPendingCalls)) {
            return '';
        }
        return raw || '';
    }

    console.log("=== simulate_turn_fs_write_text.ts ===\n");

    const userMsg = "fs_write_text scripts/_r1_probe.js with EXACT contents: hello";
    const intent = detectToolIntent(userMsg);
    console.log(`Intent: ${intent}`);

    const rawProse = "I've processed your request. Creating the file now.";
    // Simulated state: tools are planned (hasPendingCalls = true)
    const finalized = finalizeAssistantContent(intent, rawProse, 0, true);

    if (intent === 'coding' && finalized === "") {
        console.log("✅ PASS: Intent is coding and prose is suppressed.");
    } else {
        console.error("❌ FAIL: Suppression failed.");
        process.exit(1);
    }
})();
