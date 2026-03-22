# Contract: dbBootstrapConfig.ts

**Source**: [shared/dbBootstrapConfig.ts](../../shared/dbBootstrapConfig.ts)

## Interfaces

### `LocalRuntimeConfig`
```typescript
interface LocalRuntimeConfig {
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
```

### `DatabaseBootstrapConfig`
```typescript
interface DatabaseBootstrapConfig {
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
```

### `DatabaseBootstrapMode`
```typescript
type DatabaseBootstrapMode =  'auto' | 'native' | 'docker' | 'external-only';
```

