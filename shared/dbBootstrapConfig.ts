/**
 * Database Bootstrap Configuration Types
 *
 * Shared type definitions for the database bootstrap/runtime system.
 * Lives in shared/ as pure types with no Node.js dependencies,
 * so it is safe to import from both the renderer and the Electron main process.
 *
 * Runtime resolution (process.env reads, path logic) lives in
 * electron/services/db/resolveDatabaseBootstrapPlan.ts.
 */

/**
 * Bootstrap mode controls which path the DatabaseBootstrapCoordinator takes.
 *
 * - 'auto':          Try native runtime first; fall back to Docker if allowed; degrade if neither works.
 * - 'native':        Only attempt the Tala-managed native PostgreSQL runtime.
 * - 'docker':        Only attempt Docker (explicit developer convenience override).
 * - 'external-only': Only use a pre-configured external DB; never start a local runtime.
 */
export type DatabaseBootstrapMode = 'auto' | 'native' | 'docker' | 'external-only';

/**
 * Configuration for the local native PostgreSQL runtime managed by Tala.
 */
export interface LocalRuntimeConfig {
  /** Whether the local native runtime is enabled. Defaults to true. */
  enabled: boolean;

  /**
   * Override the TCP port for the local runtime.
   * Defaults to 5432.
   */
  portOverride?: number;

  /**
   * Override the runtime root path (directory containing the PostgreSQL binaries).
   * When undefined, Tala resolves this based on the platform data directory.
   */
  runtimePathOverride?: string;

  /**
   * Override the data directory path for the PostgreSQL cluster.
   * When undefined, Tala resolves this based on the platform data directory.
   */
  dataPathOverride?: string;
}

/**
 * Configuration for the database bootstrap/runtime system.
 */
export interface DatabaseBootstrapConfig {
  /**
   * Controls which bootstrap path is taken.
   * Defaults to 'auto'.
   */
  bootstrapMode: DatabaseBootstrapMode;

  /**
   * Whether Docker is allowed as a fallback when native runtime is unavailable.
   * Only meaningful when bootstrapMode is 'auto'.
   * Defaults to false — Docker is not assumed to be present.
   */
  allowDockerFallback: boolean;

  /** Local native runtime configuration. */
  localRuntime: LocalRuntimeConfig;
}

/** Default bootstrap configuration: auto-mode, native runtime enabled, no Docker assumed. */
export const DEFAULT_DATABASE_BOOTSTRAP_CONFIG: DatabaseBootstrapConfig = {
  bootstrapMode: 'auto',
  allowDockerFallback: false,
  localRuntime: {
    enabled: true,
  },
};
