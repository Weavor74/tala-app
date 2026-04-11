import * as fs from 'fs';
import * as path from 'path';
import { LogLifecycleService } from '../LogLifecycleService';

export class LogInspectionService {
    private logsRoot: string;
    private lifecycle: LogLifecycleService;

    constructor(rootPath: string) {
        const dataRoot = path.basename(rootPath) === 'data'
            ? rootPath
            : path.join(rootPath, 'data');
        this.logsRoot = path.join(dataRoot, 'logs');
        this.lifecycle = new LogLifecycleService(this.logsRoot, {
            recentReadMaxBytes: 5 * 1024 * 1024,
            recentReadMaxLines: 5000,
        });
    }

    public listAvailableLogs(): string[] {
        if (!fs.existsSync(this.logsRoot)) return [];
        return fs.readdirSync(this.logsRoot).filter(f => f.endsWith('.jsonl') || f.endsWith('.log'));
    }

    public async readRecentLogWindow(logFilename: string, linesCount: number = 200): Promise<string[]> {
        const targetPath = path.join(this.logsRoot, logFilename);
        const recent = this.lifecycle.readRecentWindowFromPath(targetPath, { maxLines: linesCount });
        if (recent.skippedMissing) {
            console.log(`[LogInspection] source=${logFilename} skipped_missing=true`);
            return [];
        }
        let parseErrors = 0;
        for (const line of recent.lines) {
            if (!line.trim().startsWith('{')) continue;
            try {
                JSON.parse(line);
            } catch {
                parseErrors++;
            }
        }
        console.log(`[LogInspection] source=${logFilename} mode=tail maxBytes=${recent.bytesRead} lines=${recent.lines.length} parseErrors=${parseErrors}`);
        return recent.lines;
    }

    public async searchLogs(query: string, linesCount: number = 500): Promise<string[]> {
        const files = this.listAvailableLogs();
        const results: string[] = [];

        for (const f of files) {
            const lines = await this.readRecentLogWindow(f, linesCount);
            const matches = lines.filter(l => l.toLowerCase().includes(query.toLowerCase()));
            results.push(...matches.map(m => `[${f}] ${m}`));
        }
        return results;
    }

    public async buildIssueEvidenceBundle(timeWindowMinutes: number = 60): Promise<any> {
        // Collects recent errors and audit history
        const errors = await this.readRecentLogWindow('runtime-errors.jsonl', 100);
        const audits = await this.readRecentLogWindow('audit-log.jsonl', 100);
        const prompts = await this.readRecentLogWindow('prompt-audit.jsonl', 100);

        // Simple timestamp filtering can be added here parsing the JSON structure

        return {
            errors: errors.slice(-50), // Last 50 errors
            recentAudits: audits.slice(-50),
            recentPromptAudits: prompts.slice(-50),
            availableChannels: this.listAvailableLogs()
        };
    }
}
