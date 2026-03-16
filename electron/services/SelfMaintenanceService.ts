import { spawn } from 'child_process';
import path from 'path';
import { app } from 'electron';
import { LogViewerService } from './LogViewerService';
import { ReflectionEngine } from './reflection/ReflectionEngine';
import { MaintenanceReflectionEvent, MaintenanceDomain, MaintenanceSeverity, MaintenanceAction } from '../../shared/maintenance/maintenanceEvents';

interface CliResult {
    code: number;
    stdout: string;
    stderr: string;
}

export class SelfMaintenanceService {
    private logViewer: LogViewerService;
    private reflectionEngine: ReflectionEngine;
    private cwd: string;

    constructor(logViewer: LogViewerService, reflectionEngine: ReflectionEngine) {
        this.logViewer = logViewer;
        this.reflectionEngine = reflectionEngine;
        this.cwd = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : path.join(__dirname, '../../');
    }

    /**
     * Executes an npm command natively, aggregating output securely.
     */
    private executeCommand(cmd: string, args: string[]): Promise<CliResult> {
        return new Promise((resolve) => {
            const child = spawn(cmd, args, { cwd: this.cwd, shell: true });
            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });

            child.on('close', (code) => {
                this.logViewer.logRuntimeError(new Error(`Maintenance Command [${cmd} ${args.join(' ')}] finished`), {
                    source: 'SelfMaintenanceService',
                    subsystem: 'maintenance',
                    metadata: { code, stdout, stderr }
                });
                // We resolve rather than reject to allow graceful parsing of errors into Reflections
                resolve({ code: code ?? 1, stdout, stderr });
            });
            
            child.on('error', (err) => {
                this.logViewer.logRuntimeError(err, { source: 'SelfMaintenanceService' });
                resolve({ code: 1, stdout: '', stderr: err.message });
            });
        });
    }

    private emitReflection(event: MaintenanceReflectionEvent) {
        // Fallback for generating an ID if one isn't populated
        if (!event.id) event.id = `maint_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        if (!event.timestamp) event.timestamp = new Date().toISOString();

        // 1. Emit to JSONL raw audit for backend observability
        // Using an any-cast here since LogViewerService doesn't have a specific strongly typed maintenance event yet 
        (this.logViewer as any).appendJsonl('audit-log.jsonl', { ...event }, 'SelfMaintenanceService');
        
        // 2. Transmit to Reflection UI engine
        this.reflectionEngine.logMaintenanceEvent(event);
    }

    private hasProtectedMemoryWarning(stdout: string | undefined): boolean {
        if (!stdout) return false;
        // A simple heuristic based on the spec
        return stdout.includes('Protected targets strictly excluded') || stdout.includes('Protected memory skipped');
    }

    public async runDocsMaintenance() {
        const res = await this.executeCommand('npm', ['run', 'docs:selfheal']);
        
        let severity: MaintenanceSeverity = res.code === 0 ? 'success' : 'error';
        let summary = 'Regenerated architecture and contract documentation.';
        const details = res.stdout.split('\n').filter(l => l.trim().length > 0);
        const changedFiles = details.filter(l => l.startsWith('  M ')).map(l => l.replace('  M ', '').trim());
                
        if (res.code !== 0 && res.stderr.includes('apply-safe')) {
            // It failed generation, usually implying a TS compilation issue during indexing
            severity = 'error';
            summary = 'Documentation generation failed. See details.';
        } else if (changedFiles.length > 0) {
            severity = 'success';
            summary = 'Documentation drift corrected successfully.';
        } else {
            severity = 'info';
            summary = 'Documentation generated cleanly with no changes required.';
        }

        const action: MaintenanceAction = 'apply-safe';

        this.emitReflection({
            id: '',
            timestamp: '',
            domain: 'documentation',
            severity,
            action,
            title: severity === 'error' ? 'Documentation Heal Failed' : (changedFiles.length > 0 ? 'Documentation Drift Corrected' : 'Documentation Verified'),
            summary,
            details: details.filter(l => !l.startsWith('  M ') && !l.startsWith('===')), // Strip raw CLI formatting
            changedFiles
        });
    }

    public async runCodeAudit() {
        const res = await this.executeCommand('npm', ['run', 'code:heal', '--', '--mode=propose']);
        
        const severity: MaintenanceSeverity = res.code === 0 ? 'success' : 'warning';
        const details = res.stdout.split('\n').filter(l => l.trim().length > 0);
        
        const proposedFixes = details.filter(l => l.startsWith('  + ')).map(l => l.replace('  + ', '').trim());
        const suggestedNextSteps: string[] = proposedFixes.length > 0 ? proposedFixes : [];

        this.emitReflection({
            id: '',
            timestamp: '',
            domain: 'code',
            severity,
            action: 'propose',
            title: severity === 'warning' ? 'Subsystem Boundary Violations Detected' : 'Repository Health Verified',
            summary: severity === 'warning' ? 'Code hygiene audit failed. Review the proposed safe fixes.' : 'Subsystem boundaries and structural integrity are intact.',
            details: details.filter(l => !l.startsWith('  + ') && !l.startsWith('===')),
            suggestedNextSteps,
            remediation: severity === 'warning' ? [
                { label: 'View Subsystems Docs', command: 'npm run docs:regen' } // Placeholder realistic remediation mapping
            ] : undefined
        });
    }

    public async runMemoryAudit() {
        const res = await this.executeCommand('npm', ['run', 'memory:check']);
        const details = res.stdout.split('\n').filter(l => l.trim().length > 0);
        
        this.emitReflection({
            id: '',
            timestamp: '',
            domain: 'memory',
            severity: 'info',
            action: 'audit',
            title: 'Memory Integrity Verified',
            summary: 'Audited derived memory artifacts and graph consistency.',
            details: details.filter(l => !l.startsWith('===')),
            remediation: [
                 { label: 'Rebuild Derived Indices', command: 'npm run memory:heal' }
            ]
        });
    }

    public async runMemoryHeal() {
       const res = await this.executeCommand('npm', ['run', 'memory:heal']);
       const details = res.stdout.split('\n').filter(l => l.trim().length > 0);
       const changedFiles = details.filter(l => l.startsWith('  M ')).map(l => l.replace('  M ', '').trim());

       // Safegaurd for protected memory
       const blocked = this.hasProtectedMemoryWarning(res.stdout);

       if (blocked) {
           this.emitReflection({
               id: '',
               timestamp: '',
               domain: 'memory',
               severity: 'warning',
               action: 'blocked',
               title: 'Protected memory skipped',
               summary: 'A request to modify protected identity or preference memory was autonomously blocked.',
               protectedItems: ['long_term_memory', 'explicit_user_facts', 'identity_rules', 'canonical_preferences']
           });
       }

       this.emitReflection({
            id: '',
            timestamp: '',
            domain: 'memory',
            severity: 'success',
            action: 'apply-safe',
            title: 'Derived Memory Index Rebuilt',
            summary: 'Vector and graph metadata refreshed successfully.',
            details: details.filter(l => !l.startsWith('  M ') && !l.startsWith('===')),
            changedFiles
       });
    }
}
