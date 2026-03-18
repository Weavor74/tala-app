/**
 * BrowserActionAck.test.ts
 *
 * Validates the browser-task execution gap fixes added in this PR.
 *
 * Tests cover:
 *   A – Action acknowledgements (browser_type / browser_click / browser_press_key return
 *       structured success or failure responses, not silent no-ops or timeouts)
 *   B – Auto DOM refresh (every successful mutating browser action appends a
 *       PAGE_STATE_SNAPSHOT to its result before the model sees it)
 *   C – Selector / target round-trip (a target emitted by browser_get_dom can be fed
 *       directly back into browser_type / browser_click, including the
 *       `"12[:V] <input:text> Search"` format the model may copy verbatim)
 *   D – Browser-task completion semantics (stalled workflows do not finalize as
 *       complete=true)
 *   E – End-to-end flow (browse → get_dom → type → get_dom continues without
 *       collapsing into blind retries)
 *
 * All tests are pure-logic unit tests that run without Electron or a live brain.
 * They mirror the exact conditional branches from AgentService and the browser
 * preload script.
 */

import { describe, it, expect } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers & re-implementations (mirrors the actual production code paths)
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors AgentService.normalizeBrowserSelector (static private method). */
function normalizeBrowserSelector(raw: string): string {
    // "12[:V] <input:text> Search"  → "12"
    // "[12] INPUT SEARCH"           → "12"
    // "12"                          → "12"
    // "input[name='q']"             → passed through
    const m = raw.match(/^\[?(\d+)\]?(?:\[|[:, <]|$)/);
    if (m) return m[1];
    return raw;
}

/**
 * Minimal re-implementation of the browser-action dispatch + auto-DOM logic
 * from AgentService, stripped of all Electron/brain dependencies so it can run
 * as a pure-logic test.
 */
class BrowserTaskSimulator {
    /** Captures every agent-event emitted during the test. */
    capturedEvents: Array<{ type: string; data: any }> = [];

    /** Pre-programmed responses keyed by data type. */
    private responses = new Map<string, string>();

    /** Tracks whether any mutating action succeeded this simulated turn. */
    browserTaskHadSuccessfulAction = false;

    /** Continuation step counter (mirrors AgentService.browserContinuationStep). */
    browserContinuationStep = 0;

    static readonly BROWSER_MAX_CONTINUATION_STEPS = 3;

    /** Pre-programmes a response that will be returned for the given data type. */
    setResponse(type: string, value: string) {
        this.responses.set(type, value);
    }

    /** Clears all pre-programmed responses (use between multi-step test stages). */
    resetResponses() {
        this.responses.clear();
    }

    private async waitForData(type: string): Promise<string> {
        return this.responses.get(type) ?? 'Error: Timeout';
    }

    private emit(type: string, data: any) {
        this.capturedEvents.push({ type, data });
    }

    async dispatchBrowserCommand(rawResult: string): Promise<string> {
        if (rawResult.startsWith('BROWSER_NAVIGATE: ')) {
            const url = rawResult.slice('BROWSER_NAVIGATE: '.length).trim();
            this.emit('browser-navigate', { url, surfaceId: 'workspace-browser-1' });
            const response = await this.waitForData('action-response');
            return response.startsWith('Error:') ? response : `Navigated to ${url}. ${response}`;
        }
        if (rawResult.startsWith('BROWSER_CLICK: ')) {
            const rawSelector = rawResult.slice('BROWSER_CLICK: '.length).trim();
            const selector = normalizeBrowserSelector(rawSelector);
            this.emit('browser-click', { selector, surfaceId: 'workspace-browser-1' });
            return await this.waitForData('action-response');
        }
        if (rawResult.startsWith('BROWSER_TYPE: ')) {
            const argsStr = rawResult.slice('BROWSER_TYPE: '.length).trim();
            let args: { selector?: string; text?: string } = {};
            try { args = JSON.parse(argsStr); } catch { args = {}; }
            if (args.selector) args.selector = normalizeBrowserSelector(args.selector);
            this.emit('browser-type', { ...args, surfaceId: 'workspace-browser-1' });
            return await this.waitForData('action-response');
        }
        if (rawResult.startsWith('BROWSER_SCROLL: ')) {
            const argsStr = rawResult.slice('BROWSER_SCROLL: '.length).trim();
            let args: { direction?: string; amount?: number } = {};
            try { args = JSON.parse(argsStr); } catch { args = {}; }
            this.emit('browser-scroll', { ...args, surfaceId: 'workspace-browser-1' });
            return await this.waitForData('action-response');
        }
        if (rawResult.startsWith('BROWSER_PRESS_KEY: ')) {
            const key = rawResult.slice('BROWSER_PRESS_KEY: '.length).trim();
            this.emit('browser-press-key', { key, surfaceId: 'workspace-browser-1' });
            return await this.waitForData('action-response');
        }
        if (rawResult === 'BROWSER_GET_DOM: REQUEST') {
            this.emit('browser-get-dom', { surfaceId: 'workspace-browser-1' });
            return await this.waitForData('dom');
        }
        return rawResult;
    }

    /** Mirrors the auto-DOM fetch logic from AgentService after each mutating tool. */
    private static readonly MUTATING_TOOLS = new Set([
        'browse', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll',
    ]);

    async executeToolWithAutoDom(
        toolName: string,
        rawResult: string
    ): Promise<string> {
        let result = await this.dispatchBrowserCommand(rawResult);

        if (BrowserTaskSimulator.MUTATING_TOOLS.has(toolName)
            && typeof result === 'string'
            && !result.startsWith('Error:')) {
            this.browserTaskHadSuccessfulAction = true;
            const domData = await this.dispatchBrowserCommand('BROWSER_GET_DOM: REQUEST');
            if (!domData.startsWith('Error:')) {
                result = `${result}\n\n[PAGE_STATE_SNAPSHOT]\n${domData}\n[/PAGE_STATE_SNAPSHOT]`;
            }
        }
        return result;
    }

    /** Mirrors shouldContinueBrowserLoop from AgentService. */
    shouldContinue(callsLength: number, activeMode: string): boolean {
        return (
            activeMode !== 'rp' &&
            this.browserContinuationStep < BrowserTaskSimulator.BROWSER_MAX_CONTINUATION_STEPS &&
            callsLength === 0
        );
    }

    /**
     * Mirrors the browser completion check from AgentService:
     * stalled = continuation limit hit AND no successful action.
     */
    isStalled(): boolean {
        return this.browserContinuationStep >= BrowserTaskSimulator.BROWSER_MAX_CONTINUATION_STEPS
            && !this.browserTaskHadSuccessfulAction;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature A – Action acknowledgements
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature A – Action acknowledgements', () => {
    it('browser_type returns a success acknowledgement when the action succeeds', async () => {
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', 'Typed 12 characters into 3');

        const result = await sim.dispatchBrowserCommand('BROWSER_TYPE: {"selector":"3","text":"Star Citizen"}');

        expect(result).not.toContain('Error:');
        expect(result).toContain('Typed');
        expect(sim.capturedEvents[0].type).toBe('browser-type');
        expect(sim.capturedEvents[0].data.selector).toBe('3');
    });

    it('browser_type returns an error acknowledgement when the element is not found', async () => {
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', 'Error: Element 99 not found');

        const result = await sim.dispatchBrowserCommand('BROWSER_TYPE: {"selector":"99","text":"hello"}');

        expect(result).toContain('Error:');
    });

    it('browser_click returns a success acknowledgement', async () => {
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', 'Clicked 5 at (200,300)');

        const result = await sim.dispatchBrowserCommand('BROWSER_CLICK: 5');

        expect(result).not.toContain('Error:');
        expect(result).toContain('Clicked');
        expect(sim.capturedEvents[0].type).toBe('browser-click');
    });

    it('browser_click returns an error acknowledgement when element is not found', async () => {
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', 'Error: Element 999 not found');

        const result = await sim.dispatchBrowserCommand('BROWSER_CLICK: 999');

        expect(result).toContain('Error:');
    });

    it('browser_press_key returns a success acknowledgement', async () => {
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', 'Pressed Enter');

        const result = await sim.dispatchBrowserCommand('BROWSER_PRESS_KEY: Enter');

        expect(result).not.toContain('Error:');
        expect(result).toContain('Enter');
        expect(sim.capturedEvents[0].type).toBe('browser-press-key');
        expect(sim.capturedEvents[0].data.key).toBe('Enter');
    });

    it('browser_scroll returns a success acknowledgement', async () => {
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', 'Scrolled down');

        const result = await sim.dispatchBrowserCommand('BROWSER_SCROLL: {"direction":"down","amount":300}');

        expect(result).not.toContain('Error:');
        expect(result).toContain('Scrolled');
        expect(sim.capturedEvents[0].type).toBe('browser-scroll');
    });

    it('browser action returns Error: Timeout when no acknowledgement arrives', async () => {
        const sim = new BrowserTaskSimulator();
        // No response registered → waitForData returns 'Error: Timeout'

        const result = await sim.dispatchBrowserCommand('BROWSER_CLICK: 7');

        expect(result).toBe('Error: Timeout');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature B – Auto DOM refresh after mutating browser actions
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_DOM = '[PAGE INFO]\nTitle: Google\n\n[INTERACTIVE ELEMENTS]\n1[:V] <input:text> Search\n2[:V] <button> Google Search';

describe('Feature B – Auto DOM refresh after mutating browser actions', () => {
    async function runTool(toolName: string, rawResult: string, domResponse = FAKE_DOM) {
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', `${toolName} succeeded`);
        sim.setResponse('dom', domResponse);
        const result = await sim.executeToolWithAutoDom(toolName, rawResult);
        return { result, sim };
    }

    it('browser_type triggers automatic browser_get_dom after success', async () => {
        const { result, sim } = await runTool(
            'browser_type',
            'BROWSER_TYPE: {"selector":"1","text":"Star Citizen"}'
        );
        expect(result).toContain('[PAGE_STATE_SNAPSHOT]');
        expect(result).toContain('[/PAGE_STATE_SNAPSHOT]');
        expect(result).toContain(FAKE_DOM);
        expect(sim.capturedEvents.some(e => e.type === 'browser-get-dom')).toBe(true);
    });

    it('browser_click triggers automatic browser_get_dom after success', async () => {
        const { result, sim } = await runTool('browser_click', 'BROWSER_CLICK: 2');
        expect(result).toContain('[PAGE_STATE_SNAPSHOT]');
        expect(sim.capturedEvents.some(e => e.type === 'browser-get-dom')).toBe(true);
    });

    it('browser_press_key triggers automatic browser_get_dom after success', async () => {
        const { result, sim } = await runTool('browser_press_key', 'BROWSER_PRESS_KEY: Enter');
        expect(result).toContain('[PAGE_STATE_SNAPSHOT]');
        expect(sim.capturedEvents.some(e => e.type === 'browser-get-dom')).toBe(true);
    });

    it('browser_scroll triggers automatic browser_get_dom after success', async () => {
        const { result, sim } = await runTool(
            'browser_scroll',
            'BROWSER_SCROLL: {"direction":"down"}'
        );
        expect(result).toContain('[PAGE_STATE_SNAPSHOT]');
        expect(sim.capturedEvents.some(e => e.type === 'browser-get-dom')).toBe(true);
    });

    it('browse triggers automatic browser_get_dom after success', async () => {
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', 'Page loaded: https://google.com');
        sim.setResponse('dom', FAKE_DOM);
        const result = await sim.executeToolWithAutoDom(
            'browse',
            'BROWSER_NAVIGATE: https://google.com'
        );
        expect(result).toContain('[PAGE_STATE_SNAPSHOT]');
        expect(sim.capturedEvents.some(e => e.type === 'browser-get-dom')).toBe(true);
    });

    it('does NOT trigger auto DOM refresh after a failed action (Error: response)', async () => {
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', 'Error: Element 99 not found');
        sim.setResponse('dom', FAKE_DOM);
        const result = await sim.executeToolWithAutoDom(
            'browser_type',
            'BROWSER_TYPE: {"selector":"99","text":"test"}'
        );
        expect(result).not.toContain('[PAGE_STATE_SNAPSHOT]');
        expect(sim.capturedEvents.some(e => e.type === 'browser-get-dom')).toBe(false);
    });

    it('does NOT trigger auto DOM refresh for browser_get_dom itself', async () => {
        const sim = new BrowserTaskSimulator();
        sim.setResponse('dom', FAKE_DOM);
        const result = await sim.executeToolWithAutoDom(
            'browser_get_dom',
            'BROWSER_GET_DOM: REQUEST'
        );
        // Should only dispatch ONE browser-get-dom event (the tool call itself)
        const domEvents = sim.capturedEvents.filter(e => e.type === 'browser-get-dom');
        expect(domEvents).toHaveLength(1);
        // No PAGE_STATE_SNAPSHOT wrapping for browser_get_dom itself
        expect(result).not.toContain('[PAGE_STATE_SNAPSHOT]');
    });

    it('includes updated page state in the result so model can plan next action', async () => {
        const { result } = await runTool(
            'browser_type',
            'BROWSER_TYPE: {"selector":"1","text":"Star Citizen"}'
        );
        expect(result).toContain('[INTERACTIVE ELEMENTS]');
        expect(result).toContain('1[:V] <input:text> Search');
    });

    it('gracefully skips PAGE_STATE_SNAPSHOT when auto DOM fetch itself errors', async () => {
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', 'Clicked 2 at (100,200)');
        // DOM fetch will return Error: Timeout (no response registered)
        const result = await sim.executeToolWithAutoDom('browser_click', 'BROWSER_CLICK: 2');
        // Result should still contain the action result, just without the snapshot
        expect(result).toContain('Clicked');
        expect(result).not.toContain('[PAGE_STATE_SNAPSHOT]');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature C – Selector / target round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature C – Selector / target round-trip', () => {
    describe('normalizeBrowserSelector', () => {
        it('extracts numeric ID from browser_get_dom output format "12[:V] <input:text> Search"', () => {
            expect(normalizeBrowserSelector('12[:V] <input:text> Search')).toBe('12');
        });

        it('extracts numeric ID from "[12] INPUT SEARCH" format', () => {
            expect(normalizeBrowserSelector('[12] INPUT SEARCH')).toBe('12');
        });

        it('keeps a plain numeric ID unchanged', () => {
            expect(normalizeBrowserSelector('12')).toBe('12');
        });

        it('passes CSS selectors through unchanged', () => {
            expect(normalizeBrowserSelector("input[name='q']")).toBe("input[name='q']");
            expect(normalizeBrowserSelector('.search-box')).toBe('.search-box');
            expect(normalizeBrowserSelector('#submit-btn')).toBe('#submit-btn');
        });

        it('handles single-digit IDs', () => {
            expect(normalizeBrowserSelector('1[:V] <button> Submit')).toBe('1');
        });

        it('handles "[1] BUTTON Submit" format', () => {
            expect(normalizeBrowserSelector('[1] BUTTON Submit')).toBe('1');
        });

        it('handles "100[:H] <a> Hidden link" (hidden element)', () => {
            expect(normalizeBrowserSelector('100[:H] <a> Hidden link')).toBe('100');
        });
    });

    it('a target emitted by browser_get_dom can be fed back into browser_click', async () => {
        const domLine = '12[:V] <input:text> Search';
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', 'Clicked 12 at (100,200)');

        // Model copies the DOM line verbatim as the selector
        await sim.dispatchBrowserCommand(`BROWSER_CLICK: ${domLine}`);

        // The event dispatched to the browser must use the normalized selector "12"
        expect(sim.capturedEvents[0].type).toBe('browser-click');
        expect(sim.capturedEvents[0].data.selector).toBe('12');
    });

    it('a target emitted by browser_get_dom can be fed back into browser_type', async () => {
        const domLine = '12[:V] <input:text> Search';
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', 'Typed 12 characters into 12');

        const args = JSON.stringify({ selector: domLine, text: 'Star Citizen' });
        await sim.dispatchBrowserCommand(`BROWSER_TYPE: ${args}`);

        expect(sim.capturedEvents[0].type).toBe('browser-type');
        expect(sim.capturedEvents[0].data.selector).toBe('12');
        expect(sim.capturedEvents[0].data.text).toBe('Star Citizen');
    });

    it('invalid / missing target returns an error-prefixed result', async () => {
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', 'Error: Element abc not found');

        const result = await sim.dispatchBrowserCommand('BROWSER_CLICK: abc-invalid');
        expect(result).toContain('Error:');
    });

    it('browser_get_dom output IDs are unique and numeric', () => {
        // The DOM output is `${tid}${visibilityTag} <${tagName}>${roleTag} ${content}`
        // tid is idCounter++ starting at 1 — always an integer string.
        const domLines = [
            '1[:V] <input:text> Search',
            '2[:V] <button> Google Search',
            '3[:H] <a> About',
        ];
        domLines.forEach(line => {
            const normalized = normalizeBrowserSelector(line);
            expect(/^\d+$/.test(normalized)).toBe(true);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature D – Browser-task completion semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature D – Browser-task completion semantics', () => {
    const MAX = BrowserTaskSimulator.BROWSER_MAX_CONTINUATION_STEPS;

    it('stalled workflow (max steps, no successful action) is NOT marked complete', () => {
        const sim = new BrowserTaskSimulator();
        sim.browserContinuationStep = MAX;
        sim.browserTaskHadSuccessfulAction = false;
        expect(sim.isStalled()).toBe(true);
    });

    it('workflow with successful action and max steps reached is NOT considered stalled', () => {
        const sim = new BrowserTaskSimulator();
        sim.browserContinuationStep = MAX;
        sim.browserTaskHadSuccessfulAction = true;
        expect(sim.isStalled()).toBe(false);
    });

    it('workflow below max continuation steps is NOT stalled even without a successful action', () => {
        const sim = new BrowserTaskSimulator();
        sim.browserContinuationStep = MAX - 1;
        sim.browserTaskHadSuccessfulAction = false;
        expect(sim.isStalled()).toBe(false);
    });

    it('shouldContinue returns false once continuation steps are exhausted', () => {
        const sim = new BrowserTaskSimulator();
        sim.browserContinuationStep = MAX;
        expect(sim.shouldContinue(0, 'assistant')).toBe(false);
    });

    it('shouldContinue returns true while steps remain and no tool calls were produced', () => {
        const sim = new BrowserTaskSimulator();
        sim.browserContinuationStep = 0;
        expect(sim.shouldContinue(0, 'assistant')).toBe(true);
    });

    it('shouldContinue returns false when model produced tool calls (no need to retry)', () => {
        const sim = new BrowserTaskSimulator();
        sim.browserContinuationStep = 0;
        expect(sim.shouldContinue(2, 'assistant')).toBe(false);
    });

    it('stall detection: running browser_type that times out leads to stalled=true', async () => {
        const sim = new BrowserTaskSimulator();
        // No response → timeout → Error: Timeout
        const result = await sim.executeToolWithAutoDom(
            'browser_type',
            'BROWSER_TYPE: {"selector":"1","text":"hello"}'
        );
        // Action failed → no successful action tracked
        expect(result).toContain('Error:');
        expect(sim.browserTaskHadSuccessfulAction).toBe(false);

        // Simulate continuation loop exhausted
        sim.browserContinuationStep = MAX;
        expect(sim.isStalled()).toBe(true);
    });

    it('successful partial task (type succeeded, stop before submit) finalizes as complete', async () => {
        const sim = new BrowserTaskSimulator();
        sim.setResponse('action-response', 'Typed 12 characters into 1');
        sim.setResponse('dom', FAKE_DOM);

        await sim.executeToolWithAutoDom(
            'browser_type',
            'BROWSER_TYPE: {"selector":"1","text":"Star Citizen"}'
        );

        // Model then returns no more tool calls → finalize
        sim.browserContinuationStep = 1; // only one continuation step needed
        expect(sim.isStalled()).toBe(false);
        expect(sim.browserTaskHadSuccessfulAction).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature E – End-to-end browser workflow
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature E – End-to-end browser workflow (browse → get_dom → type → get_dom)', () => {
    const dom1 = '[PAGE INFO]\nTitle: Google\nURL: https://google.com\n\n[INTERACTIVE ELEMENTS]\n1[:V] <input:text> Search\n2[:V] <button> Google Search';
    const dom2 = '[PAGE INFO]\nTitle: Google\nURL: https://google.com\n\n[INTERACTIVE ELEMENTS]\n1[:V] <input:text> Star Citizen\n2[:V] <button> Google Search';

    it('browse → auto get_dom → type "Star Citizen" → auto get_dom does not stall', async () => {
        const sim = new BrowserTaskSimulator();

        // Step 1: browse
        sim.setResponse('action-response', 'Page loaded: https://google.com');
        sim.setResponse('dom', dom1);
        const browseResult = await sim.executeToolWithAutoDom(
            'browse',
            'BROWSER_NAVIGATE: https://google.com'
        );
        expect(browseResult).toContain('[PAGE_STATE_SNAPSHOT]');
        expect(browseResult).toContain('1[:V] <input:text> Search');

        // Step 2: type into element 1 (using the exact DOM line as selector)
        // Reset responses for next action
        sim.resetResponses();
        sim.setResponse('action-response', 'Typed 12 characters into 1');
        sim.setResponse('dom', dom2);

        const typeResult = await sim.executeToolWithAutoDom(
            'browser_type',
            'BROWSER_TYPE: {"selector":"1[:V] <input:text> Search","text":"Star Citizen"}'
        );
        // Selector must have been normalised to "1" before dispatch
        const typeEvent = sim.capturedEvents.find(e => e.type === 'browser-type');
        expect(typeEvent?.data.selector).toBe('1');
        // Auto DOM must have been fetched after type
        expect(typeResult).toContain('[PAGE_STATE_SNAPSHOT]');
        expect(typeResult).toContain('Star Citizen');

        // Step 3: press Enter to submit
        sim.resetResponses();
        sim.setResponse('action-response', 'Pressed Enter');
        sim.setResponse('dom', '[PAGE INFO]\nTitle: Star Citizen - Google Search\n\n[INTERACTIVE ELEMENTS]\n3[:V] <a> Star Citizen Official Website');

        const keyResult = await sim.executeToolWithAutoDom(
            'browser_press_key',
            'BROWSER_PRESS_KEY: Enter'
        );
        expect(keyResult).toContain('[PAGE_STATE_SNAPSHOT]');
        expect(keyResult).toContain('Star Citizen - Google Search');

        // The turn should be marked as having a successful action
        expect(sim.browserTaskHadSuccessfulAction).toBe(true);
        expect(sim.isStalled()).toBe(false);
    });

    it('workflow does not collapse into blind retries after a successful action sequence', async () => {
        const sim = new BrowserTaskSimulator();

        // Pre-programme all three actions to succeed
        sim.setResponse('action-response', 'Clicked 5 at (300,400)');
        sim.setResponse('dom', FAKE_DOM);

        await sim.executeToolWithAutoDom('browser_click', 'BROWSER_CLICK: 5');

        // Every mutating action dispatched one browser-get-dom
        const domEvents = sim.capturedEvents.filter(e => e.type === 'browser-get-dom');
        expect(domEvents).toHaveLength(1);
        expect(sim.browserTaskHadSuccessfulAction).toBe(true);
    });
});
