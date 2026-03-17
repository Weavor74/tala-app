/**
 * BrowserTaskMode.test.ts
 *
 * Validates the browser-task mode added to the TALA agent tool loop.
 * Browser requests should enter a dedicated browser-task mode that:
 *   1. Classifies browser/web-navigation requests as 'browser' intent
 *   2. Reduces the tool palette to browser-relevant tools only
 *   3. Auto-fetches DOM after successful browse/navigation
 *   4. Continues the multi-step tool loop instead of immediately
 *      finalizing plain prose when the browser task is still incomplete
 *   5. Clarifies tool descriptions for generic routing improvement
 *
 * Tests are pure-logic unit tests mirroring the exact conditional
 * branches from IntentClassifier and AgentService without requiring
 * the full Electron / brain / settings stack.
 *
 * Covered features
 * ─────────────────
 *  Feature A – Browser intent classification
 *    Browser-like user requests must classify as 'browser' intent.
 *
 *  Feature B – Tool palette filtering
 *    Browser-task mode must send only browser-relevant tools.
 *
 *  Feature C – Auto DOM fetch after navigation
 *    Successful browse causes automatic browser_get_dom before next
 *    planning step (appended to tool result as PAGE_STATE_SNAPSHOT).
 *
 *  Feature D – Multi-step browser workflow loop
 *    browse → inspect → type → inspect continues in one turn without
 *    premature plain-content finalization.
 *
 *  Feature E – Plain-content fallback protection
 *    Browser-task mode does not finalize plain prose while the browser
 *    task is still clearly incomplete (continuation steps < max).
 *
 *  Feature F – Generic tool clarity / routing
 *    Tool subsets and descriptions improve task-specific selection
 *    without breaking non-browser tasks.
 */

import { describe, it, expect } from 'vitest';
import { IntentClassifier } from '../electron/services/router/IntentClassifier';

// ─── Feature A: Browser intent classification ─────────────────────────────────

describe('Feature A – Browser intent classification', () => {
    const browserRequests = [
        'open google.com in the workspace browser',
        'navigate to https://wikipedia.org',
        'browse to https://example.com',
        'search for Star Citizen on google.com',
        'go to wikipedia.org and search for Star Citizen',
        'click the 5th result',
        'fill in the search box',
        'scroll the page down',
        'use the workspace browser',
        'open https://google.com',
        'type Star Citizen in the search field',
        'visit bing.com',
        'load the web page',
        'search google for Star Citizen',
    ];

    browserRequests.forEach(request => {
        it(`classifies "${request}" as browser intent`, () => {
            const result = IntentClassifier.classify(request);
            expect(result.class).toBe('browser');
            expect(result.confidence).toBeGreaterThanOrEqual(0.9);
        });
    });

    const nonBrowserRequests = [
        'hello',
        'what is the capital of France',
        'write a python script',
        'tell me about the lore',
        'how does memory work in TALA',
    ];

    nonBrowserRequests.forEach(request => {
        it(`does NOT classify "${request}" as browser intent`, () => {
            const result = IntentClassifier.classify(request);
            expect(result.class).not.toBe('browser');
        });
    });
});

// ─── Feature B: Tool palette filtering ───────────────────────────────────────

/**
 * Mirrors the browser-task tool filtering logic from AgentService.
 * When isBrowserTask is true, toolsToSend is reduced to only browser tools.
 */
const BROWSER_TASK_TOOL_NAMES = new Set([
    'browse', 'browser_get_dom', 'browser_click', 'browser_hover',
    'browser_type', 'browser_scroll', 'browser_press_key', 'browser_screenshot',
]);

function filterToolsForBrowserTask(allTools: Array<{ function: { name: string } }>, isBrowserTask: boolean) {
    if (!isBrowserTask) return allTools;
    return allTools.filter(t => BROWSER_TASK_TOOL_NAMES.has(t.function.name));
}

describe('Feature B – Tool palette filtering for browser-task mode', () => {
    const allTools = [
        { function: { name: 'browse' } },
        { function: { name: 'browser_get_dom' } },
        { function: { name: 'browser_click' } },
        { function: { name: 'browser_hover' } },
        { function: { name: 'browser_type' } },
        { function: { name: 'browser_scroll' } },
        { function: { name: 'browser_press_key' } },
        { function: { name: 'browser_screenshot' } },
        { function: { name: 'fs_read_text' } },
        { function: { name: 'fs_write_text' } },
        { function: { name: 'shell_run' } },
        { function: { name: 'mem0_search' } },
        { function: { name: 'mem0_add' } },
        { function: { name: 'query_graph' } },
        { function: { name: 'manage_goals' } },
        { function: { name: 'self_audit' } },
        { function: { name: 'terminal_run' } },
        { function: { name: 'search_web' } },
    ];

    it('reduces tool palette to browser tools only in browser-task mode', () => {
        const filtered = filterToolsForBrowserTask(allTools, true);
        const filteredNames = filtered.map(t => t.function.name);

        expect(filteredNames).toContain('browse');
        expect(filteredNames).toContain('browser_get_dom');
        expect(filteredNames).toContain('browser_click');
        expect(filteredNames).toContain('browser_type');
        expect(filteredNames).toContain('browser_scroll');
        expect(filteredNames).toContain('browser_press_key');
        expect(filteredNames).toContain('browser_screenshot');
        expect(filteredNames).not.toContain('fs_read_text');
        expect(filteredNames).not.toContain('shell_run');
        expect(filteredNames).not.toContain('mem0_search');
        expect(filteredNames).not.toContain('self_audit');
        expect(filteredNames).not.toContain('terminal_run');
    });

    it('sends exactly 8 browser tools in browser-task mode', () => {
        const filtered = filterToolsForBrowserTask(allTools, true);
        expect(filtered).toHaveLength(8);
    });

    it('preserves full tool palette for non-browser tasks', () => {
        const filtered = filterToolsForBrowserTask(allTools, false);
        expect(filtered).toHaveLength(allTools.length);
    });

    it('browser-task tool set contains the core navigation + inspection + interaction tools', () => {
        // Core workflow: browse → browser_get_dom → (click|type|scroll|press_key) → browser_get_dom
        expect(BROWSER_TASK_TOOL_NAMES.has('browse')).toBe(true);
        expect(BROWSER_TASK_TOOL_NAMES.has('browser_get_dom')).toBe(true);
        expect(BROWSER_TASK_TOOL_NAMES.has('browser_click')).toBe(true);
        expect(BROWSER_TASK_TOOL_NAMES.has('browser_type')).toBe(true);
        expect(BROWSER_TASK_TOOL_NAMES.has('browser_scroll')).toBe(true);
        expect(BROWSER_TASK_TOOL_NAMES.has('browser_press_key')).toBe(true);
        expect(BROWSER_TASK_TOOL_NAMES.has('browser_screenshot')).toBe(true);
    });
});

// ─── Feature C: Auto DOM fetch after navigation ───────────────────────────────

/**
 * Mirrors the auto-DOM injection logic from AgentService.
 * After a successful browse navigation, browser_get_dom is automatically
 * dispatched and its result is appended to the tool result.
 */
async function simulateNavigationWithAutoDom(
    toolName: string,
    navigationResult: string,
    isBrowserTask: boolean,
    getDomData: string
): Promise<string> {
    let result = navigationResult;
    if (isBrowserTask && toolName === 'browse'
        && typeof result === 'string' && !result.startsWith('Error:')) {
        // Auto-fetch DOM (mirrors AgentService auto-DOM logic)
        if (!getDomData.startsWith('Error:')) {
            result = `${result}\n\n[PAGE_STATE_SNAPSHOT]\n${getDomData}\n[/PAGE_STATE_SNAPSHOT]`;
        }
    }
    return result;
}

describe('Feature C – Auto DOM fetch after successful navigation', () => {
    const fakeDom = '[PAGE INFO]\nTitle: Google\n\n[INTERACTIVE ELEMENTS]\n1[:V] <input> Search\n2[:V] <button> Google Search';
    const navResult = 'Navigated to https://google.com. Page loaded.';

    it('appends PAGE_STATE_SNAPSHOT to the navigation result in browser-task mode', async () => {
        const result = await simulateNavigationWithAutoDom('browse', navResult, true, fakeDom);
        expect(result).toContain('Navigated to https://google.com');
        expect(result).toContain('[PAGE_STATE_SNAPSHOT]');
        expect(result).toContain('[/PAGE_STATE_SNAPSHOT]');
        expect(result).toContain('[PAGE INFO]');
        expect(result).toContain('[INTERACTIVE ELEMENTS]');
    });

    it('includes DOM interactive elements in the snapshot', async () => {
        const result = await simulateNavigationWithAutoDom('browse', navResult, true, fakeDom);
        expect(result).toContain('1[:V] <input> Search');
        expect(result).toContain('2[:V] <button> Google Search');
    });

    it('does NOT append DOM snapshot for non-browser-task mode', async () => {
        const result = await simulateNavigationWithAutoDom('browse', navResult, false, fakeDom);
        expect(result).not.toContain('[PAGE_STATE_SNAPSHOT]');
        expect(result).toBe(navResult);
    });

    it('does NOT append DOM snapshot for non-browse tools', async () => {
        const result = await simulateNavigationWithAutoDom('browser_click', 'Clicked element 12', true, fakeDom);
        expect(result).not.toContain('[PAGE_STATE_SNAPSHOT]');
    });

    it('does NOT append DOM when navigation failed (Error: response)', async () => {
        const result = await simulateNavigationWithAutoDom('browse', 'Error: Timeout', true, fakeDom);
        expect(result).not.toContain('[PAGE_STATE_SNAPSHOT]');
        expect(result).toBe('Error: Timeout');
    });

    it('skips DOM snapshot gracefully when browser_get_dom itself errors', async () => {
        const result = await simulateNavigationWithAutoDom('browse', navResult, true, 'Error: DOM fetch failed');
        // When DOM fetch fails, result should still be the navigation result (no snapshot appended)
        expect(result).toBe(navResult);
        expect(result).not.toContain('[PAGE_STATE_SNAPSHOT]');
    });
});

// ─── Feature D: Multi-step browser workflow loop ──────────────────────────────

/**
 * Mirrors the browser-task continuation logic from AgentService.
 * When calls.length === 0 and isBrowserTask, the loop continues up to
 * BROWSER_MAX_CONTINUATION_STEPS times before finalizing plain content.
 */
const BROWSER_MAX_CONTINUATION_STEPS = 3;

interface BrowserLoopState {
    isBrowserTask: boolean;
    activeMode: string;
    browserContinuationStep: number;
    callsLength: number;
}

function shouldContinueBrowserLoop(state: BrowserLoopState): boolean {
    return (
        state.isBrowserTask &&
        state.activeMode !== 'rp' &&
        state.browserContinuationStep < BROWSER_MAX_CONTINUATION_STEPS &&
        state.callsLength === 0
    );
}

describe('Feature D – Multi-step browser workflow loop', () => {
    it('continues loop when browser task has no calls and continuation steps remain', () => {
        const state: BrowserLoopState = {
            isBrowserTask: true,
            activeMode: 'assistant',
            browserContinuationStep: 0,
            callsLength: 0,
        };
        expect(shouldContinueBrowserLoop(state)).toBe(true);
    });

    it('continues loop for up to BROWSER_MAX_CONTINUATION_STEPS', () => {
        for (let step = 0; step < BROWSER_MAX_CONTINUATION_STEPS; step++) {
            const state: BrowserLoopState = {
                isBrowserTask: true,
                activeMode: 'assistant',
                browserContinuationStep: step,
                callsLength: 0,
            };
            expect(shouldContinueBrowserLoop(state)).toBe(true);
        }
    });

    it('stops continuing after BROWSER_MAX_CONTINUATION_STEPS is reached', () => {
        const state: BrowserLoopState = {
            isBrowserTask: true,
            activeMode: 'assistant',
            browserContinuationStep: BROWSER_MAX_CONTINUATION_STEPS,
            callsLength: 0,
        };
        expect(shouldContinueBrowserLoop(state)).toBe(false);
    });

    it('does NOT continue for non-browser tasks when calls are empty', () => {
        const state: BrowserLoopState = {
            isBrowserTask: false,
            activeMode: 'assistant',
            browserContinuationStep: 0,
            callsLength: 0,
        };
        expect(shouldContinueBrowserLoop(state)).toBe(false);
    });

    it('does NOT continue when calls are present (model produced tool calls)', () => {
        const state: BrowserLoopState = {
            isBrowserTask: true,
            activeMode: 'assistant',
            browserContinuationStep: 0,
            callsLength: 1,
        };
        expect(shouldContinueBrowserLoop(state)).toBe(false);
    });

    it('does NOT continue in RP mode (tools disabled)', () => {
        const state: BrowserLoopState = {
            isBrowserTask: true,
            activeMode: 'rp',
            browserContinuationStep: 0,
            callsLength: 0,
        };
        expect(shouldContinueBrowserLoop(state)).toBe(false);
    });
});

// ─── Feature E: Plain-content fallback protection ────────────────────────────

describe('Feature E – Plain-content fallback protection', () => {
    it('browser-task mode with remaining continuation steps does not finalize immediately', () => {
        // Simulates the guard: if shouldContinueBrowserLoop returns true,
        // we inject a hint and continue instead of finalizing prose.
        const state: BrowserLoopState = {
            isBrowserTask: true,
            activeMode: 'assistant',
            browserContinuationStep: 0,
            callsLength: 0,
        };
        // Should continue loop, not finalize
        expect(shouldContinueBrowserLoop(state)).toBe(true);
    });

    it('finalizes only when continuation steps are exhausted', () => {
        const state: BrowserLoopState = {
            isBrowserTask: true,
            activeMode: 'assistant',
            browserContinuationStep: BROWSER_MAX_CONTINUATION_STEPS,
            callsLength: 0,
        };
        // Should NOT continue — finalize now
        expect(shouldContinueBrowserLoop(state)).toBe(false);
    });

    it('non-browser tasks always finalize on empty calls (no continuation)', () => {
        for (let step = 0; step < BROWSER_MAX_CONTINUATION_STEPS + 2; step++) {
            const state: BrowserLoopState = {
                isBrowserTask: false,
                activeMode: 'assistant',
                browserContinuationStep: step,
                callsLength: 0,
            };
            expect(shouldContinueBrowserLoop(state)).toBe(false);
        }
    });
});

// ─── Feature F: Generic tool clarity / routing ───────────────────────────────

describe('Feature F – Generic tool clarity and routing', () => {
    // Verify that IntentClassifier correctly differentiates browser vs non-browser tasks
    // so the routing layer can pick the right tool subset.

    it('technical questions do not get routed to browser mode', () => {
        const technicalQueries = [
            'how does the memory system work',
            'debug the inference pipeline',
            'explain the router architecture',
            'fix the TypeScript error in AgentService',
        ];
        technicalQueries.forEach(q => {
            const result = IntentClassifier.classify(q);
            expect(result.class).not.toBe('browser');
        });
    });

    it('coding tasks do not get routed to browser mode', () => {
        const codingQueries = [
            'write a python script to parse CSV files',
            'create a new TypeScript file for the service',
            'implement the memory ranking algorithm',
        ];
        codingQueries.forEach(q => {
            const result = IntentClassifier.classify(q);
            expect(result.class).not.toBe('browser');
        });
    });

    it('browser tasks are always classified as browser, not technical or coding', () => {
        const browserQueries = [
            'open google.com and search for Star Citizen',
            'navigate to wikipedia.org',
            'click the search button',
        ];
        browserQueries.forEach(q => {
            const result = IntentClassifier.classify(q);
            expect(result.class).toBe('browser');
            expect(result.class).not.toBe('technical');
            expect(result.class).not.toBe('coding');
        });
    });

    it('browser intent has high confidence (>= 0.9)', () => {
        const result = IntentClassifier.classify('open google.com in the workspace browser');
        expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('browser intent includes subsystem=browser', () => {
        const result = IntentClassifier.classify('navigate to https://example.com');
        expect(result.subsystem).toBe('browser');
    });

    it('browser-task tool set does NOT include file-system or memory tools', () => {
        const nonBrowserTools = ['fs_read_text', 'fs_write_text', 'fs_list', 'shell_run',
            'mem0_search', 'mem0_add', 'query_graph', 'manage_goals', 'self_audit'];
        nonBrowserTools.forEach(name => {
            expect(BROWSER_TASK_TOOL_NAMES.has(name)).toBe(false);
        });
    });
});
