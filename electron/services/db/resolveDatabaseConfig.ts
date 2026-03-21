/**
 * Database Configuration Resolver
 *
 * Resolves DatabaseConfig from environment variables, explicit overrides,
 * and defaults. This lives in the electron layer because it reads process.env.
 */

import { DEFAULT_DATABASE_CONFIG, type DatabaseConfig } from '../../../shared/dbConfig';

/**
 * Build a PostgreSQL connection string (DSN) from a DatabaseConfig.
 *
 * If the config already carries an explicit connectionString it is returned
 * unchanged.  Otherwise the DSN is composed from the individual host/port/
 * database/user/password fields so that MCP child processes receive a
 * single TALA_PG_DSN value regardless of how the parent was configured.
 */
export function buildPgDsn(config: DatabaseConfig): string {
  if (config.connectionString) {
    return config.connectionString;
  }

  const user = encodeURIComponent(config.user);
  const password = encodeURIComponent(config.password);
  const host = config.host;
  const port = config.port;
  const database = encodeURIComponent(config.database);
  const sslParam = config.ssl ? '?sslmode=require' : '';

  return `postgresql://${user}:${password}@${host}:${port}/${database}${sslParam}`;
}

/**
 * Resolve database configuration from environment and settings.
 * Environment variables take highest precedence, then explicit config, then defaults.
 */
export function resolveDatabaseConfig(overrides?: Partial<DatabaseConfig>): DatabaseConfig {
  const envConnString = process.env.TALA_DB_CONNECTION_STRING;
  const envHost = process.env.TALA_DB_HOST;
  const envPort = process.env.TALA_DB_PORT;
  const envDatabase = process.env.TALA_DB_NAME;
  const envUser = process.env.TALA_DB_USER;
  const envPassword = process.env.TALA_DB_PASSWORD;
  const envSsl = process.env.TALA_DB_SSL;

  const base: DatabaseConfig = {
    ...DEFAULT_DATABASE_CONFIG,
    ...overrides,
  };

  if (envConnString) {
    base.connectionString = envConnString;
  }
  if (envHost) base.host = envHost;
  if (envPort) base.port = parseInt(envPort, 10);
  if (envDatabase) base.database = envDatabase;
  if (envUser) base.user = envUser;
  if (envPassword) base.password = envPassword;
  if (envSsl !== undefined) base.ssl = envSsl === 'true' || envSsl === '1';

  return base;
}
