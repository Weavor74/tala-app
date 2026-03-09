import * as fs from 'fs';
import * as path from 'path';

export class LogInspectionService {
    private logsRoot: string;

    constructor(userDataPath: string) {
        this.logsRoot = path.join(userDataPath, 'logs');
    }

    public listAvailableLogs(): string[] {
        if (!fs.existsSync(this.logsRoot)) return [];
        return fs.readdirSync(this.logsRoot).filter(f => f.endsWith('.jsonl') || f.endsWith('.log'));
    }

    public async readRecentLogWindow(logFilename: string, linesCount: number = 200): Promise<string[]> {
        const targetPath = path.join(this.logsRoot, logFilename);
        if (!fs.existsSync(targetPath)) return [];

        try {
            const content = await fs.promises.readFile(targetPath, 'utf8');
            const lines = content.split('\n').filter(l => l.trim() !== '');
            return lines.slice(-linesCount);
        } catch (error) {
            console.error(`Failed to read log ${logFilename}:`, error);
            return [];
        }
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

        // Simple timestamp filtering can be added here parsing the JSON structure

        return {
            errors: errors.slice(-50), // Last 50 errors
            recentAudits: audits.slice(-50),
            availableChannels: this.listAvailableLogs()
        };
    }
}
