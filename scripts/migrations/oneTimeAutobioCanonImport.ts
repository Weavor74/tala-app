import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  buildVerificationSummary,
  inspectSourceTree,
  normalizeLtmfEvents,
  normalizeExtensionForFile,
  renderNormalizedMarkdown,
  type NormalizedLtmfEvent,
} from './autobioCanonImportUtils';

interface CliOptions {
  source: string;
  dryRun: boolean;
  doImport: boolean;
  reportPath: string | null;
  forceReembed: boolean;
}

interface ImportManifestRecord {
  eventId: string;
  sourceHash: string;
  outputPath: string;
  importedAt: string;
}

interface ImportManifest {
  version: number;
  records: Record<string, ImportManifestRecord>;
}

interface MigrationReport {
  mode: 'dry-run' | 'import';
  sourceRoot: string;
  inspection: {
    totalFiles: number;
    extensionCounts: Record<string, number>;
    likelyStructuredCount: number;
    likelyUnstructuredCount: number;
    likelyLtmfCount: number;
    ageMarkerCount: number;
    lifeStageMarkerCount: number;
    recommendedFormat: 'markdown_frontmatter' | 'jsonl' | 'direct_chunks';
    recommendedStrategy: string;
    evaluatedFormats: Array<{
      format: 'markdown_frontmatter' | 'jsonl' | 'direct_chunks';
      supportedByRuntime: boolean;
      reason: string;
    }>;
    excludedCount: number;
  };
  canonicalSourceDecision: {
    candidateEventCount: number;
    candidateExtensionCounts: Record<string, number>;
    chosenImportFormat: 'markdown_frontmatter' | 'jsonl' | 'direct_chunks';
    whyChosen: string;
  };
  normalizationSummary: {
    normalizedCount: number;
    ageTaggedCount: number;
    canonAutobioCount: number;
    age17Count: number;
  };
  sampleQueries: string[];
  importSummary: {
    writtenFiles: number;
    importedFiles: number;
    skippedAlreadyImported: number;
    failedImports: number;
  };
  queryVerification?: Record<string, number>;
}

const DEFAULT_SOURCE = 'D:\\temp';
const OUTPUT_DIR = path.resolve('memory', 'processed', 'roleplay_autobio_canon_migration');
const MANIFEST_PATH = path.join(OUTPUT_DIR, '.autobio_canon_import_manifest.json');

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    source: DEFAULT_SOURCE,
    dryRun: false,
    doImport: false,
    reportPath: null,
    forceReembed: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source') {
      opts.source = argv[i + 1] ?? opts.source;
      i++;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--import') {
      opts.doImport = true;
    } else if (arg === '--report') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        opts.reportPath = next;
        i++;
      } else {
        opts.reportPath = path.resolve(OUTPUT_DIR, 'migration_report.json');
      }
    } else if (arg === '--force-reembed') {
      opts.forceReembed = true;
    }
  }

  if (!opts.dryRun && !opts.doImport) {
    opts.dryRun = true;
  }

  return opts;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function loadManifest(): ImportManifest {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return { version: 1, records: {} };
  }
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as ImportManifest;
    if (!parsed || parsed.version !== 1 || typeof parsed.records !== 'object') {
      return { version: 1, records: {} };
    }
    return parsed;
  } catch {
    return { version: 1, records: {} };
  }
}

function saveManifest(m: ImportManifest): void {
  ensureDir(path.dirname(MANIFEST_PATH));
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2), 'utf8');
}

function resolvePythonPath(): string {
  const winVenv = path.resolve('mcp-servers', 'tala-core', 'venv', 'Scripts', 'python.exe');
  if (process.platform === 'win32' && fs.existsSync(winVenv)) return winVenv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function getServerPath(): string {
  return path.resolve('mcp-servers', 'tala-core', 'server.py');
}

function renderTargetPath(event: NormalizedLtmfEvent): string {
  const safeTitle = event.title.replace(/[^a-z0-9\- ]/gi, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'Untitled';
  return path.join(OUTPUT_DIR, `${event.eventId}-${safeTitle}.md`);
}

async function openMcpClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: resolvePythonPath(),
    args: [getServerPath()],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  const client = new Client({ name: 'autobio-canon-importer', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await transport.close();
    },
  };
}

function printUsage(): void {
  console.log('Usage: npx tsx scripts/migrations/oneTimeAutobioCanonImport.ts --source "D:\\temp" [--dry-run] [--import] [--report [path]] [--force-reembed]');
}

async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.source) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const sourceRoot = path.resolve(opts.source);
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`Source path not found: ${sourceRoot}`);
  }

  const inspection = inspectSourceTree(sourceRoot);
  const normalized = normalizeLtmfEvents({ sourceRoot });
  const summary = buildVerificationSummary(normalized);
  const extensionCountsForCandidates: Record<string, number> = {};
  for (const event of normalized) {
    const ext = normalizeExtensionForFile(event.sourcePath);
    extensionCountsForCandidates[ext] = (extensionCountsForCandidates[ext] ?? 0) + 1;
  }

  const report: MigrationReport = {
    mode: opts.doImport ? 'import' : 'dry-run',
    sourceRoot,
    inspection: {
      totalFiles: inspection.totalFiles,
      extensionCounts: inspection.extensionCounts,
      likelyStructuredCount: inspection.likelyStructuredCount,
      likelyUnstructuredCount: inspection.likelyUnstructuredCount,
      likelyLtmfCount: inspection.likelyLtmfCount,
      ageMarkerCount: inspection.ageMarkerCount,
      lifeStageMarkerCount: inspection.lifeStageMarkerCount,
      recommendedFormat: inspection.recommendedFormat,
      recommendedStrategy: inspection.recommendedStrategy,
      evaluatedFormats: inspection.evaluatedFormats,
      excludedCount: inspection.excludedCount,
    },
    canonicalSourceDecision: {
      candidateEventCount: normalized.length,
      candidateExtensionCounts: extensionCountsForCandidates,
      chosenImportFormat: inspection.recommendedFormat,
      whyChosen: inspection.recommendedStrategy,
    },
    normalizationSummary: summary,
    sampleQueries: [
      'when you were 17',
      'at 17',
      'during your seventeenth year',
    ],
    importSummary: {
      writtenFiles: 0,
      importedFiles: 0,
      skippedAlreadyImported: 0,
      failedImports: 0,
    },
  };

  ensureDir(OUTPUT_DIR);

  let mcp: { client: Client; close: () => Promise<void> } | null = null;
  const manifest = loadManifest();

  try {
    if (opts.doImport) {
      mcp = await openMcpClient();
    }

    for (const event of normalized) {
      const outPath = renderTargetPath(event);
      if (opts.doImport) {
        const markdown = renderNormalizedMarkdown(event);
        fs.writeFileSync(outPath, markdown, 'utf8');
        report.importSummary.writtenFiles += 1;
      }

      if (!opts.doImport) continue;

      const prior = manifest.records[event.eventId];
      const unchanged = !!prior && prior.sourceHash === event.sourceHash && fs.existsSync(outPath);
      if (unchanged && !opts.forceReembed) {
        report.importSummary.skippedAlreadyImported += 1;
        continue;
      }

      try {
        await mcp!.client.callTool({
          name: 'ingest_file',
          arguments: { file_path: outPath, category: 'roleplay' },
        });
        manifest.records[event.eventId] = {
          eventId: event.eventId,
          sourceHash: event.sourceHash,
          outputPath: outPath,
          importedAt: new Date().toISOString(),
        };
        report.importSummary.importedFiles += 1;
      } catch {
        report.importSummary.failedImports += 1;
      }
    }

    if (opts.doImport) {
      saveManifest(manifest);

      // Verification queries against searchable store.
      const verificationFilters = {
        age: 17,
        source_type: 'ltmf',
        memory_type: 'autobiographical',
        canon: true,
      };

      const verificationResults: Record<string, number> = {};
      for (const q of report.sampleQueries) {
        const res = await mcp!.client.callTool({
          name: 'search_memory',
          arguments: { query: q, limit: 5, filter_json: JSON.stringify(verificationFilters) },
        });
        let count = 0;
        const first = Array.isArray(res.content) ? res.content[0] as { text?: string } : undefined;
        if (first?.text) {
          try {
            const parsed = JSON.parse(first.text);
            if (Array.isArray(parsed)) count = parsed.length;
          } catch {
            count = 0;
          }
        }
        verificationResults[q] = count;
      }
      report.queryVerification = verificationResults;
    }
  } finally {
    if (mcp) {
      await mcp.close();
    }
  }

  const reportText = JSON.stringify(report, null, 2);
  if (opts.reportPath !== null) {
    const reportPath = path.resolve(opts.reportPath);
    ensureDir(path.dirname(reportPath));
    fs.writeFileSync(reportPath, reportText, 'utf8');
    console.log(`[autobio-canon-import] Wrote report: ${reportPath}`);
  }

  console.log(reportText);
}

run().catch((err) => {
  console.error('[autobio-canon-import] fatal:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
