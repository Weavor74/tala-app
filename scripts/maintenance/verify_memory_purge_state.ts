import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Pool } from 'pg';
import { resolveDatabaseConfig } from '../../electron/services/db/resolveDatabaseConfig';
import type { DatabaseConfig } from '../../shared/dbConfig';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const CANONICAL_TABLES = [
  'memory_repair_outcomes',
  'deferred_memory_work',
  'memory_duplicates',
  'memory_integrity_issues',
  'memory_projections',
  'memory_lineage',
  'memory_records',
  'memory_links',
  'relationships',
  'observations',
  'episodes',
  'entity_aliases',
  'entities',
  'artifacts',
  'embeddings',
];

const GRAPH_TABLES = ['graph_evidence', 'graph_edges', 'graph_events', 'graph_nodes'];
const RAG_TABLES = ['source_documents', 'document_chunks', 'chunk_embeddings'];
const RESEARCH_TABLES = ['notebooks', 'search_runs', 'search_run_results', 'notebook_items'];

function buildPoolConfig(config: DatabaseConfig) {
  if (config.connectionString) {
    return {
      connectionString: config.connectionString,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: config.poolMax,
      idleTimeoutMillis: config.idleTimeoutMs,
      connectionTimeoutMillis: config.connectionTimeoutMs,
    };
  }
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    max: config.poolMax,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
  };
}

async function tableExists(pool: Pool, tableName: string): Promise<boolean> {
  const result = await pool.query<{ exists: string | null }>(
    'SELECT to_regclass($1) AS exists',
    [`public.${tableName}`],
  );
  return !!result.rows[0]?.exists;
}

async function getCount(pool: Pool, tableName: string): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${tableName}`);
  return Number(result.rows[0]?.count ?? '0');
}

async function evaluateTableGroup(pool: Pool, tables: string[], label: string): Promise<CheckResult> {
  const details: string[] = [];
  let ok = true;
  for (const table of tables) {
    if (!(await tableExists(pool, table))) {
      details.push(`${table}=missing`);
      ok = false;
      continue;
    }
    const count = await getCount(pool, table);
    if (count !== 0) ok = false;
    details.push(`${table}=${count}`);
  }
  return {
    name: `${label} tables empty`,
    ok,
    detail: details.join(', '),
  };
}

async function directoryEntryCount(target: string): Promise<number | null> {
  try {
    const entries = await fs.readdir(target);
    return entries.length;
  } catch {
    return null;
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function verifySimpleVectorStore(repoRoot: string): Promise<CheckResult> {
  const storeDir = path.resolve(repoRoot, 'mcp-servers', 'tala-core', 'data', 'simple_vector_store');
  const metadataPath = path.join(storeDir, 'metadata.json');
  const vectorsPath = path.join(storeDir, 'vectors.npy');
  const metadataExists = await fileExists(metadataPath);
  const vectorsExists = await fileExists(vectorsPath);

  if (!metadataExists && !vectorsExists) {
    return {
      name: 'simple_vector_store empty',
      ok: true,
      detail: 'metadata.json and vectors.npy absent',
    };
  }

  if (metadataExists) {
    try {
      const raw = await fs.readFile(metadataPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return {
          name: 'simple_vector_store empty',
          ok: parsed.length === 0,
          detail: `metadata.json entries=${parsed.length}`,
        };
      }
      return {
        name: 'simple_vector_store empty',
        ok: false,
        detail: 'metadata.json is not an array',
      };
    } catch (error) {
      return {
        name: 'simple_vector_store empty',
        ok: false,
        detail: `failed to parse metadata.json: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    name: 'simple_vector_store empty',
    ok: false,
    detail: 'vectors.npy exists while metadata.json is missing',
  };
}

async function verifyMem0Stores(repoRoot: string): Promise<CheckResult> {
  const roots = [
    path.resolve(repoRoot, 'data', 'mem0_storage'),
    path.resolve(repoRoot, 'mcp-servers', 'mem0-core', 'data', 'mem0_storage'),
  ];
  const details: string[] = [];
  let ok = true;
  for (const root of roots) {
    const count = await directoryEntryCount(root);
    if (count === null) {
      details.push(`${root}=missing`);
      continue;
    }
    if (count !== 0) ok = false;
    details.push(`${root}=entries:${count}`);
  }
  return {
    name: 'mem0 derived storage empty',
    ok,
    detail: details.join(', '),
  };
}

async function verifyMigrationsIntact(pool: Pool): Promise<CheckResult> {
  const schemaMigrationsExists = await tableExists(pool, 'schema_migrations');
  if (!schemaMigrationsExists) {
    return {
      name: 'migrations intact',
      ok: false,
      detail: 'schema_migrations table missing',
    };
  }
  const count = await getCount(pool, 'schema_migrations');
  return {
    name: 'migrations intact',
    ok: count > 0,
    detail: `schema_migrations rows=${count}`,
  };
}

async function reportResearchTables(pool: Pool): Promise<CheckResult> {
  const details: string[] = [];
  for (const table of RESEARCH_TABLES) {
    const exists = await tableExists(pool, table);
    if (!exists) {
      details.push(`${table}=missing`);
      continue;
    }
    const count = await getCount(pool, table);
    details.push(`${table}=${count}`);
  }
  return {
    name: 'research tables (preserved by default)',
    ok: true,
    detail: details.join(', '),
  };
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const dbConfig = resolveDatabaseConfig();
  const pool = new Pool(buildPoolConfig(dbConfig));
  const checks: CheckResult[] = [];

  try {
    checks.push(await evaluateTableGroup(pool, CANONICAL_TABLES, 'canonical'));
    checks.push(await evaluateTableGroup(pool, GRAPH_TABLES, 'graph'));
    checks.push(await evaluateTableGroup(pool, RAG_TABLES, 'RAG ingestion'));
    checks.push(await verifySimpleVectorStore(repoRoot));
    checks.push(await verifyMem0Stores(repoRoot));
    checks.push(await verifyMigrationsIntact(pool));
    checks.push(await reportResearchTables(pool));
  } finally {
    await pool.end();
  }

  let failed = 0;
  console.log('[memory:purge:verify] Results:');
  for (const check of checks) {
    const status = check.ok ? 'PASS' : 'FAIL';
    if (!check.ok) failed++;
    console.log(`- ${status}: ${check.name} -> ${check.detail}`);
  }

  if (failed > 0) {
    console.error(`[memory:purge:verify] ${failed} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('[memory:purge:verify] All checks passed.');
  }
}

main().catch((error) => {
  console.error(`[memory:purge:verify] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
