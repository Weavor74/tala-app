/**
 * ToolGatekeeper.test.ts
 *
 * Deterministic unit tests for ToolGatekeeper — the explicit tool-decision
 * layer that runs before tools are sent to the model.
 *
 * Each test group maps to one of the rule groups defined in the problem spec:
 *
 *   Test 1  — Rule A: Lore + approved RAG memory blocks mem0_search
 *   Test 2  — Rule A: Lore + no canon memory allows mem0_search fallback
 *   Test 3  — Rule B: Degraded mem0_search is suppressed
 *   Test 4  — Rule E: ToolRequired retry preserves gatekept tool list
 *   Test 5  — Rule C: directAnswerPreferred = true when context is sufficient
 *   Test 6  — Rule D: Technical/coding intent still allows engineering tools
 *   Test 7  — No global tool loss for unrelated intents
 *
 * Tests are pure-logic unit tests; they create a fresh ToolGatekeeper per
 * group so health state does not bleed between groups.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolGatekeeper, type ToolGateContext } from '../electron/services/router/ToolGatekeeper';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Canonical palette used across test groups. */
const ALL_TOOLS = [
    'mem0_search',
    'mem0_add',
    'retrieve_context',
    'query_graph',
    'fs_read_text',
    'fs_write_text',
    'shell_run',
    'get_emotion_state',
    'manage_goals',
    'reflection_create_goal',
];

function makeContext(overrides: Partial<ToolGateContext> = {}): ToolGateContext {
    return {
        intentClass: 'conversation',
        activeMode: 'assistant',
        responseMode: undefined,
        approvedMemoryCount: 0,
        candidateToolNames: [...ALL_TOOLS],
        isBrowserTask: false,
        isRetry: false,
        priorBlockedTools: [],
        ...overrides,
    };
}

// ─── Test 1: Rule A — Lore + approved memory blocks mem0_search ───────────────

describe('Test 1 — Rule A: lore intent + approved RAG memory suppresses mem0_search', () => {
    let gate: ToolGatekeeper;
    beforeEach(() => { gate = new ToolGatekeeper(); });

    it('blocks mem0_search when intent=lore and approvedMemoryCount > 0', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 3,
            responseMode: 'memory_grounded_soft',
        }));
        expect(decision.blockedTools).toContain('mem0_search');
        expect(decision.allowedTools).not.toContain('mem0_search');
    });

    it('blocks mem0_search for memory_grounded_strict regardless of approvedCount', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 0,
            responseMode: 'memory_grounded_strict',
        }));
        expect(decision.blockedTools).toContain('mem0_search');
    });

    it('blocks mem0_search for memory_grounded_soft on any intent', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'coding',
            approvedMemoryCount: 5,
            responseMode: 'memory_grounded_soft',
        }));
        expect(decision.blockedTools).toContain('mem0_search');
    });

    it('preserves all other tools (no collateral suppression)', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 2,
            responseMode: 'memory_grounded_soft',
        }));
        const retained = ['retrieve_context', 'query_graph', 'fs_read_text', 'get_emotion_state', 'manage_goals'];
        for (const t of retained) {
            expect(decision.allowedTools).toContain(t);
            expect(decision.blockedTools).not.toContain(t);
        }
    });

    it('includes a gating reason for the suppression', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 1,
            responseMode: 'memory_grounded_soft',
        }));
        expect(decision.gatingReasons.some(r => r.includes('ruleA'))).toBe(true);
    });
});

// ─── Test 2: Rule A — Lore + zero canon memory allows mem0_search fallback ────

describe('Test 2 — Rule A: lore intent + zero approved memories keeps mem0_search', () => {
    let gate: ToolGatekeeper;
    beforeEach(() => { gate = new ToolGatekeeper(); });

    it('does NOT block mem0_search when intent=lore but approvedMemoryCount=0 and no responseMode', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 0,
            responseMode: undefined,
        }));
        expect(decision.blockedTools).not.toContain('mem0_search');
        expect(decision.allowedTools).toContain('mem0_search');
    });

    it('returns the full candidate set when no rules fire', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 0,
            responseMode: undefined,
        }));
        expect(decision.allowedTools.length).toBe(ALL_TOOLS.length);
    });

    it('directAnswerPreferred is false when no grounding mode is active', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 0,
            responseMode: undefined,
        }));
        expect(decision.directAnswerPreferred).toBe(false);
    });
});

// ─── Test 3: Rule B — Degraded tool suppression ───────────────────────────────

describe('Test 3 — Rule B: degraded mem0_search is suppressed', () => {
    let gate: ToolGatekeeper;
    beforeEach(() => { gate = new ToolGatekeeper(); });

    it('suppresses mem0_search after 3 failures (degraded threshold)', () => {
        // Simulate 3 consecutive timeouts within the rolling window
        gate.recordToolFailure('mem0_search');
        gate.recordToolFailure('mem0_search');
        gate.recordToolFailure('mem0_search');

        const decision = gate.evaluate(makeContext({
            intentClass: 'conversation',
            approvedMemoryCount: 0,
        }));
        expect(decision.blockedTools).toContain('mem0_search');
        expect(decision.gatingReasons.some(r => r.includes('ruleB'))).toBe(true);
    });

    it('does NOT suppress mem0_search with only 2 failures (below threshold)', () => {
        gate.recordToolFailure('mem0_search');
        gate.recordToolFailure('mem0_search');

        const decision = gate.evaluate(makeContext({ intentClass: 'conversation' }));
        expect(decision.blockedTools).not.toContain('mem0_search');
    });

    it('markToolDegraded immediately degrades a tool', () => {
        gate.markToolDegraded('mem0_search');

        const decision = gate.evaluate(makeContext({ intentClass: 'conversation' }));
        expect(decision.blockedTools).toContain('mem0_search');
    });

    it('clearToolHealth removes degraded status', () => {
        gate.markToolDegraded('mem0_search');
        gate.clearToolHealth('mem0_search');

        const decision = gate.evaluate(makeContext({ intentClass: 'conversation' }));
        expect(decision.blockedTools).not.toContain('mem0_search');
    });

    it('critical tools (manage_goals) are never suppressed by degraded rule', () => {
        gate.markToolDegraded('manage_goals');

        const decision = gate.evaluate(makeContext({ intentClass: 'conversation' }));
        expect(decision.blockedTools).not.toContain('manage_goals');
        expect(decision.allowedTools).toContain('manage_goals');
    });

    it('degraded suppression applies to tools other than mem0_search too', () => {
        gate.recordToolFailure('retrieve_context');
        gate.recordToolFailure('retrieve_context');
        gate.recordToolFailure('retrieve_context');

        const decision = gate.evaluate(makeContext({ intentClass: 'conversation' }));
        expect(decision.blockedTools).toContain('retrieve_context');
    });
});

// ─── Test 4: Rule E — ToolRequired retry preserves gatekept tool list ─────────

describe('Test 4 — Rule E: retry pass preserves blocked tools (no re-expansion)', () => {
    let gate: ToolGatekeeper;
    beforeEach(() => { gate = new ToolGatekeeper(); });

    it('re-applies priorBlockedTools on a retry pass', () => {
        // First pass: lore + grounded → mem0_search blocked
        const firstDecision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 3,
            responseMode: 'memory_grounded_soft',
        }));
        expect(firstDecision.blockedTools).toContain('mem0_search');

        // Retry pass: isRetry=true, priorBlockedTools from first pass
        const retryDecision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 3,
            responseMode: 'memory_grounded_soft',
            isRetry: true,
            priorBlockedTools: firstDecision.blockedTools,
        }));
        expect(retryDecision.blockedTools).toContain('mem0_search');
        expect(retryDecision.allowedTools).not.toContain('mem0_search');
    });

    it('retry does NOT expand back to the full tool universe', () => {
        const firstDecision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 3,
            responseMode: 'memory_grounded_soft',
        }));

        const retryDecision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 3,
            responseMode: 'memory_grounded_soft',
            isRetry: true,
            priorBlockedTools: firstDecision.blockedTools,
        }));
        // allowedTools on retry must be equal to or smaller than the first pass
        expect(retryDecision.allowedTools.length).toBeLessThanOrEqual(firstDecision.allowedTools.length);
    });

    it('retry gating reason records the preserved block count', () => {
        const retryDecision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 1,
            responseMode: 'memory_grounded_soft',
            isRetry: true,
            priorBlockedTools: ['mem0_search'],
        }));
        expect(retryDecision.gatingReasons.some(r => r.includes('retry'))).toBe(true);
    });
});

// ─── Test 5: Rule C — directAnswerPreferred when context is sufficient ─────────

describe('Test 5 — Rule C: directAnswerPreferred is set when grounded memory is available', () => {
    let gate: ToolGatekeeper;
    beforeEach(() => { gate = new ToolGatekeeper(); });

    it('is true for lore intent with approvedMemoryCount > 0', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 2,
            responseMode: 'memory_grounded_soft',
        }));
        expect(decision.directAnswerPreferred).toBe(true);
    });

    it('is true when responseMode=memory_grounded_strict regardless of intent', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'conversation',
            approvedMemoryCount: 0,
            responseMode: 'memory_grounded_strict',
        }));
        expect(decision.directAnswerPreferred).toBe(true);
    });

    it('is false for a coding turn with no grounded mode', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'coding',
            approvedMemoryCount: 5,
            responseMode: undefined,
        }));
        expect(decision.directAnswerPreferred).toBe(false);
    });

    it('is false for plain conversation with no grounded mode', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'conversation',
            approvedMemoryCount: 0,
            responseMode: undefined,
        }));
        expect(decision.directAnswerPreferred).toBe(false);
    });
});

// ─── Test 6: Rule D — Technical/coding intent still allows engineering tools ──

describe('Test 6 — Rule D: coding / technical intents allow required engineering tools', () => {
    let gate: ToolGatekeeper;
    beforeEach(() => { gate = new ToolGatekeeper(); });

    it('does not block fs_read_text, fs_write_text, shell_run for coding intent', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'coding',
            approvedMemoryCount: 0,
            responseMode: undefined,
        }));
        const needed = ['fs_read_text', 'fs_write_text', 'shell_run'];
        for (const t of needed) {
            expect(decision.allowedTools).toContain(t);
            expect(decision.blockedTools).not.toContain(t);
        }
    });

    it('sets requiresToolUse=true for coding intent', () => {
        const decision = gate.evaluate(makeContext({ intentClass: 'coding' }));
        expect(decision.requiresToolUse).toBe(true);
    });

    it('sets requiresToolUse=true for browser task', () => {
        const decision = gate.evaluate(makeContext({ intentClass: 'task', isBrowserTask: true }));
        expect(decision.requiresToolUse).toBe(true);
    });

    it('requiresToolUse is false for lore or conversation', () => {
        for (const intent of ['lore', 'conversation']) {
            const decision = gate.evaluate(makeContext({ intentClass: intent }));
            expect(decision.requiresToolUse).toBe(false);
        }
    });

    it('does not block mem0_search for a coding turn without grounding', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'coding',
            approvedMemoryCount: 3,
            responseMode: undefined,
        }));
        expect(decision.blockedTools).not.toContain('mem0_search');
        expect(decision.allowedTools).toContain('mem0_search');
    });
});

// ─── Test 7: No global tool loss for unrelated intents ────────────────────────

describe('Test 7 — No global tool loss: unrelated intents receive full candidate set', () => {
    let gate: ToolGatekeeper;
    beforeEach(() => { gate = new ToolGatekeeper(); });

    const unrelatedIntents = ['conversation', 'task', 'diagnostics', 'research', 'planning'];

    for (const intent of unrelatedIntents) {
        it(`intent=${intent} without grounding or degraded tools: all candidates allowed`, () => {
            const decision = gate.evaluate(makeContext({
                intentClass: intent,
                approvedMemoryCount: 0,
                responseMode: undefined,
            }));
            expect(decision.blockedTools.length).toBe(0);
            expect(decision.allowedTools.length).toBe(ALL_TOOLS.length);
        });
    }

    it('empty candidateToolNames produces empty allowedTools without error', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 3,
            responseMode: 'memory_grounded_soft',
            candidateToolNames: [],
        }));
        expect(decision.allowedTools).toEqual([]);
        expect(decision.blockedTools).toContain('mem0_search');
    });

    it('mem0_add is never blocked by Rule A (only mem0_search is suppressed)', () => {
        const decision = gate.evaluate(makeContext({
            intentClass: 'lore',
            approvedMemoryCount: 5,
            responseMode: 'memory_grounded_strict',
        }));
        expect(decision.allowedTools).toContain('mem0_add');
        expect(decision.blockedTools).not.toContain('mem0_add');
    });

    it('degraded tool suppression does not affect healthy tools', () => {
        // Only mem0_search is degraded
        const gate2 = new ToolGatekeeper();
        gate2.markToolDegraded('mem0_search');

        const decision = gate2.evaluate(makeContext({ intentClass: 'task' }));
        const otherTools = ALL_TOOLS.filter(t => t !== 'mem0_search');
        for (const t of otherTools) {
            if (t === 'manage_goals' || t === 'reflection_create_goal') continue; // critical - exempt
            expect(decision.allowedTools).toContain(t);
        }
    });
});
