/**
 * Canonical Memory Store Initialization
 *
 * Clean entry point for bootstrapping the canonical memory repository.
 * Reads DB config, constructs PostgresMemoryRepository, runs migrations,
 * and exposes the initialized repository for downstream consumers.
 *
 * This module is designed to be called during app startup without
 * forcing all other systems to depend on it.
 */

import { PostgresMemoryRepository } from './PostgresMemoryRepository';
import type { DatabaseConfig } from '../../../shared/dbConfig';
import type { MemoryRepository } from '../../../shared/memory/MemoryRepository';

/** Singleton reference. Null until initCanonicalMemory() succeeds. */
let _repository: MemoryRepository | null = null;

export interface InitMemoryStoreOptions {
  /** Override database configuration. Environment variables still take precedence. */
  dbConfig?: Partial<DatabaseConfig>;
  /** Override path to migrations directory. */
  migrationsDir?: string;
  /** If true, skip running migrations on init. */
  skipMigrations?: boolean;
}

/**
 * Initialize the canonical memory repository.
 * Safe to call multiple times; returns the existing instance if already initialized.
 */
export async function initCanonicalMemory(
  options: InitMemoryStoreOptions = {}
): Promise<MemoryRepository> {
  if (_repository) {
    console.log('[initCanonicalMemory] Already initialized, returning existing repository.');
    return _repository;
  }

  const repo = new PostgresMemoryRepository(options.dbConfig, options.migrationsDir);
  const resolvedHost = repo.getConfigSummary();
  console.log(`[initCanonicalMemory] Connecting to PostgreSQL at ${resolvedHost}`);

  try {
    await repo.initialize();

    if (!options.skipMigrations) {
      await repo.runMigrations();
    }

    _repository = repo;
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
 * Shut down the canonical memory store.
 */
export async function shutdownCanonicalMemory(): Promise<void> {
  if (_repository) {
    await _repository.close();
    _repository = null;
    console.log('[initCanonicalMemory] Canonical memory store shut down.');
  }
}
