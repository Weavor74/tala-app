#!/usr/bin/env tsx
/// <reference types="node" />

import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  loadContract,
  loadExceptions,
  readFileSafe,
  walkRepoFiles,
  writeExceptions
} from './shared/io';
import { collectViolations, violationKey } from './shared/naming-rules';
import {
  GatekeeperNamingFinding,
  GatekeeperNamingResult,
  NamingExceptionEntry,
  NamingExceptionsFile,
  Violation
} from './shared/types';

const ROOT = path.resolve(__dirname, '../..');
const CONTRACT_PATH = path.join(ROOT, 'docs/contracts/naming.contract.json');
const EXCEPTIONS_PATH = path.join(ROOT, 'docs/contracts/naming.exceptions.json');
const GATEKEEPER_CONFIG_PATH = path.join(ROOT, 'docs/contracts/naming-gatekeeper.config.json');
const EXCEPTIONS_RELATIVE_PATH = 'docs/contracts/naming.exceptions.json';

type ParsedArgs = {
  updateBaseline: boolean;
  gatekeeper: boolean;
  json: boolean;
  changedFilesFile?: string;
  changedFiles: string[];
  baselineRef: string;
  baselineGrowthJustification?: string;
};

type NamingValidationState = {
  contract: ReturnType<typeof loadContract>;
  exceptionFile: NamingExceptionsFile;
  violations: Violation[];
  newViolations: Violation[];
  allowedExceptions: Violation[];
  staleExceptions: NamingExceptionEntry[];
};

type NamingGatekeeperConfig = {
  criticalBoundaryPathRegexes: string[];
  hardFailRulesInCriticalChangedFiles: string[];
  baselineGrowthControl?: {
    requireJustification: boolean;
    maxAllowedGrowthWithJustification?: number;
  };
};

function parseArgs(argv: string[]): ParsedArgs {
  const changedFiles: string[] = [];
  let changedFilesFile: string | undefined;
  let baselineRef = 'HEAD';
  let baselineGrowthJustification: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--changed-file=')) {
      const value = arg.slice('--changed-file='.length).trim();
      if (value) changedFiles.push(value);
      continue;
    }
    if (arg.startsWith('--changed-files-file=')) {
      const value = arg.slice('--changed-files-file='.length).trim();
      if (value) changedFilesFile = value;
      continue;
    }
    if (arg.startsWith('--baseline-ref=')) {
      const value = arg.slice('--baseline-ref='.length).trim();
      if (value) baselineRef = value;
      continue;
    }
    if (arg.startsWith('--baseline-growth-justification=')) {
      const value = arg.slice('--baseline-growth-justification='.length).trim();
      if (value) baselineGrowthJustification = value;
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
    if (arg === '--changed-files-file') {
      const value = argv[i + 1];
      if (value) {
        changedFilesFile = value;
        i += 1;
      }
      continue;
    }
    if (arg === '--baseline-ref') {
      const value = argv[i + 1];
      if (value) {
        baselineRef = value;
        i += 1;
      }
      continue;
    }
    if (arg === '--baseline-growth-justification') {
      const value = argv[i + 1];
      if (value) {
        baselineGrowthJustification = value;
        i += 1;
      }
      continue;
    }
    if (!arg.startsWith('--')) {
      changedFiles.push(arg);
    }
  }

  if (!baselineGrowthJustification) {
    baselineGrowthJustification = process.env.TALA_NAMING_BASELINE_JUSTIFICATION?.trim() || undefined;
  }

  return {
    updateBaseline: argv.includes('--update-baseline'),
    gatekeeper: argv.includes('--gatekeeper'),
    json: argv.includes('--json'),
    changedFilesFile,
    changedFiles,
    baselineRef,
    baselineGrowthJustification
  };
}

function toPosix(relPath: string): string {
  return relPath.replace(/\\/g, '/');
}

function parseFileList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(toPosix);
}

function runGit(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function resolveChangedFiles(parsedArgs: ParsedArgs): string[] {
  const results = new Set<string>();

  for (const file of parsedArgs.changedFiles) {
    if (!file) continue;
    results.add(toPosix(file));
  }

  if (parsedArgs.changedFilesFile) {
    const raw = readFileSafe(ROOT, toPosix(path.relative(ROOT, path.resolve(parsedArgs.changedFilesFile))));
    if (raw) {
      for (const file of parseFileList(raw)) results.add(file);
    }
  }

  if (results.size > 0) return Array.from(results).sort();

  const baseRef = process.env.GITHUB_BASE_REF?.trim();
  if (baseRef) {
    try {
      const diff = runGit(['diff', '--name-only', `origin/${baseRef}...HEAD`]);
      for (const file of parseFileList(diff)) results.add(file);
    } catch {
      // Best-effort fallback below.
    }
  }

  if (results.size === 0) {
    try {
      const diff = runGit(['diff', '--name-only', 'HEAD~1..HEAD']);
      for (const file of parseFileList(diff)) results.add(file);
    } catch {
      // Best-effort fallback below.
    }
  }

  if (results.size === 0) {
    try {
      const status = runGit(['status', '--porcelain']);
      for (const line of parseFileList(status)) {
        const trimmed = line.trim();
        const file = trimmed.length > 3 ? trimmed.slice(3).trim() : '';
        if (!file) continue;
        results.add(toPosix(file));
      }
    } catch {
      // If git is unavailable, we return an empty list and emit escalation later.
    }
  }

  return Array.from(results).sort();
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

function collectNamingValidationState(): NamingValidationState {
  const contract = loadContract(CONTRACT_PATH);
  const files = walkRepoFiles(ROOT);
  const violations = dedupeViolations(
    collectViolations(contract, files, relFile => readFileSafe(ROOT, relFile))
  );
  const exceptionFile = loadExceptions(EXCEPTIONS_PATH);

  const exceptionKeyToEntry = new Map<string, NamingExceptionEntry>();
  for (const entry of exceptionFile.exceptions) {
    const key = violationKey({
      file: entry.file,
      rule: entry.rule,
      symbol: entry.symbol,
      value: entry.value
    });
    if (exceptionKeyToEntry.has(key)) {
      throw new Error(`Duplicate exception entry detected for key: ${key}`);
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

  return {
    contract,
    exceptionFile,
    violations,
    newViolations,
    allowedExceptions,
    staleExceptions
  };
}

function loadGatekeeperConfig(): NamingGatekeeperConfig {
  const raw = readFileSafe(ROOT, path.relative(ROOT, GATEKEEPER_CONFIG_PATH).replace(/\\/g, '/'));
  if (!raw) {
    throw new Error(`Gatekeeper naming config not found: ${GATEKEEPER_CONFIG_PATH}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Gatekeeper naming config is malformed JSON: ${String(error)}`);
  }

  const candidate = parsed as Partial<NamingGatekeeperConfig>;
  if (!candidate || !Array.isArray(candidate.criticalBoundaryPathRegexes) || !Array.isArray(candidate.hardFailRulesInCriticalChangedFiles)) {
    throw new Error(`Gatekeeper naming config is malformed: expected criticalBoundaryPathRegexes and hardFailRulesInCriticalChangedFiles arrays.`);
  }

  return {
    criticalBoundaryPathRegexes: candidate.criticalBoundaryPathRegexes,
    hardFailRulesInCriticalChangedFiles: candidate.hardFailRulesInCriticalChangedFiles,
    baselineGrowthControl: candidate.baselineGrowthControl ?? {
      requireJustification: true
    }
  };
}

function toGatekeeperFinding(
  source: GatekeeperNamingFinding['source'],
  finding: Violation | NamingExceptionEntry,
  messageOverride?: string
): GatekeeperNamingFinding {
  if ('message' in finding) {
    return {
      source,
      file: finding.file,
      rule: finding.rule,
      message: messageOverride ?? finding.message,
      symbol: finding.symbol,
      value: finding.value,
      severity: finding.severity,
      line: finding.line,
      column: finding.column
    };
  }

  return {
    source,
    file: finding.file,
    rule: finding.rule,
    message: messageOverride ?? 'Baseline entry exists but violation no longer occurs.',
    symbol: finding.symbol,
    value: finding.value
  };
}

function readExceptionCountAtGitRef(gitRef: string): number | null {
  try {
    const raw = runGit(['show', `${gitRef}:${EXCEPTIONS_RELATIVE_PATH}`]);
    const parsed = JSON.parse(raw) as Partial<NamingExceptionsFile>;
    return Array.isArray(parsed.exceptions) ? parsed.exceptions.length : null;
  } catch {
    return null;
  }
}

function buildGatekeeperResult(parsedArgs: ParsedArgs, state: NamingValidationState): GatekeeperNamingResult {
  const config = loadGatekeeperConfig();
  const changedFiles = resolveChangedFiles(parsedArgs);
  const warnings: string[] = [];
  const escalations: string[] = [];
  const failReasons: string[] = [];

  if (changedFiles.length === 0) {
    warnings.push('Gatekeeper could not determine changed files; critical-boundary strictness used empty changed-file scope.');
  }

  const criticalMatchers = config.criticalBoundaryPathRegexes.map(entry => new RegExp(entry));
  const hardFailRuleSet = new Set(config.hardFailRulesInCriticalChangedFiles);
  const changedCriticalFiles = changedFiles.filter(file => criticalMatchers.some(rx => rx.test(file)));
  const changedCriticalFileSet = new Set(changedCriticalFiles);

  const criticalBoundaryFindings: GatekeeperNamingFinding[] = [];
  for (const violation of state.violations) {
    if (!changedCriticalFileSet.has(violation.file)) continue;
    if (!hardFailRuleSet.has(violation.rule)) continue;
    criticalBoundaryFindings.push(
      toGatekeeperFinding(
        state.newViolations.some(v => violationKey(v) === violationKey(violation))
          ? 'new_violation'
          : 'allowed_exception',
        violation,
        `Critical-boundary naming rule violation in changed file: ${violation.message}`
      )
    );
  }

  if (state.newViolations.length > 0) {
    failReasons.push(`new naming violations detected (${state.newViolations.length})`);
  }
  if (state.staleExceptions.length > 0) {
    failReasons.push(`stale naming exceptions detected (${state.staleExceptions.length})`);
  }
  if (criticalBoundaryFindings.length > 0) {
    failReasons.push(`critical-boundary naming violations detected in changed files (${criticalBoundaryFindings.length})`);
  }

  const previousExceptionCount = readExceptionCountAtGitRef(parsedArgs.baselineRef);
  const currentExceptionCount = state.exceptionFile.exceptions.length;
  const baselineExceptionDelta = previousExceptionCount == null ? 0 : currentExceptionCount - previousExceptionCount;
  const baselineGrowthJustified = Boolean(parsedArgs.baselineGrowthJustification);

  if (previousExceptionCount == null) {
    escalations.push(`Unable to compare exception baseline growth against git ref "${parsedArgs.baselineRef}".`);
  } else if (baselineExceptionDelta > 0) {
    const requireJustification = config.baselineGrowthControl?.requireJustification ?? true;
    const maxAllowedGrowth = config.baselineGrowthControl?.maxAllowedGrowthWithJustification ?? 20;
    if (requireJustification && !baselineGrowthJustified) {
      failReasons.push(
        `naming exception baseline grew by ${baselineExceptionDelta} entries without explicit justification`
      );
    } else if (baselineExceptionDelta > maxAllowedGrowth) {
      failReasons.push(
        `naming exception baseline grew by ${baselineExceptionDelta}, exceeding max allowed ${maxAllowedGrowth} entries`
      );
    } else {
      escalations.push(
        `naming exception baseline grew by ${baselineExceptionDelta} with justification; manual reviewer confirmation required`
      );
    }
  }

  let status: GatekeeperNamingResult['status'];
  if (failReasons.length > 0) {
    status = 'FAIL';
  } else if (warnings.length > 0 || escalations.length > 0) {
    status = 'WARN_ESCALATE';
  } else if (state.allowedExceptions.length > 0) {
    status = 'PASS_WITH_DEBT';
  } else {
    status = 'PASS';
  }

  const summary =
    status === 'FAIL'
      ? `Gatekeeper naming check failed: ${failReasons.join('; ')}.`
      : status === 'WARN_ESCALATE'
        ? 'Gatekeeper naming check passed with escalation warnings.'
        : status === 'PASS_WITH_DEBT'
          ? 'Gatekeeper naming check passed with existing naming debt (exceptions).'
          : 'Gatekeeper naming check passed with no naming debt.';

  return {
    status,
    summary,
    counts: {
      totalDetectedViolations: state.violations.length,
      newViolations: state.newViolations.length,
      allowedExceptions: state.allowedExceptions.length,
      staleExceptions: state.staleExceptions.length,
      criticalBoundaryFindings: criticalBoundaryFindings.length,
      changedCriticalFiles: changedCriticalFiles.length,
      baselineExceptionDelta
    },
    findings: {
      newViolations: state.newViolations.map(v => toGatekeeperFinding('new_violation', v)),
      staleExceptions: state.staleExceptions.map(v => toGatekeeperFinding('stale_exception', v)),
      criticalBoundaryFindings
    },
    debt: {
      hasNamingDebt: state.allowedExceptions.length > 0,
      allowedExceptionCount: state.allowedExceptions.length
    },
    warnings,
    escalations,
    metadata: {
      changedFilesEvaluated: changedFiles,
      criticalBoundaryFilesEvaluated: changedCriticalFiles,
      baselineGrowthJustified,
      baselineGrowthJustification: parsedArgs.baselineGrowthJustification,
      gatekeeperConfigPath: path.relative(ROOT, GATEKEEPER_CONFIG_PATH).replace(/\\/g, '/')
    }
  };
}

function printGatekeeperResult(result: GatekeeperNamingResult): void {
  console.log(`[GATEKEEPER] status=${result.status}`);
  console.log(`[GATEKEEPER] ${result.summary}`);
  console.log('');
  console.log('Counts:');
  console.log(`  total detected violations: ${result.counts.totalDetectedViolations}`);
  console.log(`  new violations: ${result.counts.newViolations}`);
  console.log(`  allowed exceptions: ${result.counts.allowedExceptions}`);
  console.log(`  stale exceptions: ${result.counts.staleExceptions}`);
  console.log(`  changed critical files: ${result.counts.changedCriticalFiles}`);
  console.log(`  critical-boundary findings: ${result.counts.criticalBoundaryFindings}`);
  console.log(`  baseline exception delta: ${result.counts.baselineExceptionDelta}`);

  for (const finding of result.findings.newViolations) {
    const loc = finding.line ? `${finding.file}:${finding.line}${finding.column ? `:${finding.column}` : ''}` : finding.file;
    console.log('');
    console.log(`[NEW] ${finding.rule}`);
    console.log(`  file: ${loc}`);
    if (finding.symbol) console.log(`  symbol: ${finding.symbol}`);
    if (finding.value) console.log(`  value: ${finding.value}`);
    console.log(`  issue: ${finding.message}`);
  }

  for (const finding of result.findings.staleExceptions) {
    console.log('');
    console.log(`[STALE] ${finding.rule}`);
    console.log(`  file: ${finding.file}`);
    if (finding.symbol) console.log(`  symbol: ${finding.symbol}`);
    if (finding.value) console.log(`  value: ${finding.value}`);
    console.log(`  issue: ${finding.message}`);
  }

  for (const finding of result.findings.criticalBoundaryFindings) {
    const loc = finding.line ? `${finding.file}:${finding.line}${finding.column ? `:${finding.column}` : ''}` : finding.file;
    console.log('');
    console.log(`[CRITICAL] ${finding.rule}`);
    console.log(`  file: ${loc}`);
    if (finding.symbol) console.log(`  symbol: ${finding.symbol}`);
    if (finding.value) console.log(`  value: ${finding.value}`);
    console.log(`  issue: ${finding.message}`);
  }

  if (result.warnings.length > 0) {
    console.log('');
    for (const warning of result.warnings) {
      console.log(`[WARN] ${warning}`);
    }
  }

  if (result.escalations.length > 0) {
    console.log('');
    for (const escalation of result.escalations) {
      console.log(`[ESCALATE] ${escalation}`);
    }
  }
}

function runBaselineUpdate(state: NamingValidationState): void {
  const baseline: NamingExceptionsFile = {
    contract: state.contract.contractName,
    contractVersion: state.contract.version,
    generatedAt: new Date().toISOString(),
    exceptions: state.violations.map(toException)
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
}

function runLegacyValidationOutput(state: NamingValidationState): void {
  for (const violation of state.newViolations) {
    printViolation('[NEW]', violation);
  }

  for (const violation of state.allowedExceptions) {
    printViolation('[EXCEPTION]', violation);
  }

  for (const entry of state.staleExceptions) {
    printStale('[STALE]', entry);
  }

  console.log('');
  console.log('Summary:');
  console.log(`  new violations: ${state.newViolations.length}`);
  console.log(`  allowed exceptions: ${state.allowedExceptions.length}`);
  console.log(`  stale exceptions: ${state.staleExceptions.length}`);
  console.log(`  total detected violations: ${state.violations.length}`);

  if (state.newViolations.length > 0 || state.staleExceptions.length > 0) {
    console.error('');
    console.error('Naming contract validation failed.');
    console.error('Fix new violations or update baseline intentionally with: npm run docs:baseline:naming');
    process.exit(1);
  }

  console.log('Naming contract validation passed (no new violations, no stale exceptions).');
}

function main(): void {
  const parsedArgs = parseArgs(process.argv.slice(2));

  let state: NamingValidationState;
  try {
    state = collectNamingValidationState();
  } catch (error) {
    console.error(`[ERROR] ${String(error)}`);
    process.exit(1);
    return;
  }

  if (parsedArgs.updateBaseline) {
    runBaselineUpdate(state);
    process.exit(0);
  }

  if (parsedArgs.gatekeeper) {
    let result: GatekeeperNamingResult;
    try {
      result = buildGatekeeperResult(parsedArgs, state);
    } catch (error) {
      console.error(`[ERROR] ${String(error)}`);
      process.exit(1);
      return;
    }

    if (parsedArgs.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printGatekeeperResult(result);
    }

    if (result.status === 'FAIL') {
      process.exit(1);
    }
    process.exit(0);
  }

  runLegacyValidationOutput(state);
}

main();
