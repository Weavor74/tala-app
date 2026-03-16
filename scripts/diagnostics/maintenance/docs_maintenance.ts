import { execSync } from 'child_process';
import { MaintenanceLane, MaintenanceMode, MaintenanceReport } from './maintenance_policy';

export class DocumentationLane implements MaintenanceLane {
  name = 'documentation' as const;
  description = 'Regenerate and validate project documentation derived from the codebase.';
  allowedModes: MaintenanceMode[] = ['apply-safe'];

  async run(mode: MaintenanceMode): Promise<MaintenanceReport> {
    const report: MaintenanceReport = {
      lane: this.name,
      status: 'success',
      mode,
      messages: []
    };

    if (mode === 'audit' || mode === 'propose') {
      report.messages.push(`Mode '${mode}' mapped to drift verification for documentation lane.`);
      try {
        execSync('npm run docs:verify', { stdio: 'inherit' });
        report.messages.push('Documentation drift check passed. No regeneration needed.');
      } catch (err: any) {
        report.status = 'warning';
        report.messages.push('Documentation drift detected. Run with mode=apply-safe to heal.');
      }
      return report;
    }

    if (mode === 'apply-safe') {
      try {
        report.messages.push('Regenerating documentation...');
        execSync('npm run docs:regen', { stdio: 'inherit' });
        
        // Detect if anything actually changed
        let statusOutput = '';
        try {
           statusOutput = execSync('git status --porcelain docs/ TDP_INDEX.md', { encoding: 'utf-8' });
        } catch (e) {
           // git status failed, assume changed
        }

        if (statusOutput.trim().length > 0) {
          report.messages.push('Documentation successfully regenerated and changes applied to workspace.');
          report.changedFiles = statusOutput.trim().split('\n').map(l => l.substring(3));
        } else {
          report.messages.push('Documentation generated cleanly, but no changes were required.');
        }

        // Verify it passes after generation
        execSync('npm run docs:verify', { stdio: 'inherit' });

      } catch (err: any) {
        report.status = 'error';
        report.messages.push(`Documentation generation failed: ${err.message}`);
      }
    }

    return report;
  }
}
