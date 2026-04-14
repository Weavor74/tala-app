#!/usr/bin/env tsx
/// <reference types="node" />

import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanImpact, type DocImpactEntry, type ScanImpactResult } from './scan-impact';

const ROOT = path.resolve(__dirname, '../..');
const IMPACT_DOC_PATH = path.join(ROOT, 'docs/review/doclock-impact.md');
const GENERATED_START = '<!-- GENERATED:impact-map:start -->';
const GENERATED_END = '<!-- GENERATED:impact-map:end -->';
const REVIEW_START = '<!-- REVIEW_REQUIRED:start -->';
const REVIEW_END = '<!-- REVIEW_REQUIRED:end -->';

type ParsedArgs = {
  check: boolean;
  json: boolean;
  changedFiles: string[];
  changedFilesFile?: string;
};

type HealDocsResult = {
  changed: boolean;
  unresolvedReviewCount: number;
  reportPath: string;
  summary: ScanImpactResult['summary'];
  unresolvedReviewItems: string[];
};

function parseArgs(argv: string[]): ParsedArgs {
  const changedFiles: string[] = [];
  let changedFilesFile: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--changed-file=')) {
      const value = arg.slice('--changed-file='.length).trim();
      if (value) changedFiles.push(value);
      continue;
    }
    if (arg === '--changed-file') {
      const value = argv[i + 1];
      if (value) {
        changedFiles.push(value);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--changed-files-file=')) {
      const value = arg.slice('--changed-files-file='.length).trim();
      if (value) changedFilesFile = value;
      continue;
    }
    if (arg === '--changed-files-file') {
      const value = argv[i + 1];
      if (value) {
        changedFilesFile = value;
        i += 1;
      }
      continue;
    }
    if (!arg.startsWith('--')) {
      changedFiles.push(arg);
    }
  }
  return {
    check: argv.includes('--check'),
    json: argv.includes('--json'),
    changedFiles,
    changedFilesFile
  };
}

function ensureReportSkeleton(existing: string | null): string {
  if (existing) return existing;
  return [
    '# Doclock Impact Report',
    '',
    'This document is deterministic and maintained by `tools/doclock/heal-docs.ts`.',
    '',
    '## Impact Map',
    GENERATED_START,
    '_No impact scan has run yet._',
    GENERATED_END,
    '',
    '## REVIEW_REQUIRED',
    REVIEW_START,
    'None.',
    REVIEW_END,
    ''
  ].join('\n');
}

function replaceBoundedBlock(content: string, startMarker: string, endMarker: string, body: string): string {
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);
  if (startIndex >= 0 && endIndex > startIndex) {
    return `${content.slice(0, startIndex + startMarker.length)}\n${body}\n${content.slice(endIndex)}`;
  }
  return `${content.trimEnd()}\n\n${startMarker}\n${body}\n${endMarker}\n`;
}

function renderImpactBlock(result: ScanImpactResult): string {
  if (result.impacts.length === 0) {
    return 'No changed files detected; no doc impact to heal.';
  }
  const lines: string[] = [];
  lines.push('| Changed Path | Doc Owners | Generated Sections | Mode |');
  lines.push('| --- | --- | --- | --- |');
  for (const impact of result.impacts) {
    const mode = impact.requiresManualReview ? 'manual' : 'auto';
    lines.push(
      `| \`${impact.changedPath}\` | ${impact.ownedDocs.map(doc => `\`${doc}\``).join('<br>')} | ${impact.generatedSectionIds.map(id => `\`${id}\``).join(', ')} | ${mode} |`
    );
  }
  lines.push('');
  lines.push(`Summary: total_changed=${result.summary.totalChangedFiles}, impact_candidates=${result.summary.totalImpactCandidates}, mapped=${result.summary.mappedFiles}, unmapped=${result.summary.unmappedFiles}, manual_review=${result.summary.manualReviewRequiredCount}.`);
  return lines.join('\n');
}

function isManualReviewSatisfied(impact: DocImpactEntry, changedFiles: Set<string>): boolean {
  return impact.ownedDocs.some(doc => changedFiles.has(doc));
}

function renderReviewRequiredBlock(result: ScanImpactResult): { text: string; unresolvedItems: string[] } {
  const changedSet = new Set(result.changedFiles);
  const manualImpacts = result.impacts.filter(impact => impact.requiresManualReview);
  if (manualImpacts.length === 0) {
    return { text: 'None.', unresolvedItems: [] };
  }

  const lines: string[] = [];
  const unresolvedItems: string[] = [];
  for (const impact of manualImpacts) {
    const satisfied = isManualReviewSatisfied(impact, changedSet);
    const checkbox = satisfied ? '[x]' : '[ ]';
    const owners = impact.ownedDocs.join(', ');
    const line = `- ${checkbox} \`${impact.changedPath}\` -> review/update: ${owners} (reason: ${impact.reasonCode})`;
    lines.push(line);
    if (!satisfied) unresolvedItems.push(line);
  }
  lines.push('');
  lines.push('Rule: unresolved `[ ]` items block `docs:validate`.');
  return { text: lines.join('\n'), unresolvedItems };
}

export function healDocs(parsed: ParsedArgs): HealDocsResult {
  const impact = scanImpact({
    json: false,
    changedFiles: parsed.changedFiles,
    changedFilesFile: parsed.changedFilesFile
  });

  const current = fs.existsSync(IMPACT_DOC_PATH) ? fs.readFileSync(IMPACT_DOC_PATH, 'utf8') : null;
  let next = ensureReportSkeleton(current);
  next = replaceBoundedBlock(next, GENERATED_START, GENERATED_END, renderImpactBlock(impact));
  const review = renderReviewRequiredBlock(impact);
  next = replaceBoundedBlock(next, REVIEW_START, REVIEW_END, review.text);

  const changed = current !== next;
  if (!parsed.check && changed) {
    const dir = path.dirname(IMPACT_DOC_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(IMPACT_DOC_PATH, next, 'utf8');
  }

  return {
    changed,
    unresolvedReviewCount: review.unresolvedItems.length,
    reportPath: path.relative(ROOT, IMPACT_DOC_PATH).replace(/\\/g, '/'),
    summary: impact.summary,
    unresolvedReviewItems: review.unresolvedItems
  };
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  const result = healDocs(parsed);

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[doclock] Healed: ${result.reportPath}`);
    console.log(`[doclock] Changed: ${result.changed ? 'yes' : 'no'}`);
    console.log(`[doclock] Unresolved REVIEW_REQUIRED items: ${result.unresolvedReviewCount}`);
    if (result.unresolvedReviewCount > 0) {
      for (const line of result.unresolvedReviewItems) {
        console.log(`  ${line}`);
      }
    }
  }

  if (parsed.check) {
    if (result.changed) {
      console.error('[doclock] Drift detected: generated documentation block is out of date.');
      process.exit(1);
    }
    if (result.unresolvedReviewCount > 0) {
      console.error('[doclock] REVIEW_REQUIRED contains unresolved items.');
      process.exit(1);
    }
  }
}

if (require.main === module) {
  main();
}
