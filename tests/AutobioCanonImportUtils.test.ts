import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectSourceTree,
  normalizeLtmfEvents,
  renderNormalizedMarkdown,
} from '../scripts/migrations/autobioCanonImportUtils';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-autobio-import-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Autobiographical canon migration utils', () => {
  it('normalizes age=17 events without requiring full calendar dates', () => {
    const root = makeTempDir();
    writeFile(
      path.join(root, 'roleplay_backup_txt', 'tala_long_term_memory_file_ltmf_age_17_memory_03.txt'),
      [
        'Anchor Memory: Learned hard lessons',
        'Age / Life Stage: 17',
        '',
        'This happened during my seventeenth year.',
      ].join('\n'),
    );

    const events = normalizeLtmfEvents({ sourceRoot: root });
    expect(events).toHaveLength(1);
    expect(events[0]?.age).toBe(17);
    expect(events[0]?.ageSequence).toBe(3);
    expect(events[0]?.sourceType).toBe('ltmf');
    expect(events[0]?.memoryType).toBe('autobiographical');
    expect(events[0]?.canon).toBe(true);
  });

  it('produces deterministic event ids and sequence fallback order in same age bucket', () => {
    const root = makeTempDir();
    writeFile(
      path.join(root, 'roleplay_md', 'LTMF-A17-0001.md'),
      [
        '---',
        'title: First event',
        'age: 17',
        '---',
        '',
        'Event one body.',
      ].join('\n'),
    );
    writeFile(
      path.join(root, 'roleplay_md', 'LTMF-A17-0002.md'),
      [
        '---',
        'title: Second event',
        'age: 17',
        '---',
        '',
        'Event two body.',
      ].join('\n'),
    );

    const firstPass = normalizeLtmfEvents({ sourceRoot: root });
    const secondPass = normalizeLtmfEvents({ sourceRoot: root });

    expect(firstPass).toHaveLength(2);
    expect(secondPass.map((e) => e.eventId)).toEqual(firstPass.map((e) => e.eventId));
    expect(firstPass[0]?.ageSequence).toBe(1);
    expect(firstPass[1]?.ageSequence).toBe(2);
  });

  it('inspection recommends markdown-frontmatter import strategy for tala-core ingest_file compatibility', () => {
    const root = makeTempDir();
    writeFile(path.join(root, 'roleplay_md', 'memory_a17.md'), '# Story Outline\nAt 17...');
    writeFile(path.join(root, 'mixed_dump.txt'), 'when you were 17 this happened');
    writeFile(path.join(root, 'structured.json'), '{"age":17,"canon":true}');
    writeFile(path.join(root, 'random.bin'), 'binary-like placeholder');

    const report = inspectSourceTree(root);

    expect(report.totalFiles).toBe(4);
    expect(report.extensionCounts['.md']).toBe(1);
    expect(report.extensionCounts['.txt']).toBe(1);
    expect(report.extensionCounts['.json']).toBe(1);
    expect(report.recommendedFormat).toBe('markdown_frontmatter');
    expect(report.recommendedStrategy.toLowerCase()).toContain('frontmatter');
    expect(report.evaluatedFormats.find((f) => f.format === 'jsonl')?.supportedByRuntime).toBe(false);
  });

  it('renders normalized canon metadata into markdown frontmatter for ingestion', () => {
    const root = makeTempDir();
    writeFile(
      path.join(root, 'roleplay_md', 'LTMF-A17-memory_09.md'),
      [
        '---',
        'title: Test title',
        'age: 17',
        'memory_index: 9',
        '---',
        '',
        'Body content here.',
      ].join('\n'),
    );

    const [event] = normalizeLtmfEvents({ sourceRoot: root });
    expect(event).toBeDefined();
    const markdown = renderNormalizedMarkdown(event!);

    expect(markdown).toContain('source_type: ltmf');
    expect(markdown).toContain('memory_type: autobiographical');
    expect(markdown).toContain('canon: true');
    expect(markdown).toContain('age: 17');
    expect(markdown).toContain('age_sequence: 9');
  });
});
