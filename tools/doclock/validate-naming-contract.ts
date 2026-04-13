#!/usr/bin/env tsx
/// <reference types="node" />

import * as path from 'node:path';
import {
  loadContract,
  loadExceptions,
  readFileSafe,
  walkRepoFiles,
  writeExceptions
} from './shared/io';
import { collectViolations, violationKey } from './shared/naming-rules';
import { NamingExceptionEntry, NamingExceptionsFile, Violation } from './shared/types';

const ROOT = path.resolve(__dirname, '../..');
const CONTRACT_PATH = path.join(ROOT, 'docs/contracts/naming.contract.json');
const EXCEPTIONS_PATH = path.join(ROOT, 'docs/contracts/naming.exceptions.json');

function parseArgs(argv: string[]): { updateBaseline: boolean } {
  return {
    updateBaseline: argv.includes('--update-baseline')
  };
}

function toException(violation: Violation): NamingExceptionEntry {
  return {
    file: violation.file,
    rule: violation.rule,
    symbol: violation.symbol,
    value: violation.value,
    reason: 'legacy violation - baseline tracking',
    addedAt: new Date().toISOString()
  };
}

function printViolation(prefix: string, v: Violation): void {
  const loc = v.line ? `${v.file}:${v.line}${v.column ? `:${v.column}` : ''}` : v.file;
  console.log(`${prefix} ${v.rule}`);
  console.log(`  file: ${loc}`);
  if (v.symbol) console.log(`  symbol: ${v.symbol}`);
  if (v.value) console.log(`  value: ${v.value}`);
  console.log(`  issue: ${v.message}`);
}

function printStale(prefix: string, entry: NamingExceptionEntry): void {
  console.log(`${prefix} ${entry.rule}`);
  console.log(`  file: ${entry.file}`);
  if (entry.symbol) console.log(`  symbol: ${entry.symbol}`);
  if (entry.value) console.log(`  value: ${entry.value}`);
  console.log('  issue: baseline entry exists but violation no longer occurs.');
}

function dedupeViolations(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  const out: Violation[] = [];
  for (const violation of violations) {
    const key = violationKey(violation);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(violation);
  }
  return out;
}

function main(): void {
  const { updateBaseline } = parseArgs(process.argv.slice(2));

  let contract;
  try {
    contract = loadContract(CONTRACT_PATH);
  } catch (error) {
    console.error(`[ERROR] ${String(error)}`);
    process.exit(1);
  }

  const files = walkRepoFiles(ROOT);
  const violations = dedupeViolations(
    collectViolations(contract, files, relFile => readFileSafe(ROOT, relFile))
  );

  if (updateBaseline) {
    const baseline: NamingExceptionsFile = {
      contract: contract.contractName,
      contractVersion: contract.version,
      generatedAt: new Date().toISOString(),
      exceptions: violations.map(toException)
    };

    baseline.exceptions.sort((a, b) => {
      const fileCmp = a.file.localeCompare(b.file);
      if (fileCmp !== 0) return fileCmp;
      const ruleCmp = a.rule.localeCompare(b.rule);
      if (ruleCmp !== 0) return ruleCmp;
      const symbolCmp = (a.symbol ?? '').localeCompare(b.symbol ?? '');
      if (symbolCmp !== 0) return symbolCmp;
      return (a.value ?? '').localeCompare(b.value ?? '');
    });

    writeExceptions(EXCEPTIONS_PATH, baseline);
    console.log(`[BASELINE] Wrote ${baseline.exceptions.length} exception entries to docs/contracts/naming.exceptions.json`);
    process.exit(0);
  }

  let exceptionFile;
  try {
    exceptionFile = loadExceptions(EXCEPTIONS_PATH);
  } catch (error) {
    console.error(`[ERROR] ${String(error)}`);
    process.exit(1);
  }

  const exceptionKeyToEntry = new Map<string, NamingExceptionEntry>();
  for (const entry of exceptionFile.exceptions) {
    const key = violationKey({
      file: entry.file,
      rule: entry.rule,
      symbol: entry.symbol,
      value: entry.value
    });
    if (exceptionKeyToEntry.has(key)) {
      console.error(`[ERROR] Duplicate exception entry detected for key: ${key}`);
      process.exit(1);
    }
    exceptionKeyToEntry.set(key, entry);
  }

  const violationKeyToViolation = new Map<string, Violation>();
  for (const violation of violations) {
    violationKeyToViolation.set(violationKey(violation), violation);
  }

  const newViolations: Violation[] = [];
  const allowedExceptions: Violation[] = [];
  for (const violation of violations) {
    const key = violationKey(violation);
    if (exceptionKeyToEntry.has(key)) {
      allowedExceptions.push(violation);
    } else {
      newViolations.push(violation);
    }
  }

  const staleExceptions: NamingExceptionEntry[] = [];
  for (const entry of exceptionFile.exceptions) {
    const key = violationKey({
      file: entry.file,
      rule: entry.rule,
      symbol: entry.symbol,
      value: entry.value
    });
    if (!violationKeyToViolation.has(key)) {
      staleExceptions.push(entry);
    }
  }

  for (const violation of newViolations) {
    printViolation('[NEW]', violation);
  }

  for (const violation of allowedExceptions) {
    printViolation('[EXCEPTION]', violation);
  }

  for (const entry of staleExceptions) {
    printStale('[STALE]', entry);
  }

  console.log('');
  console.log(`Summary:`);
  console.log(`  new violations: ${newViolations.length}`);
  console.log(`  allowed exceptions: ${allowedExceptions.length}`);
  console.log(`  stale exceptions: ${staleExceptions.length}`);
  console.log(`  total detected violations: ${violations.length}`);

  if (newViolations.length > 0 || staleExceptions.length > 0) {
    console.error('');
    console.error('Naming contract validation failed.');
    console.error('Fix new violations or update baseline intentionally with: npm run docs:baseline:naming');
    process.exit(1);
  }

  console.log('Naming contract validation passed (no new violations, no stale exceptions).');
}

main();
