/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import process from 'process';

// Repo root is two levels up from scripts/diagnostics/
const ROOT = path.resolve(__dirname, '../..');

interface Violation {
  check: string;
  file: string;
  fix: string;
}

interface SubsystemMapping {
  prohibited_at_root?: string[];
  [key: string]: unknown;
}

function readJsonSafe(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Match a filename against a simple glob pattern.
 * Supports * as wildcard. Does not support ** or path separators.
 */
function matchesGlob(filename: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(filename);
}

const violations: Violation[] = [];
let checksRun = 0;

// ---------------------------------------------------------------------------
// Load config files from repo root
// ---------------------------------------------------------------------------
const codeRootsPath = path.join(ROOT, 'code_roots.json');
const subsystemMappingPath = path.join(ROOT, 'subsystem_mapping.json');
const subsystemMapping = readJsonSafe(subsystemMappingPath) as SubsystemMapping | null;

// ---------------------------------------------------------------------------
// CHECK 1: Forbidden tracked root clutter
// ---------------------------------------------------------------------------
checksRun++;
console.log('[CHECK 1] Forbidden root clutter');

const prohibitedFilePatterns: string[] = (subsystemMapping?.prohibited_at_root ?? [
  '*.db', '*.sqlite', '*.gguf',
  '*_output.txt', '*_debug*.txt',
  'memory_audit.jsonl', '.agent_response_marker',
]).filter((p: string) => !p.endsWith('/'));

// Always enforce *.jsonl and *.log regardless of what subsystem_mapping.json contains
for (const always of ['*.jsonl', '*.log']) {
  if (!prohibitedFilePatterns.includes(always)) {
    prohibitedFilePatterns.push(always);
  }
}

// Directory patterns may appear with or without a trailing '/'.
// We normalise by stripping the slash so the name comparison is consistent.
const prohibitedDirPatterns: string[] = (subsystemMapping?.prohibited_at_root ?? [
  'tmp/', 'scratch/', 'DOCS_TODAY/', 'TEST_RUNS/',
]).filter((p: string) => p.endsWith('/')).map((p: string) => p.slice(0, -1));

const rootEntries = fs.readdirSync(ROOT, { withFileTypes: true });

for (const entry of rootEntries) {
  if (entry.isFile()) {
    for (const pattern of prohibitedFilePatterns) {
      if (matchesGlob(entry.name, pattern)) {
        violations.push({
          check: 'Forbidden root clutter',
          file: entry.name,
          fix: `Remove or move '${entry.name}' — forbidden files must not be tracked at the repo root`,
        });
        break;
      }
    }
  } else if (entry.isDirectory()) {
    for (const dir of prohibitedDirPatterns) {
      if (entry.name === dir) {
        violations.push({
          check: 'Forbidden root directory',
          file: `${entry.name}/`,
          fix: `Remove '${entry.name}/' — prohibited directories must not exist at the repo root`,
        });
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CHECK 2: Files placed in invalid top-level locations
// ---------------------------------------------------------------------------
checksRun++;
console.log('[CHECK 2] Invalid top-level file placement');

// Well-known config and bootstrap files that are valid at the repo root
const VALID_ROOT_FILES = new Set([
  'package.json', 'package-lock.json',
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'vite.config.ts', 'vitest.config.ts', 'eslint.config.js',
  'code_roots.json', 'subsystem_mapping.json',
  'AGENTS.md', 'README.md', 'index.html',
  'bootstrap.sh', 'bootstrap.ps1', 'start.sh', 'start.bat',
  'launch-inference.bat', 'start_local_inference.bat',
  'MASTER_PYTHON_REQUIREMENTS.txt', 'PORTABLE_BUILD_README.txt',
  '.gitignore', '.gitattributes', '.npmrc', '.nvmrc', '.node-version',
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py']);

for (const entry of rootEntries) {
  if (!entry.isFile()) continue;
  const ext = path.extname(entry.name).toLowerCase();
  if (SOURCE_EXTENSIONS.has(ext) && !VALID_ROOT_FILES.has(entry.name)) {
    violations.push({
      check: 'Invalid top-level placement',
      file: entry.name,
      fix: `Move '${entry.name}' into the appropriate subsystem directory (see code_roots.json)`,
    });
  }
}

// ---------------------------------------------------------------------------
// CHECK 3: Scripts placed directly under scripts/ instead of subdirectories
// ---------------------------------------------------------------------------
checksRun++;
console.log('[CHECK 3] Scripts placed directly under scripts/');

const SCRIPT_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.py', '.sh', '.bat', '.ps1']);
const scriptsDir = path.join(ROOT, 'scripts');

if (fs.existsSync(scriptsDir)) {
  const scriptEntries = fs.readdirSync(scriptsDir, { withFileTypes: true });
  for (const entry of scriptEntries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (SCRIPT_EXTENSIONS.has(ext)) {
      violations.push({
        check: 'Script misplaced directly under scripts/',
        file: `scripts/${entry.name}`,
        fix: `Move 'scripts/${entry.name}' to scripts/build/ or scripts/diagnostics/ as appropriate`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// CHECK 4: Missing required repo structure files
// ---------------------------------------------------------------------------
checksRun++;
console.log('[CHECK 4] Required repo structure files');

const REQUIRED_FILES = [
  { rel: 'docs/repo_layout.md',       description: 'Repository layout documentation' },
  { rel: 'docs/agent_working_rules.md', description: 'Agent working rules documentation' },
  { rel: 'code_roots.json',            description: 'Code roots registry' },
  { rel: 'subsystem_mapping.json',     description: 'Subsystem ownership map' },
];

for (const req of REQUIRED_FILES) {
  if (!fs.existsSync(path.join(ROOT, req.rel))) {
    violations.push({
      check: 'Missing required file',
      file: req.rel,
      fix: `Create '${req.rel}' — ${req.description} is required for repo structure enforcement`,
    });
  }
}

// ---------------------------------------------------------------------------
// Print report
// ---------------------------------------------------------------------------
const passed = violations.length === 0;
const line = '='.repeat(62);

console.log(`\n${line}`);
console.log('  REPO STRUCTURE VALIDATION REPORT');
console.log(line);
console.log(`  Checks run : ${checksRun}`);
console.log(`  Violations : ${violations.length}`);
console.log(`  Result     : ${passed ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(line);

if (violations.length > 0) {
  console.log('\n  VIOLATIONS\n');
  for (const v of violations) {
    console.log(`  ▸ [${v.check}]`);
    console.log(`    File : ${v.file}`);
    console.log(`    Fix  : ${v.fix}`);
    console.log('');
  }
  console.log(line);
}

if (!passed) {
  process.exit(1);
}
