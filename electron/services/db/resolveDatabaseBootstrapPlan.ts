/**
 * Database Bootstrap Plan Resolution
 *
 * Determines which bootstrap path the DatabaseBootstrapCoordinator should take,
 * based on environment variables and the resolved bootstrap configuration.
 *
 * This is an Electron-layer module (reads process.env) and must not be imported
 * from shared/ or the renderer.
 *
 * Bootstrap priority order:
 *  1. TALA_DB_CONNECTION_STRING env var → external-connection-string
 *  2. bootstrapMode === 'external-only' → local-configured (use env/settings as-is)
 *  3. bootstrapMode === 'docker' → docker-fallback (explicit developer override)
 *  4. bootstrapMode === 'native' | 'auto' (default) → native-runtime
 *  5. Fallback → degraded
 */

import {
  type DatabaseBootstrapConfig,
  DEFAULT_DATABASE_BOOTSTRAP_CONFIG,
} from '../../../shared/dbBootstrapConfig';

/**
 * The resolved bootstrap path that the coordinator will execute.
 *
 * - 'external-connection-string': Use TALA_DB_CONNECTION_STRING directly.
 * - 'local-configured': Use whatever env/settings config is present; no runtime startup.
 * - 'native-runtime': Start the Tala-managed native PostgreSQL runtime.
 * - 'docker-fallback': Probe for a Docker-managed PostgreSQL instance.
 * - 'degraded': No viable path found; app continues without memory.
 */
export type BootstrapMode =
  | 'external-connection-string'
  | 'local-configured'
  | 'native-runtime'
  | 'docker-fallback'
  | 'degraded';

/** Resolved bootstrap plan passed to DatabaseBootstrapCoordinator. */
export interface DatabaseBootstrapPlan {
  /** Which bootstrap path to take. */
  mode: BootstrapMode;

  /** Whether Docker is allowed as a secondary fallback from native-runtime. */
  allowDockerFallback: boolean;

  /** The fully-merged bootstrap configuration used to produce this plan. */
  bootstrapConfig: DatabaseBootstrapConfig;
}

/** Valid bootstrap mode values, used for both validation and error messages. */
const VALID_BOOTSTRAP_MODES = ['auto', 'native', 'docker', 'external-only'] as const;

/**
 * Resolve the database bootstrap plan from the current environment and config.
 *
 * @param overrides  Partial bootstrap configuration from app settings.
 * @returns          The resolved DatabaseBootstrapPlan.
 */
export function resolveDatabaseBootstrapPlan(
  overrides?: Partial<DatabaseBootstrapConfig>
): DatabaseBootstrapPlan {
  const config: DatabaseBootstrapConfig = {
    ...DEFAULT_DATABASE_BOOTSTRAP_CONFIG,
    ...overrides,
    localRuntime: {
      ...DEFAULT_DATABASE_BOOTSTRAP_CONFIG.localRuntime,
      ...overrides?.localRuntime,
    },
  };

  // Environment variable can override bootstrap mode at the highest level
  const envBootstrapMode = process.env.TALA_DB_BOOTSTRAP_MODE;
  if (envBootstrapMode) {
    if ((VALID_BOOTSTRAP_MODES as readonly string[]).includes(envBootstrapMode)) {
      config.bootstrapMode = envBootstrapMode as DatabaseBootstrapConfig['bootstrapMode'];
    } else {
      console.warn(
        `[resolveDatabaseBootstrapPlan] Ignoring invalid TALA_DB_BOOTSTRAP_MODE value: "${envBootstrapMode}". ` +
        `Valid values: ${VALID_BOOTSTRAP_MODES.join(' | ')}`
      );
    }
  }

  const envAllowDocker = process.env.TALA_DB_ALLOW_DOCKER_FALLBACK;
  if (envAllowDocker !== undefined) {
    config.allowDockerFallback = envAllowDocker === 'true' || envAllowDocker === '1';
  }

  // Priority 1: Explicit remote/external connection string
  if (process.env.TALA_DB_CONNECTION_STRING) {
    return {
      mode: 'external-connection-string',
      allowDockerFallback: false,
      bootstrapConfig: config,
    };
  }

  // Priority 2: external-only mode — use env/settings config, no local runtime startup
  if (config.bootstrapMode === 'external-only') {
    return {
      mode: 'local-configured',
      allowDockerFallback: false,
      bootstrapConfig: config,
    };
  }

  // Priority 3: Docker-only mode (explicit developer override)
  if (config.bootstrapMode === 'docker') {
    return {
      mode: 'docker-fallback',
      allowDockerFallback: true,
      bootstrapConfig: config,
    };
  }

  // Priority 4: native or auto — attempt the Tala-managed native runtime
  if (
    (config.bootstrapMode === 'native' || config.bootstrapMode === 'auto') &&
    config.localRuntime.enabled
  ) {
    return {
      mode: 'native-runtime',
      // In auto mode, Docker fallback is permitted when explicitly enabled
      allowDockerFallback:
        config.bootstrapMode === 'auto' && config.allowDockerFallback,
      bootstrapConfig: config,
    };
  }

  // Fallback: degraded (localRuntime disabled + no other path configured)
  return {
    mode: 'degraded',
    allowDockerFallback: config.allowDockerFallback,
    bootstrapConfig: config,
  };
}
