#!/usr/bin/env tsx
/// <reference types="node" />

import * as path from 'node:path';
import { loadContract } from './shared/io';
import { resolveArtifactClassification } from './shared/artifact-naming';
import { ArtifactClassificationInput } from './shared/types';

const ROOT = path.resolve(__dirname, '../..');
const CONTRACT_PATH = path.join(ROOT, 'docs/contracts/naming.contract.json');

function readFlag(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function printUsage(): void {
  console.log('Usage: npx tsx tools/doclock/classify-artifact.ts --subsystem <name> --layer <name> --role <name> --mutability <read|write|transform|validate|execute|schedule|route|register> --exposure <internal|ipc|api|external|contract_facing> --artifact-kind <kind>');
}

export function resolveClassificationFromArgs(args: string[]) {
  const input: ArtifactClassificationInput = {
    subsystem: readFlag(args, '--subsystem') ?? '',
    layer: readFlag(args, '--layer') ?? '',
    role: readFlag(args, '--role') ?? '',
    mutability: readFlag(args, '--mutability') ?? '',
    exposure: readFlag(args, '--exposure') ?? '',
    artifactKind: readFlag(args, '--artifact-kind') ?? readFlag(args, '--kind') ?? ''
  };

  const contract = loadContract(CONTRACT_PATH);
  return resolveArtifactClassification(input, contract);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  let result;
  try {
    result = resolveClassificationFromArgs(args);
  } catch (error) {
    console.error(`[ERROR] ${String(error)}`);
    process.exit(1);
  }

  if (!result.ok) {
    console.error('[INVALID CLASSIFICATION]');
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log('[CLASSIFICATION]');
  console.log(JSON.stringify(result.classification, null, 2));
}

if (require.main === module) {
  main();
}
