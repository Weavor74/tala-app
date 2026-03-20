/**
 * PostgreSQL Process Manager
 *
 * Manages the lifecycle of the Tala-managed native PostgreSQL process:
 *   - Validates runtime binary assets are present
 *   - Initialises the PostgreSQL cluster (initdb) on first run
 *   - Starts and stops the postgres server process
 *   - Probes readiness via TCP
 *   - Reports pgvector extension availability
 *
 * This module is Electron-layer only; it uses Node.js APIs (fs, child_process,
 * net) and must not be imported from shared/ or the renderer.
 */

import fs from 'fs';
import path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { probeTcpPort } from './probeTcpPort';
import type { LocalDatabaseRuntime } from './LocalDatabaseRuntime';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the Tala-managed PostgreSQL runtime binary assets are absent.
 * Provides actionable guidance on resolution paths.
 */
export class MissingRuntimeAssetsError extends Error {
  constructor(expectedBinaryPath: string, platform: NodeJS.Platform) {
    super(
      `Tala-managed PostgreSQL runtime assets are not present.\n` +
      `Expected binary: ${expectedBinaryPath}\n` +
      `Platform: ${platform}\n\n` +
      `To use the Tala-managed native runtime, the PostgreSQL binaries must be ` +
      `present in the runtime root directory.\n` +
      `See docs/architecture/memory_bootstrap.md for setup instructions.\n\n` +
      `Alternatives:\n` +
      `  1. Set TALA_DB_CONNECTION_STRING to connect to an existing PostgreSQL instance.\n` +
      `  2. Run "npm run memory:up" to start a Docker-based PostgreSQL (requires Docker).\n` +
      `  3. Install PostgreSQL manually and set TALA_DB_HOST / TALA_DB_PORT / TALA_DB_USER / TALA_DB_PASSWORD.`
    );
    this.name = 'MissingRuntimeAssetsError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for constructing a PostgresProcessManager. */
export interface ProcessManagerOptions {
  /** Maximum milliseconds to wait for PostgreSQL to become ready after start. */
  startupTimeoutMs?: number;
  /** Maximum milliseconds to wait for PostgreSQL to stop cleanly. */
  shutdownTimeoutMs?: number;
}

/** Options for cluster initialisation. */
export interface ClusterInitOptions {
  /** Database cluster encoding. Defaults to 'UTF8'. */
  encoding?: string;
  /** Locale to pass to initdb. Defaults to platform default. */
  locale?: string;
}

/** Current lifecycle state of the managed postgres process. */
export type PostgresProcessState =
  | 'unknown'
  | 'not-initialized'
  | 'initialized'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'error';

// ---------------------------------------------------------------------------
// PostgresProcessManager
// ---------------------------------------------------------------------------

/**
 * PostgresProcessManager
 *
 * Manages the lifecycle of a single Tala-managed native PostgreSQL process.
 * Callers interact through start(), stop(), and the readiness/asset checks.
 */
export class PostgresProcessManager {
  private readonly runtime: LocalDatabaseRuntime;
  private readonly options: Required<ProcessManagerOptions>;
  private postgresProcess: ChildProcess | null = null;
  private _state: PostgresProcessState = 'unknown';

  constructor(runtime: LocalDatabaseRuntime, options: ProcessManagerOptions = {}) {
    this.runtime = runtime;
    this.options = {
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 10_000,
    };
  }

  /** Current lifecycle state of the managed process. */
  getState(): PostgresProcessState {
    return this._state;
  }

  // -------------------------------------------------------------------------
  // Asset checks
  // -------------------------------------------------------------------------

  /**
   * Check whether the runtime binary assets are present on disk.
   * Does not throw — returns false if assets are missing.
   */
  checkRuntimeAssetsPresent(): boolean {
    const bins = this.runtime.getBinaryPaths();
    return fs.existsSync(bins.postgres);
  }

  /**
   * Assert that runtime binary assets are present; throw MissingRuntimeAssetsError if not.
   */
  assertRuntimeAssetsPresent(): void {
    const bins = this.runtime.getBinaryPaths();
    if (!fs.existsSync(bins.postgres)) {
      throw new MissingRuntimeAssetsError(bins.postgres, process.platform);
    }
  }

  /**
   * Check whether the pgvector shared library is present in the runtime assets.
   * pgvector is required by Tala's canonical memory store.
   */
  checkPgvectorAvailable(): boolean {
    const runtimeRoot = this.runtime.getRuntimeRoot();
    const candidates =
      process.platform === 'win32'
        ? [
            path.join(runtimeRoot, 'lib', 'vector.dll'),
            path.join(runtimeRoot, 'share', 'extension', 'vector.control'),
          ]
        : [
            path.join(runtimeRoot, 'lib', 'postgresql', 'vector.so'),
            path.join(runtimeRoot, 'lib', 'vector.so'),
            path.join(runtimeRoot, 'share', 'extension', 'vector.control'),
          ];
    return candidates.some((p) => fs.existsSync(p));
  }

  /**
   * Assert that the pgvector extension is available; throw an informative error if not.
   */
  assertPgvectorAvailable(): void {
    if (!this.checkPgvectorAvailable()) {
      const runtimeRoot = this.runtime.getRuntimeRoot();
      throw new Error(
        `[PostgresProcessManager] pgvector extension library is not present in the runtime assets.\n` +
        `Runtime root: ${runtimeRoot}\n\n` +
        `Tala's canonical memory store requires pgvector for vector embeddings.\n` +
        `Ensure your PostgreSQL runtime bundle includes the pgvector extension.\n` +
        `See docs/architecture/memory_bootstrap.md for packaging instructions.`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Cluster initialisation
  // -------------------------------------------------------------------------

  /** Whether the PostgreSQL cluster data directory is already initialised. */
  isClusterInitialized(): boolean {
    const dataRoot = this.runtime.getDataRoot();
    return fs.existsSync(path.join(dataRoot, 'PG_VERSION'));
  }

  /**
   * Initialise the PostgreSQL cluster using initdb.
   * Idempotent — does nothing if the cluster is already initialised.
   *
   * After initdb, writes a postgresql.conf fragment that pins the runtime to
   * localhost-only binding, the configured port, and the logs directory.
   */
  async initCluster(opts: ClusterInitOptions = {}): Promise<void> {
    this.assertRuntimeAssetsPresent();

    if (this.isClusterInitialized()) {
      console.log('[PostgresProcessManager] Cluster already initialised, skipping initdb.');
      this._state = 'initialized';
      return;
    }

    const bins = this.runtime.getBinaryPaths();
    const dataDir = this.runtime.getDataRoot();
    const conn = this.runtime.getConnectionConfig();

    // Ensure directories exist
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(this.runtime.getLogsRoot(), { recursive: true });

    console.log(`[PostgresProcessManager] Initialising cluster at: ${dataDir}`);

    // Write password to a temporary file to avoid leaking it on the command line
    const pwFile = path.join(dataDir, '.pg_init_pwfile');
    fs.writeFileSync(pwFile, conn.password, { mode: 0o600 });

    const args: string[] = [
      '-D', dataDir,
      '-U', conn.user,
      '--pwfile', pwFile,
      '--auth', 'md5',
      '--encoding', opts.encoding ?? 'UTF8',
    ];
    if (opts.locale) {
      args.push('--locale', opts.locale);
    }

    const result = spawnSync(bins.initdb, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });

    // Always remove the password file, even on failure
    try { fs.unlinkSync(pwFile); } catch (cleanupErr) {
      console.warn('[PostgresProcessManager] Could not remove initdb password file:', cleanupErr);
    }

    if (result.status !== 0) {
      const stderr = result.stderr ?? '';
      const stdout = result.stdout ?? '';
      this._state = 'error';
      throw new Error(
        `[PostgresProcessManager] initdb failed (exit ${result.status}):\n${stdout}\n${stderr}`
      );
    }

    // Pin the runtime to localhost only and configure logging
    this.writeRuntimeConfigOverrides();

    this._state = 'initialized';
    console.log('[PostgresProcessManager] Cluster initialised successfully.');
  }

  /**
   * Append Tala-managed runtime overrides to postgresql.conf.
   * Ensures the server only listens on 127.0.0.1 and writes logs to the
   * configured logs directory.
   */
  private writeRuntimeConfigOverrides(): void {
    const dataDir = this.runtime.getDataRoot();
    const conn = this.runtime.getConnectionConfig();
    const logsDir = this.runtime.getLogsRoot();
    const confPath = path.join(dataDir, 'postgresql.conf');

    // Normalise path separators for postgresql.conf (forward slashes on all platforms)
    const logsDirConf = logsDir.replace(/\\/g, '/');

    const overrides = [
      '',
      '# ── Tala-managed runtime overrides ────────────────────────────────────',
      `listen_addresses = '127.0.0.1'`,
      `port = ${conn.port}`,
      `log_directory = '${logsDirConf}'`,
      `log_filename = 'postgresql-%Y-%m-%d.log'`,
      `logging_collector = on`,
      `log_min_messages = warning`,
      `# ────────────────────────────────────────────────────────────────────────`,
      '',
    ].join('\n');

    const existing = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : '';
    fs.writeFileSync(confPath, existing + overrides, 'utf8');
  }

  // -------------------------------------------------------------------------
  // Process lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the Tala-managed PostgreSQL server.
   * Initialises the cluster first if needed.
   * Waits until the server accepts TCP connections before returning.
   */
  async start(): Promise<void> {
    if (this._state === 'running') {
      console.log('[PostgresProcessManager] Already running.');
      return;
    }

    this.assertRuntimeAssetsPresent();

    if (!this.isClusterInitialized()) {
      await this.initCluster();
    }

    const bins = this.runtime.getBinaryPaths();
    const dataDir = this.runtime.getDataRoot();
    const logsDir = this.runtime.getLogsRoot();
    const conn = this.runtime.getConnectionConfig();

    fs.mkdirSync(logsDir, { recursive: true });

    console.log(
      `[PostgresProcessManager] Starting PostgreSQL on 127.0.0.1:${conn.port}, data dir: ${dataDir}`
    );

    const logFile = path.join(logsDir, 'postgres.log');
    const args: string[] = [
      '-D', dataDir,
      // -k sets the Unix-domain socket directory; passing an empty string
      // configures it to the data directory itself (PostgreSQL default), which
      // is safe. The key security constraint is listen_addresses='127.0.0.1'
      // written by writeRuntimeConfigOverrides(), not this flag.
      '-k', '',
      '-h', '127.0.0.1',
      '-p', String(conn.port),
    ];

    this._state = 'starting';

    this.postgresProcess = spawn(bins.postgres, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Tee stdout/stderr to the log file
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    this.postgresProcess.stdout?.pipe(logStream);
    this.postgresProcess.stderr?.pipe(logStream);

    this.postgresProcess.on('exit', (code, signal) => {
      console.warn(
        `[PostgresProcessManager] PostgreSQL process exited (code=${code}, signal=${signal})`
      );
      if (this._state === 'running' || this._state === 'starting') {
        this._state = 'stopped';
      }
      this.postgresProcess = null;
    });

    this.postgresProcess.on('error', (err) => {
      console.error('[PostgresProcessManager] Process error:', err);
      this._state = 'error';
    });

    await this.waitReady();
    this._state = 'running';
    console.log(`[PostgresProcessManager] PostgreSQL is ready on port ${conn.port}.`);
  }

  /**
   * Stop the running PostgreSQL server.
   * Prefers a clean shutdown via pg_ctl; falls back to SIGTERM / SIGKILL.
   */
  async stop(): Promise<void> {
    if (!this.postgresProcess && this._state !== 'running') {
      this._state = 'stopped';
      return;
    }

    console.log('[PostgresProcessManager] Stopping PostgreSQL...');
    this._state = 'stopping';

    const bins = this.runtime.getBinaryPaths();
    const dataDir = this.runtime.getDataRoot();

    // Prefer pg_ctl for a clean, orderly shutdown
    if (fs.existsSync(bins.pgCtl)) {
      const result = spawnSync(bins.pgCtl, ['-D', dataDir, 'stop', '-m', 'fast'], {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: this.options.shutdownTimeoutMs,
      });
      if (result.status === 0) {
        this.postgresProcess = null;
        this._state = 'stopped';
        console.log('[PostgresProcessManager] PostgreSQL stopped cleanly via pg_ctl.');
        return;
      }
    }

    // Fallback: signal the child process directly
    if (this.postgresProcess) {
      this.postgresProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.postgresProcess?.kill('SIGKILL');
          resolve();
        }, this.options.shutdownTimeoutMs);
        this.postgresProcess?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    this.postgresProcess = null;
    this._state = 'stopped';
    console.log('[PostgresProcessManager] PostgreSQL stopped.');
  }

  // -------------------------------------------------------------------------
  // Readiness probe
  // -------------------------------------------------------------------------

  /**
   * Poll the local TCP port until PostgreSQL accepts connections or the
   * startup timeout elapses.
   */
  async waitReady(): Promise<void> {
    const conn = this.runtime.getConnectionConfig();
    const deadline = Date.now() + this.options.startupTimeoutMs;

    while (Date.now() < deadline) {
      if (await probeTcpPort(conn.host, conn.port)) {
        return;
      }
      await sleep(500);
    }

    throw new Error(
      `[PostgresProcessManager] Timed out waiting for PostgreSQL to be ready on ` +
      `${conn.host}:${conn.port} after ${this.options.startupTimeoutMs}ms. ` +
      `Check logs at: ${this.getLogPath()}`
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Absolute path to the PostgreSQL server log file. */
  getLogPath(): string {
    return path.join(this.runtime.getLogsRoot(), 'postgres.log');
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
