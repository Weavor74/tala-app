/**
 * Provider Detection Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InferenceProviderRegistry } from '../../services/inference/InferenceProviderRegistry';

const emittedEvents: Array<{ eventType: string; status: string }> = [];

vi.mock('../../services/TelemetryService', () => ({
  telemetry: {
    emit: (_s: string, et: string, _sv: string, _a: string, _sum: string, st: string) => emittedEvents.push({ eventType: et, status: st }),
    operational: (_s: string, et: string, _sv: string, _a: string, _sum: string, st: string) => emittedEvents.push({ eventType: et, status: st }),
    audit: (_s: string, et: string, _a: string, _sum: string, st: string) => emittedEvents.push({ eventType: et, status: st }),
    debug: (_s: string, et: string) => emittedEvents.push({ eventType: et, status: 'success' }),
  },
}));

const httpResponses: Record<string, { status: number; body: string } | 'error'> = {};

function setHttpResponse(urlFragment: string, resp: { status: number; body: string } | 'error') {
  httpResponses[urlFragment] = resp;
}

function clearHttpResponses() {
  for (const key of Object.keys(httpResponses)) delete httpResponses[key];
}

vi.mock('http', () => {
  function makeRequest(url: string, _opts: any, cb?: (res: any) => void) {
    const callbackFn = typeof _opts === 'function' ? _opts : cb;
    const matchKey = Object.keys(httpResponses).find((k) => url.includes(k));
    const response = matchKey ? httpResponses[matchKey] : 'error';

    if (response === 'error' || !response) {
      const req = {
        on: (evt: string, handler: (...args: any[]) => void) => {
          if (evt === 'error') setTimeout(() => handler(new Error('ECONNREFUSED')), 0);
          return req;
        },
        end: () => req,
        destroy: () => req,
      };
      return req;
    }

    const fakeRes = {
      statusCode: response.status,
      on: (evt: string, handler: (...args: any[]) => void) => {
        if (evt === 'data') setTimeout(() => handler(Buffer.from(response.body)), 0);
        if (evt === 'end') setTimeout(() => handler(), 5);
        return fakeRes;
      },
      resume: () => undefined,
    };
    if (callbackFn) setTimeout(() => callbackFn(fakeRes), 0);
    const req = {
      on: (_evt: string, _handler: (...args: any[]) => void) => req,
      end: () => req,
      destroy: () => req,
    };
    return req;
  }

  return {
    default: { get: makeRequest, request: makeRequest },
    get: makeRequest,
    request: makeRequest,
  };
});

vi.mock('https', () => ({ default: { get: vi.fn() }, get: vi.fn() }));

describe('InferenceProviderRegistry detection', () => {
  beforeEach(() => {
    emittedEvents.length = 0;
    clearHttpResponses();
  });

  it('detects ollama when /api/tags is reachable', async () => {
    setHttpResponse('/api/tags', {
      status: 200,
      body: JSON.stringify({ models: [{ name: 'llama3:latest' }] }),
    });

    const registry = new InferenceProviderRegistry({
      ollama: { endpoint: 'http://127.0.0.1:11434', enabled: true },
      embeddedVllm: { port: 8000, modelId: 'qwen2.5:3b', enabled: true },
    });

    await registry.refresh();

    const ollama = registry.getInventory().providers.find((p) => p.providerId === 'ollama');
    expect(ollama?.ready).toBe(true);
    expect(ollama?.models).toContain('llama3:latest');
  });

  it('includes embedded_vllm and excludes embedded_llamacpp from inventory', () => {
    const registry = new InferenceProviderRegistry({
      ollama: { endpoint: 'http://127.0.0.1:11434', enabled: true },
      embeddedVllm: { port: 8000, modelId: 'qwen2.5:3b', enabled: true },
      ...( { embeddedLlamaCpp: { enabled: true, port: 8080 } } as Record<string, unknown> ),
    } as any);

    const ids = registry.getInventory().providers.map((p) => p.providerId);
    expect(ids).toContain('embedded_vllm');
    expect(ids).not.toContain('embedded_llamacpp');
  });
});
