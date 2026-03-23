import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetrievalOrchestrator } from '../electron/services/retrieval/RetrievalOrchestrator';
import type { SearchProvider, SearchProviderResult, NormalizedSearchResult } from '../shared/retrieval/retrievalTypes';

// Mock telemetry to prevent console noise
vi.mock('../electron/services/TelemetryService', () => ({
  telemetry: {
    emit: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

function makeResult(itemKey: string): NormalizedSearchResult {
  return {
    itemKey,
    title: 'Test',
    providerId: 'test',
    uri: null, sourcePath: null, snippet: null, sourceType: null, externalId: null, contentHash: null, score: null, metadata: {},
  };
}

function makeProvider(id: string, modes: import('../shared/retrieval/retrievalTypes').RetrievalMode[], options: { results?: NormalizedSearchResult[], errorMsg?: string, delayMs?: number }): SearchProvider {
  return {
    id,
    supportedModes: modes,
    search: vi.fn(async () => {
      if (options.delayMs) await new Promise(r => setTimeout(r, options.delayMs));
      if (options.errorMsg) {
        return { providerId: id, results: [], error: options.errorMsg, durationMs: 1 };
      }
      return { providerId: id, results: options.results ?? [], error: null, durationMs: 1 };
    }),
  };
}

describe('RetrievalOrchestrator Fallback Logic', () => {
  let orchestrator: RetrievalOrchestrator;
  let duckduckgo: SearchProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new RetrievalOrchestrator();
    duckduckgo = makeProvider('duckduckgo', ['keyword', 'semantic', 'hybrid'], {
      results: [makeResult('ddg1')],
    });
    orchestrator.registerProvider(duckduckgo);
  });

  it('falls back to duckduckgo when curated provider throws an error', async () => {
    const brave = makeProvider('external:brave', ['keyword'], { errorMsg: 'API Key Invalid' });
    orchestrator.registerProvider(brave);
    orchestrator.setCuratedProviderId('brave');

    const res = await orchestrator.retrieve({
      query: 'test query',
      mode: 'keyword',
      scope: 'global',
      providerCategory: 'external',
    });

    // Both were called
    expect(brave.search).toHaveBeenCalledTimes(1);
    expect(duckduckgo.search).toHaveBeenCalledTimes(1);

    // DuckDuckGo results were used
    expect(res.results).toHaveLength(1);
    expect(res.results[0].itemKey).toBe('ddg1');

    // Expected providerResults to show the fallback was successful
    expect(res.providerResults.length).toBe(1);
    expect(res.providerResults[0].providerId).toBe('duckduckgo');
    expect(res.providerResults[0].error).toBeNull();
  });

  it('does NOT fallback to duckduckgo when curated provider returns 0 results successfully', async () => {
    const brave = makeProvider('external:brave', ['keyword'], { results: [] });
    orchestrator.registerProvider(brave);
    orchestrator.setCuratedProviderId('brave');

    const res = await orchestrator.retrieve({
      query: 'test query empty',
      mode: 'keyword',
      scope: 'global',
      providerCategory: 'external',
    });

    expect(brave.search).toHaveBeenCalledTimes(1);
    expect(duckduckgo.search).not.toHaveBeenCalled();

    expect(res.results).toHaveLength(0);
    expect(res.providerResults.length).toBe(1);
    expect(res.providerResults[0].providerId).toBe('external:brave');
    expect(res.providerResults[0].error).toBeNull();
  });

  it('keeps both errors if fallback also fails', async () => {
    const brave = makeProvider('external:brave', ['keyword'], { errorMsg: 'Brave Error' });
    const ddgFail = makeProvider('duckduckgo', ['keyword'], { errorMsg: 'DDG Error' });
    
    orchestrator.registerProvider(brave);
    orchestrator.registerProvider(ddgFail);
    orchestrator.setCuratedProviderId('brave');

    const res = await orchestrator.retrieve({
      query: 'doom',
      mode: 'keyword',
      scope: 'global',
      providerCategory: 'external',
    });

    expect(brave.search).toHaveBeenCalledTimes(1);
    expect(ddgFail.search).toHaveBeenCalledTimes(1);

    expect(res.results).toHaveLength(0);
    expect(res.providerResults).toHaveLength(2); // Keeps both for diagnostics
    expect(res.providerResults[0].error).toContain('Brave Error');
    expect(res.providerResults[1].error).toContain('DDG Error');
  });
});
