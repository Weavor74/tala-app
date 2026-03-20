/**
 * Database Configuration Types
 *
 * Shared configuration schema for PostgreSQL connectivity.
 * Supports local-first operation with optional remote override.
 *
 * NOTE: Runtime resolution (environment variable reads) lives in
 * electron/services/db/resolveDatabaseConfig.ts to avoid Node.js
 * dependencies in shared/ (which is also compiled for the renderer).
 */

export interface DatabaseConfig {
  /** PostgreSQL connection string. Overrides individual fields when provided. */
  connectionString?: string;

  /** Database host. Defaults to 'localhost'. */
  host: string;

  /** Database port. Defaults to 5432. */
  port: number;

  /** Database name. */
  database: string;

  /** Database user. */
  user: string;

  /** Database password. */
  password: string;

  /** Enable SSL for remote connections. Defaults to false. */
  ssl: boolean;

  /** Maximum pool size. Defaults to 10. */
  poolMax: number;

  /** Idle timeout in milliseconds. Defaults to 30000. */
  idleTimeoutMs: number;

  /** Connection timeout in milliseconds. Defaults to 5000. */
  connectionTimeoutMs: number;
}

/** Default local-first database configuration. */
export const DEFAULT_DATABASE_CONFIG: DatabaseConfig = {
  host: 'localhost',
  port: 5432,
  database: 'tala',
  user: 'tala',
  password: 'tala',
  ssl: false,
  poolMax: 10,
  idleTimeoutMs: 30000,
  connectionTimeoutMs: 5000,
};

