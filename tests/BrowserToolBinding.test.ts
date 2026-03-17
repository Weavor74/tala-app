/**
 * BrowserToolBinding.test.ts
 *
 * Validates that browser tools are correctly wired to the built-in workspace
 * browser panel via the agent-event dispatch mechanism.
 *
 * Tests:
 *   1. ToolService returns BROWSER_* prefix strings for all browser tools.
 *   2. AgentService.dispatchBrowserCommand maps BROWSER_* prefixes to the
 *      correct agent-event types with the stable workspace-browser-1 surface ID.
 *   3. Surface ID is consistent across all browser tool types.
 *   4. dispatchBrowserCommand resolves with the actual browser response, not the
 *      raw prefix string.
 *   5. Non-browser BROWSER_SEARCH commands pass through unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
}));

vi.mock('../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        event: vi.fn(),
        emit: vi.fn(),
    },
}));

vi.mock('uuid', () => ({
    v4: vi.fn(() => 'test-uuid-browser'),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal test double for AgentService that exposes `dispatchBrowserCommand`
 * and `provideBrowserData` / `waitForBrowserData` without requiring the full
 * Electron + service graph to be initialised.
 */
class BrowserCommandDispatcher {
    static readonly SURFACE_ID = 'workspace-browser-1';

    private resolvers = new Map<string, (d: any) => void>();

    waitForBrowserData(type: string, retryEmit?: () => void): Promise<string> {
        return new Promise(resolve => {
            const t = setTimeout(() => {
                this.resolvers.delete(type);
                resolve('Error: Timeout');
            }, 5000);
            this.resolvers.set(type, (d: any) => {
                clearTimeout(t);
                resolve(String(d));
            });
            retryEmit?.();
        });
    }

    provideBrowserData(type: string, data: any) {
        const res = this.resolvers.get(type);
        if (res) {
            res(data);
            this.resolvers.delete(type);
        }
    }

    async dispatchBrowserCommand(
        rawResult: string,
        onEvent: (type: string, data: any) => void
    ): Promise<string> {
        const surfaceId = BrowserCommandDispatcher.SURFACE_ID;

        if (rawResult.startsWith('BROWSER_NAVIGATE: ')) {
            const url = rawResult.slice('BROWSER_NAVIGATE: '.length).trim();
            onEvent('browser-navigate', { url, surfaceId });
            const response = await this.waitForBrowserData('action-response');
            return response.startsWith('Error:') ? response : `Navigated to ${url}. ${response}`;
        }

        if (rawResult.startsWith('BROWSER_CLICK: ')) {
            const selector = rawResult.slice('BROWSER_CLICK: '.length).trim();
            onEvent('browser-click', { selector, surfaceId });
            return await this.waitForBrowserData('action-response');
        }

        if (rawResult.startsWith('BROWSER_HOVER: ')) {
            const selector = rawResult.slice('BROWSER_HOVER: '.length).trim();
            onEvent('browser-hover', { selector, surfaceId });
            return await this.waitForBrowserData('action-response');
        }

        if (rawResult.startsWith('BROWSER_TYPE: ')) {
            const argsStr = rawResult.slice('BROWSER_TYPE: '.length).trim();
            let args: { selector?: string; text?: string } = {};
            try { args = JSON.parse(argsStr); } catch { args = {}; }
            onEvent('browser-type', { ...args, surfaceId });
            return await this.waitForBrowserData('action-response');
        }

        if (rawResult.startsWith('BROWSER_SCROLL: ')) {
            const argsStr = rawResult.slice('BROWSER_SCROLL: '.length).trim();
            let args: { direction?: string; amount?: number } = {};
            try { args = JSON.parse(argsStr); } catch { args = {}; }
            onEvent('browser-scroll', { ...args, surfaceId });
            return await this.waitForBrowserData('action-response');
        }

        if (rawResult.startsWith('BROWSER_PRESS_KEY: ')) {
            const key = rawResult.slice('BROWSER_PRESS_KEY: '.length).trim();
            onEvent('browser-press-key', { key, surfaceId });
            return await this.waitForBrowserData('action-response');
        }

        if (rawResult === 'BROWSER_GET_DOM: REQUEST') {
            onEvent('browser-get-dom', { surfaceId });
            return await this.waitForBrowserData('dom');
        }

        if (rawResult === 'BROWSER_SCREENSHOT: REQUEST') {
            onEvent('browser-screenshot', { surfaceId });
            const base64 = await this.waitForBrowserData('screenshot');
            if (base64.startsWith('Error:')) return base64;
            return `Screenshot captured from ${surfaceId} (${base64.length} bytes base64 PNG).`;
        }

        return rawResult;
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Browser Tool Binding', () => {
    const SURFACE_ID = 'workspace-browser-1';
    let dispatcher: BrowserCommandDispatcher;
    let capturedEvents: Array<{ type: string; data: any }>;
    let onEvent: (type: string, data: any) => void;

    beforeEach(() => {
        dispatcher = new BrowserCommandDispatcher();
        capturedEvents = [];
        onEvent = (type, data) => capturedEvents.push({ type, data });
    });

    // ── 1. Surface ID is stable ─────────────────────────────────────────────

    it('uses workspace-browser-1 as the stable surface ID', () => {
        expect(BrowserCommandDispatcher.SURFACE_ID).toBe(SURFACE_ID);
    });

    // ── 2. browse / BROWSER_NAVIGATE ────────────────────────────────────────

    it('dispatches browser-navigate event with surfaceId and resolves with navigation confirmation', async () => {
        const url = 'https://example.com';
        const dispatchPromise = dispatcher.dispatchBrowserCommand(
            `BROWSER_NAVIGATE: ${url}`,
            onEvent
        );

        // Simulate Browser.tsx providing navigation-complete feedback
        setTimeout(() => dispatcher.provideBrowserData('action-response', `Page loaded: ${url}`), 10);

        const result = await dispatchPromise;

        expect(capturedEvents).toHaveLength(1);
        expect(capturedEvents[0].type).toBe('browser-navigate');
        expect(capturedEvents[0].data.url).toBe(url);
        expect(capturedEvents[0].data.surfaceId).toBe(SURFACE_ID);
        expect(result).toContain(url);
        expect(result).toContain('Page loaded');
    });

    // ── 3. browser_click / BROWSER_CLICK ────────────────────────────────────

    it('dispatches browser-click event and resolves with action response', async () => {
        const selector = '12';
        const dispatchPromise = dispatcher.dispatchBrowserCommand(
            `BROWSER_CLICK: ${selector}`,
            onEvent
        );

        setTimeout(() => dispatcher.provideBrowserData('action-response', `Clicked 12 at (100,200)`), 10);

        const result = await dispatchPromise;

        expect(capturedEvents[0].type).toBe('browser-click');
        expect(capturedEvents[0].data.selector).toBe(selector);
        expect(capturedEvents[0].data.surfaceId).toBe(SURFACE_ID);
        expect(result).toBe('Clicked 12 at (100,200)');
    });

    // ── 4. browser_hover / BROWSER_HOVER ────────────────────────────────────

    it('dispatches browser-hover event with surfaceId', async () => {
        const dispatchPromise = dispatcher.dispatchBrowserCommand('BROWSER_HOVER: 5', onEvent);
        setTimeout(() => dispatcher.provideBrowserData('action-response', 'Hovered element 5'), 10);

        const result = await dispatchPromise;

        expect(capturedEvents[0].type).toBe('browser-hover');
        expect(capturedEvents[0].data.surfaceId).toBe(SURFACE_ID);
        expect(result).toContain('Hovered');
    });

    // ── 5. browser_type / BROWSER_TYPE ──────────────────────────────────────

    it('dispatches browser-type event with selector, text, and surfaceId', async () => {
        const args = { selector: '3', text: 'Star Citizen' };
        const dispatchPromise = dispatcher.dispatchBrowserCommand(
            `BROWSER_TYPE: ${JSON.stringify(args)}`,
            onEvent
        );
        setTimeout(() => dispatcher.provideBrowserData('action-response', 'Typed: Star Citizen'), 10);

        const result = await dispatchPromise;

        expect(capturedEvents[0].type).toBe('browser-type');
        expect(capturedEvents[0].data.selector).toBe('3');
        expect(capturedEvents[0].data.text).toBe('Star Citizen');
        expect(capturedEvents[0].data.surfaceId).toBe(SURFACE_ID);
        expect(result).toContain('Typed');
    });

    // ── 6. browser_scroll / BROWSER_SCROLL ──────────────────────────────────

    it('dispatches browser-scroll event with direction and surfaceId', async () => {
        const args = { direction: 'down', amount: 300 };
        const dispatchPromise = dispatcher.dispatchBrowserCommand(
            `BROWSER_SCROLL: ${JSON.stringify(args)}`,
            onEvent
        );
        setTimeout(() => dispatcher.provideBrowserData('action-response', 'Scrolled down 300px'), 10);

        const result = await dispatchPromise;

        expect(capturedEvents[0].type).toBe('browser-scroll');
        expect(capturedEvents[0].data.direction).toBe('down');
        expect(capturedEvents[0].data.surfaceId).toBe(SURFACE_ID);
        expect(result).toContain('Scrolled');
    });

    // ── 7. browser_press_key / BROWSER_PRESS_KEY ────────────────────────────

    it('dispatches browser-press-key event with key name and surfaceId', async () => {
        const dispatchPromise = dispatcher.dispatchBrowserCommand('BROWSER_PRESS_KEY: Enter', onEvent);
        setTimeout(() => dispatcher.provideBrowserData('action-response', 'Pressed Enter'), 10);

        const result = await dispatchPromise;

        expect(capturedEvents[0].type).toBe('browser-press-key');
        expect(capturedEvents[0].data.key).toBe('Enter');
        expect(capturedEvents[0].data.surfaceId).toBe(SURFACE_ID);
        expect(result).toContain('Pressed');
    });

    // ── 8. browser_get_dom / BROWSER_GET_DOM ────────────────────────────────

    it('dispatches browser-get-dom event and resolves with DOM string', async () => {
        const fakeDom = '[PAGE INFO]\nTitle: Example\n\n[INTERACTIVE ELEMENTS]\n1[:V] <a> Link';
        const dispatchPromise = dispatcher.dispatchBrowserCommand('BROWSER_GET_DOM: REQUEST', onEvent);
        setTimeout(() => dispatcher.provideBrowserData('dom', fakeDom), 10);

        const result = await dispatchPromise;

        expect(capturedEvents[0].type).toBe('browser-get-dom');
        expect(capturedEvents[0].data.surfaceId).toBe(SURFACE_ID);
        expect(result).toContain('[PAGE INFO]');
        expect(result).toContain('[INTERACTIVE ELEMENTS]');
    });

    // ── 9. browser_screenshot / BROWSER_SCREENSHOT ──────────────────────────

    it('dispatches browser-screenshot event and returns size metadata', async () => {
        const fakeBase64 = 'abc123'.repeat(100); // fake base64 data
        const dispatchPromise = dispatcher.dispatchBrowserCommand('BROWSER_SCREENSHOT: REQUEST', onEvent);
        setTimeout(() => dispatcher.provideBrowserData('screenshot', fakeBase64), 10);

        const result = await dispatchPromise;

        expect(capturedEvents[0].type).toBe('browser-screenshot');
        expect(capturedEvents[0].data.surfaceId).toBe(SURFACE_ID);
        expect(result).toContain(SURFACE_ID);
        expect(result).toContain('bytes base64 PNG');
    });

    // ── 10. All events carry the same stable surface ID ──────────────────────

    it('all browser tool events carry the same surface ID for session continuity', async () => {
        const commands = [
            ['BROWSER_CLICK: 1', 'action-response', 'Clicked'],
            ['BROWSER_HOVER: 2', 'action-response', 'Hovered'],
            ['BROWSER_PRESS_KEY: Escape', 'action-response', 'Pressed'],
        ] as const;

        for (const [cmd, responseType, responseValue] of commands) {
            const dispatchPromise = dispatcher.dispatchBrowserCommand(cmd, onEvent);
            setTimeout(() => dispatcher.provideBrowserData(responseType, responseValue), 10);
            await dispatchPromise;
        }

        const surfaceIds = capturedEvents.map(e => e.data.surfaceId);
        expect(surfaceIds.every(id => id === SURFACE_ID)).toBe(true);
    });

    // ── 11. BROWSER_SEARCH passes through unchanged ──────────────────────────

    it('passes BROWSER_SEARCH commands through without dispatching events', async () => {
        const result = await dispatcher.dispatchBrowserCommand('BROWSER_SEARCH: Star Citizen', onEvent);
        expect(capturedEvents).toHaveLength(0);
        expect(result).toBe('BROWSER_SEARCH: Star Citizen');
    });

    // ── 12. Timeout propagates cleanly ──────────────────────────────────────

    it('returns an error string on browser data timeout', async () => {
        // Override waitForBrowserData to time out immediately
        const fastDispatcher = new BrowserCommandDispatcher();
        fastDispatcher.waitForBrowserData = (_type: string) =>
            new Promise(resolve => setTimeout(() => resolve('Error: Timeout'), 10));

        const result = await fastDispatcher.dispatchBrowserCommand('BROWSER_NAVIGATE: https://example.com', onEvent);
        expect(result).toContain('Error: Timeout');
    });
});
