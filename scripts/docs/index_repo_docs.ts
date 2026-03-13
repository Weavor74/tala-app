/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const DOCS_DIR = path.join(ROOT, 'docs');
const OUTPUT_FILE = path.join(ROOT, 'docs/TDP_INDEX.md'); // Tala Documentation Project Index

interface DocFile {
  title: string;
  path: string;
  category: string;
}

function getTitle(content: string, fileName: string): string {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : fileName;
}

function scanDocs(dir: string, category = ''): DocFile[] {
  const files: DocFile[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(DOCS_DIR, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      files.push(...scanDocs(fullPath, entry.name));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      files.push({
        title: getTitle(content, entry.name),
        path: relPath,
        category: category || 'General'
      });
    }
  }
  return files;
}

function generateMarkdown(files: DocFile[]): string {
  const categories = [...new Set(files.map(f => f.category))].sort();
  let md = '# Tala Documentation Index\n\n';
  md += 'Automatically generated on ' + new Date().toISOString() + '\n\n';

  for (const cat of categories) {
    md += `## ${cat}\n\n`;
    const catFiles = files.filter(f => f.category === cat).sort((a, b) => a.title.localeCompare(b.title));
    for (const file of catFiles) {
      md += `- [${file.title}](${file.path})\n`;
    }
    md += '\n';
  }

  return md;
}

console.log('Indexing documentation...');
const files = scanDocs(DOCS_DIR);
const markdown = generateMarkdown(files);
fs.writeFileSync(OUTPUT_FILE, markdown);
console.log(`Index generated at ${path.relative(ROOT, OUTPUT_FILE)}`);
