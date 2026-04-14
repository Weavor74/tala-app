#!/usr/bin/env tsx
/// <reference types="node" />

import { healDocs } from './heal-docs';

type ParsedArgs = {
  changedFiles: string[];
  changedFilesFile?: string;
  json: boolean;
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
  }
  return {
    changedFiles,
    changedFilesFile,
    json: argv.includes('--json')
  };
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  const result = healDocs({
    check: true,
    json: parsed.json,
    changedFiles: parsed.changedFiles,
    changedFilesFile: parsed.changedFilesFile
  });

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[doclock] Validation checked: ${result.reportPath}`);
    console.log(`[doclock] Changed: ${result.changed ? 'yes' : 'no'}`);
    console.log(`[doclock] Unresolved REVIEW_REQUIRED: ${result.unresolvedReviewCount}`);
  }

  if (result.changed) {
    console.error('[doclock] Drift detected: docs/review/doclock-impact.md needs regeneration.');
    process.exit(1);
  }
  if (result.unresolvedReviewCount > 0) {
    console.error('[doclock] Unresolved REVIEW_REQUIRED items detected.');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
