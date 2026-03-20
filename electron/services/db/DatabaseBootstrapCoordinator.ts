/**
 * Database Bootstrap Coordinator
 *
 * Orchestrates the full database bootstrap flow for the Tala application.
 *
 * Bootstrap priority order:
 *  1. TALA_DB_CONNECTION_STRING is set → use it directly (external DB)
 *  2. bootstrapMode === 'external-only' → use env/settings config as-is
 *  3. bootstrapMode === 'native' | 'auto' → start Tala-managed native runtime
 *  4. Docker fallback (only if allowDockerFallback === true in config/env)
 *  5. Degraded mode — app continues without canonical memory
 *
 * Docker is NOT started automatically by this coordinator. The Docker fallback
 * path only probes for an already-running Docker-managed instance started via
 * `npm run memory:up`. Starting Docker is a developer concern, not an app
 * startup concern.
 *
 * This module is Electron-layer only; it uses Node.js APIs and must not be
 * imported from shared/ or the renderer.
 */

import { resolveDatabaseBootstrapPlan, type BootstrapMode, type DatabaseBootstrapPlan } from './resolveDatabaseBootstrapPlan';
import { LocalDatabaseRuntime } from './LocalDatabaseRuntime';
import { PostgresProcessManager } from './PostgresProcessManager';
import { resolveDatabaseConfig } from './resolveDatabaseConfig';
import { probeTcpPort } from './probeTcpPort';
import type { DatabaseConfig } from '../../../shared/dbConfig';
import type { DatabaseBootstrapConfig } from '../../../shared/dbBootstrapConfig';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** The coordinator completed successfully and a DB config is available. */
export interface BootstrapSuccess {
  success: true;
  /** The bootstrap path that succeeded. */
  mode: BootstrapMode;
  /** Resolved database configuration to use for the connection pool. */
  config: DatabaseConfig;
  /** Whether the Tala-managed native runtime is currently running. */
  nativeRuntimeActive: boolean;
}

/** The coordinator could not establish a viable database path. */
export interface BootstrapDegraded {
  success: false;
  mode: 'degraded';
  /** Human-readable reason why bootstrap degraded. */
  error: string;
  /** A best-effort config that callers may attempt to use (likely to fail on connect). */
  config: DatabaseConfig;
}

export type BootstrapResult = BootstrapSuccess | BootstrapDegraded;

// ---------------------------------------------------------------------------
// Constructor options (support test injection)
// ---------------------------------------------------------------------------

export interface BootstrapCoordinatorOptions {
  /** Override bootstrap configuration (from app settings). */
  bootstrapConfig?: Partial<DatabaseBootstrapConfig>;
  /** Inject a pre-built LocalDatabaseRuntime (for testing). */
  runtime?: LocalDatabaseRuntime;
  /** Inject a pre-built PostgresProcessManager (for testing). */
  processManager?: PostgresProcessManager;
}

// ---------------------------------------------------------------------------
// DatabaseBootstrapCoordinator
// ---------------------------------------------------------------------------

/**
 * DatabaseBootstrapCoordinator
 *
 * Runs the bootstrap flow determined by resolveDatabaseBootstrapPlan and
 * returns the final DatabaseConfig to use for the PostgresMemoryRepository.
 *
 * One coordinator instance should be kept alive for the duration of the app
 * session so that shutdown() can cleanly stop the native runtime when the app
 * exits.
 */
export class DatabaseBootstrapCoordinator {
  private readonly options: BootstrapCoordinatorOptions;
  private _processManager: PostgresProcessManager | null = null;
  private _nativeRuntimeActive = false;

  constructor(options: BootstrapCoordinatorOptions = {}) {
    this.options = options;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run the bootstrap flow.
   *
   * Returns a BootstrapResult with the final DatabaseConfig. On degraded mode
   * the result carries success=false and an error description, but still
   * includes a best-effort config so callers can attempt a connection if they
   * wish (the connection will likely fail).
   */
  async bootstrap(): Promise<BootstrapResult> {
    const plan = resolveDatabaseBootstrapPlan(this.options.bootstrapConfig);

    console.log(`[DatabaseBootstrapCoordinator] Bootstrap plan: ${plan.mode}`);

    switch (plan.mode) {
      case 'external-connection-string':
        return this.bootstrapExternal(plan);

      case 'local-configured':
        return this.bootstrapLocalConfigured(plan);

      case 'native-runtime':
        return this.bootstrapNativeRuntime(plan);

      case 'docker-fallback':
        return this.bootstrapDockerFallback(plan);

      case 'degraded':
      default:
        return this.degraded(plan, 'No viable database bootstrap path configured.');
    }
  }

  /**
   * Shut down the native runtime if it was started by this coordinator.
   * Safe to call even if native runtime was never started.
   */
  async shutdown(): Promise<void> {
    if (this._processManager && this._nativeRuntimeActive) {
      console.log('[DatabaseBootstrapCoordinator] Shutting down native runtime...');
      await this._processManager.stop();
      this._nativeRuntimeActive = false;
      console.log('[DatabaseBootstrapCoordinator] Native runtime shut down.');
    }
  }

  /** Whether the Tala-managed native runtime is currently active. */
  isNativeRuntimeActive(): boolean {
    return this._nativeRuntimeActive;
  }

  // -------------------------------------------------------------------------
  // Bootstrap paths
  // -------------------------------------------------------------------------

  /** Use the externally-configured TALA_DB_CONNECTION_STRING directly. */
  private async bootstrapExternal(plan: DatabaseBootstrapPlan): Promise<BootstrapResult> {
    console.log('[DatabaseBootstrapCoordinator] Using external connection string.');
    const config = resolveDatabaseConfig();
    return { success: true, mode: plan.mode, config, nativeRuntimeActive: false };
  }

  /**
   * Use whatever env/settings database config is present without starting any
   * local runtime. Used when bootstrapMode === 'external-only'.
   */
  private async bootstrapLocalConfigured(plan: DatabaseBootstrapPlan): Promise<BootstrapResult> {
    console.log('[DatabaseBootstrapCoordinator] Using configured local database (external-only mode).');
    const config = resolveDatabaseConfig();
    return { success: true, mode: plan.mode, config, nativeRuntimeActive: false };
  }

  /** Start and use the Tala-managed native PostgreSQL runtime. */
  private async bootstrapNativeRuntime(plan: DatabaseBootstrapPlan): Promise<BootstrapResult> {
    console.log('[DatabaseBootstrapCoordinator] Attempting Tala-managed native runtime...');

    const runtime =
      this.options.runtime ??
      new LocalDatabaseRuntime({
        portOverride: plan.bootstrapConfig.localRuntime.portOverride,
        runtimePathOverride: plan.bootstrapConfig.localRuntime.runtimePathOverride,
        dataPathOverride: plan.bootstrapConfig.localRuntime.dataPathOverride,
      });

    const manager =
      this.options.processManager ?? new PostgresProcessManager(runtime);

    this._processManager = manager;

    // Check runtime asset availability before attempting startup
    if (!manager.checkRuntimeAssetsPresent()) {
      const paths = runtime.getRuntimePaths();
      console.warn(
        `[DatabaseBootstrapCoordinator] Native runtime assets not found.\n` +
        `  Runtime root: ${paths.runtimeRoot}\n\n` +
        `See docs/architecture/memory_bootstrap.md for installation instructions.`
      );

      if (plan.allowDockerFallback) {
        console.log('[DatabaseBootstrapCoordinator] Falling back to Docker...');
        return this.bootstrapDockerFallback(plan);
      }

      return this.degraded(
        plan,
        `Native runtime assets are not present at: ${paths.runtimeRoot}. ` +
        `Set TALA_DB_CONNECTION_STRING to connect to an existing PostgreSQL instance, ` +
        `or run 'npm run memory:up' to start via Docker.`
      );
    }

    // Warn if pgvector is missing — migrations will fail later, but we surface
    // the issue here so developers get a clear, early signal.
    if (!manager.checkPgvectorAvailable()) {
      console.warn(
        `[DatabaseBootstrapCoordinator] ⚠ pgvector extension library not found in native runtime assets.\n` +
        `  Runtime root: ${runtime.getRuntimeRoot()}\n` +
        `  Canonical memory store requires pgvector. Migrations may fail.\n` +
        `  See docs/architecture/memory_bootstrap.md for packaging instructions.`
      );
    }

    try {
      await manager.start();
      this._nativeRuntimeActive = true;
      const dbConfig = runtime.toDatabaseConfig();
      console.log(
        `[DatabaseBootstrapCoordinator] Native runtime ready — ` +
        `${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`
      );
      return {
        success: true,
        mode: 'native-runtime',
        config: dbConfig,
        nativeRuntimeActive: true,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[DatabaseBootstrapCoordinator] Native runtime startup failed:', msg);

      if (plan.allowDockerFallback) {
        console.log('[DatabaseBootstrapCoordinator] Native runtime failed, trying Docker fallback...');
        return this.bootstrapDockerFallback(plan);
      }

      return this.degraded(plan, `Native runtime startup failed: ${msg}`);
    }
  }

  /**
   * Docker fallback path.
   *
   * Only probes for an already-running Docker-managed PostgreSQL instance.
   * This coordinator does NOT start Docker; that is the developer's
   * responsibility via `npm run memory:up`.
   */
  private async bootstrapDockerFallback(plan: DatabaseBootstrapPlan): Promise<BootstrapResult> {
    console.log(
      '[DatabaseBootstrapCoordinator] Docker fallback: probing for running PostgreSQL...'
    );

    const config = resolveDatabaseConfig();
    const reachable = await probeTcpPort(config.host, config.port, 3_000);

    if (reachable) {
      console.log(
        `[DatabaseBootstrapCoordinator] Found running PostgreSQL at ` +
        `${config.host}:${config.port} (Docker or manual install).`
      );
      return { success: true, mode: 'docker-fallback', config, nativeRuntimeActive: false };
    }

    return this.degraded(
      plan,
      `Docker fallback attempted but no running PostgreSQL found at ` +
      `${config.host}:${config.port}. ` +
      `Run 'npm run memory:up' to start the Docker-based memory stack.`
    );
  }

  /** Produce a degraded result with a structured warning. */
  private degraded(plan: DatabaseBootstrapPlan, reason: string): BootstrapDegraded {
    const config = resolveDatabaseConfig();
    console.warn(
      `[DatabaseBootstrapCoordinator] ⚠ Database bootstrap degraded.\n` +
      `  Reason: ${reason}\n` +
      `  The application will continue but memory features will be unavailable.`
    );
    return { success: false, mode: 'degraded', error: reason, config };
  }
}

// (TCP probe utility lives in ./probeTcpPort.ts)
