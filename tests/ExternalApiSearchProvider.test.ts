import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExternalApiSearchProvider, providerHealthTracker, providerCache, testProvider } from '../electron/services/retrieval/providers/ExternalApiSearchProvider';
import type { SearchProvider as SettingsSearchProvider } from '../shared/settings';
// @ts-ignore
import https from 'https';
// @ts-ignore
import { EventEmitter } from 'node:events';

// Mock https locally since ExternalApiSearchProvider uses https.request
vi.mock('https', () => ({
  default: {
    request: vi.fn(),
  }
}));

describe('ExternalApiSearchProvider and Health Tracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerHealthTracker.resetAll();
    providerCache.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles success and records health', async () => {
    const mockRes = new EventEmitter() as any;
    mockRes.statusCode = 200;
    
    // Setup http response stream
    vi.mocked(https.request).mockImplementation((...args: any[]) => {
      const cb = args.find(a => typeof a === 'function');
      if (cb) cb(mockRes);
      return {
        on: vi.fn().mockReturnThis(),
        end: vi.fn(() => {
          mockRes.emit('data', JSON.stringify({
            web: { results: [{ title: 'Brave Search', url: 'https://brave.com', description: 'desc' }] }
          }));
          mockRes.emit('end');
        }),
        setTimeout: vi.fn().mockReturnThis(),
      } as any;
    });

    const cfg: SettingsSearchProvider = { id: 'brave', name: 'Brave', type: 'brave', enabled: true, apiKey: 'valid-key' };
    const provider = new ExternalApiSearchProvider(cfg);

    const res = await provider.search('test', { scopeType: 'global', uris: [], itemKeys: [], sourcePaths: [] }, { topK: 1 });

    expect(res.error).toBeNull();
    expect(res.results).toHaveLength(1);
    expect(res.results[0].title).toBe('Brave Search');
    expect(providerHealthTracker.isDegraded('external:brave')).toBe(false);
  });

  it('handles 401 error and increments consecutive failure tracker', async () => {
    const mockRes = new EventEmitter() as any;
    mockRes.statusCode = 401;

    vi.mocked(https.request).mockImplementation((...args: any[]) => {
      const cb = args.find(a => typeof a === 'function');
      if (cb) cb(mockRes);
      return {
        on: vi.fn().mockReturnThis(),
        end: vi.fn(() => {
          mockRes.emit('data', JSON.stringify({ message: "Invalid API key" }));
          mockRes.emit('end');
        }),
        setTimeout: vi.fn().mockReturnThis(),
      } as any;
    });

    const cfg: SettingsSearchProvider = { id: 'brave', name: 'Brave', type: 'brave', enabled: true, apiKey: 'invalid-key' };
    const provider = new ExternalApiSearchProvider(cfg);

    const res = await provider.search('test', { scopeType: 'global', uris: [], itemKeys: [], sourcePaths: [] }, { topK: 1 });

    expect(res.error).toContain('HTTP 401');
    expect(providerHealthTracker.isDegraded('external:brave')).toBe(false); // 1 failure, not degraded yet

    // Second failure
    await provider.search('test2', { scopeType: 'global', uris: [], itemKeys: [], sourcePaths: [] }, { topK: 1 });
    // Third failure -> degraded
    await provider.search('test3', { scopeType: 'global', uris: [], itemKeys: [], sourcePaths: [] }, { topK: 1 });

    expect(providerHealthTracker.isDegraded('external:brave')).toBe(true);
  });

  it('throws early if missing api key', async () => {
    const cfg: SettingsSearchProvider = { id: 'brave', name: 'Brave', type: 'brave', enabled: true, apiKey: '' };
    const provider = new ExternalApiSearchProvider(cfg);

    const res = await provider.search('test', { scopeType: 'global', uris: [], itemKeys: [], sourcePaths: [] }, { topK: 1 });

    expect(res.error).toContain('is not configured');
    expect(https.request).not.toHaveBeenCalled();
  });

  it('validates normalized results and filters bad ones', async () => {
    const mockRes = new EventEmitter() as any;
    mockRes.statusCode = 200;

    vi.mocked(https.request).mockImplementation((...args: any[]) => {
      const cb = args.find(a => typeof a === 'function');
      if (cb) cb(mockRes);
      return {
        on: vi.fn().mockReturnThis(),
        end: vi.fn(() => {
          mockRes.emit('data', JSON.stringify({
            web: { 
              results: [
                { title: 'Good Result', url: 'https://good.com', description: 'desc' },
                { title: '', url: 'https://bad1.com', description: 'no title' }, // invalid (no title)
                { title: 'No desc', url: 'ftp://bad2.com', description: '' }     // invalid (not http)
              ]
            }
          }));
          mockRes.emit('end');
        }),
        setTimeout: vi.fn().mockReturnThis(),
      } as any;
    });

    const cfg: SettingsSearchProvider = { id: 'brave', name: 'Brave', type: 'brave', enabled: true, apiKey: 'valid-key' };
    const provider = new ExternalApiSearchProvider(cfg);

    const res = await provider.search('validation test', { scopeType: 'global', uris: [], itemKeys: [], sourcePaths: [] }, { topK: 5 });
    
    // There are 3 results, 1 good, 2 bad. That's >50% bad, which throws a validation error
    expect(res.error).toContain('More than 50% of results');
    expect(res.results).toHaveLength(0);
  });

  it('testProvider export handles success and formats properly', async () => {
    const mockRes = new EventEmitter() as any;
    mockRes.statusCode = 200;

    vi.mocked(https.request).mockImplementation((...args: any[]) => {
      const cb = args.find(a => typeof a === 'function');
      if (cb) cb(mockRes);
      return {
        on: vi.fn().mockReturnThis(),
        end: vi.fn(() => {
          mockRes.emit('data', JSON.stringify({
            web: { results: [{ title: 'Good', url: 'https://good.com', description: 'desc' }] }
          }));
          mockRes.emit('end');
        }),
        setTimeout: vi.fn().mockReturnThis(),
      } as any;
    });

    const cfg: SettingsSearchProvider = { id: 'brave', name: 'Brave', type: 'brave', enabled: true, apiKey: 'test-key' };
    const res = await testProvider({ activeProviderId: 'brave', providers: [cfg] }, 'brave');

    expect(res.success).toBe(true);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.error).toBeUndefined();
  });
});
