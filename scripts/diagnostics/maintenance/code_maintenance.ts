import { execSync } from 'child_process';
import { MaintenanceLane, MaintenanceMode, MaintenanceReport } from './maintenance_policy';

export class CodeMaintenanceLane implements MaintenanceLane {
  name = 'code' as const;
  description = 'Validate repository structure, subsystem boundaries, and propose safe code hygiene fixes.';
  allowedModes: MaintenanceMode[] = ['audit', 'propose', 'apply-safe'];

  async run(mode: MaintenanceMode): Promise<MaintenanceReport> {
    const report: MaintenanceReport = {
      lane: this.name,
      status: 'success',
      mode,
      messages: []
    };

    try {
      report.messages.push('Running repository structure check...');
      execSync('npm run repo:check', { stdio: 'pipe' });
      report.messages.push('Repository structure intact.');
    } catch (err: any) {
      report.status = 'error';
      report.messages.push('Repository structure violations detected.');
      report.messages.push(err.stdout ? err.stdout.toString() : err.message);
    }

    try {
      report.messages.push('Running subsystem boundary validation...');
      execSync('npm run repo:boundaries', { stdio: 'pipe' });
      report.messages.push('Subsystem boundaries intact.');
    } catch (err: any) {
      report.status = 'error';
      report.messages.push('Subsystem boundary violations detected.');
      report.messages.push(err.stdout ? err.stdout.toString() : err.message);
    }

    if (mode === 'propose') {
      report.messages.push('Reporting safe autofix opportunities...');
      if (report.status === 'success') {
          report.messages.push('No safe autofixes required at this time.');
      } else {
          // If we had logic to analyze the TS boundary errors, we would populate proposedFixes here.
          report.proposedFixes = [
             'Detected boundary violations. Automatic safe-fixing of boundaries is not currently supported.',
             'Developers must manually resolve restricted imports.'
          ];
      }
    }

    if (mode === 'apply-safe') {
        report.messages.push('Applying safe code hygiene fixes...');
        report.messages.push('No autonomous known-safe fix rules triggered.');
    }

    return report;
  }
}
