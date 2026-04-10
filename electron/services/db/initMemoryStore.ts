/**
 * Canonical Memory Store Initialization
 *
 * Clean entry point for bootstrapping the canonical memory repository.
 *
 * Bootstrap priority (via DatabaseBootstrapCoordinator):
 *  1. TALA_DB_CONNECTION_STRING env var   → use it directly
 *  2. bootstrapMode === 'external-only'   → use env/settings config as-is
 *  3. Tala-managed native runtime (default local-first path)
 *  4. Docker fallback (only if allowDockerFallback === true)
 *  5. Degraded mode                       → app continues without canonical memory
 *
 * If an explicit dbConfig override is supplied the coordinator is bypassed and
 * the supplied config is used directly (backward-compatible path for tests and
 * tooling that manage their own connection).
 *
 * This module is designed to be called during app startup without
 * forcing all other systems to depend on it.
 */

import { PostgresMemoryRepository } from './PostgresMemoryRepository';
import { DatabaseBootstrapCoordinator } from './DatabaseBootstrapCoordinator';
import { ResearchRepository } from './ResearchRepository';
import { ContentRepository } from './ContentRepository';
import { EmbeddingsRepository } from './EmbeddingsRepository';
import { DbHealthService } from './DbHealthService';
import type { CanonicalDbHealth } from './DbHealthService';
import type { DatabaseConfig } from '../../../shared/dbConfig';
import type { DatabaseBootstrapConfig } from '../../../shared/dbBootstrapConfig';
import type { MemoryRepository } from '../../../shared/memory/MemoryRepository';

/** Singleton repository reference. Null until initCanonicalMemory() succeeds. */
let _repository: MemoryRepository | null = null;

/** Singleton research repository — shares pool with _repository once initialized. */
let _researchRepository: ResearchRepository | null = null;

/** Singleton content repository — shares pool with _repository once initialized. */
let _contentRepository: ContentRepository | null = null;

/** Singleton embeddings repository — shares pool with _repository once initialized. */
let _embeddingsRepository: EmbeddingsRepository | null = null;

/**
 * Singleton coordinator reference.
 * Kept alive so shutdown() can stop the native runtime when the app exits.
 */
let _coordinator: DatabaseBootstrapCoordinator | null = null;

/**
 * Result of the most recent DB preflight health check.
 * Set during initCanonicalMemory() after the pool is created.
 */
let _lastDbHealth: CanonicalDbHealth | null = null;

export interface InitMemoryStoreOptions {
  /**
   * Override database configuration directly. When provided, the bootstrap
   * coordinator is skipped entirely. Environment variables still take
   * precedence over individual fields within this override.
   */
  dbConfig?: Partial<DatabaseConfig>;

  /** Override path to migrations directory. */
  migrationsDir?: string;

  /** If true, skip running migrations on init. */
  skipMigrations?: boolean;

  /**
   * Bootstrap configuration for the DatabaseBootstrapCoordinator.
   * Only used when dbConfig is not explicitly provided.
   * Mirrors the 'databaseBootstrap' section in app_settings.json.
   */
  bootstrapConfig?: Partial<DatabaseBootstrapConfig>;
}

/**
 * Initialize the canonical memory repository.
 *
 * When called without an explicit dbConfig, this function runs the
 * DatabaseBootstrapCoordinator to determine whether to start a
 * Tala-managed native PostgreSQL runtime, connect to a configured external
 * DB, or attempt a Docker fallback.
 *
 * Safe to call multiple times; returns the existing instance if already
 * initialized.
 */
export async function initCanonicalMemory(
  options: InitMemoryStoreOptions = {}
): Promise<MemoryRepository> {
  if (_repository) {
    console.log('[initCanonicalMemory] Already initialized, returning existing repository.');
    return _repository;
  }

  // ── Step 1: Resolve the database connection config ──────────────────────
  let resolvedConfig: Partial<DatabaseConfig> | undefined = options.dbConfig;

  if (!resolvedConfig) {
    // Run the bootstrap coordinator to determine the best available DB path.
    const coordinator = new DatabaseBootstrapCoordinator({
      bootstrapConfig: options.bootstrapConfig,
    });
    _coordinator = coordinator;

    const bootstrapResult = await coordinator.bootstrap();

    if (bootstrapResult.success) {
      resolvedConfig = bootstrapResult.config;
      console.log(
        `[initCanonicalMemory] Bootstrap succeeded via mode: ${bootstrapResult.mode}`
      );
    } else {
      // Degraded mode — still attempt to connect with best-effort config.
      // If the connection fails, main.ts handles the error non-fatally.
      resolvedConfig = bootstrapResult.config;
      console.warn(
        `[initCanonicalMemory] Bootstrap degraded (${bootstrapResult.error}). ` +
        `Attempting connection with resolved best-effort config — memory features may be unavailable.`
      );
    }
  }

  // ── Step 2: Connect and run migrations ──────────────────────────────────
  const repo = new PostgresMemoryRepository(resolvedConfig, options.migrationsDir);
  const resolvedHost = repo.getConfigSummary();
  console.log(`[initCanonicalMemory] Connecting to PostgreSQL at ${resolvedHost}`);

  try {
    await repo.initialize();

    // ── Step 2a: Preflight DB health check ──────────────────────────────
    // Run after pool creation so we can reuse the same connection, but before
    // migrations so the caller receives structured diagnostics on any gap.
    // maxRetries=1: the pool just connected successfully inside initialize(),
    // so a single probe is sufficient here. Retry policy for the broader
    // connection cycle is owned by DatabaseBootstrapCoordinator, not this check.
    // _lastDbHealth is set here — before runMigrations() — so it is always
    // available to callers even if a subsequent migration failure throws.
    const healthSvc = new DbHealthService(repo.getSharedPool(), { maxRetries: 1 });
    const health = await healthSvc.check();
    _lastDbHealth = health;

    if (!options.skipMigrations) {
      await repo.runMigrations();
    }

    _repository = repo;
    _researchRepository = new ResearchRepository(repo.getSharedPool());
    _contentRepository = new ContentRepository(repo.getSharedPool());
    _embeddingsRepository = new EmbeddingsRepository(repo.getSharedPool());
    console.log('[initCanonicalMemory] Canonical memory store ready.');
    return _repository;
  } catch (err) {
    console.error('[initCanonicalMemory] Failed to initialize canonical memory store:', err);
    // Attempt to clean up the pool on failure
    try {
      await repo.close();
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Get the initialized memory repository.
 * Returns null if not yet initialized.
 */
export function getCanonicalMemoryRepository(): MemoryRepository | null {
  return _repository;
}

/**
 * Get the initialized research repository.
 * Returns null if not yet initialized (canonical memory init must succeed first).
 */
export function getResearchRepository(): ResearchRepository | null {
  return _researchRepository;
}

/**
 * Get the initialized content repository.
 * Returns null if not yet initialized (canonical memory init must succeed first).
 */
export function getContentRepository(): ContentRepository | null {
  return _contentRepository;
}

/**
 * Get the initialized embeddings repository.
 * Returns null if not yet initialized (canonical memory init must succeed first).
 */
export function getEmbeddingsRepository(): EmbeddingsRepository | null {
  return _embeddingsRepository;
}

/**
 * Get the result of the most recent DB preflight health check.
 *
 * Returns `null` if `initCanonicalMemory()` has not been called yet, or if
 * `shutdownCanonicalMemory()` has been called since the last init.
 *
 * The result is set *before* migrations run inside `initCanonicalMemory()`,
 * so it is always populated after `initialize()` succeeds — even when a
 * subsequent migration error causes `initCanonicalMemory()` to throw.
 */
export function getLastDbHealth(): CanonicalDbHealth | null {
  return _lastDbHealth;
}

/**
 * Shut down the canonical memory store and any managed runtime.
 *
 * Closes the database connection pool and, if the Tala-managed native
 * PostgreSQL runtime is active, stops the postgres process.
 */
export async function shutdownCanonicalMemory(): Promise<void> {
  if (_repository) {
    await _repository.close();
    _repository = null;
    _researchRepository = null;
    _contentRepository = null;
    _embeddingsRepository = null;
    _lastDbHealth = null;
    console.log('[initCanonicalMemory] Canonical memory store shut down.');
  }

  if (_coordinator) {
    await _coordinator.shutdown();
    _coordinator = null;
  }
}
