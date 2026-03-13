/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const CODE_ROOTS_PATH = path.join(ROOT, 'code_roots.json');
const SUBSYSTEM_MAPPING_PATH = path.join(ROOT, 'subsystem_mapping.json');
const OUTPUT_DIR = path.join(ROOT, 'docs/architecture');

interface CodeRoot {
  id: string;
  path: string;
  purpose: string;
}

interface Subsystem {
  id: string;
  name: string;
  root: string;
  owns: string[];
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateOverview(roots: CodeRoot[], subsystems: Subsystem[]) {
  let md = '# System Architecture Overview\n\n';
  md += 'This document provides an automated overview of the repository structure and subsystem boundaries.\n\n';

  md += '## Code Roots\n\n';
  md += '| ID | Path | Purpose |\n';
  md += '|---|---|---|\n';
  for (const root of roots) {
    md += `| \`${root.id}\` | \`${root.path}\` | ${root.purpose} |\n`;
  }

  md += '\n## Subsystems\n\n';
  for (const sub of subsystems) {
    md += `### ${sub.name} (\`${sub.id}\`)\n\n`;
    md += `**Root**: \`${sub.root}\`\n\n`;
    md += '**Ownership Patterns**:\n';
    for (const pattern of sub.owns) {
      md += `- \`${pattern}\`\n`;
    }
    md += '\n---\n\n';
  }

  return md;
}

console.log('Extracting architecture documentation...');
const codeRoots = JSON.parse(fs.readFileSync(CODE_ROOTS_PATH, 'utf-8')).roots as CodeRoot[];
const subsystems = JSON.parse(fs.readFileSync(SUBSYSTEM_MAPPING_PATH, 'utf-8')).subsystems as Subsystem[];

ensureDir(OUTPUT_DIR);
const overviewMd = generateOverview(codeRoots, subsystems);
fs.writeFileSync(path.join(OUTPUT_DIR, 'overview.md'), overviewMd);
console.log(`Architecture overview generated at docs/architecture/overview.md`);
