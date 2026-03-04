/// <reference types="node" />
/**
 * simulate_agent_turn_tools_only.ts
 *
 * Smoke test for the final UI boundary guard.
 * This simulates the end of AgentService.chat() where transientMessages
 * are finalized and pushed to history.
 *
 * Run with:  npx tsx scripts/simulate_agent_turn_tools_only.ts
 */

interface ChatMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: any[];
}

// ---------------------------------------------------------------------------
// Final UI Boundary Guard Logic (mirrors AgentService exactly)
// ---------------------------------------------------------------------------
function applyFinalGuard(
    toolCategory: string,
    transientMessages: ChatMessage[],
    activeSessionId: string
): void {
    // Ensure that for coding intent, if any tool calls were executed, no assistant prose remains.
    const finalCalls = transientMessages.filter(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0);
    if (toolCategory === 'coding' && finalCalls.length > 0) {
        for (const msg of transientMessages) {
            if (msg.role === 'assistant' && msg.content && msg.content.trim().length > 0) {
                console.warn(`[AgentService] FINAL GUARD TRIGGERED: Suppressing leaked prose for coding turn. Session: ${activeSessionId || 'unknown'}`);
                console.log(`[AgentService] Leaked prose preview: ${msg.content.substring(0, 100)}...`);
                msg.content = '';
            }
        }
    }
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

async function run() {
    console.log('\n=== simulate_agent_turn_tools_only.ts ===\n');

    const SESSION_ID = 'TEST-SESSION-123';

    // ── Case 1: Coding Turn with Tool Calls + Leaked Prose ────────────────────
    console.log('Case 1: Coding turn + tool calls + leaked prose → prose suppressed');
    {
        const messages: ChatMessage[] = [
            { role: 'assistant', content: "I'll help you with that file change.", tool_calls: [{ id: 'call_1', function: { name: 'fs_write_text' } }] },
            { role: 'tool', content: 'Success', tool_call_id: 'call_1' }
        ];
        applyFinalGuard('coding', messages, SESSION_ID);
        check('Prose in first message suppressed', messages[0].content === '');
        check('Tool call itself preserved', Array.isArray(messages[0].tool_calls) && messages[0].tool_calls.length === 1);
        check('Tool response content preserved', messages[1].content === 'Success');
    }

    // ── Case 2: Coding Turn with Native Tool Calls (no prose) ──────────────────
    console.log('\nCase 2: Coding turn + tool calls + already empty prose → stays empty');
    {
        const messages: ChatMessage[] = [
            { role: 'assistant', content: '', tool_calls: [{ id: 'call_2', function: { name: 'shell_run' } }] }
        ];
        applyFinalGuard('coding', messages, SESSION_ID);
        check('Content remains empty', messages[0].content === '');
    }

    // ── Case 3: Non-Coding Turn with Tool Calls + Prose ────────────────────────
    console.log('\nCase 3: Memory turn + tool calls + prose → prose preserved');
    {
        const prose = "Searching your memories now.";
        const messages: ChatMessage[] = [
            { role: 'assistant', content: prose, tool_calls: [{ id: 'call_3', function: { name: 'search_memory' } }] }
        ];
        applyFinalGuard('memory', messages, SESSION_ID);
        check('Prose preserved for memory intent', messages[0].content === prose);
    }

    // ── Case 4: Coding Turn NO Tool Calls ──────────────────────────────────────
    console.log('\nCase 4: Coding turn + zero tool calls (conversational) → prose preserved');
    {
        const prose = "I can help you refactor that later.";
        const messages: ChatMessage[] = [
            { role: 'assistant', content: prose }
        ];
        applyFinalGuard('coding', messages, SESSION_ID);
        check('Prose preserved when no tool calls generated', messages[0].content === prose);
    }

    // summary
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exit(1);
}

run().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
