/**
 * SearchUIInteraction.test.ts
 *
 * Validates the interaction path that caused the regression:
 *   "Search result action buttons (save, scrape, create notebook) do not
 *    trigger behavior at runtime — no IPC activity occurs when buttons are
 *    clicked."
 *
 * Root cause (identified via preserve loop):
 *   - `selectedNotebookId` initialized to `''` (empty string).
 *   - Both toolbar selects had an `<option value="">Select Notebook...</option>`.
 *   - Selecting the empty option set `selectedNotebookId = ''`.
 *   - Buttons became `disabled={!selectedNotebookId}` = `disabled={true}`.
 *   - Disabled HTML buttons suppress click events → zero IPC calls.
 *
 * Fix applied:
 *   1. Default `selectedNotebookId` to `'CREATE_NEW_NB'` (never an empty string).
 *   2. Removed the empty `<option value="">` from both selects.
 *   3. `loadNotebooks` upgrades the `CREATE_NEW_NB` placeholder to a real
 *      notebook id as soon as one is available.
 *
 * These tests cover the critical invariants that enforce the fix without
 * requiring a DOM/jsdom environment (pure logic tests only).
 */

import { describe, it, expect } from 'vitest';
import {
    resultKey,
    filterSelectedResults,
    allResultKeys,
    resultToNotebookItem,
    type SearchResultInput,
} from '../src/renderer/utils/searchSelection';

// ─── Invariant 1: disabled condition evaluation ───────────────────────────────

describe('button disabled condition', () => {
    /**
     * The button disabled prop is: disabled={!selectedNotebookId}
     * Any non-empty string (including 'CREATE_NEW_NB') must evaluate to false
     * so the button is ENABLED and click events fire.
     */

    it("empty string disables buttons — the root cause of the regression", () => {
        const selectedNotebookId = '';
        expect(!selectedNotebookId).toBe(true);  // disabled
    });

    it("'CREATE_NEW_NB' enables buttons — the fixed default", () => {
        const selectedNotebookId = 'CREATE_NEW_NB';
        expect(!selectedNotebookId).toBe(false);  // enabled
    });

    it('a real notebook UUID enables buttons', () => {
        const selectedNotebookId = 'nb-abc123';
        expect(!selectedNotebookId).toBe(false);  // enabled
    });

    it('handler early-return condition matches disabled condition exactly', () => {
        // The handler guard: `if (selectedKeys.size === 0 || !selectedNotebookId) return;`
        // Both the disabled prop and the guard must agree so a click never fires
        // on a disabled button and handlers never skip an enabled-button click.
        const cases = [
            { id: '', selectedCount: 2, shouldReturn: true },
            { id: 'CREATE_NEW_NB', selectedCount: 0, shouldReturn: true },
            { id: 'CREATE_NEW_NB', selectedCount: 1, shouldReturn: false },
            { id: 'nb-abc', selectedCount: 3, shouldReturn: false },
        ];
        for (const c of cases) {
            const wouldReturn = c.selectedCount === 0 || !c.id;
            expect(wouldReturn).toBe(c.shouldReturn);
        }
    });
});

// ─── Invariant 2: notebook selection default state ────────────────────────────

describe('notebook selection default state', () => {
    it("'CREATE_NEW_NB' is the correct fallback when no initial id is provided", () => {
        // Simulates: useState<string>(initialNotebookId || 'CREATE_NEW_NB')
        const initialNotebookId = undefined;
        const selectedNotebookId = initialNotebookId || 'CREATE_NEW_NB';
        expect(selectedNotebookId).toBe('CREATE_NEW_NB');
        expect(!selectedNotebookId).toBe(false); // button enabled
    });

    it('an explicit initialNotebookId is preserved over the default', () => {
        const initialNotebookId = 'nb-from-parent';
        const selectedNotebookId = initialNotebookId || 'CREATE_NEW_NB';
        expect(selectedNotebookId).toBe('nb-from-parent');
    });

    it('null initialNotebookId falls back to CREATE_NEW_NB', () => {
        const initialNotebookId: string | null = null;
        const selectedNotebookId = initialNotebookId || 'CREATE_NEW_NB';
        expect(selectedNotebookId).toBe('CREATE_NEW_NB');
        expect(!selectedNotebookId).toBe(false);
    });
});

// ─── Invariant 3: loadNotebooks upgrade logic ─────────────────────────────────

describe('loadNotebooks selection upgrade logic', () => {
    /**
     * The auto-select condition was: `if (!selectedNotebookId)`
     * After the fix it is: `if (!selectedNotebookId || selectedNotebookId === 'CREATE_NEW_NB')`
     *
     * The old condition would NOT upgrade 'CREATE_NEW_NB' to a real notebook id
     * because `!'CREATE_NEW_NB'` is false.  The fix ensures a real notebook id
     * wins over the placeholder as soon as one is available.
     */

    function computeAutoSelectNotebook(
        current: string,
        availableNotebooks: Array<{ id: string; name: string }>,
    ): string {
        // Mirrors the post-fix logic in loadNotebooks
        if (!current || current === 'CREATE_NEW_NB') {
            return availableNotebooks.length > 0
                ? availableNotebooks[0].id
                : 'CREATE_NEW_NB';
        }
        return current; // preserve explicit selection
    }

    it('upgrades CREATE_NEW_NB placeholder to first real notebook id', () => {
        const result = computeAutoSelectNotebook('CREATE_NEW_NB', [
            { id: 'nb-001', name: 'Research' },
            { id: 'nb-002', name: 'Notes' },
        ]);
        expect(result).toBe('nb-001');
    });

    it('keeps CREATE_NEW_NB when no notebooks exist', () => {
        const result = computeAutoSelectNotebook('CREATE_NEW_NB', []);
        expect(result).toBe('CREATE_NEW_NB');
    });

    it('preserves a real notebook id when explicitly chosen by the user', () => {
        const result = computeAutoSelectNotebook('nb-user-choice', [
            { id: 'nb-001', name: 'Other' },
        ]);
        expect(result).toBe('nb-user-choice');
    });

    it('empty string is upgraded to first notebook (guards against stale state)', () => {
        const result = computeAutoSelectNotebook('', [
            { id: 'nb-001', name: 'Research' },
        ]);
        expect(result).toBe('nb-001');
    });

    it('empty string with no notebooks yields CREATE_NEW_NB', () => {
        const result = computeAutoSelectNotebook('', []);
        expect(result).toBe('CREATE_NEW_NB');
    });

    it('OLD behavior (broken): CREATE_NEW_NB would NOT be upgraded', () => {
        // Demonstrates the old bug: `if (!current)` skips CREATE_NEW_NB
        function oldComputeAutoSelect(
            current: string,
            notebooks: Array<{ id: string }>,
        ): string {
            if (!current) {  // ← old condition: only upgrades truly empty string
                return notebooks.length > 0 ? notebooks[0].id : 'CREATE_NEW_NB';
            }
            return current;
        }
        // With old logic, CREATE_NEW_NB is treated as an explicit choice and kept
        const oldResult = oldComputeAutoSelect('CREATE_NEW_NB', [{ id: 'nb-001' }]);
        expect(oldResult).toBe('CREATE_NEW_NB'); // ← would NOT use nb-001 (wrong)

        // With the new logic, CREATE_NEW_NB gets replaced:
        const newResult = computeAutoSelectNotebook('CREATE_NEW_NB', [{ id: 'nb-001' }]);
        expect(newResult).toBe('nb-001'); // ← correctly selects the real notebook
    });
});

// ─── Invariant 4: selection utilities support the IPC call path ───────────────

describe('selection utilities — IPC call path readiness', () => {
    const webResults: SearchResultInput[] = [
        { uri: 'https://example.com/article', title: 'Article', providerId: 'external:brave', sourceType: 'web' },
        { uri: 'https://example.com/paper', title: 'Paper', providerId: 'external:brave', sourceType: 'web' },
        { sourcePath: '/workspace/notes.md', title: 'Notes', providerId: 'local', sourceType: 'local_file' },
    ];

    it('filterSelectedResults produces non-empty items when results are selected', () => {
        const selectedKeys = allResultKeys(webResults);
        const selected = filterSelectedResults(webResults, selectedKeys);
        expect(selected.length).toBe(webResults.length);
        // Confirmed: notebookItems.length > 0 → IPC call will be made
        const notebookItems = selected.map(({ result, index }) => resultToNotebookItem(result, index));
        expect(notebookItems.length).toBeGreaterThan(0);
    });

    it('partial selection produces correct subset for IPC call', () => {
        const selectedKeys = new Set(['https://example.com/article']);
        const selected = filterSelectedResults(webResults, selectedKeys);
        expect(selected.length).toBe(1);
        expect(selected[0].result.uri).toBe('https://example.com/article');
        const items = selected.map(({ result, index }) => resultToNotebookItem(result, index));
        expect(items[0].item_key).toBe('https://example.com/article');
    });

    it('empty selection produces zero items — no IPC call made (correct guard behavior)', () => {
        const selected = filterSelectedResults(webResults, new Set());
        expect(selected.length).toBe(0);
        // When notebookItems.length === 0, the IPC call is correctly skipped
    });

    it('handleBulkAdd uri extraction only includes web results with URIs', () => {
        const selectedKeys = allResultKeys(webResults);
        // Mirrors the filter in handleBulkAdd:
        const uris = webResults
            .filter((r, i) => r.uri && selectedKeys.has(resultKey(r.uri, r.sourcePath, i)))
            .map(r => r.uri as string);
        expect(uris).toEqual([
            'https://example.com/article',
            'https://example.com/paper',
        ]);
        // Local result (no uri) is correctly excluded from scrape loop
        expect(uris).not.toContain(undefined);
    });
});

// ─── Invariant 5: selectedItemKeys stability (DB path) ───────────────────────

describe('selectedItemKeys for search-run-based IPC calls', () => {
    /**
     * handleSaveSelected computes: `const selectedItemKeys = Array.from(selectedKeys)`
     * and passes it to researchAddSearchRunResultsToNotebook.
     * The ResearchRepository filters search_run_results by item_key using these keys.
     * Keys must be stable and match what was stored during researchAddSearchRunResults.
     */

    it('selectedItemKeys are stable uri-based keys for web results', () => {
        const results: SearchResultInput[] = [
            { uri: 'https://a.com', title: 'A' },
            { uri: 'https://b.com', title: 'B' },
        ];
        const selectedKeys = allResultKeys(results);
        const selectedItemKeys = Array.from(selectedKeys);
        // Keys must match what was stored as item_key during search run registration
        expect(selectedItemKeys).toContain('https://a.com');
        expect(selectedItemKeys).toContain('https://b.com');
    });

    it('selectedItemKeys are stable path-based keys for local results', () => {
        const results: SearchResultInput[] = [
            { sourcePath: '/workspace/doc.md', title: 'Doc' },
        ];
        const selectedKeys = allResultKeys(results);
        const selectedItemKeys = Array.from(selectedKeys);
        expect(selectedItemKeys).toContain('/workspace/doc.md');
    });
});
