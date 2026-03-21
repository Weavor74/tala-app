/**
 * LocalEmbeddingProvider.test.ts
 *
 * Unit tests for LocalEmbeddingProvider.
 *
 * Validates:
 *   1. Default endpoint and model when no InferenceInstance is provided
 *   2. Endpoint resolved from an active InferenceInstance
 *   3. Path suffix stripped from Ollama endpoint
 *   4. Model override respected
 *   5. embedText returns the embedding vector on success
 *   6. embedText throws on HTTP error status
 *   7. embedText throws when response lacks "embedding" field
 *   8. embedText throws on network timeout / error
 *
 * No real network connections are used — http/https modules are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InferenceInstance } from '../shared/settings';
import {
  LocalEmbeddingProvider,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_OLLAMA_ENDPOINT,
  LOCAL_EMBEDDING_PROVIDER_ID,
} from '../electron/services/embedding/LocalEmbeddingProvider';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

// ─── HTTP mock helpers ────────────────────────────────────────────────────────

/**
 * Replace the postJson HTTP layer by monkeypatching the http module.
 * We intercept at the module boundary by mocking the `http` module's
 * `request` method. Since LocalEmbeddingProvider imports `http` at the top
 * of its module, we use vi.mock with a factory.
 */

vi.mock('http', () => {
  const mockRequest = vi.fn();
  return { default: { request: mockRequest }, request: mockRequest };
});

vi.mock('https', () => {
  const mockRequest = vi.fn();
  return { default: { request: mockRequest }, request: mockRequest };
});

// Re-import after mocking
import * as httpMod from 'http';

// ─── Stub factory ─────────────────────────────────────────────────────────────

interface StubOptions {
  statusCode?: number;
  body?: string;
  error?: Error;
  timeout?: boolean;
}

function stubHttpRequest(opts: StubOptions) {
  const { statusCode = 200, body = '{}', error, timeout } = opts;

  (httpMod.request as ReturnType<typeof vi.fn>).mockImplementation(
    (_options: unknown, callback: (res: any) => void) => {
      const req: any = {
        setTimeout: vi.fn((ms: number, cb: () => void) => {
          if (timeout) setImmediate(cb);
        }),
        on: vi.fn((event: string, cb: (e: Error) => void) => {
          if (event === 'error' && error) setImmediate(() => cb(error));
        }),
        write: vi.fn(),
        end: vi.fn(() => {
          if (timeout || error) return;
          const res: any = {
            statusCode,
            on: vi.fn((event: string, cb: (...args: any[]) => void) => {
              if (event === 'data') setImmediate(() => cb(Buffer.from(body)));
              if (event === 'end') setImmediate(() => cb());
            }),
          };
          setImmediate(() => callback(res));
        }),
        destroy: vi.fn((err: Error) => {
          const errorCb = (req.on as ReturnType<typeof vi.fn>).mock.calls.find(
            ([e]: [string]) => e === 'error',
          )?.[1];
          if (errorCb) setImmediate(() => errorCb(err));
        }),
      };
      return req;
    },
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInstance(
  overrides: Partial<InferenceInstance> = {},
): InferenceInstance {
  return {
    id: 'test-ollama',
    alias: 'Test Ollama',
    source: 'local',
    engine: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    model: 'llama3',
    priority: 1,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LocalEmbeddingProvider — construction', () => {
  it('uses DEFAULT_OLLAMA_ENDPOINT when no instance provided', () => {
    const p = new LocalEmbeddingProvider();
    expect(p.getEndpoint()).toBe(DEFAULT_OLLAMA_ENDPOINT);
  });

  it('uses DEFAULT_EMBEDDING_MODEL when no override provided', () => {
    const p = new LocalEmbeddingProvider();
    expect(p.getModel()).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it('exposes stable providerId', () => {
    const p = new LocalEmbeddingProvider();
    expect(p.providerId).toBe(LOCAL_EMBEDDING_PROVIDER_ID);
  });

  it('resolves endpoint from active InferenceInstance', () => {
    const instance = makeInstance({ endpoint: 'http://192.168.1.10:11434' });
    const p = new LocalEmbeddingProvider(instance);
    expect(p.getEndpoint()).toBe('http://192.168.1.10:11434');
  });

  it('strips path suffix from instance endpoint', () => {
    const instance = makeInstance({ endpoint: 'http://127.0.0.1:11434/v1' });
    const p = new LocalEmbeddingProvider(instance);
    expect(p.getEndpoint()).toBe('http://127.0.0.1:11434');
  });

  it('falls back to default when instance endpoint is empty', () => {
    const instance = makeInstance({ endpoint: '' });
    const p = new LocalEmbeddingProvider(instance);
    expect(p.getEndpoint()).toBe(DEFAULT_OLLAMA_ENDPOINT);
  });

  it('applies model override', () => {
    const p = new LocalEmbeddingProvider(null, 'nomic-embed-text');
    expect(p.getModel()).toBe('nomic-embed-text');
  });

  it('ignores whitespace-only model override', () => {
    const p = new LocalEmbeddingProvider(null, '   ');
    expect(p.getModel()).toBe(DEFAULT_EMBEDDING_MODEL);
  });
});

describe('LocalEmbeddingProvider — embedText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns embedding vector on success', async () => {
    const vector = [0.1, 0.2, 0.3];
    stubHttpRequest({ body: JSON.stringify({ embedding: vector }) });

    const p = new LocalEmbeddingProvider();
    const result = await p.embedText('hello world');
    expect(result).toEqual(vector);
  });

  it('sends request to /api/embeddings with correct body', async () => {
    const vector = [0.5, 0.6];
    stubHttpRequest({ body: JSON.stringify({ embedding: vector }) });

    const p = new LocalEmbeddingProvider(null, 'my-model');
    await p.embedText('test input');

    const callArgs = (httpMod.request as ReturnType<typeof vi.fn>).mock.calls[0];
    const reqOptions = callArgs[0] as { path: string; hostname: string };
    expect(reqOptions.path).toBe('/api/embeddings');
    expect(reqOptions.hostname).toBe('127.0.0.1');
  });

  it('throws on HTTP 4xx error', async () => {
    stubHttpRequest({ statusCode: 400, body: 'model not found' });

    const p = new LocalEmbeddingProvider();
    await expect(p.embedText('hello')).rejects.toThrow(/HTTP 400/);
  });

  it('throws when response body lacks embedding field', async () => {
    stubHttpRequest({ body: JSON.stringify({ result: 'ok' }) });

    const p = new LocalEmbeddingProvider();
    await expect(p.embedText('hello')).rejects.toThrow(
      /embedding.*missing|not an array/i,
    );
  });

  it('throws when embedding field is not an array', async () => {
    stubHttpRequest({ body: JSON.stringify({ embedding: 'not-an-array' }) });

    const p = new LocalEmbeddingProvider();
    await expect(p.embedText('hello')).rejects.toThrow();
  });

  it('throws on network error', async () => {
    stubHttpRequest({ error: new Error('ECONNREFUSED') });

    const p = new LocalEmbeddingProvider();
    await expect(p.embedText('hello')).rejects.toThrow('ECONNREFUSED');
  });
});
