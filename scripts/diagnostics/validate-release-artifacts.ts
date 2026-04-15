/// <reference types="node" />
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

function mustExist(relPath: string): void {
  const absPath = path.join(ROOT, relPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Missing required artifact: ${relPath}`);
  }
}

function findPackagedRoot(): { relPath: string; absPath: string } {
  const distPath = path.join(ROOT, 'dist');
  if (!fs.existsSync(distPath)) {
    throw new Error('dist/ does not exist. Run package:smoke first.');
  }

  const preferredNames = ['win-unpacked', 'linux-unpacked', 'mac', 'mac-arm64', 'mac-universal'];
  for (const name of preferredNames) {
    const abs = path.join(distPath, name);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      return { relPath: path.join('dist', name).replace(/\\/g, '/'), absPath: abs };
    }
  }

  for (const entry of fs.readdirSync(distPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (/(?:-unpacked$|^mac(?:-arm64|-universal)?$)/.test(entry.name)) {
      const relPath = path.join('dist', entry.name).replace(/\\/g, '/');
      return { relPath, absPath: path.join(distPath, entry.name) };
    }
  }

  throw new Error('No packaged output directory found in dist/.');
}

function hasAny(absPaths: string[]): boolean {
  return absPaths.some((candidate) => fs.existsSync(candidate));
}

function main(): void {
  console.log('[artifacts:validate] Validating build outputs...');
  mustExist('dist/index.html');
  mustExist('dist-electron/electron/main.js');

  const packagedRoot = findPackagedRoot();
  console.log(`[artifacts:validate] Using packaged output: ${packagedRoot.relPath}`);

  const packagedRequired = [
    'resources',
    'mcp-servers',
    'local-inference',
    'runtime/guardrails',
    'launch-inference.bat',
    'launch-inference.sh',
    'PORTABLE_BUILD_README.md'
  ];

  for (const rel of packagedRequired) {
    const candidate = path.join(packagedRoot.absPath, rel);
    if (!fs.existsSync(candidate)) {
      throw new Error(`Packaged artifact missing: ${path.join(packagedRoot.relPath, rel).replace(/\\/g, '/')}`);
    }
  }

  const appPayloadCandidates = [
    path.join(packagedRoot.absPath, 'resources', 'app'),
    path.join(packagedRoot.absPath, 'resources', 'app.asar')
  ];
  if (!hasAny(appPayloadCandidates)) {
    throw new Error('Packaged application payload missing (expected resources/app or resources/app.asar).');
  }

  console.log('[artifacts:validate] Artifact validation passed.');
}

main();
