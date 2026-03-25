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
 *   node scripts/memory-cmd.js logs
 *
 * On Windows: calls the .ps1 script via PowerShell
 * On Linux/macOS: calls the .sh script via bash
 */

'use strict';

const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT_DIR = __dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
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

if (cmd === 'up') {
  let exitCode;
  if (isWindows) {
    exitCode = runPowerShell(path.join(SCRIPT_DIR, 'bootstrap-memory.ps1'), extraArgs);
  } else {
    exitCode = runBash(path.join(SCRIPT_DIR, 'bootstrap-memory.sh'), extraArgs);
  }
  process.exit(exitCode);

} else if (cmd === 'down') {
  let exitCode;
  if (isWindows) {
    exitCode = runPowerShell(path.join(SCRIPT_DIR, 'stop-memory.ps1'), extraArgs);
  } else {
    exitCode = runBash(path.join(SCRIPT_DIR, 'stop-memory.sh'), extraArgs);
  }
  process.exit(exitCode);

} else if (cmd === 'logs') {
  // Tail the native PostgreSQL runtime log file.
  // Log path mirrors LocalDatabaseRuntime: APP_ROOT/data/logs/postgres/postgres.log
  const logFile = path.join(REPO_ROOT, 'data', 'logs', 'postgres', 'postgres.log');

  if (!fs.existsSync(logFile)) {
    console.log('[memory-cmd] No native PostgreSQL log file found at:', logFile);
    console.log('[memory-cmd] The native runtime may not have been started yet.');
    process.exit(0);
  }

  console.log('[memory-cmd] Tailing native PostgreSQL log:', logFile);
  console.log('[memory-cmd] Press Ctrl+C to stop.\n');

  let tail;
  if (isWindows) {
    tail = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', `Get-Content -Wait -Tail 50 "${logFile}"`],
      { stdio: 'inherit' }
    );
  } else {
    tail = spawn('tail', ['-n', '50', '-f', logFile], { stdio: 'inherit' });
  }

  tail.on('exit', (code) => process.exit(code ?? 0));
  tail.on('error', (err) => {
    console.error('[memory-cmd] Failed to tail log:', err.message);
    process.exit(1);
  });

} else {
  console.error(`[memory-cmd] Unknown command: ${cmd}`);
  console.error('Usage: node scripts/memory-cmd.js <up|down|logs> [flags]');
  process.exit(1);
}
