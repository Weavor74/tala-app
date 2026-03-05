/// <reference types="node" />
/**
 * verify_no_duplicate_assistant.ts
 *
 * Unit-tests for the duplicate message suppression logic in AgentService.
 */

interface ChatMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    tool_calls?: any[];
}

function finalizeAssistantContent(intent: string, raw: string, executedToolCount: number, hasPendingCalls: boolean): string {
    if (intent === 'coding' && (executedToolCount > 0 || hasPendingCalls)) {
        return '';
    }
    return raw || '';
}

function commitAssistantMessage(
    transientMessages: ChatMessage[],
    msg: ChatMessage,
    intent: string,
    executedToolCount: number,
    turnSeenHashes: Set<string>
): void {
    const hasPendingCalls = (msg.tool_calls?.length || 0) > 0;
    const finalized = finalizeAssistantContent(intent, msg.content, executedToolCount, hasPendingCalls);

    // Use content-based hash to suppress duplicate prose
    // Normalize: trim + collapse whitespace to single spaces
    const normalized = finalized.trim().replace(/\s+/g, ' ');
    const hash = `assistant|${normalized}`;
    const isDuplicateProse = turnSeenHashes.has(hash) && normalized.length > 0;

    if (isDuplicateProse && !hasPendingCalls) {
        console.log(`[Test] duplicate assistant message suppressed (len=${finalized.length}, intent=${intent})`);
        return;
    }

    // Push if:
    // 1. Has non-duplicate finalized content
    // 2. Has tool calls (always push these as they are actions)
    // 3. Or it's a coding turn and we want at least one assistant message (one per turn due to hash check).
    const shouldPush = (normalized.length > 0 && !isDuplicateProse) ||
        hasPendingCalls ||
        (intent === 'coding' && (executedToolCount > 0 || hasPendingCalls) && !turnSeenHashes.has(hash));

    if (shouldPush) {
        msg.content = finalized;
        transientMessages.push(msg);
        turnSeenHashes.add(hash);
    }
}

(function runTests() {
    let passed = 0;
    let failed = 0;

    function check(label: string, condition: boolean) {
        if (condition) {
            console.log(`✅ PASS: ${label}`);
            passed++;
        } else {
            console.error(`❌ FAIL: ${label}`);
            failed++;
        }
    }

    console.log("=== verify_no_duplicate_assistant.ts ===\n");

    // Case 1: Standard conversation, no duplicates
    {
        const transient: ChatMessage[] = [];
        const hashes = new Set<string>();
        commitAssistantMessage(transient, { role: 'assistant', content: "Hello" }, 'conversation', 0, hashes);
        commitAssistantMessage(transient, { role: 'assistant', content: "World" }, 'conversation', 0, hashes);
        check("Conversation: distinct messages preserved", transient.length === 2 && transient[0].content === "Hello" && transient[1].content === "World");
    }

    // Case 2: Standard conversation, identical duplicate with whitespace
    {
        const transient: ChatMessage[] = [];
        const hashes = new Set<string>();
        commitAssistantMessage(transient, { role: 'assistant', content: "Hello   World" }, 'conversation', 0, hashes);
        commitAssistantMessage(transient, { role: 'assistant', content: "Hello World" }, 'conversation', 0, hashes);
        check("Conversation: identical duplicate (after collapsing whitespace) suppressed", transient.length === 1 && transient[0].content === "Hello   World");
    }

    // Case 3: Coding turn, suppressed prose
    {
        const transient: ChatMessage[] = [];
        const hashes = new Set<string>();
        // Pre-execution (pending calls)
        commitAssistantMessage(transient, { role: 'assistant', content: "Updating file...", tool_calls: [{ name: 'fs_write' }] }, 'coding', 0, hashes);
        check("Coding: prose suppressed when pending calls exist", transient.length === 1 && transient[0].content === "" && transient[0].tool_calls!.length === 1);
    }

    // Case 4: Coding turn, redundant empty assistant message suppressed
    {
        const transient: ChatMessage[] = [];
        const hashes = new Set<string>();
        // First message (coding) - Pushes empty prose + tool calls
        commitAssistantMessage(transient, { role: 'assistant', content: "Narration", tool_calls: [{ name: 'fs_write' }] }, 'coding', 0, hashes);
        // Tool result (added externally in real code, here we just simulate the state)
        transient.push({ role: 'tool', content: "Success" });
        // Second message (final results) - Should be suppressed because we already have an assistant message in this turn
        commitAssistantMessage(transient, { role: 'assistant', content: "Refactoring complete." }, 'coding', 1, hashes);

        check("Coding: redundant empty assistant message suppressed",
            transient.length === 2 && transient[0].role === 'assistant' && transient[0].content === "");
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
