
function scrubRawToolJson(text, mode = 'assistant', intent = 'conversation') {
    if (!text) return text;
    // Regex to find things that look like raw tool JSON: {"name":"...", "arguments":{...}}
    const rawJsonRegex = /\{"name"\s*:\s*"[^"]+",\s*"arguments"\s*:\s*\{[\s\S]*?\}\}/g;
    // Also check for tag fragments that might leak
    const tagLeakRegex = /<\/tool_call>/g;

    let scrubbed = text;
    let blocked = false;

    if (rawJsonRegex.test(scrubbed)) {
        scrubbed = scrubbed.replace(rawJsonRegex, '[TECHNICAL ARTIFACT SUPPRESSED]');
        blocked = true;
    }
    if (tagLeakRegex.test(scrubbed)) {
        scrubbed = scrubbed.replace(tagLeakRegex, '');
        blocked = true;
    }

    if (blocked) {
        console.log(`[AgentService] RAW_TOOL_JSON_BLOCKED_AT_COMMIT mode=${mode} intent=${intent}`);
    }
    return scrubbed;
}

function finalizeAssistantContent(intent, raw, executedToolCount, hasPendingCalls, mode = 'assistant') {
    if (intent === 'coding' && (executedToolCount > 0 || hasPendingCalls)) {
        return '';
    }

    let content = raw || '';
    // Scrub raw tool JSON leaks, especially in RP mode
    if (mode === 'rp' || content.includes('{"name":') || content.includes('"arguments":') || content.includes('</tool_call>')) {
        content = scrubRawToolJson(content, mode, intent);
    }

    return content;
}

// Test cases
const testCases = [
    {
        name: "Normal message",
        text: "Hello, how are you?",
        mode: "assistant",
        intent: "conversation",
        expected: "Hello, how are you?"
    },
    {
        name: "Full JSON leak in RP",
        text: 'I found the file: {"name": "fs_read_text", "arguments": {"path": "test.txt"}}',
        mode: "rp",
        intent: "conversation",
        expected: "I found the file: [TECHNICAL ARTIFACT SUPPRESSED]"
    },
    {
        name: "Partial JSON leak in Assistant",
        text: 'Process output: {"name": "shell_run", "arguments": {"command": "ls"}} completed.',
        mode: "assistant",
        intent: "conversation",
        expected: "Process output: [TECHNICAL ARTIFACT SUPPRESSED] completed."
    },
    {
        name: "Tag leak",
        text: 'Here is the code.</tool_call>',
        mode: "rp",
        intent: "conversation",
        expected: "Here is the code."
    },
    {
        name: "Multiple leaks especially in RP",
        text: 'A: {"name":"a","arguments":{}} B: </tool_call>',
        mode: "rp",
        intent: "conversation",
        expected: "A: [TECHNICAL ARTIFACT SUPPRESSED] B: "
    }
];

let failed = false;
testCases.forEach(tc => {
    const result = finalizeAssistantContent(tc.intent, tc.text, tc.executedToolCount || 0, tc.hasPendingCalls || false, tc.mode);
    if (result === tc.expected) {
        console.log(`✅ Passed: ${tc.name}`);
    } else {
        console.error(`❌ Failed: ${tc.name}`);
        console.error(`   Expected: "${tc.expected}"`);
        console.error(`   Got:      "${result}"`);
        failed = true;
    }
});

if (failed) {
    process.exit(1);
} else {
    console.log("\nALL LOGIC TESTS PASSED");
}
