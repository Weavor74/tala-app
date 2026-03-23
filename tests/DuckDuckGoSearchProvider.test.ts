/**
 * DuckDuckGoSearchProvider.test.ts
 *
 * Unit tests for the DuckDuckGoSearchProvider.
 * Verifies HTML scraping, URL extraction, and result normalization.
 */

import { describe, it, expect, vi } from 'vitest';
import { DuckDuckGoSearchProvider } from '../electron/services/retrieval/providers/DuckDuckGoSearchProvider';
import https from 'https';

vi.mock('https');

describe('DuckDuckGoSearchProvider', () => {
  it('has id "duckduckgo" and supports keyword mode', () => {
    const provider = new DuckDuckGoSearchProvider();
    expect(provider.id).toBe('duckduckgo');
    expect(provider.supportedModes).toContain('keyword');
    expect(provider.supportedModes).toContain('hybrid');
  });

  it('normalizes scraped HTML into NormalizedSearchResult shape', async () => {
    const mockHtml = `
      <table>
        <tr>
          <td>
            <a class="result-link" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&amp;rut=1">Example Page 1</a>
          </td>
          <td class="result-snippet">This is the first snippet.</td>
        </tr>
        <tr>
          <td>
            <a class="result-link" href="https://example.com/page2">Example Page 2</a>
          </td>
          <td class="result-snippet">Second snippet here.</td>
        </tr>
      </table>
    `;

    const mockRes: any = {
      on: vi.fn((event, cb) => {
        if (event === 'data') cb(mockHtml);
        if (event === 'end') cb();
        return mockRes;
      }),
    };

    (https.get as any).mockImplementation((_url: string, _options: any, cb: any) => {
      cb(mockRes);
      return {
        on: vi.fn().mockReturnThis(),
        setTimeout: vi.fn().mockReturnThis(),
      };
    });

    const provider = new DuckDuckGoSearchProvider();
    const result = await provider.search(
      'test query',
      { scopeType: 'global', uris: [], sourcePaths: [], itemKeys: [] } as any,
      { topK: 10 },
    );

    expect(result.providerId).toBe('duckduckgo');
    expect(result.results).toHaveLength(2);
    expect(result.error).toBeUndefined();

    const first = result.results[0];
    expect(first.title).toBe('Example Page 1');
    expect(first.uri).toBe('https://example.com/page1');
    expect(first.snippet).toBe('This is the first snippet.');
    expect(first.itemKey).toBe('web:ddg:https://example.com/page1');
    expect(first.sourceType).toBe('web');

    const second = result.results[1];
    expect(second.uri).toBe('https://example.com/page2');
    expect(second.title).toBe('Example Page 2');
  });

  it('handles requests with no results safely', async () => {
    const mockRes: any = {
      on: vi.fn((event, cb) => {
        if (event === 'end') cb();
        return mockRes;
      }),
    };

    (https.get as any).mockImplementation((_url: string, _options: any, cb: any) => {
      cb(mockRes);
      return {
        on: vi.fn().mockReturnThis(),
        setTimeout: vi.fn().mockReturnThis(),
      };
    });

    const provider = new DuckDuckGoSearchProvider();
    const result = await provider.search('empty search', {} as any, {});

    expect(result.results).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures network errors gracefully', async () => {
    (https.get as any).mockImplementation(() => {
      const emitter: any = {
        on: vi.fn((event, cb) => {
          if (event === 'error') cb(new Error('DNS Failure'));
          return emitter;
        }),
        setTimeout: vi.fn().mockReturnThis(),
      };
      return emitter;
    });

    const provider = new DuckDuckGoSearchProvider();
    const result = await provider.search('fail', {} as any, {});

    expect(result.results).toEqual([]);
    expect(result.error).toMatch(/DNS Failure/);
  });
});
