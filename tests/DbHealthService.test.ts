/**
 * DbHealthService.test.ts
 *
 * Unit tests for DbHealthService — deterministic Postgres preflight checker.
 *
 * Covers:
 *   DBH-01 — returns reachable=true with all flags on success
 *   DBH-02 — returns pgvectorInstalled=true when pg_extension row found
 *   DBH-03 — returns pgvectorInstalled=false when pg_extension row missing
 *   DBH-04 — returns migrationsApplied=true when schema_migrations table exists
 *   DBH-05 — returns migrationsApplied=false when schema_migrations table absent
 *   DBH-06 — returns reachable=false on pool.connect() failure
 *   DBH-07 — error message is captured in CanonicalDbHealth.error on failure
 *   DBH-08 — releases client after successful check
 *   DBH-09 — releases client after failed check (finally block)
 *   DBH-10 — retries up to maxRetries on failure and returns last result
 *   DBH-11 — stops retrying immediately on first success
 *   DBH-12 — default maxRetries is 5
 *   DBH-13 — default retryDelayMs is 2000
 *   DBH-14 — logs [DBHealth] reachable=true line on success
 *   DBH-15 — logs [DBHealth] reachable=false line on failure
 *   DBH-16 — warns about missing pgvector on success path
 *   DBH-17 — warns about missing migrations on success path
 *   DBH-18 — check() resolves (does not throw) on pool connect failure
 *   DBH-19 — check() resolves (does not throw) on query failure
 *   DBH-20 — authenticated=true only when SELECT 1 succeeds
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DbHealthService } from '../electron/services/db/DbHealthService';
import type { CanonicalDbHealth } from '../electron/services/db/DbHealthService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockClient = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    query: vi.fn(),
    release: vi.fn(),
    ...overrides,
  };
}

function makePool(client: MockClient | null, connectError?: Error) {
  return {
    connect: connectError
      ? vi.fn().mockRejectedValue(connectError)
      : vi.fn().mockResolvedValue(client),
  } as any;
}

// Suppress console output from DbHealthService during tests by default
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DbHealthService', () => {
  // ── Success path ──────────────────────────────────────────────────────────

  it('DBH-01 — returns reachable=true with all flags on full success', async () => {
    const client = makeClient({
      query: vi.fn()
        .mockResolvedValueOnce({}) // SELECT 1
        .mockResolvedValueOnce({ rows: [{ extname: 'vector' }] }) // pg_extension
        .mockResolvedValueOnce({ rows: [{ exists: 'public.schema_migrations' }] }), // to_regclass
    });
    const svc = new DbHealthService(makePool(client), { maxRetries: 1 });

    const health = await svc.check();

    expect(health.reachable).toBe(true);
    expect(health.authenticated).toBe(true);
    expect(health.databaseExists).toBe(true);
    expect(health.pgvectorInstalled).toBe(true);
    expect(health.migrationsApplied).toBe(true);
    expect(health.error).toBeUndefined();
  });

  it('DBH-02 — returns pgvectorInstalled=true when vector row found', async () => {
    const client = makeClient({
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ extname: 'vector' }] })
        .mockResolvedValueOnce({ rows: [{ exists: null }] }),
    });
    const svc = new DbHealthService(makePool(client), { maxRetries: 1 });

    const health = await svc.check();
    expect(health.pgvectorInstalled).toBe(true);
  });

  it('DBH-03 — returns pgvectorInstalled=false when no vector row', async () => {
    const client = makeClient({
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] }) // no pgvector
        .mockResolvedValueOnce({ rows: [{ exists: 'public.schema_migrations' }] }),
    });
    const svc = new DbHealthService(makePool(client), { maxRetries: 1 });

    const health = await svc.check();
    expect(health.pgvectorInstalled).toBe(false);
  });

  it('DBH-04 — returns migrationsApplied=true when schema_migrations exists', async () => {
    const client = makeClient({
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ extname: 'vector' }] })
        .mockResolvedValueOnce({ rows: [{ exists: 'public.schema_migrations' }] }),
    });
    const svc = new DbHealthService(makePool(client), { maxRetries: 1 });

    const health = await svc.check();
    expect(health.migrationsApplied).toBe(true);
  });

  it('DBH-05 — returns migrationsApplied=false when to_regclass returns null', async () => {
    const client = makeClient({
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ extname: 'vector' }] })
        .mockResolvedValueOnce({ rows: [{ exists: null }] }), // table absent
    });
    const svc = new DbHealthService(makePool(client), { maxRetries: 1 });

    const health = await svc.check();
    expect(health.migrationsApplied).toBe(false);
  });

  // ── Failure path ──────────────────────────────────────────────────────────

  it('DBH-06 — returns reachable=false on pool.connect() failure', async () => {
    const svc = new DbHealthService(
      makePool(null, new Error('ECONNREFUSED')),
      { maxRetries: 1 }
    );

    const health = await svc.check();
    expect(health.reachable).toBe(false);
    expect(health.authenticated).toBe(false);
    expect(health.databaseExists).toBe(false);
  });

  it('DBH-07 — captures error message in CanonicalDbHealth.error on failure', async () => {
    const svc = new DbHealthService(
      makePool(null, new Error('ECONNREFUSED 127.0.0.1:5432')),
      { maxRetries: 1 }
    );

    const health = await svc.check();
    expect(health.error).toContain('ECONNREFUSED');
  });

  it('DBH-08 — releases client after successful check', async () => {
    const client = makeClient({
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ exists: null }] }),
    });
    const svc = new DbHealthService(makePool(client), { maxRetries: 1 });

    await svc.check();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('DBH-09 — releases client even when a query throws', async () => {
    const client = makeClient({
      query: vi.fn()
        .mockResolvedValueOnce({}) // SELECT 1
        .mockRejectedValueOnce(new Error('pg_extension query failed')),
    });
    const svc = new DbHealthService(makePool(client), { maxRetries: 1 });

    await svc.check();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  // ── Retry logic ───────────────────────────────────────────────────────────

  it('DBH-10 — retries up to maxRetries on failure and returns last result', async () => {
    const connectMock = vi.fn().mockRejectedValue(new Error('timeout'));
    const pool = { connect: connectMock } as any;
    const svc = new DbHealthService(pool, { maxRetries: 3, retryDelayMs: 0 });

    const health = await svc.check();
    // 3 attempts expected (maxRetries=3 means loop runs 3 times: i=0,1,2)
    expect(connectMock).toHaveBeenCalledTimes(3);
    expect(health.reachable).toBe(false);
  });

  it('DBH-11 — stops retrying immediately on first success', async () => {
    const client = makeClient({
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ exists: null }] }),
    });
    const connectMock = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(client); // succeeds on second attempt
    const pool = { connect: connectMock } as any;
    const svc = new DbHealthService(pool, { maxRetries: 5, retryDelayMs: 0 });

    const health = await svc.check();
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(health.reachable).toBe(true);
  });

  it('DBH-12 — default maxRetries is 5', async () => {
    const connectMock = vi.fn().mockRejectedValue(new Error('fail'));
    const pool = { connect: connectMock } as any;
    // Override retryDelayMs to 0 to keep test fast, but use default maxRetries
    // by not passing options at all then check attempt count
    const svc = new DbHealthService(pool);
    // Patch sleep to be instant
    (svc as any)._sleep = () => Promise.resolve();

    await svc.check();
    expect(connectMock).toHaveBeenCalledTimes(5);
  });

  it('DBH-13 — default retryDelayMs is 2000', () => {
    const pool = { connect: vi.fn() } as any;
    const svc = new DbHealthService(pool);
    expect((svc as any).retryDelayMs).toBe(2000);
  });

  // ── Logging ───────────────────────────────────────────────────────────────

  it('DBH-14 — logs [DBHealth] reachable=true line on success', async () => {
    const client = makeClient({
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ extname: 'vector' }] })
        .mockResolvedValueOnce({ rows: [{ exists: 'public.schema_migrations' }] }),
    });
    const svc = new DbHealthService(makePool(client), { maxRetries: 1 });

    await svc.check();

    const loggedLine = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .find((msg: string) => typeof msg === 'string' && msg.includes('[DBHealth]') && msg.includes('reachable=true'));
    expect(loggedLine).toBeTruthy();
  });

  it('DBH-15 — logs [DBHealth] reachable=false line on failure', async () => {
    const svc = new DbHealthService(
      makePool(null, new Error('ECONNREFUSED')),
      { maxRetries: 1 }
    );

    await svc.check();

    const loggedLine = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .find((msg: string) => typeof msg === 'string' && msg.includes('[DBHealth]') && msg.includes('reachable=false'));
    expect(loggedLine).toBeTruthy();
  });

  it('DBH-16 — warns about missing pgvector on success path', async () => {
    const client = makeClient({
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] }) // no pgvector
        .mockResolvedValueOnce({ rows: [{ exists: 'public.schema_migrations' }] }),
    });
    const svc = new DbHealthService(makePool(client), { maxRetries: 1 });

    await svc.check();

    const warned = (console.warn as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .some((msg: string) => typeof msg === 'string' && msg.toLowerCase().includes('pgvector'));
    expect(warned).toBe(true);
  });

  it('DBH-17 — warns about missing migrations on success path', async () => {
    const client = makeClient({
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ extname: 'vector' }] })
        .mockResolvedValueOnce({ rows: [{ exists: null }] }), // no migrations
    });
    const svc = new DbHealthService(makePool(client), { maxRetries: 1 });

    await svc.check();

    const warned = (console.warn as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .some((msg: string) => typeof msg === 'string' && msg.toLowerCase().includes('schema'));
    expect(warned).toBe(true);
  });

  it('DBH-18 — check() resolves (does not throw) on pool.connect() failure', async () => {
    const svc = new DbHealthService(
      makePool(null, new Error('connection refused')),
      { maxRetries: 1 }
    );

    await expect(svc.check()).resolves.toBeDefined();
  });

  it('DBH-19 — check() resolves (does not throw) on query failure', async () => {
    const client = makeClient({
      query: vi.fn().mockRejectedValue(new Error('relation does not exist')),
    });
    const svc = new DbHealthService(makePool(client), { maxRetries: 1 });

    await expect(svc.check()).resolves.toBeDefined();
  });

  it('DBH-20 — authenticated=true only when pool.connect() + SELECT 1 succeed', async () => {
    const client = makeClient({
      query: vi.fn()
        .mockResolvedValueOnce({}) // SELECT 1 succeeds
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ exists: null }] }),
    });
    const svc = new DbHealthService(makePool(client), { maxRetries: 1 });

    const health = await svc.check();
    expect(health.authenticated).toBe(true);

    // Verify that a failed SELECT 1 produces authenticated=false
    const clientFail = makeClient({
      query: vi.fn().mockRejectedValue(new Error('auth failed')),
    });
    const svc2 = new DbHealthService(makePool(clientFail), { maxRetries: 1 });
    const health2 = await svc2.check();
    expect(health2.authenticated).toBe(false);
  });
});
