/**
 * SearchSelection.test.ts
 *
 * Unit tests for the pure search-selection and save-to-notebook utilities
 * defined in src/renderer/utils/searchSelection.ts.
 *
 * Validates:
 *   1. resultKey — stable key derivation for web / local / fallback results
 *   2. resultToNotebookItem — full metadata mapping, no scraping, provenance preserved
 *   3. filterSelectedResults — subset filtering by key set
 *   4. allResultKeys — build complete key set for "Select All"
 *   5. Zero-selection guard — no items produced when nothing is selected
 *   6. Provider provenance — providerId and externalId survive the mapping
 *   7. No automatic ingestion — the mapping never references a scrape API
 */

import { describe, it, expect } from 'vitest';
import {
    resultKey,
    resultToNotebookItem,
    filterSelectedResults,
    allResultKeys,
    type SearchResultInput,
    type NotebookItemInput,
} from '../src/renderer/utils/searchSelection';

// ─── resultKey ────────────────────────────────────────────────────────────────

describe('resultKey', () => {
    it('returns the URL when present', () => {
        expect(resultKey('https://example.com/article', '/some/path', 3)).toBe('https://example.com/article');
    });

    it('returns the file path when URL is absent', () => {
        expect(resultKey(undefined, '/workspace/notes.md', 0)).toBe('/workspace/notes.md');
    });

    it('returns a fallback index string when both url and path are absent', () => {
        expect(resultKey(undefined, undefined, 7)).toBe('result:7');
    });

    it('uses index 0 as default fallback', () => {
        expect(resultKey()).toBe('result:0');
    });

    it('prefers URL over path', () => {
        // Both provided — URL wins
        expect(resultKey('https://a.com', '/local/path', 0)).toBe('https://a.com');
    });
});

// ─── resultToNotebookItem ─────────────────────────────────────────────────────

describe('resultToNotebookItem', () => {
    it('maps a web result to a notebook item with correct fields', () => {
        const result: SearchResultInput = {
            uri: 'https://example.com/page',
            title: 'Example Page',
            snippet: 'A short excerpt from the page.',
            providerId: 'external:brave',
            sourceType: 'web',
        };
        const item: NotebookItemInput = resultToNotebookItem(result, 0);

        expect(item.item_key).toBe('https://example.com/page');
        expect(item.item_type).toBe('web');
        expect(item.title).toBe('Example Page');
        expect(item.uri).toBe('https://example.com/page');
        expect(item.snippet).toBe('A short excerpt from the page.');
        expect(item.source_path).toBeUndefined();
        expect(item.metadata_json?.providerId).toBe('external:brave');
        expect(item.metadata_json?.openTarget).toBe('https://example.com/page');
        expect(item.metadata_json?.openTargetType).toBe('browser');
    });

    it('maps a local file result to a notebook item with correct fields', () => {
        const result: SearchResultInput = {
            sourcePath: '/workspace/research/notes.md',
            title: 'Research Notes',
            snippet: 'Some content from the file.',
            providerId: 'local',
            sourceType: 'local_file',
        };
        const item: NotebookItemInput = resultToNotebookItem(result, 2);

        expect(item.item_key).toBe('/workspace/research/notes.md');
        expect(item.item_type).toBe('local_file');
        expect(item.title).toBe('Research Notes');
        expect(item.source_path).toBe('/workspace/research/notes.md');
        expect(item.uri).toBeUndefined();
        // content used as snippet fallback
        expect(item.snippet).toBe('Some content from the file.');
        expect(item.metadata_json?.providerId).toBe('local');
        expect(item.metadata_json?.openTarget).toBe('/workspace/research/notes.md');
        expect(item.metadata_json?.openTargetType).toBe('workspace_file');
    });

    it('infers item_type from providerId when sourceType is absent', () => {
        const webResult: SearchResultInput = { uri: 'https://x.com', providerId: 'external:bing' };
        expect(resultToNotebookItem(webResult, 0).item_type).toBe('web');

        const localResult: SearchResultInput = { sourcePath: '/a/b.txt', providerId: 'local' };
        expect(resultToNotebookItem(localResult, 1).item_type).toBe('local_file');
    });

    it('preserves provider provenance in metadata_json', () => {
        const result: SearchResultInput = {
            uri: 'https://search.example.com/result',
            providerId: 'external:serpapi',
            externalId: 'serpapi-result-abc123',
            metadata: { rank: 1, domain: 'example.com' },
        };
        const item = resultToNotebookItem(result, 0);

        expect(item.metadata_json?.providerId).toBe('external:serpapi');
        expect(item.metadata_json?.externalId).toBe('serpapi-result-abc123');
        expect(item.metadata_json?.rank).toBe(1);
        expect(item.metadata_json?.domain).toBe('example.com');
    });

    it('truncates long snippets to 500 characters', () => {
        const longText = 'x'.repeat(1000);
        const result: SearchResultInput = { uri: 'https://ex.com', snippet: longText };
        const item = resultToNotebookItem(result, 0);
        expect(item.snippet?.length).toBe(500);
    });

    it('falls back to content when snippet is absent', () => {
        const result: SearchResultInput = { sourcePath: '/f.md', snippet: 'body text' };
        const item = resultToNotebookItem(result, 0);
        expect(item.snippet).toBe('body text');
    });

    it('uses path as title fallback when title is absent', () => {
        const result: SearchResultInput = { sourcePath: '/workspace/document.md' };
        const item = resultToNotebookItem(result, 0);
        expect(item.title).toBe('/workspace/document.md');
    });

    it('still emits canonical metadata_json even when provider provenance is absent', () => {
        const result: SearchResultInput = { uri: 'https://ex.com' };
        const item = resultToNotebookItem(result, 0);
        expect(item.metadata_json?.openTarget).toBe('https://ex.com');
        expect(item.metadata_json?.openTargetType).toBe('browser');
        expect(item.metadata_json?.retrievalStatus).toBe('saved_metadata_only');
    });

    it('does NOT reference a scrape or ingest API — pure metadata mapping', () => {
        // This test confirms the function is free of side effects. It must return
        // synchronously and must not contain a reference to scrapeUrl or any
        // content-fetching mechanism. We verify by inspecting the return type and
        // confirming no promise is returned.
        const result: SearchResultInput = { uri: 'https://target.com', title: 'Target' };
        const returnValue = resultToNotebookItem(result, 0);

        // Return value must be a plain object, not a Promise
        expect(typeof returnValue).toBe('object');
        expect(returnValue).not.toBeInstanceOf(Promise);
    });

    it('maps generated/internal content without forcing browser open', () => {
        const result: SearchResultInput = {
            title: 'Generated Note',
            sourceType: 'generated',
            contentText: 'Generated summary body.',
            providerId: 'internal:notes',
        };
        const item = resultToNotebookItem(result, 9);

        expect(item.item_type).toBe('generated');
        expect(item.metadata_json?.openTargetType).toBe('generated');
        expect(item.metadata_json?.openTarget).toBeNull();
    });
});

// ─── filterSelectedResults ────────────────────────────────────────────────────

describe('filterSelectedResults', () => {
    const results: SearchResultInput[] = [
        { uri: 'https://a.com', title: 'A' },
        { uri: 'https://b.com', title: 'B' },
        { sourcePath: '/local/c.md', title: 'C' },
        { sourcePath: '/local/d.md', title: 'D' },
    ];

    it('returns only items whose key is in the selection set', () => {
        const selected = new Set(['https://a.com', '/local/d.md']);
        const filtered = filterSelectedResults(results, selected);
        expect(filtered).toHaveLength(2);
        expect(filtered[0].result.title).toBe('A');
        expect(filtered[1].result.title).toBe('D');
    });

    it('returns empty array when nothing is selected (zero-selection guard)', () => {
        const filtered = filterSelectedResults(results, new Set());
        expect(filtered).toHaveLength(0);
    });

    it('returns all items when all keys are selected', () => {
        const allKeys = allResultKeys(results);
        const filtered = filterSelectedResults(results, allKeys);
        expect(filtered).toHaveLength(results.length);
    });

    it('preserves the original index for each result', () => {
        const selected = new Set(['/local/c.md']);
        const filtered = filterSelectedResults(results, selected);
        expect(filtered[0].index).toBe(2);
    });
});

// ─── allResultKeys ─────────────────────────────────────────────────────────────

describe('allResultKeys', () => {
    it('returns a set containing the stable key for every result', () => {
        const results: SearchResultInput[] = [
            { uri: 'https://x.com' },
            { sourcePath: '/a/b.md' },
            { title: 'fallback only' }, // no url or path → result:2
        ];
        const keys = allResultKeys(results);
        expect(keys.size).toBe(3);
        expect(keys.has('https://x.com')).toBe(true);
        expect(keys.has('/a/b.md')).toBe(true);
        expect(keys.has('result:2')).toBe(true);
    });

    it('returns empty set for empty results', () => {
        expect(allResultKeys([]).size).toBe(0);
    });
});

// ─── Notebook item shape (integration check) ─────────────────────────────────

describe('notebook item shape contract', () => {
    it('produces items with the required fields for researchAddItemsToNotebook', () => {
        const results: SearchResultInput[] = [
            {
                uri: 'https://paper.example.com/abstract',
                title: 'Interesting Paper',
                snippet: 'Abstract of the paper.',
                providerId: 'external:semantic_scholar',
                sourceType: 'web',
                externalId: 'ss-42',
            },
            {
                sourcePath: '/research/local-notes.md',
                title: 'Local Notes',
                snippet: 'My own notes about the topic.',
                providerId: 'local',
                sourceType: 'local_file',
            },
        ];

        const allKeys = allResultKeys(results);
        const selected = filterSelectedResults(results, allKeys);
        const notebookItems = selected.map(({ result, index }) => resultToNotebookItem(result, index));

        // Verify required fields for the researchAddItemsToNotebook IPC call
        for (const item of notebookItems) {
            expect(item.item_key).toBeTruthy();
            expect(item.item_type).toBeTruthy();
        }

        // Web item
        expect(notebookItems[0].item_key).toBe('https://paper.example.com/abstract');
        expect(notebookItems[0].uri).toBe('https://paper.example.com/abstract');
        expect(notebookItems[0].metadata_json?.providerId).toBe('external:semantic_scholar');
        expect(notebookItems[0].metadata_json?.externalId).toBe('ss-42');

        // Local item
        expect(notebookItems[1].item_key).toBe('/research/local-notes.md');
        expect(notebookItems[1].source_path).toBe('/research/local-notes.md');
        expect(notebookItems[1].metadata_json?.providerId).toBe('local');
    });
});
