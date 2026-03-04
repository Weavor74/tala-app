/// <reference types="node" />
/**
 * verify_tools_only_render.ts
 *
 * Unit-tests for:
 *  A) extractJsonObjectEnvelope() — brace-depth scanner
 *  B) Tools-only render suppression (coding intent, calls.length > 0 → prose = "")
 *
 * Run with:  npx tsx scripts/verify_tools_only_render.ts
 */

// ---------------------------------------------------------------------------
// Inline copy of extractJsonObjectEnvelope (mirrors AgentService exactly)
// Kept separate so this script has zero electron/node-pty deps.
// ---------------------------------------------------------------------------
function extractJsonObjectEnvelope(text: string): any | null {
    const len = text.length;
    let i = 0;

    while (i < len) {
        if (text[i] !== '{') { i++; continue; }

        const start = i;
        let depth = 0;
        let inString = false;
        let escape = false;

        while (i < len) {
            const ch = text[i];

            if (escape) { escape = false; i++; continue; }
            if (ch === '\\' && inString) { escape = true; i++; continue; }
            if (ch === '"') { inString = !inString; i++; continue; }

            if (!inString) {
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        const candidate = text.substring(start, i + 1);
                        try {
                            const parsed = JSON.parse(candidate);
                            if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tool_calls)) {
                                return parsed;
                            }
                        } catch { /* not valid JSON yet, try next */ }
                        i++;
                        break;
                    }
                }
            }
            i++;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Tools-only suppression logic (mirrors AgentService exactly)
// ---------------------------------------------------------------------------
function simulateCodingTurnContent(
    toolCategory: string,
    responseContent: string,
    callsLength: number
): string {
    let content = responseContent;
    if (toolCategory === 'coding' && callsLength > 0) {
        content = '';
    }
    return content;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
    if (condition) {
        console.log(`  ✅ PASS: ${label}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

console.log('\n=== verify_tools_only_render.ts ===\n');

// ── Case 1: Pure JSON envelope ─────────────────────────────────────────────
console.log('Case 1: Pure JSON envelope → extracted, tool_calls recognized');
{
    const input = `{"tool_calls":[{"name":"fs_write_text","arguments":{"path":"a.ts","content":"hello"}}]}`;
    const result = extractJsonObjectEnvelope(input);
    check('Result is non-null', result !== null);
    check('tool_calls is array', Array.isArray(result?.tool_calls));
    check('First call is fs_write_text', result?.tool_calls?.[0]?.name === 'fs_write_text');
}

// ── Case 2: Prose before + JSON + prose after ──────────────────────────────
console.log('\nCase 2: Prose before JSON, prose after → extracted successfully');
{
    const input = `I'll write that file for you right away!\n{"tool_calls":[{"name":"fs_write_text","arguments":{"path":"b.ts","content":"world"}}]}\nDone! Let me know if you need anything else.`;
    const result = extractJsonObjectEnvelope(input);
    check('Result is non-null', result !== null, 'extractJsonObjectEnvelope returned null');
    check('tool_calls recognized', Array.isArray(result?.tool_calls));
    check('name is fs_write_text', result?.tool_calls?.[0]?.name === 'fs_write_text');
}

// ── Case 3: Multiple JSON objects → picks the one with tool_calls ──────────
console.log('\nCase 3: Multiple JSON objects → picks the one with tool_calls');
{
    const input = `{"unrelated":"value","foo":42} Some text here. {"tool_calls":[{"name":"shell_run","arguments":{"command":"npm run lint"}}]} {"another":"object"}`;
    const result = extractJsonObjectEnvelope(input);
    check('Result is non-null', result !== null);
    check('Correct object selected (has tool_calls)', Array.isArray(result?.tool_calls));
    check('First call is shell_run', result?.tool_calls?.[0]?.name === 'shell_run');
}

// ── Case 4: Nested JSON inside arguments ──────────────────────────────────
console.log('\nCase 4: Nested JSON in arguments → scanner handles braces correctly');
{
    // Use JSON.stringify to build the input unambiguously
    const innerContent = '{"key":"value"}';
    const envelope = { tool_calls: [{ name: 'fs_write_text', arguments: { path: 'c.json', content: innerContent } }] };
    const input = 'Here is your tool call:\n' + JSON.stringify(envelope);
    const result = extractJsonObjectEnvelope(input);
    check('Result is non-null', result !== null);
    check('tool_calls present', Array.isArray(result?.tool_calls));
    check('Nested content preserved', result?.tool_calls?.[0]?.arguments?.content === innerContent, `got: ${JSON.stringify(result?.tool_calls?.[0]?.arguments?.content)}`);
}

// ── Case 5: No JSON at all → returns null ─────────────────────────────────
console.log('\nCase 5: No JSON at all → null returned');
{
    const input = `I'll do that for you. No JSON here at all.`;
    const result = extractJsonObjectEnvelope(input);
    check('Returns null for no-JSON input', result === null);
}

// ── Case 6: JSON without tool_calls key → returns null ────────────────────
console.log('\nCase 6: JSON present but no tool_calls key → null returned');
{
    const input = `{"action":"run","target":"test"}`;
    const result = extractJsonObjectEnvelope(input);
    check('Returns null when tool_calls key absent', result === null);
}

// ── Case 7: Coding intent + calls.length > 0 → prose suppressed ───────────
console.log('\nCase 7: coding intent with calls → assistant prose suppressed to ""');
{
    const prose = "I'll write that script for you right now!";
    const out = simulateCodingTurnContent('coding', prose, 1);
    check('Content suppressed to empty string', out === '');
}

// ── Case 8: Non-coding intent + calls → prose NOT suppressed ──────────────
console.log('\nCase 8: non-coding intent with calls → prose kept');
{
    const prose = "Here are your memories.";
    const out = simulateCodingTurnContent('memory', prose, 1);
    check('Content preserved for non-coding intent', out === prose);
}

// ── Case 9: Coding intent + zero calls → prose NOT suppressed ─────────────
console.log('\nCase 9: coding intent but no calls → prose kept');
{
    const prose = "This is a conversational response.";
    const out = simulateCodingTurnContent('coding', prose, 0);
    check('Content preserved when no tool calls', out === prose);
}

// ── Case 10: Escaped quotes inside string values don't confuse parser ──────
console.log('\nCase 10: escaped quotes inside string values → parser correct');
{
    // Build input using JSON.stringify to guarantee correct escaping
    const contentVal = 'say "hello" here';
    const envelope = { tool_calls: [{ name: 'fs_write_text', arguments: { path: 'x.ts', content: contentVal } }] };
    const input = JSON.stringify(envelope);
    const result = extractJsonObjectEnvelope(input);
    check('Result is non-null', result !== null);
    check('tool_calls present', Array.isArray(result?.tool_calls));
    check('Escaped quotes preserved in content', result?.tool_calls?.[0]?.arguments?.content === contentVal, `got: ${JSON.stringify(result?.tool_calls?.[0]?.arguments?.content)}`);
}

// ── Summary ────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
const summary = { passed, failed, total: passed + failed, allPassed: failed === 0, timestamp: new Date().toISOString() };
fs.writeFileSync(path.join(process.cwd(), 'scripts', 'verify_tools_only_render.json'), JSON.stringify(summary, null, 2));
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
console.log(JSON.stringify(summary, null, 2));
if (failed > 0) process.exit(1);
