#!/usr/bin/env node
/**
 * memory-cmd.js
 *
 * Cross-platform dispatcher for memory bootstrap commands.
 * Detects the current OS and invokes the appropriate shell script.
 *
 * Usage (via npm scripts):
 *   node scripts/memory-cmd.js up
 *   node scripts/memory-cmd.js down
 *   node scripts/memory-cmd.js down --reset
 *
 * On Windows: calls the .ps1 script via PowerShell
 * On Linux/macOS: calls the .sh script via bash
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT_DIR = __dirname;
const cmd = process.argv[2] || 'up';
const extraArgs = process.argv.slice(3);

const isWindows = process.platform === 'win32';

function runPowerShell(script, args) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { stdio: 'inherit' }
  );
  return result.status ?? 0;
}

function runBash(script, args) {
  const result = spawnSync('bash', [script, ...args], { stdio: 'inherit' });
  return result.status ?? 0;
}

let exitCode = 0;

if (cmd === 'up') {
  if (isWindows) {
    exitCode = runPowerShell(path.join(SCRIPT_DIR, 'bootstrap-memory.ps1'), extraArgs);
  } else {
    exitCode = runBash(path.join(SCRIPT_DIR, 'bootstrap-memory.sh'), extraArgs);
  }
} else if (cmd === 'down') {
  if (isWindows) {
    exitCode = runPowerShell(path.join(SCRIPT_DIR, 'stop-memory.ps1'), extraArgs);
  } else {
    exitCode = runBash(path.join(SCRIPT_DIR, 'stop-memory.sh'), extraArgs);
  }
} else {
  console.error(`[memory-cmd] Unknown command: ${cmd}`);
  console.error('Usage: node scripts/memory-cmd.js <up|down> [flags]');
  process.exit(1);
}

process.exit(exitCode);
