/**
 * DbHealthService
 *
 * Deterministic Postgres preflight checker that verifies connectivity,
 * authentication, database availability, pgvector extension presence, and
 * schema migration state before the canonical memory subsystem is activated.
 *
 * Results are returned as a structured `CanonicalDbHealth` object so callers
 * can make informed decisions about whether to proceed, warn, or abort ignition.
 */

import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CanonicalDbHealth = {
  /** Whether a TCP/auth connection to Postgres succeeded. */
  reachable: boolean;
  /** Whether the pool authenticated successfully (separate signal from reachable). */
  authenticated: boolean;
  /** Whether the target database exists and is queryable. */
  databaseExists: boolean;
  /** Whether the pgvector extension is installed in this database. */
  pgvectorInstalled: boolean;
  /** Whether the schema_migrations table exists (i.e. migrations have been applied). */
  migrationsApplied: boolean;
  /** Human-readable error message if any check failed. */
  error?: string;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Performs a structured health check against a Postgres pool.
 *
 * Usage:
 *   const svc = new DbHealthService(pool);
 *   const health = await svc.check();
 *
 * The check is non-destructive — it only reads pg_extension and
 * to_regclass('public.schema_migrations').
 */
export class DbHealthService {
  /**
   * How many times to retry a failed health check before giving up.
   * Each retry is separated by `retryDelayMs` milliseconds.
   */
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly pool: Pool,
    options?: { maxRetries?: number; retryDelayMs?: number }
  ) {
    this.maxRetries = options?.maxRetries ?? 5;
    this.retryDelayMs = options?.retryDelayMs ?? 2000;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run the preflight check, retrying up to `maxRetries` times on failure.
   *
   * On success, returns a fully-populated `CanonicalDbHealth` with all
   * `reachable` / `authenticated` flags set to `true`.
   *
   * On exhausted retries, returns the last failed diagnostic object.
   */
  async check(): Promise<CanonicalDbHealth> {
    let last: CanonicalDbHealth = this._unreachable('Not yet checked');

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      last = await this._runOnce();

      if (last.reachable) {
        // Successfully reached Postgres — no need to retry.
        break;
      }

      const remaining = this.maxRetries - attempt - 1;
      if (remaining > 0) {
        console.warn(
          `[DBHealth] Attempt ${attempt + 1}/${this.maxRetries} failed ` +
          `(${last.error ?? 'unknown error'}). Retrying in ${this.retryDelayMs}ms…`
        );
        await this._sleep(this.retryDelayMs);
      }
    }

    this._logResult(last);
    return last;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _runOnce(): Promise<CanonicalDbHealth> {
    let client;
    try {
      client = await this.pool.connect();
    } catch (err: any) {
      return this._unreachable(err?.message ?? String(err));
    }

    try {
      // 1. Basic connectivity / authentication
      await client.query('SELECT 1');

      // 2. pgvector extension check
      const vectorRes = await client.query<{ extname: string }>(
        `SELECT extname FROM pg_extension WHERE extname = 'vector'`
      );

      // 3. Migrations table existence check
      const migrationsRes = await client.query<{ exists: string | null }>(
        `SELECT to_regclass('public.schema_migrations') AS exists`
      );

      return {
        reachable: true,
        authenticated: true,
        databaseExists: true,
        pgvectorInstalled: vectorRes.rows.length > 0,
        migrationsApplied: !!migrationsRes.rows[0]?.exists,
      };
    } catch (err: any) {
      return this._unreachable(err?.message ?? String(err));
    } finally {
      client.release();
    }
  }

  private _unreachable(errorMessage: string): CanonicalDbHealth {
    return {
      reachable: false,
      authenticated: false,
      databaseExists: false,
      pgvectorInstalled: false,
      migrationsApplied: false,
      error: errorMessage,
    };
  }

  private _logResult(health: CanonicalDbHealth): void {
    if (health.reachable) {
      console.log(
        `[DBHealth] reachable=true authenticated=true` +
        ` pgvector=${health.pgvectorInstalled} migrations=${health.migrationsApplied}`
      );
      if (!health.pgvectorInstalled) {
        console.warn('[DBHealth] pgvector extension not installed — vector search will be unavailable');
      }
      if (!health.migrationsApplied) {
        console.warn('[DBHealth] schema_migrations table not found — schema may not be initialized');
      }
    } else {
      console.error(`[DBHealth] reachable=false error=${health.error ?? 'unknown'}`);
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
