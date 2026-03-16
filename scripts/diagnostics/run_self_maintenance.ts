import { parseArgs } from 'util';
import { MaintenanceLane, MaintenanceMode, MaintenanceReport } from './maintenance/maintenance_policy';
import { DocumentationLane } from './maintenance/docs_maintenance';
import { CodeMaintenanceLane } from './maintenance/code_maintenance';
import { MemoryMaintenanceLane } from './maintenance/memory_maintenance';

function printReport(report: MaintenanceReport) {
  const color = report.status === 'success' ? '\x1b[32m' : report.status === 'warning' ? '\x1b[33m' : '\x1b[31m';
  const reset = '\x1b[0m';
  
  console.log(`\n${color}=== Lane: ${report.lane.toUpperCase()} | Status: ${report.status.toUpperCase()} ===${reset}`);
  console.log(`Mode Executed: ${report.mode}`);
  console.log(`\nMessages:`);
  report.messages.forEach(msg => console.log(`  - ${msg}`));
  
  if (report.changedFiles && report.changedFiles.length > 0) {
    console.log(`\nFiles Modified:`);
    report.changedFiles.forEach(f => console.log(`  M ${f}`));
  }

  if (report.proposedFixes && report.proposedFixes.length > 0) {
    console.log(`\nProposed Safe Fixes:`);
    report.proposedFixes.forEach(f => console.log(`  + ${f}`));
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'audit' },
      'docs-only': { type: 'boolean', default: false },
      'code-only': { type: 'boolean', default: false },
      'memory-only': { type: 'boolean', default: false },
      stage: { type: 'boolean', default: false },
      'no-test': { type: 'boolean', default: false },
      'changed-only': { type: 'boolean', default: false }
    }
  });

  const mode = values.mode as MaintenanceMode;
  if (!['audit', 'propose', 'apply-safe'].includes(mode)) {
    console.error(`Invalid mode: ${mode}. Must be audit, propose, or apply-safe.`);
    process.exit(1);
  }

  const allSelected = !values['docs-only'] && !values['code-only'] && !values['memory-only'];
  
  const activeLanes: MaintenanceLane[] = [];
  if (allSelected || values['docs-only']) activeLanes.push(new DocumentationLane());
  if (allSelected || values['code-only']) activeLanes.push(new CodeMaintenanceLane());
  if (allSelected || values['memory-only']) activeLanes.push(new MemoryMaintenanceLane());

  console.log(`\x1b[36mStarting Self-Maintenance Orchestrator (${mode} mode)...\x1b[0m`);
  
  let overallFailed = false;

  for (const lane of activeLanes) {
    if (!lane.allowedModes.includes(mode) && mode !== 'audit') {
       console.log(`\n[Skip] Lane '${lane.name}' does not support mode '${mode}'. Falling back to audit.`);
    }

    const actualModeToRun = lane.allowedModes.includes(mode) ? mode : 'audit';
    try {
      const report = await lane.run(actualModeToRun);
      printReport(report);
      if (report.status === 'error') overallFailed = true;
    } catch (e: any) {
      console.error(`\x1b[31mFatal error executing lane ${lane.name}:\x1b[0m`, e);
      overallFailed = true;
    }
  }

  console.log('\n\x1b[36mMaintenance suite complete.\x1b[0m');
  if (overallFailed) {
      process.exit(1);
  }
}

main().catch(err => {
    console.error("Unhandled top-level error in Maintenance Orchestrator", err);
    process.exit(1);
});
