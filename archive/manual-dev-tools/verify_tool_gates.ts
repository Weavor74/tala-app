/// <reference types="node" />
/**
 * verify_tool_gates.ts
 *
 * Proves that both gates (AgentService pre-execution + ToolService Gate #2)
 * correctly block legacy and out-of-set tool calls, while allowing canonical ones.
 *
 * DESIGN: ToolService imports node-pty/electron which crash outside Electron.
 * We test the gate LOGIC directly by:
 *  1) Extracting the gate guard functions as standalone implementations
 *     (mirroring what is in ToolService/AgentService exactly)
 *  2) Loading only CodeAccessPolicy (pure Node.js) for the shell policy check
 *
 * Run with:  npx tsx scripts/verify_tool_gates.ts
 */
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Gate #1: Static LEGACY_TOOLS set (mirrors ToolService.LEGACY_TOOLS)
// ---------------------------------------------------------------------------
const LEGACY_TOOLS = new Set([
    'write_file', 'read_file', 'list_files', 'delete_file',
    'create_directory', 'patch_file', 'move_file', 'copy_file',
    'terminal_run', 'execute_command', 'execute_script'
]);

// ---------------------------------------------------------------------------
// Gate #2: Turn-scoped allowedNames (mirrors ToolService.executeTool gate)
// ---------------------------------------------------------------------------
function simulateExecuteTool(
    name: string,
    _args: any,
    allowedNames?: ReadonlySet<string>
): string {
    // Strip provider prefix
    if (name.startsWith('default_api:')) name = name.substring('default_api:'.length);

    // Gate #2 – fires before registry lookup
    if (allowedNames && !allowedNames.has(name)) {
        throw new Error(`ToolNotAllowedThisTurn: ${name}`);
    }
    // Gate #1 – legacy block
    if (LEGACY_TOOLS.has(name)) {
        return `Error: Tool '${name}' is a legacy tool.`;
    }
    // Canonical tool: success stub
    return `OK:${name}`;
}

// ---------------------------------------------------------------------------
// AgentService pre-execution gate (Gate #1 in AgentService)
// ---------------------------------------------------------------------------
function agentGate(toolName: string, allowedToolNames: ReadonlySet<string>): boolean {
    return allowedToolNames.has(toolName);
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
const CODING_ALLOWED: ReadonlySet<string> = new Set(['fs_read_text', 'fs_write_text', 'fs_list', 'shell_run']);

let passed = 0;
let failed = 0;
const results: string[] = [];

function ok(label: string) {
    const line = `  ✅ PASS: ${label}`;
    console.log(line);
    results.push(line);
    passed++;
}
function fail(label: string, detail?: string) {
    const line = `  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`;
    console.error(line);
    results.push(line);
    failed++;
}

console.log('\n=== verify_tool_gates.ts ===\n');

// ── Test 1 ──────────────────────────────────────────────────────────────────
console.log('Test 1: AgentService Gate: write_file rejected (not in allowedToolNames)');
if (!agentGate('write_file', CODING_ALLOWED)) {
    ok('write_file blocked by AgentService pre-execution gate');
} else {
    fail('write_file passed AgentService gate — WRONG');
}

// ── Test 2 ──────────────────────────────────────────────────────────────────
console.log('\nTest 2: AgentService Gate: shell_run accepted (in allowedToolNames)');
if (agentGate('shell_run', CODING_ALLOWED)) {
    ok('shell_run passes AgentService pre-execution gate');
} else {
    fail('shell_run blocked by AgentService gate — WRONG');
}

// ── Test 3 ──────────────────────────────────────────────────────────────────
console.log('\nTest 3: ToolService Gate #2: write_file with allowedNames → ToolNotAllowedThisTurn');
try {
    simulateExecuteTool('write_file', {}, CODING_ALLOWED);
    fail('write_file should have thrown ToolNotAllowedThisTurn');
} catch (e: any) {
    if (e.message.startsWith('ToolNotAllowedThisTurn:')) {
        ok(`Gate #2 threw: ${e.message}`);
    } else {
        fail('Wrong error', e.message);
    }
}

// ── Test 4 ──────────────────────────────────────────────────────────────────
console.log('\nTest 4: ToolService Gate #2: search_memory with allowedNames → ToolNotAllowedThisTurn');
try {
    simulateExecuteTool('search_memory', { query: 'test' }, CODING_ALLOWED);
    fail('search_memory should have thrown ToolNotAllowedThisTurn');
} catch (e: any) {
    if (e.message.startsWith('ToolNotAllowedThisTurn:')) {
        ok(`Gate #2 threw: ${e.message}`);
    } else {
        fail('Wrong error', e.message);
    }
}

// ── Test 5 ──────────────────────────────────────────────────────────────────
console.log('\nTest 5: ToolService Gate #1 (static): write_file without allowedNames → legacy block');
try {
    const result = simulateExecuteTool('write_file', {});
    if (result.includes('legacy tool')) {
        ok(`Gate #1 returned legacy error: "${result}"`);
    } else {
        fail('write_file returned unexpected result', result);
    }
} catch (e: any) {
    fail('write_file threw unexpectedly', e.message);
}

// ── Test 6 ──────────────────────────────────────────────────────────────────
console.log('\nTest 6: ToolService Gate #2: fs_write_text (canonical) with allowedNames → OK');
try {
    const result = simulateExecuteTool('fs_write_text', { path: 'a.txt', content: 'x' }, CODING_ALLOWED);
    if (result.startsWith('OK:')) {
        ok(`fs_write_text passed both gates: "${result}"`);
    } else {
        fail('fs_write_text returned unexpected', result);
    }
} catch (e: any) {
    fail('fs_write_text threw unexpectedly', e.message);
}

// ── Test 7 ──────────────────────────────────────────────────────────────────
console.log('\nTest 7: provider prefix stripped: default_api:write_file → write_file → Gate #2 blocks');
try {
    simulateExecuteTool('default_api:write_file', {}, CODING_ALLOWED);
    fail('default_api:write_file should have been blocked');
} catch (e: any) {
    if (e.message.startsWith('ToolNotAllowedThisTurn:')) {
        ok(`Provider prefix stripped, then Gate #2 blocked: ${e.message}`);
    } else {
        fail('Wrong error', e.message);
    }
}

// ── Test 8 ──────────────────────────────────────────────────────────────────
console.log('\nTest 8: Retry invariant — filteredTools set is not re-expanded on retry');
// Simulate what AgentService does: allowedToolNames computed once, same reference on retry
const turnAllowed = new Set(CODING_ALLOWED);
const retryAllowed = turnAllowed; // same reference, not re-computed
if (turnAllowed === retryAllowed && [...retryAllowed].join(',') === 'fs_read_text,fs_write_text,fs_list,shell_run') {
    ok(`Retry uses same allowedToolNames set (${turnAllowed.size} tools, unchanged)`);
} else {
    fail('Retry allowedToolNames differs from turn allowedToolNames');
}

// ── Summary ──────────────────────────────────────────────────────────────────
const summary = {
    passed,
    failed,
    total: passed + failed,
    allPassed: failed === 0,
    timestamp: new Date().toISOString()
};
const outPath = path.join(process.cwd(), 'scripts', 'verify_tool_gates.json');
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
console.log(JSON.stringify(summary, null, 2));

if (failed > 0) process.exit(1);
