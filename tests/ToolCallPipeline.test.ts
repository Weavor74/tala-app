/**
 * ToolCallPipeline.test.ts
 *
 * Verifies the four behavioral fixes applied to the AgentService tool-call
 * execution pipeline.  Each test group documents the "before" behaviour that
 * caused the regression and the "after" behaviour that the patch enforces.
 *
 * Tests are intentionally pure-logic unit tests — they extract and mirror the
 * exact conditional branches from AgentService without requiring the full
 * Electron / brain / settings stack.
 *
 * Covered fixes
 * ─────────────
 *  Fix 1 – Loop-detection guard
 *    Loop detection must NOT fire when the response carries canonical toolCalls.
 *    Previously the guard was absent, causing all tool calls to be silently
 *    dropped whenever the assistant content hash matched a prior response.
 *
 *  Fix 2 – Broadened requiresTool gate
 *    The recovery-retry must fire for browser/web tasks and for any turn where
 *    tools were sent but the model returned no structured tool calls.
 *    Previously only narrow file-system keywords triggered the retry, so browser
 *    tool requests were never recovered and always fell through to plain content.
 *
 *  Fix 3 – Non-coding retry fall-through
 *    When a retry produces no tool calls on a non-coding turn the pipeline must
 *    fall through to plain-content finalization (using the original response
 *    text) instead of hard-failing with "Tool call required".
 *    Coding turns still hard-fail as before.
 *
 *  Fix 4 – assistantMsg content updated from retry response
 *    When the retry response produces tool calls, the assistant message content
 *    should be sourced from the retry response (not the original response) so
 *    the committed context is internally consistent.
 */

import { describe, it, expect } from 'vitest';

// ─── Mirrors of the exact conditions from AgentService ───────────────────────

/**
 * Mirrors AgentService line 2171 (after fix).
 * Returns true → loop detection should fire and halt the turn.
 * Returns false → loop detection is skipped (tool calls proceed).
 */
function shouldFireLoopDetection(
    responseToolCallsLength: number,
    isContentLooping: boolean
): boolean {
    // Fix 1: guard added — only fire when no canonical tool calls present.
    return !responseToolCallsLength && isContentLooping;
}

/**
 * Mirrors the full ToolRequired retry gate in AgentService (after fix).
 *
 * This reflects BOTH the `requiresTool` boolean AND the outer
 * `if (requiresTool && calls.length === 0 && activeMode !== 'rp')` guard so
 * callers can test the exact condition that determines whether a retry fires.
 *
 * @param userMessage        The raw user message.
 * @param toolsSentCount     Number of tool definitions sent to the model.
 * @param callsLength        Number of structured tool calls the model returned.
 * @param activeMode         Current agent mode.
 */
function shouldAttemptToolRetry(
    userMessage: string,
    toolsSentCount: number,
    callsLength: number,
    activeMode: string
): boolean {
    // In the actual code the outer gate always includes `calls.length === 0`.
    if (callsLength > 0) return false;
    if (activeMode === 'rp') return false;

    const intentVerbs = [
        'create', 'write', 'edit', 'modify', 'delete', 'remove', 'add', 'update',
        'patch', 'refactor', 'generate', 'scaffold', 'implement', 'fix', 'run',
        'execute', 'lint', 'test', 'build', 'install', 'start',
    ];
    const intentNouns = [
        'file', 'script', 'folder', 'directory', 'path', 'ts', 'js', 'json', 'md',
        'txt', 'npm', 'node', 'pnpm', 'yarn', 'python', 'pytest', 'eslint', 'tsc',
    ];
    const browserVerbs = [
        'browse', 'navigate', 'open', 'search', 'click', 'visit', 'load',
        'go', 'type', 'scroll',
    ];
    const browserNouns = [
        'website', 'url', 'page', 'browser', 'site', 'link', 'tab',
        'http', 'https', 'www',
    ];

    const lower = userMessage.toLowerCase();

    const keywordRequiresTool =
        (intentVerbs.some(v => lower.includes(v)) && intentNouns.some(n => lower.includes(n))) ||
        (browserVerbs.some(v => lower.includes(v)) &&
            (browserNouns.some(n => lower.includes(n)) || /https?:\/\//.test(lower)));

    // Fix 2: also recover when tools were sent but not used
    const requiresTool = keywordRequiresTool || (toolsSentCount > 0 && callsLength === 0);

    // Mirror the outer gate: `requiresTool && calls.length === 0 && activeMode !== 'rp'`
    return requiresTool && callsLength === 0 && activeMode !== 'rp';
}

/**
 * Mirrors the retry failure branch in AgentService (after fix).
 *
 * Returns the action to take when the retry also produced no calls:
 *   'hard_fail'    – coding intent, break with "Tool call required"
 *   'fall_through' – non-coding intent, fall through to plain content
 */
function retryFailureAction(intentClass: string): 'hard_fail' | 'fall_through' {
    // Fix 3: only hard-fail for coding turns.
    if (intentClass === 'coding') return 'hard_fail';
    return 'fall_through';
}

/**
 * Mirrors the assistantMsg.content update after retry (after fix).
 *
 * When the retry provides tool calls, the assistant message content MUST come
 * from the retry response to keep the committed context internally consistent.
 */
function resolveAssistantMsgContent(
    originalContent: string,
    retryContent: string,
    retryCallsLength: number
): string {
    // Fix 4: use retry content when retry produced tool calls.
    if (retryCallsLength > 0) {
        return retryContent || '';
    }
    return originalContent;
}

// ─── Fix 1: Loop-detection guard ─────────────────────────────────────────────

describe('Fix 1 – Loop detection guard with canonical toolCalls', () => {
    it('fires when content is looping and there are NO tool calls', () => {
        // Before fix: always fired; after fix: still fires here (no tool calls).
        expect(shouldFireLoopDetection(0, true)).toBe(true);
    });

    it('does NOT fire when the response carries canonical toolCalls (content irrelevant)', () => {
        // Before fix: would fire → tool calls silently dropped.
        // After fix: guard added → tool calls proceed to execution.
        expect(shouldFireLoopDetection(1, true)).toBe(false);
        expect(shouldFireLoopDetection(3, true)).toBe(false);
    });

    it('does NOT fire when content is not looping and there are no tool calls', () => {
        expect(shouldFireLoopDetection(0, false)).toBe(false);
    });

    it('does NOT fire when content is not looping and tool calls are present', () => {
        expect(shouldFireLoopDetection(2, false)).toBe(false);
    });
});

// ─── Fix 2: Broadened requiresTool gate ──────────────────────────────────────

describe('Fix 2 – requiresTool covers browser and any tools-sent-but-not-used', () => {

    // ── Original file-system keywords still work ──────────────────────────

    it('fires for canonical file-system task keywords', () => {
        expect(shouldAttemptToolRetry('create a file called test.py', 10, 0, 'assistant')).toBe(true);
        expect(shouldAttemptToolRetry('write a script to update the json config', 10, 0, 'assistant')).toBe(true);
        expect(shouldAttemptToolRetry('edit the README.md file', 10, 0, 'assistant')).toBe(true);
    });

    // ── Browser / web keywords (new) ─────────────────────────────────────

    it('fires for "browse to" combined with a URL or site keyword', () => {
        expect(shouldAttemptToolRetry('browse to https://example.com', 10, 0, 'assistant')).toBe(true);
    });

    it('fires for "navigate to" with a URL', () => {
        expect(shouldAttemptToolRetry('navigate to https://github.com/repo', 10, 0, 'assistant')).toBe(true);
    });

    it('fires for "open" combined with browser/website noun', () => {
        expect(shouldAttemptToolRetry('open the browser and go to example.com', 10, 0, 'assistant')).toBe(true);
    });

    it('fires for "search" combined with "website"', () => {
        expect(shouldAttemptToolRetry('search this website for the documentation', 10, 0, 'assistant')).toBe(true);
    });

    it('fires for "click" combined with "page"', () => {
        expect(shouldAttemptToolRetry('click the submit button on the page', 10, 0, 'assistant')).toBe(true);
    });

    it('fires for "scroll" combined with "page"', () => {
        expect(shouldAttemptToolRetry('scroll down the page', 10, 0, 'assistant')).toBe(true);
    });

    // ── tools-sent-but-not-used trigger (new) ────────────────────────────

    it('fires when tools were sent and no tool calls returned, regardless of keywords', () => {
        // A non-keyword task where the model skipped tool calls
        expect(shouldAttemptToolRetry('what is the weather today', 5, 0, 'assistant')).toBe(true);
    });

    it('fires when tools were sent and no tool calls returned even for a greeting', () => {
        // Edge case: tools were somehow sent for a greeting turn (shouldn't happen
        // in practice due to routing invariants, but the gate should still trigger).
        expect(shouldAttemptToolRetry('hello!', 3, 0, 'assistant')).toBe(true);
    });

    it('does NOT fire when no tools were sent and no keyword match', () => {
        // Conversation turns: toolsToSend = 0, no keywords → no retry
        expect(shouldAttemptToolRetry('what is python?', 0, 0, 'assistant')).toBe(false);
    });

    it('does NOT fire when calls are already present (model used structured tool calls)', () => {
        // When the model already returned tool calls, no retry is needed
        expect(shouldAttemptToolRetry('create a file called test.py', 10, 2, 'assistant')).toBe(false);
        expect(shouldAttemptToolRetry('browse to https://example.com', 10, 1, 'assistant')).toBe(false);
    });

    it('does NOT fire in RP mode regardless of keywords or tools sent', () => {
        expect(shouldAttemptToolRetry('create a script file', 0, 0, 'rp')).toBe(false);
        expect(shouldAttemptToolRetry('browse to https://example.com', 5, 0, 'rp')).toBe(false);
    });
});

// ─── Fix 3: Non-coding retry fall-through ────────────────────────────────────

describe('Fix 3 – Non-coding retry falls through instead of hard-failing', () => {
    it('coding intent → hard_fail when retry produces no tool calls', () => {
        // Coding turns MUST use tools; hard-fail is correct here.
        expect(retryFailureAction('coding')).toBe('hard_fail');
    });

    it('task intent → fall_through when retry produces no tool calls', () => {
        // Before fix: was hard_fail ("Tool call required for this task. Re-issue…")
        // After fix: fall through → plain content from original response is used.
        expect(retryFailureAction('task')).toBe('fall_through');
    });

    it('troubleshooting intent → fall_through', () => {
        expect(retryFailureAction('troubleshooting')).toBe('fall_through');
    });

    it('conversation intent → fall_through', () => {
        expect(retryFailureAction('conversation')).toBe('fall_through');
    });
});

// ─── Fix 4: assistantMsg content sourced from retry when retry provides calls ─

describe('Fix 4 – assistantMsg.content comes from retry response when retry provides tool calls', () => {
    it('returns retry content when retry produced tool calls', () => {
        const original = 'I will create that file for you.';
        const retry = 'Executing tool now.';
        // After fix: retry content replaces original content for consistency.
        expect(resolveAssistantMsgContent(original, retry, 1)).toBe(retry);
    });

    it('returns empty string when retry content is empty but retry produced tool calls', () => {
        expect(resolveAssistantMsgContent('original response', '', 2)).toBe('');
    });

    it('returns original content when retry produced NO tool calls', () => {
        const original = 'Here is some information about Python.';
        // No retry tool calls → use original content (plain text response)
        expect(resolveAssistantMsgContent(original, 'retry prose', 0)).toBe(original);
    });
});

// ─── Integration-style verification ──────────────────────────────────────────

describe('Pipeline invariant: finalResponse must not be assigned from plain content when toolCalls are present', () => {
    /**
     * Mirrors the full decision path in AgentService (simplified).
     *
     * Returns either 'execute_tools' or the finalResponse string that would be
     * set, along with whether that represents a plain-content fallthrough.
     */
    function simulatePipelineDecision(opts: {
        responseToolCalls: { type: string; function: { name: string } }[];
        responseContent: string;
        activeMode: string;
        isContentLooping: boolean;
        intentClass: string;
        toolsSentCount: number;
    }): { outcome: 'execute_tools' | 'final_response'; value: string } {
        const { responseToolCalls, responseContent, activeMode, isContentLooping, intentClass, toolsSentCount } = opts;

        // Fix 1: loop detection guard
        if (shouldFireLoopDetection(responseToolCalls.length, isContentLooping)) {
            return { outcome: 'final_response', value: 'Loop detected. Halting repeated tool execution. Awaiting new user instruction.' };
        }

        const calls = activeMode === 'rp' ? [] : [...responseToolCalls];

        // Simplified: if calls are empty, the requiresTool retry would run but
        // assume it also returns empty (worst case) — then check the outcome.
        if (calls.length === 0) {
            // Fix 3: non-coding falls through to plain content
            const action = retryFailureAction(intentClass);
            if (action === 'hard_fail') {
                return { outcome: 'final_response', value: 'Tool call required for this task. The model did not emit tool calls.' };
            }
            // plain content
            return { outcome: 'final_response', value: responseContent };
        }

        return { outcome: 'execute_tools', value: '' };
    }

    it('response with canonical toolCalls → execute_tools (not plain content)', () => {
        const result = simulatePipelineDecision({
            responseToolCalls: [{ type: 'function', function: { name: 'browse' } }],
            responseContent: 'I will browse that for you.',
            activeMode: 'assistant',
            isContentLooping: false,
            intentClass: 'task',
            toolsSentCount: 5,
        });
        expect(result.outcome).toBe('execute_tools');
    });

    it('response with canonical toolCalls AND repeated content → execute_tools (loop detection skipped)', () => {
        // Before fix: loop detection would fire → final_response 'Loop detected…'
        // After fix: toolCalls are present → loop detection skipped → tools execute
        const result = simulatePipelineDecision({
            responseToolCalls: [{ type: 'function', function: { name: 'browse' } }],
            responseContent: 'I will browse that for you.', // "repeated" content
            activeMode: 'assistant',
            isContentLooping: true,
            intentClass: 'task',
            toolsSentCount: 5,
        });
        expect(result.outcome).toBe('execute_tools');
        expect(result.value).not.toBe('Loop detected. Halting repeated tool execution. Awaiting new user instruction.');
    });

    it('response with no toolCalls and non-coding intent → plain content (not hard-fail)', () => {
        const result = simulatePipelineDecision({
            responseToolCalls: [],
            responseContent: 'Here is some information.',
            activeMode: 'assistant',
            isContentLooping: false,
            intentClass: 'task',
            toolsSentCount: 3,
        });
        expect(result.outcome).toBe('final_response');
        expect(result.value).toBe('Here is some information.');
    });

    it('response with no toolCalls and coding intent → hard fail (not plain content)', () => {
        const result = simulatePipelineDecision({
            responseToolCalls: [],
            responseContent: 'Here is the code.',
            activeMode: 'assistant',
            isContentLooping: false,
            intentClass: 'coding',
            toolsSentCount: 3,
        });
        expect(result.outcome).toBe('final_response');
        expect(result.value).toContain('Tool call required');
        expect(result.value).not.toBe('Here is the code.');
    });

    it('RP mode: toolCalls (if any) are ignored and content is used', () => {
        const result = simulatePipelineDecision({
            responseToolCalls: [{ type: 'function', function: { name: 'fs_write_text' } }],
            responseContent: 'RP prose response.',
            activeMode: 'rp',
            isContentLooping: false,
            intentClass: 'conversation',
            toolsSentCount: 0,
        });
        // RP mode clears calls → falls through to plain content
        expect(result.outcome).toBe('final_response');
        expect(result.value).toBe('RP prose response.');
    });
});

// ─── Fix 5 – Retry tool count respects mode filter ───────────────────────────
//
// Root cause (observed in logs):
//   First attempt (hybrid mode) sent 5 tools (toolsToSend filtered).
//   On ToolRequired retry the code used `filteredTools` (57 tools) instead of
//   `toolsToSend`, blowing up the payload to 52 KB and reliably timing out the
//   8B Ollama model a second time.
//
// Fix: retry uses `toolsToSend` (the mode-filtered palette), not `filteredTools`.

/**
 * Mirrors the retry tool selection logic from AgentService (after fix).
 *
 * @param isBrowserTask      Whether the turn is a browser task.
 * @param toolsToSend        Mode-filtered tools sent on the original attempt.
 * @param filteredTools      Full capability-resolved tool set (before mode filter).
 * @param browserTaskNames   Set of browser-only tool names (for browser-task palette).
 */
function selectRetryTools(
    isBrowserTask: boolean,
    toolsToSend: { name: string }[],
    filteredTools: { name: string }[],
    browserTaskNames: Set<string>
): { name: string }[] {
    // This mirrors the FIXED branch in AgentService:
    //   const retryTools = isBrowserTask
    //       ? filteredTools.filter(t => BROWSER_TASK_TOOL_NAMES.has(t.function.name))
    //       : toolsToSend;          ← was filteredTools before the fix
    return isBrowserTask
        ? filteredTools.filter(t => browserTaskNames.has(t.name))
        : toolsToSend;
}

describe('ToolCallPipeline Fix 5 — retry uses mode-filtered toolsToSend', () => {

    const BROWSER_NAMES = new Set(['browse', 'browser_click', 'browser_type']);

    const hybridPalette = [
        { name: 'fs_read_text' },
        { name: 'mem0_search' },
        { name: 'query_graph' },
        { name: 'manage_goals' },
        { name: 'reflection_create_goal' },
    ];

    // Simulates the full filteredTools before hybrid mode filtering (57 in prod).
    const fullFilteredTools = [
        ...hybridPalette,
        { name: 'shell_run' }, { name: 'fs_write_text' }, { name: 'browse' },
        { name: 'browser_click' }, { name: 'browser_type' }, { name: 'search_web' },
        { name: 'desktop_screenshot' }, { name: 'mem0_add' }, { name: 'get_user_profile' },
        // … (57 total in production; abbreviated here for test clarity)
    ];

    it('non-browser retry uses toolsToSend (mode-filtered), not the full filteredTools', () => {
        const retryTools = selectRetryTools(false, hybridPalette, fullFilteredTools, BROWSER_NAMES);
        // Must equal the mode-filtered hybrid palette, not the full set.
        expect(retryTools).toEqual(hybridPalette);
        expect(retryTools.length).toBe(hybridPalette.length);
        // Specifically must NOT expand to the full filteredTools count.
        expect(retryTools.length).toBeLessThan(fullFilteredTools.length);
    });

    it('non-browser retry tool count matches original attempt (no explosion)', () => {
        const retryTools = selectRetryTools(false, hybridPalette, fullFilteredTools, BROWSER_NAMES);
        // Production scenario: first attempt sent 5 tools; retry must also send 5.
        expect(retryTools.length).toBe(5);
    });

    it('browser-task retry uses browser-only subset of filteredTools', () => {
        const retryTools = selectRetryTools(true, hybridPalette, fullFilteredTools, BROWSER_NAMES);
        // Browser-task retry: filtered from fullFilteredTools, not hybridPalette.
        expect(retryTools.every(t => BROWSER_NAMES.has(t.name))).toBe(true);
        expect(retryTools.length).toBeGreaterThan(0);
    });

    it('browser-task retry does not include non-browser tools from hybridPalette', () => {
        const retryTools = selectRetryTools(true, hybridPalette, fullFilteredTools, BROWSER_NAMES);
        const nonBrowser = retryTools.filter(t => !BROWSER_NAMES.has(t.name));
        expect(nonBrowser.length).toBe(0);
    });

    it('retry tool list is stable — same tools every retry iteration (no growth)', () => {
        // Simulate three consecutive retry iterations — tool count must not grow.
        const iter1 = selectRetryTools(false, hybridPalette, fullFilteredTools, BROWSER_NAMES);
        const iter2 = selectRetryTools(false, hybridPalette, fullFilteredTools, BROWSER_NAMES);
        const iter3 = selectRetryTools(false, hybridPalette, fullFilteredTools, BROWSER_NAMES);
        expect(iter1.length).toBe(iter2.length);
        expect(iter2.length).toBe(iter3.length);
    });
});
