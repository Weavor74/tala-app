import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Pool } from 'pg';
import { resolveDatabaseConfig } from '../../electron/services/db/resolveDatabaseConfig';
import type { DatabaseConfig } from '../../shared/dbConfig';

interface CliOptions {
  dryRun: boolean;
  yes: boolean;
  allowRemote: boolean;
  skipFiles: boolean;
}

interface TargetDbInfo {
  host: string;
  database: string;
  port: number;
}

type FileTargetKind = 'directory_contents' | 'file';

interface FileTarget {
  kind: FileTargetKind;
  absolutePath: string;
  description: string;
}

const TABLE_GROUPS: Array<{ group: string; tables: string[] }> = [
  {
    group: 'canonical_authority',
    tables: [
      'memory_repair_outcomes',
      'deferred_memory_work',
      'memory_duplicates',
      'memory_integrity_issues',
      'memory_projections',
      'memory_lineage',
      'memory_records',
    ],
  },
  {
    group: 'legacy_canonical_memory',
    tables: [
      'memory_links',
      'relationships',
      'observations',
      'episodes',
      'entity_aliases',
      'entities',
      'artifacts',
      'embeddings',
    ],
  },
  {
    group: 'rag_ingestion',
    tables: ['chunk_embeddings', 'document_chunks', 'source_documents'],
  },
  {
    group: 'graph_projection',
    tables: ['graph_evidence', 'graph_edges', 'graph_events', 'graph_nodes'],
  },
];

function parseArgs(argv: string[]): CliOptions {
  const hasYes = argv.includes('--yes');
  const hasDryRun = argv.includes('--dry-run');
  return {
    yes: hasYes,
    dryRun: hasDryRun || !hasYes,
    allowRemote: argv.includes('--allow-remote'),
    skipFiles: argv.includes('--skip-files'),
  };
}

function getTargetDbInfo(config: DatabaseConfig): TargetDbInfo {
  if (config.connectionString) {
    const parsed = new URL(config.connectionString);
    return {
      host: parsed.hostname,
      database: parsed.pathname.replace(/^\//, ''),
      port: Number(parsed.port || 5432),
    };
  }
  return {
    host: config.host,
    database: config.database,
    port: config.port,
  };
}

function isLocalHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  const baseHost = normalized.split('/')[0];
  return baseHost === 'localhost' || baseHost === '127.0.0.1' || baseHost === '::1';
}

function assertSafeDbTarget(info: TargetDbInfo, allowRemote: boolean): void {
  if (allowRemote) return;

  if (!isLocalHost(info.host)) {
    throw new Error(
      `[memory:purge] Refusing to run against non-local DB host '${info.host}'. ` +
      `Use --allow-remote only when you intentionally target a remote DB.`
    );
  }

  if (info.database.trim().toLowerCase() !== 'tala') {
    throw new Error(
      `[memory:purge] Refusing to run against database '${info.database}'. ` +
      `Expected database name 'tala'. Use --allow-remote to bypass.`
    );
  }
}

async function tableExists(pool: Pool, tableName: string): Promise<boolean> {
  const result = await pool.query<{ exists: string | null }>(
    `SELECT to_regclass($1) AS exists`,
    [`public.${tableName}`],
  );
  return !!result.rows[0]?.exists;
}

async function getTableCount(pool: Pool, tableName: string): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${tableName}`);
  return Number(result.rows[0]?.count ?? '0');
}

function resolveFileTargets(repoRoot: string): FileTarget[] {
  const envGraphDb = process.env.TALA_MEMORY_DB;
  const targets: FileTarget[] = [
    {
      kind: 'directory_contents',
      absolutePath: path.resolve(repoRoot, 'mcp-servers', 'tala-core', 'data', 'simple_vector_store'),
      description: 'Tala-core simple vector store',
    },
    {
      kind: 'directory_contents',
      absolutePath: path.resolve(repoRoot, 'data', 'mem0_storage'),
      description: 'Mem0 root storage cache',
    },
    {
      kind: 'directory_contents',
      absolutePath: path.resolve(repoRoot, 'mcp-servers', 'mem0-core', 'data', 'mem0_storage'),
      description: 'Mem0-core local storage',
    },
    {
      kind: 'file',
      absolutePath: path.resolve(repoRoot, 'mcp-servers', 'tala-memory-graph', 'tala_memory_v1.db'),
      description: 'Legacy SQLite graph store (tala-memory-graph)',
    },
    {
      kind: 'file',
      absolutePath: path.resolve(repoRoot, 'tala_memory_v1.db'),
      description: 'Legacy SQLite graph store (repo root)',
    },
    {
      kind: 'directory_contents',
      absolutePath: path.resolve(repoRoot, 'memory', 'processed', 'roleplay_autobio_canon_migration'),
      description: 'Generated one-time autobiographical canon migration outputs',
    },
  ];

  if (envGraphDb) {
    const resolved = path.resolve(envGraphDb);
    targets.push({
      kind: 'file',
      absolutePath: resolved,
      description: 'Graph store from TALA_MEMORY_DB env override',
    });
  }

  return targets;
}

function assertPathInsideRepo(repoRoot: string, target: string): void {
  const root = path.resolve(repoRoot);
  const resolvedTarget = path.resolve(target);
  const withSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!(resolvedTarget === root || resolvedTarget.startsWith(withSep))) {
    throw new Error(
      `[memory:purge] Unsafe target outside repository root.\n` +
      `  repoRoot: ${root}\n` +
      `  target:   ${resolvedTarget}`
    );
  }
}

async function clearDirectoryContents(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    await fs.rm(fullPath, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const opts = parseArgs(process.argv.slice(2));
  const modeLabel = opts.dryRun ? 'DRY-RUN' : 'EXECUTE';
  console.log(`[memory:purge] Mode: ${modeLabel}`);

  const resolvedConfig = resolveDatabaseConfig();
  const targetInfo = getTargetDbInfo(resolvedConfig);
  assertSafeDbTarget(targetInfo, opts.allowRemote);

  console.log(
    `[memory:purge] Target DB: host=${targetInfo.host} port=${targetInfo.port} database=${targetInfo.database}`
  );
  if (opts.dryRun) {
    console.log('[memory:purge] Dry-run is active. No destructive actions will be performed.');
    console.log('[memory:purge] Execute with: npm run memory:purge -- --yes');
  }

  const pool = new Pool(
    resolvedConfig.connectionString
      ? {
          connectionString: resolvedConfig.connectionString,
          max: resolvedConfig.poolMax,
          idleTimeoutMillis: resolvedConfig.idleTimeoutMs,
          connectionTimeoutMillis: resolvedConfig.connectionTimeoutMs,
          ssl: resolvedConfig.ssl ? { rejectUnauthorized: false } : undefined,
        }
      : {
          host: resolvedConfig.host,
          port: resolvedConfig.port,
          database: resolvedConfig.database,
          user: resolvedConfig.user,
          password: resolvedConfig.password,
          max: resolvedConfig.poolMax,
          idleTimeoutMillis: resolvedConfig.idleTimeoutMs,
          connectionTimeoutMillis: resolvedConfig.connectionTimeoutMs,
          ssl: resolvedConfig.ssl ? { rejectUnauthorized: false } : undefined,
        }
  );

  try {
    const health = await pool.query<{
      current_database: string;
      server_addr: string | null;
      server_port: number;
    }>(
      `SELECT
         current_database() AS current_database,
         inet_server_addr()::text AS server_addr,
         inet_server_port() AS server_port`
    );
    const dbRow = health.rows[0];
    const liveDb = dbRow?.current_database ?? 'unknown';
    const liveHost = dbRow?.server_addr ?? 'unknown';
    if (!opts.allowRemote && liveDb.toLowerCase() !== 'tala') {
      throw new Error(
        `[memory:purge] Connected DB is '${liveDb}', expected 'tala'. Refusing to continue without --allow-remote.`
      );
    }
    if (!opts.allowRemote && liveHost !== 'unknown' && !isLocalHost(liveHost)) {
      throw new Error(
        `[memory:purge] Connected server host is '${liveHost}', expected localhost. ` +
        `Refusing to continue without --allow-remote.`
      );
    }

    const existingTables: string[] = [];
    for (const group of TABLE_GROUPS) {
      for (const table of group.tables) {
        if (await tableExists(pool, table)) {
          existingTables.push(table);
        }
      }
    }

    console.log(`[memory:purge] Existing target tables: ${existingTables.length}`);
    for (const table of existingTables) {
      const count = await getTableCount(pool, table);
      console.log(`  - ${table}: ${count} row(s)`);
    }

    if (!opts.dryRun && existingTables.length > 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`TRUNCATE TABLE ${existingTables.join(', ')} RESTART IDENTITY CASCADE`);
        await client.query('COMMIT');
        console.log('[memory:purge] PostgreSQL memory tables truncated.');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    if (!opts.skipFiles) {
      const targets = resolveFileTargets(repoRoot);
      console.log(`[memory:purge] File targets: ${targets.length}`);

      for (const target of targets) {
        if (!opts.allowRemote || target.absolutePath.startsWith(path.resolve(repoRoot))) {
          assertPathInsideRepo(repoRoot, target.absolutePath);
        }

        const exists = await pathExists(target.absolutePath);
        if (!exists) {
          console.log(`  - skip (missing): ${target.description} -> ${target.absolutePath}`);
          continue;
        }

        if (target.kind === 'directory_contents') {
          if (opts.dryRun) {
            const childEntries = await fs.readdir(target.absolutePath);
            console.log(
              `  - dry-run clear dir contents: ${target.description} (${childEntries.length} child entries)`
            );
          } else {
            const removed = await clearDirectoryContents(target.absolutePath);
            console.log(`  - cleared dir contents: ${target.description} (${removed} entries removed)`);
          }
        } else if (target.kind === 'file') {
          if (opts.dryRun) {
            console.log(`  - dry-run remove file: ${target.description}`);
          } else {
            await fs.rm(target.absolutePath, { force: true });
            console.log(`  - removed file: ${target.description}`);
          }
        }
      }
    } else {
      console.log('[memory:purge] --skip-files set, filesystem cleanup skipped.');
    }

    if (opts.dryRun) {
      console.log('[memory:purge] Dry-run completed. No state was modified.');
    } else {
      console.log('[memory:purge] Purge completed.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[memory:purge] failed: ${message}`);
  process.exitCode = 1;
});
