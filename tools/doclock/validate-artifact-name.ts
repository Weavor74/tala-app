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
  console.log('Usage: npx tsx tools/doclock/validate-artifact-name.ts --name <proposedName> --subsystem <name> --layer <name> --role <name> --mutability <...> --exposure <...> --artifact-kind <kind>');
}

export function validateFromArgs(args: string[]) {
  const proposedName = readFlag(args, '--name') ?? '';
  const contract = loadContract(CONTRACT_PATH);
  const classificationInput: ArtifactClassificationInput = {
    subsystem: readFlag(args, '--subsystem') ?? '',
    layer: readFlag(args, '--layer') ?? '',
    role: readFlag(args, '--role') ?? '',
    mutability: readFlag(args, '--mutability') ?? '',
    exposure: readFlag(args, '--exposure') ?? '',
    artifactKind: readFlag(args, '--artifact-kind') ?? readFlag(args, '--kind') ?? ''
  };

  const classified = resolveArtifactClassification(classificationInput, contract);
  if (!classified.ok) {
    throw new Error(`Invalid classification: ${classified.errors.join('; ')}`);
  }

  return validateArtifactName(contract, classified.classification, proposedName);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const proposedName = readFlag(args, '--name') ?? '';
  if (!proposedName) {
    console.error('[ERROR] Missing required --name <proposedName>');
    process.exit(1);
  }

  let result;
  let contract;
  try {
    contract = loadContract(CONTRACT_PATH);
    result = validateFromArgs(args);
  } catch (error) {
    console.error(`[INVALID CLASSIFICATION] ${String(error)}`);
    process.exit(1);
  }

  if (result.valid) {
    console.log('[VALID] naming contract accepted proposed name');
    console.log(`  name: ${result.name}`);
    console.log(`  kind: ${result.classification.artifactKind}`);
    console.log(`  subsystem: ${result.classification.subsystem}`);
    process.exit(0);
  }

  console.error('[INVALID] naming contract rejected proposed name');
  console.error(`  name: ${result.name}`);
  console.error(`  kind: ${result.classification.artifactKind}`);
  for (const issue of result.issues) {
    console.error(`  - [${issue.severity}] ${issue.rule}: ${issue.message}`);
  }

  const suggested = buildArtifactNameSuggestion(contract, result.classification);
  if (suggested) {
    console.error(`  suggested: ${suggested}`);
  }

  process.exit(1);
}

if (require.main === module) {
  main();
}
