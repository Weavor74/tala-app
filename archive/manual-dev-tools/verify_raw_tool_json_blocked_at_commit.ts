
// This script verifies that raw tool JSON is blocked at the final commit boundary.
// It mocks the logic found in AgentService.ts

function scrubRawToolJson(text, mode = 'assistant', intent = 'conversation') {
    if (!text) return text;
    const rawJsonRegex = /\{"name"\s*:\s*"[^"]+",\s*"arguments"\s*:\s*\{[\s\S]*?\}\}/g;
    const tagLeakRegex = /<\/tool_call>/g;

    let scrubbed = text;
    if (rawJsonRegex.test(scrubbed)) {
        scrubbed = scrubbed.replace(rawJsonRegex, '[TECHNICAL ARTIFACT SUPPRESSED]');
    }
    if (tagLeakRegex.test(scrubbed)) {
        scrubbed = scrubbed.replace(tagLeakRegex, '');
    }
    return scrubbed;
}

function finalizeAssistantContent(intent, raw, executedToolCount, hasPendingCalls, mode = 'assistant') {
    if (intent === 'coding' && (executedToolCount > 0 || hasPendingCalls)) {
        return '';
    }

    let content = raw || '';
    if (mode === 'rp' || content.includes('{"name":') || content.includes('"arguments":') || content.includes('</tool_call>')) {
        content = scrubRawToolJson(content, mode, intent);
    }

    return content;
}

const testOutput = '{"name":"fs_read_text","arguments":{"path":"src/renderer/components/chat/ChatSessions.tsx"}} </tool_call>';

console.log('--- VERIFY RAW TOOL JSON BLOCKED AT COMMIT ---');

const resultRP = finalizeAssistantContent('conversation', testOutput, 0, false, 'rp');
console.log('RP Mode Result:', resultRP);
if (resultRP.includes('fs_read_text') || resultRP.includes('tool_call')) {
    console.error('❌ FAILED: Raw JSON leaked in RP mode');
    process.exit(1);
}

const resultAst = finalizeAssistantContent('conversation', testOutput, 0, false, 'assistant');
console.log('Assistant Mode Result:', resultAst);
if (resultAst.includes('fs_read_text') || resultAst.includes('tool_call')) {
    console.error('❌ FAILED: Raw JSON leaked in Assistant mode');
    process.exit(1);
}

console.log('✅ SUCCESS: Raw tool JSON blocked in all modes');
