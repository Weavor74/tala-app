import * as fs from 'node:fs';
import * as path from 'node:path';
import { NamingContract, NamingExceptionsFile } from './types';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-electron',
  'build',
  'coverage',
  '.git',
  'out',
  'release',
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache'
]);

const INCLUDE_ROOTS = [
  'electron',
  'src',
  'shared',
  'scripts',
  'tools',
  'tests',
  'docs',
  'mcp-servers',
  '.github'
];

function toPosix(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

export function walkRepoFiles(repoRoot: string): string[] {
  const results: string[] = [];

  function walkAbsolute(absDir: string): void {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.DS_Store')) continue;
      const absPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walkAbsolute(absPath);
        continue;
      }
      const rel = toPosix(path.relative(repoRoot, absPath));
      results.push(rel);
    }
  }

  for (const root of INCLUDE_ROOTS) {
    const absRoot = path.join(repoRoot, root);
    if (!fs.existsSync(absRoot)) continue;
    walkAbsolute(absRoot);
  }

  results.sort();
  return results;
}

export function loadContract(contractPath: string): NamingContract {
  if (!fs.existsSync(contractPath)) {
    throw new Error(`Naming contract not found: ${contractPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (error) {
    throw new Error(`Naming contract is malformed JSON: ${contractPath} (${String(error)})`);
  }

  const contract = parsed as Partial<NamingContract>;
  if (!contract || typeof contract !== 'object') {
    throw new Error(`Naming contract is malformed: expected object in ${contractPath}`);
  }
  if (!contract.contractName || !contract.version) {
    throw new Error(`Naming contract missing required fields contractName/version: ${contractPath}`);
  }

  return contract as NamingContract;
}

export function loadExceptions(exceptionsPath: string): NamingExceptionsFile {
  if (!fs.existsSync(exceptionsPath)) {
    throw new Error(
      `Naming exceptions file missing: ${exceptionsPath}. Run baseline generation with --update-baseline.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));
  } catch (error) {
    throw new Error(`Naming exceptions file is malformed JSON: ${exceptionsPath} (${String(error)})`);
  }

  const data = parsed as Partial<NamingExceptionsFile>;
  if (!data || typeof data !== 'object' || !Array.isArray(data.exceptions)) {
    throw new Error(`Naming exceptions file is malformed: expected { exceptions: [] } in ${exceptionsPath}`);
  }

  return {
    contract: data.contract ?? 'tala.naming',
    contractVersion: data.contractVersion ?? 'unknown',
    generatedAt: data.generatedAt ?? new Date(0).toISOString(),
    exceptions: data.exceptions
  };
}

export function writeExceptions(exceptionsPath: string, data: NamingExceptionsFile): void {
  const dir = path.dirname(exceptionsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(exceptionsPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function readFileSafe(repoRoot: string, relPath: string): string | null {
  const abs = path.join(repoRoot, relPath);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}
