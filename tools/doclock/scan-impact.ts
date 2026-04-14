#!/usr/bin/env tsx
/// <reference types="node" />

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');

type ImpactRule = {
  id: string;
  description: string;
  pathRegexes: RegExp[];
  ownedDocs: string[];
  generatedSectionIds: string[];
  requiresManualReview: boolean;
};

export type DocImpactEntry = {
  changedPath: string;
  matchedRuleIds: string[];
  descriptions: string[];
  ownedDocs: string[];
  generatedSectionIds: string[];
  requiresManualReview: boolean;
  reasonCode: string;
};

export type ScanImpactResult = {
  changedFiles: string[];
  impactCandidates: string[];
  impacts: DocImpactEntry[];
  summary: {
    totalChangedFiles: number;
    totalImpactCandidates: number;
    mappedFiles: number;
    unmappedFiles: number;
    manualReviewRequiredCount: number;
  };
};

const IMPACT_RULES: ImpactRule[] = [
  {
    id: 'runtime-services',
    description: 'Runtime services changed (behavior/contracts/operations).',
    pathRegexes: [
      /^electron\/services\/.+/,
      /^src\/renderer\/settingsData\.ts$/,
      /^electron\/services\/IpcRouter\.ts$/
    ],
    ownedDocs: [
      'docs/subsystems/SERVICES.md',
      'docs/architecture/service_interactions.md',
      'docs/review/doclock-impact.md'
    ],
    generatedSectionIds: ['impact-map', 'service-ownership-map'],
    requiresManualReview: false
  },
  {
    id: 'ipc-surface',
    description: 'IPC surface changed.',
    pathRegexes: [
      /^electron\/services\/IpcRouter\.ts$/,
      /^electron\/preload\.ts$/,
      /^shared\/a2uiTypes\.ts$/,
      /^electron\/ipc\/.+/
    ],
    ownedDocs: [
      'docs/interfaces/ipc_interface_control.md',
      'docs/review/doclock-impact.md'
    ],
    generatedSectionIds: ['impact-map', 'ipc-inventory'],
    requiresManualReview: false
  },
  {
    id: 'memory-db-authority',
    description: 'Database/memory authority paths changed.',
    pathRegexes: [
      /^electron\/services\/db\/.+/,
      /^electron\/services\/memory\/.+/,
      /^scripts\/migrations\/.+/,
      /^migrations\/.+/
    ],
    ownedDocs: [
      'docs/architecture/memory-authority-invariant.md',
      'docs/development/memory_purge.md',
      'docs/review/doclock-impact.md'
    ],
    generatedSectionIds: ['impact-map', 'migration-ledger'],
    requiresManualReview: true
  },
  {
    id: 'reflection-autonomy',
    description: 'Reflection/autonomy workflows changed.',
    pathRegexes: [
      /^electron\/services\/reflection\/.+/,
      /^electron\/services\/maintenance\/.+/,
      /^shared\/reflection.*\.ts$/,
      /^shared\/autonomy.*\.ts$/
    ],
    ownedDocs: [
      'docs/development/self_maintenance.md',
      'docs/architecture/phase4b_self_maintenance_foundation.md',
      'docs/review/doclock-impact.md'
    ],
    generatedSectionIds: ['impact-map', 'workflow-registry'],
    requiresManualReview: true
  },
  {
    id: 'tooling-policies',
    description: 'Tool execution/policy orchestration changed.',
    pathRegexes: [
      /^electron\/services\/tools\/.+/,
      /^electron\/services\/ToolService\.ts$/,
      /^electron\/services\/policy\/.+/,
      /^docs\/runtime\/tool_execution_policy\.md$/
    ],
    ownedDocs: [
      'docs/runtime/tool_execution_policy.md',
      'docs/features/tool_execution_features.md',
      'docs/review/doclock-impact.md'
    ],
    generatedSectionIds: ['impact-map', 'tool-policy-matrix'],
    requiresManualReview: false
  },
  {
    id: 'inference-stack',
    description: 'Inference stack changed.',
    pathRegexes: [
      /^electron\/services\/inference\/.+/,
      /^electron\/services\/InferenceService\.ts$/,
      /^shared\/inferenceProviderTypes\.ts$/
    ],
    ownedDocs: [
      'docs/features/inference_engine_features.md',
      'docs/interfaces/inference_interface_control.md',
      'docs/review/doclock-impact.md'
    ],
    generatedSectionIds: ['impact-map', 'config-env-matrix'],
    requiresManualReview: false
  },
  {
    id: 'mcp-services',
    description: 'MCP service/runtime integration changed.',
    pathRegexes: [
      /^mcp\/.+/,
      /^mcp-servers\/.+/,
      /^electron\/services\/Mcp.+\.ts$/
    ],
    ownedDocs: [
      'docs/interfaces/mcp_interface_control.md',
      'docs/subsystems/MCP_TOOLS.md',
      'docs/review/doclock-impact.md'
    ],
    generatedSectionIds: ['impact-map', 'mcp-service-summary'],
    requiresManualReview: false
  },
  {
    id: 'telemetry-catalog',
    description: 'Telemetry event contracts or emitters changed.',
    pathRegexes: [
      /^shared\/telemetry\.ts$/,
      /^shared\/runtimeEventTypes\.ts$/,
      /^electron\/services\/TelemetryService\.ts$/,
      /^electron\/services\/.+Telemetry.+\.ts$/,
      /^electron\/services\/policy\/PolicyEnforcement\.ts$/
    ],
    ownedDocs: [
      'docs/contracts/telemetry.md',
      'docs/security/logging_and_audit.md',
      'docs/review/doclock-impact.md'
    ],
    generatedSectionIds: ['impact-map', 'telemetry-event-catalog'],
    requiresManualReview: false
  },
  {
    id: 'schema-config',
    description: 'Settings/config schema changed.',
    pathRegexes: [
      /^shared\/settings\.ts$/,
      /^shared\/dbConfig\.ts$/,
      /^shared\/dbBootstrapConfig\.ts$/,
      /^docs\/contracts\/.+\.json$/,
      /^package\.json$/
    ],
    ownedDocs: [
      'docs/interfaces/configuration_contracts.md',
      'docs/contracts/settings.md',
      'docs/review/doclock-impact.md'
    ],
    generatedSectionIds: ['impact-map', 'config-env-matrix'],
    requiresManualReview: false
  },
  {
    id: 'workflow-registry',
    description: 'Workflow registry/automation tooling changed.',
    pathRegexes: [
      /^electron\/services\/Workflow.+\.ts$/,
      /^scripts\/diagnostics\/maintenance\/.+/,
      /^tools\/doclock\/.+/,
      /^\.github\/workflows\/.+/
    ],
    ownedDocs: [
      'docs/operations/naming-maintenance-protocol.md',
      'docs/development/self_maintenance.md',
      'docs/review/doclock-impact.md'
    ],
    generatedSectionIds: ['impact-map', 'workflow-registry'],
    requiresManualReview: false
  },
  {
    id: 'test-surfaces',
    description: 'Automated test coverage changed.',
    pathRegexes: [
      /^tests\/.+\.test\.ts$/,
      /^electron\/__tests__\/.+\.test\.ts$/
    ],
    ownedDocs: [
      'docs/traceability/test_trace_matrix.md',
      'docs/review/doclock-impact.md'
    ],
    generatedSectionIds: ['impact-map'],
    requiresManualReview: false
  },
  {
    id: 'scripts-ops',
    description: 'Operational scripts changed.',
    pathRegexes: [
      /^scripts\/.+/
    ],
    ownedDocs: [
      'docs/development/self_maintenance.md',
      'docs/build/maintenance_guidelines.md',
      'docs/review/doclock-impact.md'
    ],
    generatedSectionIds: ['impact-map', 'workflow-registry'],
    requiresManualReview: false
  },
  {
    id: 'operator-instructions',
    description: 'Operator instruction surfaces changed.',
    pathRegexes: [
      /^AGENTS\.md$/,
      /^\.agents\/skills\/.+\/SKILL\.md$/,
      /^docs\/agent_working_rules\.md$/
    ],
    ownedDocs: [
      'docs/agent_working_rules.md',
      'docs/review/doclock-impact.md'
    ],
    generatedSectionIds: ['impact-map'],
    requiresManualReview: true
  }
];

type ParsedArgs = {
  json: boolean;
  changedFiles: string[];
  changedFilesFile?: string;
};

function toPosix(input: string): string {
  return input.replace(/\\/g, '/');
}

function parseArgs(argv: string[]): ParsedArgs {
  const changedFiles: string[] = [];
  let changedFilesFile: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('--changed-file=')) {
      const value = arg.slice('--changed-file='.length).trim();
      if (value) changedFiles.push(toPosix(value));
      continue;
    }
    if (arg === '--changed-file') {
      const value = argv[i + 1];
      if (value) {
        changedFiles.push(toPosix(value));
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
      changedFiles.push(toPosix(arg));
    }
  }

  return { json, changedFiles, changedFilesFile };
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

function resolveChangedFiles(parsed: ParsedArgs): string[] {
  const out = new Set<string>(parsed.changedFiles.map(toPosix));

  const addPathOrDirectoryFiles = (candidatePath: string) => {
    const normalized = toPosix(candidatePath).trim();
    if (!normalized) return;
    const abs = path.join(ROOT, normalized);
    if (normalized.endsWith('/') && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const stack = [abs];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const entryAbs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(entryAbs);
            continue;
          }
          const rel = toPosix(path.relative(ROOT, entryAbs));
          out.add(rel);
        }
      }
      return;
    }
    out.add(normalized);
  };

  const changedFilesFileCandidates = [
    parsed.changedFilesFile,
    fs.existsSync(path.join(ROOT, '.changed-files.txt')) ? path.join(ROOT, '.changed-files.txt') : undefined
  ].filter(Boolean) as string[];

  for (const candidate of changedFilesFileCandidates) {
    try {
      const abs = path.isAbsolute(candidate) ? candidate : path.resolve(ROOT, candidate);
      const raw = fs.readFileSync(abs, 'utf8');
      for (const file of parseFileList(raw)) addPathOrDirectoryFiles(file);
    } catch {
      // Best-effort.
    }
  }

  if (out.size > 0) return Array.from(out).sort();

  const gitSources = [
    ['diff', '--name-only', '--cached'],
    ['diff', '--name-only'],
    ['diff', '--name-only', 'HEAD~1..HEAD']
  ];

  for (const args of gitSources) {
    try {
      const raw = runGit(args);
      for (const file of parseFileList(raw)) addPathOrDirectoryFiles(file);
      if (out.size > 0) break;
    } catch {
      // Continue.
    }
  }

  try {
    const status = runGit(['status', '--porcelain']);
    const lines = status.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('?? ')) {
        const file = line.slice(3).trim();
        if (file) addPathOrDirectoryFiles(file);
        continue;
      }
      if (line.length > 3) {
        const file = line.slice(3).trim();
        if (file) addPathOrDirectoryFiles(file);
      }
    }
  } catch {
    // Best-effort; existing set is still usable.
  }

  return Array.from(out)
    .map(normalizeRepoPath)
    .filter(isLikelyRepositoryPath)
    .sort();
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function isImpactCandidate(relPath: string): boolean {
  const normalized = toPosix(relPath);
  if (normalized.startsWith('docs/')) return false;
  if (normalized === 'docs') return false;
  return true;
}

function normalizeRepoPath(rawPath: string): string {
  return toPosix(rawPath).trim().replace(/^"+|"+$/g, '');
}

function isLikelyRepositoryPath(relPath: string): boolean {
  const normalized = normalizeRepoPath(relPath);
  if (!normalized) return false;
  if (normalized.startsWith('warning:')) return false;
  if (!/^[A-Za-z0-9._\-\/]+$/.test(normalized)) return false;
  const abs = path.join(ROOT, normalized);
  if (fs.existsSync(abs)) return true;
  const parent = path.dirname(abs);
  return fs.existsSync(parent);
}

function mapChangedFileToImpact(changedPath: string): DocImpactEntry {
  const matchedRules = IMPACT_RULES.filter(rule => rule.pathRegexes.some(regex => regex.test(changedPath)));
  if (matchedRules.length === 0) {
    return {
      changedPath,
      matchedRuleIds: [],
      descriptions: ['No explicit doclock mapping rule matched; manual documentation review required.'],
      ownedDocs: ['docs/review/documentation_gaps.md', 'docs/review/doclock-impact.md'],
      generatedSectionIds: ['impact-map'],
      requiresManualReview: true,
      reasonCode: 'UNMAPPED_PATH'
    };
  }

  return {
    changedPath,
    matchedRuleIds: matchedRules.map(rule => rule.id),
    descriptions: matchedRules.map(rule => rule.description),
    ownedDocs: unique(matchedRules.flatMap(rule => rule.ownedDocs)).sort(),
    generatedSectionIds: unique(matchedRules.flatMap(rule => rule.generatedSectionIds)).sort(),
    requiresManualReview: matchedRules.some(rule => rule.requiresManualReview),
    reasonCode: matchedRules.some(rule => rule.requiresManualReview) ? 'MANUAL_REVIEW_REQUIRED' : 'AUTO_HEALABLE'
  };
}

export function scanImpactFromChangedFiles(changedFiles: string[]): ScanImpactResult {
  const normalized = unique(changedFiles.map(toPosix)).sort();
  const impactCandidates = normalized.filter(isImpactCandidate);
  const impacts = impactCandidates.map(mapChangedFileToImpact);
  const mappedFiles = impacts.filter(entry => entry.matchedRuleIds.length > 0).length;
  const unmappedFiles = impacts.length - mappedFiles;
  const manualReviewRequiredCount = impacts.filter(entry => entry.requiresManualReview).length;

  return {
    changedFiles: normalized,
    impactCandidates,
    impacts,
    summary: {
      totalChangedFiles: normalized.length,
      totalImpactCandidates: impactCandidates.length,
      mappedFiles,
      unmappedFiles,
      manualReviewRequiredCount
    }
  };
}

export function scanImpact(parsed: ParsedArgs): ScanImpactResult {
  const changedFiles = resolveChangedFiles(parsed);
  return scanImpactFromChangedFiles(changedFiles);
}

function printHumanReadable(result: ScanImpactResult): void {
  console.log('[doclock] Documentation impact scan');
  console.log(`Changed files: ${result.summary.totalChangedFiles}`);
  console.log(`Impact candidates: ${result.summary.totalImpactCandidates}`);
  console.log(`Mapped: ${result.summary.mappedFiles}`);
  console.log(`Unmapped: ${result.summary.unmappedFiles}`);
  console.log(`Manual review required: ${result.summary.manualReviewRequiredCount}`);
  if (result.impacts.length === 0) {
    console.log('No changed files detected.');
    return;
  }
  for (const impact of result.impacts) {
    console.log(`- ${impact.changedPath}`);
    console.log(`  reason: ${impact.reasonCode}`);
    console.log(`  docs: ${impact.ownedDocs.join(', ')}`);
    console.log(`  sections: ${impact.generatedSectionIds.join(', ')}`);
  }
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  const result = scanImpact(parsed);
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printHumanReadable(result);
}

if (require.main === module) {
  main();
}
