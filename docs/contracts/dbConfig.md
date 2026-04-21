# Contract: dbConfig.ts

**Source**: [shared\dbConfig.ts](../../shared/dbConfig.ts)

## Interfaces

### `DatabaseConfig`
```typescript
interface DatabaseConfig {
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
```

