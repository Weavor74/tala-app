/// <reference types="node" />
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');

type SmokeInput = {
  type: 'file' | 'dir';
  relPath: string;
  placeholderText?: string;
};

const SMOKE_INPUTS: SmokeInput[] = [
  { type: 'dir', relPath: 'models' },
  { type: 'dir', relPath: 'memory' },
  { type: 'dir', relPath: 'bin/python-win' },
  { type: 'dir', relPath: 'bin/python' },
  {
    type: 'file',
    relPath: 'bin/python-win/python.exe',
    placeholderText: 'packaging-smoke placeholder runtime binary\n'
  },
  {
    type: 'file',
    relPath: 'bin/python/python3',
    placeholderText: 'packaging-smoke placeholder runtime binary\n'
  },
  {
    type: 'file',
    relPath: 'models/.packaging-smoke-placeholder.txt',
    placeholderText: 'placeholder model artifact for CI packaging smoke\n'
  }
];

function ensureInput(input: SmokeInput): void {
  const absPath = path.join(ROOT, input.relPath);
  if (input.type === 'dir') {
    fs.mkdirSync(absPath, { recursive: true });
    return;
  }

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  if (!fs.existsSync(absPath)) {
    fs.writeFileSync(absPath, input.placeholderText ?? 'packaging-smoke placeholder\n', 'utf8');
  }
}

function runStep(label: string, command: string, args: string[]): void {
  console.log(`[package:smoke] ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? -1})`);
  }
}

function detectPackagedOutputDir(): string {
  const distPath = path.join(ROOT, 'dist');
  if (!fs.existsSync(distPath)) {
    throw new Error('dist/ not found after packaging smoke run.');
  }

  const candidates = fs.readdirSync(distPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /(?:-unpacked$|^mac(?:-arm64|-universal)?$)/.test(name));

  if (candidates.length === 0) {
    throw new Error('No packaged output directory found in dist/ (expected *-unpacked or mac*).');
  }

  const chosen = path.join(distPath, candidates[0]);
  console.log(`[package:smoke] Packaged output detected: ${chosen}`);
  return chosen;
}

function main(): void {
  console.log('[package:smoke] Preparing deterministic packaging inputs...');
  for (const input of SMOKE_INPUTS) ensureInput(input);

  runStep('build', 'npm', ['run', 'build']);
  runStep('electron-builder (dir target, non-publish)', 'npx', [
    'electron-builder',
    '--dir',
    '--publish',
    'never',
    '-c.npmRebuild=false'
  ]);
  detectPackagedOutputDir();

  console.log('[package:smoke] Packaging smoke passed.');
}

main();
