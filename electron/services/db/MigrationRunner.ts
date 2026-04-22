/**
 * SQL Migration Runner
 *
 * Finds SQL migration files in the migrations directory, tracks applied
 * migrations in a schema_migrations table, and executes unapplied ones
 * in filename order.
 */

import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';
import { resolveAppPath } from '../PathResolver';

export interface MigrationRecord {
  version: string;
  applied_at: Date;
}

export class MigrationRunner {
  private pool: Pool;
  private migrationsDir: string;

  constructor(pool: Pool, migrationsDir?: string) {
    this.pool = pool;
    // Default: look for migrations relative to this file's compiled location.
    // In production the compiled JS lives in dist-electron/electron/services/db/
    // and migrations in dist-electron/electron/migrations/.
    // In dev, resolve from the source tree.
    this.migrationsDir = migrationsDir ?? this.resolveDefaultMigrationsDir();
  }

  private resolveDefaultMigrationsDir(): string {
    // Walk up from this file to find the migrations directory.
    // Works for both source (electron/services/db/) and compiled (dist-electron/electron/services/db/).
    const candidates = [
      path.resolve(__dirname, '../../migrations'),        // compiled: dist-electron/electron/services/db -> dist-electron/electron/migrations
      path.resolve(__dirname, '../../../electron/migrations'), // compiled fallback
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    // Fallback: resolve from app root so runtime is launch-location agnostic.
    return resolveAppPath(path.join('electron', 'migrations'));
  }

  /**
   * Ensure the schema_migrations tracking table exists.
   */
  async ensureMigrationsTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  /**
   * Return list of already-applied migration versions.
   */
  async getAppliedMigrations(): Promise<string[]> {
    const result = await this.pool.query<MigrationRecord>(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    return result.rows.map(r => r.version);
  }

  /**
   * Discover SQL migration files sorted by filename.
   */
  discoverMigrations(): string[] {
    if (!fs.existsSync(this.migrationsDir)) {
      console.warn(`[MigrationRunner] Migrations directory not found: ${this.migrationsDir}`);
      return [];
    }
    return fs.readdirSync(this.migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
  }

  /**
   * Run all unapplied migrations in order.
   * Each migration runs in its own transaction where possible.
   */
  async runAll(): Promise<string[]> {
    await this.ensureMigrationsTable();

    const applied = new Set(await this.getAppliedMigrations());
    const files = this.discoverMigrations();
    const executed: string[] = [];

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) {
        continue;
      }

      const filePath = path.join(this.migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      console.log(`[MigrationRunner] Applying migration: ${version}`);

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [version]
        );
        await client.query('COMMIT');
        executed.push(version);
        console.log(`[MigrationRunner] Applied: ${version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[MigrationRunner] Failed to apply migration ${version}:`, err);
        throw err;
      } finally {
        client.release();
      }
    }

    if (executed.length === 0) {
      console.log('[MigrationRunner] All migrations are up to date.');
    } else {
      console.log(`[MigrationRunner] Applied ${executed.length} migration(s).`);
    }

    return executed;
  }
}
