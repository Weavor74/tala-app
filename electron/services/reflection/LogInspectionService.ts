import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import { LogLifecycleService } from '../LogLifecycleService';

export type ClusterSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ClusteredIssue {
    clusterKey: string;
    family: string;
    sourceComponent: string;
    errorCode?: string;
    firstSeenAt?: string;
    lastSeenAt?: string;
    eventCount: number;
    uniqueContextCount: number;
    sources: string[];
    representativeSamples: string[];
    priorRunCount: number;
    baseSeverity: ClusterSeverity;
    computedSeverity: ClusterSeverity;
    escalationReasons: string[];
    confidence: number;
}

interface ClusterAccumulator {
    clusterKey: string;
    family: string;
    sourceComponent: string;
    errorCode?: string;
    firstSeenAt?: string;
    lastSeenAt?: string;
    eventCount: number;
    sources: Set<string>;
    contexts: Set<string>;
    samples: string[];
}

interface HistoryRecord {
    timestamp: string;
    clusterKey: string;
}

export class LogInspectionService {
    private logsRoot: string;
    private reflectionRoot: string;
    private clusterHistoryPath: string;
    private lifecycle: LogLifecycleService;

    constructor(rootPath: string) {
        const dataRoot = path.basename(rootPath) === 'data'
            ? rootPath
            : path.join(rootPath, 'data');
        this.logsRoot = path.join(dataRoot, 'logs');
        this.reflectionRoot = path.join(dataRoot, 'reflection');
        this.clusterHistoryPath = path.join(this.reflectionRoot, 'issue-cluster-history.jsonl');
        this.lifecycle = new LogLifecycleService(this.logsRoot, {
            recentReadMaxBytes: 5 * 1024 * 1024,
            recentReadMaxLines: 5000,
        });
        fs.mkdirSync(this.reflectionRoot, { recursive: true });
    }

    public listAvailableLogs(): string[] {
        if (!fs.existsSync(this.logsRoot)) return [];
        return fs.readdirSync(this.logsRoot).filter(f => f.endsWith('.jsonl') || f.endsWith('.log'));
    }

    public async readRecentLogWindow(logFilename: string, linesCount: number = 200): Promise<string[]> {
        const targetPath = path.join(this.logsRoot, logFilename);
        console.log(`[LogInspection] read_recent file=${logFilename} maxLines=${linesCount}`);
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
        const errors = await this.readRecentLogWindow('runtime-errors.jsonl', 400);
        const audits = await this.readRecentLogWindow('audit-log.jsonl', 200);
        const prompts = await this.readRecentLogWindow('prompt-audit.jsonl', 200);
        const issueClusters = this.clusterIssueEvents([
            { source: 'runtime-errors.jsonl', lines: errors },
            { source: 'audit-log.jsonl', lines: audits },
            { source: 'prompt-audit.jsonl', lines: prompts },
        ]);

        // Simple timestamp filtering can be added here parsing the JSON structure

        return {
            errors: errors.slice(-50), // Last 50 errors
            recentAudits: audits.slice(-50),
            recentPromptAudits: prompts.slice(-50),
            availableChannels: this.listAvailableLogs(),
            issueClusters,
            clusterCount: issueClusters.length,
            analyzedWindowMinutes: timeWindowMinutes,
        };
    }

    public recordIssueClusters(clusters: ClusteredIssue[]): void {
        if (!clusters.length) return;
        const rows = clusters.map((cluster) => JSON.stringify({
            timestamp: new Date().toISOString(),
            clusterKey: cluster.clusterKey,
            family: cluster.family,
            severity: cluster.computedSeverity,
            eventCount: cluster.eventCount,
        }));
        fs.appendFileSync(this.clusterHistoryPath, `${rows.join('\n')}\n`, 'utf-8');
    }

    private clusterIssueEvents(inputs: Array<{ source: string; lines: string[] }>): ClusteredIssue[] {
        const map = new Map<string, ClusterAccumulator>();
        for (const input of inputs) {
            for (const rawLine of input.lines) {
                const normalized = this.normalizeLogLine(rawLine);
                if (!normalized.family) continue;
                if (this.isSuppressedFamily(normalized.family)) continue;
                const clusterKey = this.computeClusterKey(input.source, normalized.family, normalized.component, normalized.errorCode);
                const existing = map.get(clusterKey) ?? {
                    clusterKey,
                    family: normalized.family,
                    sourceComponent: normalized.component,
                    errorCode: normalized.errorCode,
                    firstSeenAt: normalized.timestamp,
                    lastSeenAt: normalized.timestamp,
                    eventCount: 0,
                    sources: new Set<string>(),
                    contexts: new Set<string>(),
                    samples: [],
                };
                existing.eventCount += 1;
                existing.sources.add(input.source);
                existing.contexts.add(normalized.contextKey);
                existing.firstSeenAt = existing.firstSeenAt || normalized.timestamp;
                existing.lastSeenAt = normalized.timestamp || existing.lastSeenAt;
                if (existing.samples.length < 5) {
                    existing.samples.push(rawLine);
                }
                map.set(clusterKey, existing);
            }
        }

        const history = this.loadRecentHistory();
        const clusters: ClusteredIssue[] = Array.from(map.values()).map((acc) => {
            const priorRunCount = history.filter((h) => h.clusterKey === acc.clusterKey).length;
            const escalated = this.escalateSeverity(acc, priorRunCount);
            const cluster: ClusteredIssue = {
                clusterKey: acc.clusterKey,
                family: acc.family,
                sourceComponent: acc.sourceComponent,
                errorCode: acc.errorCode,
                firstSeenAt: acc.firstSeenAt,
                lastSeenAt: acc.lastSeenAt,
                eventCount: acc.eventCount,
                uniqueContextCount: acc.contexts.size,
                sources: Array.from(acc.sources),
                representativeSamples: acc.samples,
                priorRunCount,
                baseSeverity: escalated.baseSeverity,
                computedSeverity: escalated.computedSeverity,
                escalationReasons: escalated.reasons,
                confidence: escalated.confidence,
            };
            console.log(`[IssueCluster] key=${cluster.clusterKey} family=${cluster.family} count=${cluster.eventCount}`);
            if (cluster.escalationReasons.length) {
                console.log(`[SeverityEscalation] key=${cluster.clusterKey} base=${cluster.baseSeverity} final=${cluster.computedSeverity} reasons=${cluster.escalationReasons.join(',')}`);
            }
            return cluster;
        });

        if (!clusters.length) {
            console.log('[IssueCluster] key=none family=none count=0');
        }

        return clusters.sort((a, b) => {
            const severityWeight = this.severityToWeight(b.computedSeverity) - this.severityToWeight(a.computedSeverity);
            if (severityWeight !== 0) return severityWeight;
            return b.eventCount - a.eventCount;
        });
    }

    private normalizeLogLine(raw: string): { family: string; component: string; errorCode?: string; contextKey: string; timestamp?: string } {
        const source = String(raw || '');
        const timestamp = source.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)?.[0];
        const errorCode = source.match(/\b(E[A-Z_]{3,}|ERR_[A-Z_]{2,}|ECONNREFUSED|ENOENT|ETIMEDOUT)\b/i)?.[0]?.toUpperCase();
        const component = source.match(/\[([A-Za-z0-9:_-]+)\]/)?.[1]?.toLowerCase() || 'unknown';
        let normalized = source.toLowerCase();
        normalized = normalized
            .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z/g, '<ts>')
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, '<uuid>')
            .replace(/[a-z]:\\[^ "'\n]+/g, '<path>')
            .replace(/\/[^ "'\n]+/g, '<path>')
            .replace(/\b\d{4,}\b/g, '<n>')
            .replace(/\b\d+ms\b/g, '<duration>');

        let family = 'log.generic';
        if (normalized.includes('read-file') && (normalized.includes('file not found') || normalized.includes('enoent'))) {
            family = 'ipc.read-file.file_not_found';
        } else if (normalized.includes('provider') && normalized.includes('unreachable')) {
            family = normalized.includes('ollama') ? 'provider.discovery.unreachable.ollama' : 'provider.discovery.unreachable';
        } else if (normalized.includes('timeout')) {
            family = normalized.includes('ollama') ? 'inference.timeout.ollama' : 'inference.timeout.generic';
        } else if (normalized.includes('prompt') && (normalized.includes('overflow') || normalized.includes('too long') || normalized.includes('token'))) {
            family = 'prompt.overflow';
        } else if (normalized.includes('memory') && normalized.includes('failed')) {
            family = 'memory.operation.failed';
        } else if (normalized.includes('reflection') && normalized.includes('failed')) {
            family = 'reflection.pipeline.failed';
        }

        const contextKey = `${family}|${component}|${errorCode || ''}|${normalized.slice(0, 120)}`;
        return { family, component, errorCode, contextKey, timestamp };
    }

    private computeClusterKey(source: string, family: string, component: string, errorCode?: string): string {
        const stable = `${source}|${family}|${component}|${errorCode || ''}`;
        return `cluster_${crypto.createHash('sha1').update(stable).digest('hex').slice(0, 16)}`;
    }

    private loadRecentHistory(hours: number = 24): HistoryRecord[] {
        if (!fs.existsSync(this.clusterHistoryPath)) return [];
        const since = Date.now() - hours * 60 * 60 * 1000;
        const lines = fs.readFileSync(this.clusterHistoryPath, 'utf-8').split('\n').filter(Boolean);
        const out: HistoryRecord[] = [];
        for (const line of lines.slice(-800)) {
            try {
                const parsed = JSON.parse(line) as HistoryRecord;
                const ts = new Date(parsed.timestamp).getTime();
                if (Number.isFinite(ts) && ts >= since && parsed.clusterKey) {
                    out.push(parsed);
                }
            } catch {
                // Ignore malformed history lines.
            }
        }
        return out;
    }

    private isSuppressedFamily(family: string): boolean {
        const benign = new Set(['log.generic']);
        return benign.has(family);
    }

    private severityToWeight(value: ClusterSeverity): number {
        switch (value) {
            case 'critical': return 4;
            case 'high': return 3;
            case 'medium': return 2;
            default: return 1;
        }
    }

    private weightToSeverity(weight: number): ClusterSeverity {
        if (weight >= 4) return 'critical';
        if (weight >= 3) return 'high';
        if (weight >= 2) return 'medium';
        return 'low';
    }

    private escalateSeverity(cluster: ClusterAccumulator, priorRunCount: number): { baseSeverity: ClusterSeverity; computedSeverity: ClusterSeverity; reasons: string[]; confidence: number } {
        let weight = 1;
        const reasons: string[] = [];
        if (cluster.eventCount >= 5) {
            weight += 1;
            reasons.push('repeated_occurrence');
        }
        if (cluster.eventCount >= 20) {
            weight += 1;
            reasons.push('high_frequency_short_window');
        }
        if (priorRunCount >= 2) {
            weight += 1;
            reasons.push('consecutive_runs');
        }
        if (cluster.sources.size > 1) {
            weight += 1;
            reasons.push('multi_component_impact');
        }
        if (/^(ipc\.read-file|provider\.discovery|inference\.|memory\.|reflection\.)/.test(cluster.family) && cluster.eventCount >= 3) {
            weight += 1;
            reasons.push('persistent_background_failure');
        }

        const baseSeverity: ClusterSeverity = 'low';
        const computedSeverity = this.weightToSeverity(Math.min(weight, 4));
        const confidence = Math.min(0.98, 0.55 + Math.min(cluster.eventCount, 20) * 0.015 + Math.min(priorRunCount, 3) * 0.05);
        return { baseSeverity, computedSeverity, reasons, confidence };
    }
}
