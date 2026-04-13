#!/usr/bin/env tsx
/// <reference types="node" />

import * as path from 'node:path';
import { loadContract } from './shared/io';
import { buildArtifactNameSuggestion, resolveArtifactClassification, validateArtifactName } from './shared/artifact-naming';
import { ArtifactClassificationInput } from './shared/types';

const ROOT = path.resolve(__dirname, '../..');
const CONTRACT_PATH = path.join(ROOT, 'docs/contracts/naming.contract.json');

function readFlag(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function printUsage(): void {
  console.log('Usage: npx tsx tools/doclock/suggest-name.ts --subsystem <name> --layer <name> --role <name> --mutability <...> --exposure <...> --artifact-kind <kind>');
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const contract = loadContract(CONTRACT_PATH);
  const input: ArtifactClassificationInput = {
    subsystem: readFlag(args, '--subsystem') ?? '',
    layer: readFlag(args, '--layer') ?? '',
    role: readFlag(args, '--role') ?? '',
    mutability: readFlag(args, '--mutability') ?? '',
    exposure: readFlag(args, '--exposure') ?? '',
    artifactKind: readFlag(args, '--artifact-kind') ?? readFlag(args, '--kind') ?? ''
  };

  const classified = resolveArtifactClassification(input, contract);
  if (!classified.ok) {
    console.error('[INVALID CLASSIFICATION]');
    for (const err of classified.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const suggestion = buildArtifactNameSuggestion(contract, classified.classification);
  const validation = validateArtifactName(contract, classified.classification, suggestion);

  console.log('[SUGGESTED NAME]');
  console.log(`  ${suggestion}`);

  if (!validation.valid) {
    console.error('[WARNING] suggested name still has issues:');
    for (const issue of validation.issues) {
      console.error(`  - [${issue.severity}] ${issue.rule}: ${issue.message}`);
    }
    process.exit(1);
  }

  console.log('[VALID] suggestion passes naming contract.');
}

if (require.main === module) {
  main();
}
