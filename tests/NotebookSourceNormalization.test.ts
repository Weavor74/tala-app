import { describe, expect, it } from 'vitest';
import {
  normalizeNotebookItemForStorage,
  normalizeNotebookSourceRecord,
  resolveNotebookOpenTarget,
} from '../shared/researchTypes';

describe('notebook source normalization', () => {
  it('normalizes web item with canonical browser open target', () => {
    const normalized = normalizeNotebookSourceRecord({
      title: 'Example',
      uri: 'https://example.com/article',
      provider_id: 'external:duckduckgo',
      sourceType: 'web',
    });

    expect(normalized.sourceType).toBe('web');
    expect(normalized.uri).toBe('https://example.com/article');
    expect(normalized.openTargetType).toBe('browser');
    expect(normalized.openTarget).toBe('https://example.com/article');
  });

  it('normalizes local item with workspace open target', () => {
    const normalized = normalizeNotebookSourceRecord({
      source_path: '/workspace/doc.md',
      item_type: 'local_file',
      title: 'Doc',
    });

    expect(normalized.sourceType).toBe('local');
    expect(normalized.sourcePath).toBe('/workspace/doc.md');
    expect(normalized.openTargetType).toBe('workspace_file');
    expect(normalized.openTarget).toBe('/workspace/doc.md');
  });

  it('maps legacy metadata uri/path into canonical fields', () => {
    const normalized = normalizeNotebookSourceRecord({
      item_key: 'legacy-1',
      metadata_json: {
        uri: 'https://legacy.example.com',
        sourcePath: '/legacy/doc.txt',
        providerId: 'legacy-provider',
      },
    });

    expect(normalized.uri).toBe('https://legacy.example.com');
    expect(normalized.sourcePath).toBe('/legacy/doc.txt');
    expect(normalized.providerId).toBe('legacy-provider');
  });

  it('storage normalization keeps deterministic fallback retrieval status', () => {
    const normalized = normalizeNotebookItemForStorage({
      item_key: 'k1',
      title: 'Title',
      uri: 'https://k1.example',
      metadata_json: {},
    });

    expect(normalized.item_key).toBe('k1');
    expect(normalized.source_id).toBeNull();
    expect(normalized.metadata_json.retrievalStatus).toBe('saved_metadata_only');
  });

  it('generated/internal without uri/path is not browser-openable', () => {
    const open = resolveNotebookOpenTarget({
      item_key: 'gen-1',
      sourceType: 'generated',
      title: 'Generated Note',
    });

    expect(open.openTargetType).toBe('none');
    expect(open.openTarget).toBeNull();
    expect(open.sourceUnavailableReason).toContain('source_unavailable');
  });
});
