/// <reference types="node" />
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

// Project root is two levels up from scripts/diagnostics/
const ROOT = path.resolve(__dirname, '..', '..');

// 1. Read package.json name/version
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
console.log(`App: ${pkg.name}  v${pkg.version}`);

// 2. Count files in src recursively (files only, not dirs)
function countFiles(dir: string): number {
  let count = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
    else count++;
  }
  return count;
}
const srcCount = countFiles(path.join(ROOT, 'src'));
console.log(`Files in src/: ${srcCount}`);

// 3. Run npm run lint, capture exit code (non-zero is acceptable)
const lint = spawnSync('npm', ['run', 'lint'], { cwd: ROOT, encoding: 'utf8', shell: true });
const lintExitCode = lint.status ?? -1;
const lintStatus = lintExitCode === 0 ? 'passed' : `failed (exit ${lintExitCode})`;
console.log(`Lint: ${lintStatus}`);
if (lint.stdout) console.log(lint.stdout.slice(0, 500));
if (lint.stderr) console.log(lint.stderr.slice(0, 200));

// 4. Write summary JSON
const summary = {
  name: pkg.name,
  version: pkg.version,
  srcFileCount: srcCount,
  lintExitCode,
  lintStatus,
  probeTimestamp: new Date().toISOString()
};
const outPath = path.join(ROOT, 'scripts', 'health_probe.json');
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`\nSummary written to: ${outPath}`);
console.log(JSON.stringify(summary, null, 2));