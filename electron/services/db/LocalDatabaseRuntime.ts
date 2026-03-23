/**
 * Local Database Runtime
 *
 * Resolves portable, app-root-relative paths and connection settings for the
 * Tala-managed native PostgreSQL runtime.
 *
 * Default Resolution (AppRoot-relative):
 *   Runtime Root: [APP_ROOT]/runtime/postgres/  — bundled binaries (read-only)
 *   Data Root:    [APP_ROOT]/data/postgres/     — cluster data (writable)
 *   Logs Root:    [APP_ROOT]/data/logs/postgres/ — server logs (writable)
 *
 * Resolution Order:
 *   1. Explicit settings override (absolute or relative to AppRoot/DataRoot)
 *   2. Portable AppRoot-relative default
 *
 * This module is Electron-layer only; it uses Node.js APIs and PathResolver,
 * and must not be imported from shared/ or the renderer.
 */

import path from 'path';
import type { DatabaseConfig } from '../../../shared/dbConfig';
import { resolveRuntimePath, resolveDataPath } from '../PathResolver';

/** Resolved path set for the local runtime. */
export interface RuntimePaths {
  /** Root directory for bundled PostgreSQL binaries. */
  runtimeRoot: string;
  /** PostgreSQL cluster data directory. */
  dataRoot: string;
  /** Directory for PostgreSQL server log files. */
  logsRoot: string;
  /** Directory containing the PostgreSQL executables (postgres, initdb, pg_ctl, psql). */
  binDir: string;
}

/** Resolved paths for the core PostgreSQL executables. */
export interface RuntimeBinaryPaths {
  postgres: string;
  initdb: string;
  pgCtl: string;
  psql: string;
}

/** Localhost-only connection settings for the local native runtime. */
export interface LocalRuntimeConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

/** Construction options for LocalDatabaseRuntime. */
export interface LocalDatabaseRuntimeOptions {
  /** Override the TCP port. Defaults to 5432. */
  portOverride?: number;
  /** Override the runtime root path (directory with postgres binaries). */
  runtimePathOverride?: string;
  /** Override the data directory path for the cluster. */
  dataPathOverride?: string;
}

/**
 * LocalDatabaseRuntime
 *
 * Provides deterministic path resolution and connection config for the
 * Tala-managed native PostgreSQL runtime. Does not perform any I/O itself.
 */
export class LocalDatabaseRuntime {
  private readonly options: LocalDatabaseRuntimeOptions;
  private readonly platform: NodeJS.Platform;

  constructor(options: LocalDatabaseRuntimeOptions = {}) {
    this.options = options;
    this.platform = process.platform;
  }

  /**
   * Runtime root: directory containing the bundled PostgreSQL binaries.
   * In a packaged release, binaries are typically in APP_ROOT/runtime/postgres.
   */
  getRuntimeRoot(): string {
    return resolveRuntimePath('postgres', this.options.runtimePathOverride);
  }

  /**
   * Data root: PostgreSQL cluster data directory.
   * Tala initialises this via initdb on first run and writes cluster data here.
   */
  getDataRoot(): string {
    return resolveDataPath('postgres', this.options.dataPathOverride);
  }

  /** Logs root: directory for PostgreSQL server log files. */
  getLogsRoot(): string {
    return resolveDataPath(path.join('logs', 'postgres'));
  }

  /** Directory containing the PostgreSQL executables within the runtime root. */
  getBinDir(): string {
    return path.join(this.getRuntimeRoot(), 'bin');
  }

  /**
   * Resolved paths for the core PostgreSQL executables.
   * On Windows, executables carry a .exe extension.
   */
  getBinaryPaths(): RuntimeBinaryPaths {
    const binDir = this.getBinDir();
    const ext = this.platform === 'win32' ? '.exe' : '';
    return {
      postgres: path.join(binDir, `postgres${ext}`),
      initdb: path.join(binDir, `initdb${ext}`),
      pgCtl: path.join(binDir, `pg_ctl${ext}`),
      psql: path.join(binDir, `psql${ext}`),
    };
  }

  /** All runtime paths in a single descriptor. */
  getRuntimePaths(): RuntimePaths {
    return {
      runtimeRoot: this.getRuntimeRoot(),
      dataRoot: this.getDataRoot(),
      logsRoot: this.getLogsRoot(),
      binDir: this.getBinDir(),
    };
  }

  /** TCP port for the local native runtime. */
  getPort(): number {
    return this.options.portOverride ?? 5432;
  }

  /**
   * Connection configuration for the Tala-managed local runtime.
   * Always binds to 127.0.0.1 only — never exposed to the network.
   */
  getConnectionConfig(): LocalRuntimeConnectionConfig {
    return {
      host: '127.0.0.1',
      port: this.getPort(),
      database: 'tala',
      user: 'tala',
      // Local-only default password; not a secret since the port is not network-exposed.
      password: 'tala_local',
      ssl: false,
    };
  }

  /** PostgreSQL connection string for the local native runtime. */
  getConnectionString(): string {
    const cfg = this.getConnectionConfig();
    return `postgresql://${cfg.user}:${cfg.password}@${cfg.host}:${cfg.port}/${cfg.database}`;
  }

  /** Convert to a full DatabaseConfig object for use with PostgresMemoryRepository. */
  toDatabaseConfig(): DatabaseConfig {
    const cfg = this.getConnectionConfig();
    return {
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      ssl: cfg.ssl,
      poolMax: 5,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 5_000,
    };
  }

  /** Human-readable summary of this runtime configuration (no passwords). */
  describe(): string {
    const paths = this.getRuntimePaths();
    return [
      `  Platform:     ${this.platform}`,
      `  Runtime root: ${paths.runtimeRoot}`,
      `  Data dir:     ${paths.dataRoot}`,
      `  Logs dir:     ${paths.logsRoot}`,
      `  Port:         ${this.getPort()}`,
    ].join('\n');
  }
}
