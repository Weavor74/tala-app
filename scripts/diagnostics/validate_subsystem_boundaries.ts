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
  severity: 'WARNING' | 'ERROR';
}

interface Subsystem {
  id: string;
  name: string;
  root: string;
  owns: string[];
}

interface CodeRoot {
  id: string;
  path: string;
  purpose: string;
}

const violations: Violation[] = [];
let filesScanned = 0;
let importsChecked = 0;

// ---------------------------------------------------------------------------
// Config Loading
// ---------------------------------------------------------------------------

function readJsonSafe(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

const codeRoots = (readJsonSafe(path.join(ROOT, 'code_roots.json'))?.roots || []) as CodeRoot[];
const subsystems = (readJsonSafe(path.join(ROOT, 'subsystem_mapping.json'))?.subsystems || []) as Subsystem[];

const RENDERER_ROOT = path.join(ROOT, 'src');
const ELECTRON_ROOT = path.join(ROOT, 'electron');
const SHARED_ROOT = path.join(ROOT, 'shared');

// ---------------------------------------------------------------------------
// Import Extraction
// ---------------------------------------------------------------------------

// Simple regex to find imports and requires
const IMPORT_REGEX = /(?:import|from|require)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g;

function extractImports(content: string): string[] {
  const imports: string[] = [];
  let match;
  while ((match = IMPORT_REGEX.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

// ---------------------------------------------------------------------------
// Path Utilities
// ---------------------------------------------------------------------------

function isInternal(importPath: string): boolean {
  return importPath.startsWith('.') || importPath.startsWith('/') || importPath.startsWith('@/');
}

function resolveImport(sourceFile: string, importPath: string): string | null {
  if (!isInternal(importPath)) return null;

  // Handle alias if applicable (assuming @/ maps to src/ for now, adjust if needed)
  let absolutePath = '';
  if (importPath.startsWith('@/')) {
    absolutePath = path.join(RENDERER_ROOT, importPath.slice(2));
  } else {
    absolutePath = path.resolve(path.dirname(sourceFile), importPath);
  }

  // Common extensions to check
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
  for (const ext of extensions) {
    const p = absolutePath + ext;
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return absolutePath; // Return best guess even if not found
}

// ---------------------------------------------------------------------------
// Validation Logic
// ---------------------------------------------------------------------------

function validateFile(filePath: string) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const imports = extractImports(content);
  filesScanned++;

  for (const imp of imports) {
    const resolved = resolveImport(filePath, imp);
    if (!resolved) continue;
    
    importsChecked++;
    const relativeSource = path.relative(ROOT, filePath);
    const relativeTarget = path.relative(ROOT, resolved);

    // NEW RULE: Neutral zone check - 'shared/' imports are allowed from anywhere
    if (relativeTarget.startsWith('shared' + path.sep)) {
      validateSharedContent(resolved);
      continue;
    }

    // Rule 1: src/ cannot import from electron/
    if (relativeSource.startsWith('src' + path.sep) && relativeTarget.startsWith('electron' + path.sep)) {
      violations.push({
        check: 'Renderer importing Electron Main code',
        file: relativeSource,
        fix: `Remove import of '${imp}'. Use IPC calls for backend interaction.`,
        severity: 'WARNING'
      });
    }

    // Rule 2: Production code cannot import from scripts/
    const isProd = relativeSource.startsWith('src' + path.sep) || relativeSource.startsWith('electron' + path.sep);
    if (isProd && relativeTarget.startsWith('scripts' + path.sep)) {
      violations.push({
        check: 'Production code importing diagnostic/build scripts',
        file: relativeSource,
        fix: `Move shared logic out of 'scripts/' to a service or utility in 'electron/' or 'src/'.`,
        severity: 'WARNING'
      });
    }

    // Rule 3: Production code cannot import from docs, test_data, etc.
    const forbiddenTiers = ['docs', 'test_data', 'archive'];
    for (const tier of forbiddenTiers) {
      if (isProd && (relativeTarget === tier || relativeTarget.startsWith(tier + path.sep))) {
        violations.push({
          check: `Production code importing from ${tier}`,
          file: relativeSource,
          fix: `Remove import of '${imp}'. ${tier} is not part of the runtime bundle.`,
          severity: 'WARNING'
        });
      }
    }

    // Rule 4: electron/ cannot import from src/
    if (relativeSource.startsWith('electron' + path.sep) && relativeTarget.startsWith('src' + path.sep)) {
      violations.push({
        check: 'Electron Main importing Renderer code',
        file: relativeSource,
        fix: `Remove import of '${imp}'. Main process should not depend on UI components or renderer logic.`,
        severity: 'WARNING'
      });
    }
  }
}

/**
 * Validates that files in the 'shared/' subsystem do not contain
 * forbidden APIs or logic (e.g., Node, Electron, React).
 */
function validateSharedContent(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  const relativePath = path.relative(ROOT, filePath);

  // 1. Forbidden Imports/Includes
  const forbiddenPatterns = [
    { regex: /from\s+['"](electron|react|react-dom|os|fs|path|child_process|http|https|net|crypto)['"]/, msg: 'Forbidden import of platform/UI API' },
    { regex: /require\s*\(['"](electron|react|react-dom|os|fs|path|child_process|http|https|net|crypto)['"]\)/, msg: 'Forbidden require of platform/UI API' },
    { regex: /\b(window|document|navigator)\b/, msg: 'Forbidden browser-specific global usage' },
    { regex: /\b(process|__dirname|__filename)\b/, msg: 'Forbidden Node-specific global usage' },
    { regex: /\b(ipcRenderer|ipcMain|shell|app|remote)\b/, msg: 'Forbidden Electron-specific API usage' },
    { regex: /class\s+\w+\s+\{/, msg: 'Stateful class detected (shared should prefer interfaces/types)', severity: 'WARNING' as const }
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.regex.test(content)) {
      violations.push({
        check: `Bad content in shared subsystem: ${pattern.msg}`,
        file: relativePath,
        fix: `Move this logic to 'electron/' or 'src/'. 'shared/' must be a pure contract zone.`,
        severity: pattern.severity || 'WARNING'
      });
    }
  }
}

function walk(dir: string) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'dist-electron') continue;
      walk(fullPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
        validateFile(fullPath);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

console.log('Starting Subsystem Boundary Validation...');
console.log(`Scan Root: ${ROOT}`);

walk(RENDERER_ROOT);
walk(ELECTRON_ROOT);
walk(SHARED_ROOT);
// We also scan scripts to ensure they don't leak into each other or violate some rules, 
// though the primary focus is production boundary leaks.
// walk(path.join(ROOT, 'scripts')); 

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const line = '='.repeat(80);
console.log(`\n${line}`);
console.log('  SUBSYSTEM BOUNDARY VALIDATION REPORT');
console.log(line);
console.log(`  Files scanned   : ${filesScanned}`);
console.log(`  Imports checked : ${importsChecked}`);
console.log(`  Violations      : ${violations.length}`);
console.log(`  Mode            : WARNING ONLY`);
console.log(line);

if (violations.length > 0) {
  console.log('\n  VIOLATIONS DETECTED\n');
  for (const v of violations) {
    console.log(`  [${v.severity}] ${v.check}`);
    console.log(`  File : ${v.file}`);
    console.log(`  Fix  : ${v.fix}`);
    console.log('  ' + '-'.repeat(40));
  }
} else {
  console.log('\n  ✅ No subsystem boundary violations found!');
}

console.log(`\n${line}\n`);

// Always exit 0 in warning-only mode
process.exit(0);
