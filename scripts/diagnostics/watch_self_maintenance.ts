import chokidar from 'chokidar';
import { parseArgs } from 'util';
import { execSync } from 'child_process';
import * as path from 'path';

const { values } = parseArgs({
  options: {
    'docs-only': { type: 'boolean', default: false },
    'code-only': { type: 'boolean', default: false },
    'memory-only': { type: 'boolean', default: false },
    debounce: { type: 'string', default: '1500' }
  }
});

const debounceMs = parseInt(values.debounce as string, 10) || 1500;

// Rebuild arguments array to pass downwards to the runner
const args: string[] = ['--mode=apply-safe'];
if (values['docs-only']) args.push('--docs-only');
if (values['code-only']) args.push('--code-only');
if (values['memory-only']) args.push('--memory-only');

const ROOT = path.resolve(__dirname, '../../');

const watchPaths = [
  path.join(ROOT, 'shared/**'),
  path.join(ROOT, 'electron/**'),
  path.join(ROOT, 'src/**'),
  path.join(ROOT, 'mcp-servers/**'),
  path.join(ROOT, 'scripts/docs/**'),
  path.join(ROOT, 'scripts/diagnostics/**'),
  path.join(ROOT, 'code_roots.json'),
  path.join(ROOT, 'subsystem_mapping.json'),
  path.join(ROOT, 'memory/**')
];

const ignoredPaths = [
  path.join(ROOT, 'docs/**'),
  path.join(ROOT, 'dist/**'),
  path.join(ROOT, 'dist-electron/**'),
  path.join(ROOT, 'node_modules/**'),
  path.join(ROOT, 'tmp/**'),
  path.join(ROOT, 'tmp_userdata/**'),
  path.join(ROOT, 'archive/**'),
  path.join(ROOT, '**/*.log'),
  path.join(ROOT, '**/*.jsonl')
];

console.log(`Starting Self-Maintenance Watcher (debounce: ${debounceMs}ms)...`);
console.log(`Forwarding args: ${args.join(' ')}\n`);

let timeout: NodeJS.Timeout | null = null;
let isRunning = false;
let pendingTrigger = false;

function triggerMaintenance() {
    if (isRunning) {
        pendingTrigger = true;
        return;
    }

    isRunning = true;
    console.log(`\x1b[36m[Watcher] Change detected. Invoking Self Maintenance...\x1b[0m`);
    const cmd = `npx tsx scripts/diagnostics/run_self_maintenance.ts ${args.join(' ')}`;
    
    try {
        console.log(`\x1b[36m[Watcher] Routing command out to standard maintenance pipeline.\x1b[0m`);
        // The watch mode invokes the run_self_maintenance CLI which natively lacks ReflectionEngine injection.
        // As a temporary pass-through, the orchestrator triggers and standard logging catches it.
        execSync(cmd, { stdio: 'inherit', cwd: ROOT });
        console.log(`\x1b[32m[Watcher] Self Maintenance passed.\x1b[0m\n`);
    } catch (e: any) {
        console.error(`\x1b[31m[Watcher] Self Maintenance reported failures.\x1b[0m\n`);
    } finally {
        isRunning = false;
        if (pendingTrigger) {
            pendingTrigger = false;
            timeout = setTimeout(triggerMaintenance, debounceMs);
        }
    }
}

const watcher = chokidar.watch(watchPaths, {
  ignored: ignoredPaths,
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
  }
});

watcher.on('all', (event, p) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(triggerMaintenance, debounceMs);
});

console.log('Watching for deterministically handled code events...\n');
