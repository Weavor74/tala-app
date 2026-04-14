/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../..');

function getDocFiles(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getDocFiles(fullPath));
    } else if (file.endsWith('.md')) {
      results.push(fullPath);
    }
  });
  return results;
}

function checkDrift() {
  console.log('Checking for documentation drift...');

  // We'll use a strategy of:
  // 1. Read current state of docs
  // 2. Run generation scripts
  // 3. Compare current state with new state
  // 4. (In a real CI, we might use git diff, but here we'll manually compare)

  const dirsToWatch = [
    path.join(ROOT, 'docs/architecture'),
    path.join(ROOT, 'docs/contracts'),
    path.join(ROOT, 'docs/subsystems')
  ];

  const beforeStates = new Map<string, string>();
  dirsToWatch.forEach(dir => {
    if (fs.existsSync(dir)) {
      getDocFiles(dir).forEach(f => {
        beforeStates.set(f, fs.readFileSync(f, 'utf-8'));
      });
    }
  });

  try {
    console.log('Running documentation generation...');
    execSync('npx tsx scripts/docs/extract_architecture.ts', { cwd: ROOT });
    execSync('npx tsx scripts/docs/generate_contract_docs.ts', { cwd: ROOT });
    execSync('npx tsx scripts/docs/index_repo_docs.ts', { cwd: ROOT });
  } catch (err) {
    console.error('Failed to run doc generation scripts:', err);
    process.exit(1);
  }

  let driftDetected = false;
  dirsToWatch.forEach(dir => {
    if (fs.existsSync(dir)) {
      getDocFiles(dir).forEach(f => {
        const newState = fs.readFileSync(f, 'utf-8');
        const oldState = beforeStates.get(f);

        if (oldState === undefined) {
          console.log(`[DRIFT] New documentation file created: ${path.relative(ROOT, f)}`);
          driftDetected = true;
        } else if (oldState !== newState) {
          console.log(`[DRIFT] Documentation drift detected in: ${path.relative(ROOT, f)}`);
          driftDetected = true;
        }
      });
    }
  });

  if (driftDetected) {
    console.log('\n❌ Documentation drift detected! Please run "npm run docs:regen" and commit the changes.');
    process.exit(1);
  } else {
    console.log('\n✅ Documentation is up to date.');
    process.exit(0);
  }
}

checkDrift();

