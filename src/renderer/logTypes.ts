export type LogSeverity = 'debug' | 'info' | 'warn' | 'error' | 'unknown';

export interface LogViewerEntry {
    id: string;
    timestamp: string;
    level: LogSeverity;
    source: string;
    subsystem?: string;
    eventType: string;
    message: string;
    sessionId?: string;
    turnId?: string;
    raw: any;
    rawText: string;
}

export interface SystemHealth {
    status: 'online' | 'degraded' | 'offline' | 'unknown';
    latestTimestamp?: string;
    lastMessage?: string;
    metadata?: Record<string, any>;
}

export interface LogHealthSnapshot {
    [subsystem: string]: SystemHealth;
}

export interface LogDiagnosticsSummary {
    totalEntries: number;
    errorCount: number;
    warnCount: number;
    promptAuditCount: number;
    lastTimestamp?: string;
    uniqueSessions: number;
    uniqueTurns: number;
}

export interface RuntimeErrorRecord {
    timestamp: string;
    level: 'error';
    source: string;
    subsystem: string;
    eventType: 'uncaughtException' | 'unhandledRejection' | 'rendererError' | 'ipcError' | 'unknownRuntimeError';
    message: string;
    stack?: string;
    sessionId?: string;
    turnId?: string;
    processType?: 'main' | 'renderer' | 'worker' | 'unknown';
    metadata?: Record<string, unknown>;
}

export interface PerformanceMetricRecord {
    timestamp: string;
    source: string;
    subsystem: string;
    metricType: string;
    name: string;
    value: number;
    unit: 'ms' | 'count' | 'chars' | 'tokens' | 'entries' | 'boolean';
    sessionId?: string;
    turnId?: string;
    metadata?: Record<string, unknown>;
}

export interface TimelineEvent {
    id: string;
    timestamp: string;
    subsystem: string;
    source: string;
    level: string;
    eventType: string;
    message: string;
    turnId?: string;
    sessionId?: string;
    raw?: unknown;
}

export interface PerformanceSummary {
    avgOllamaLatency: number;
    avgPromptAssemblyTime: number;
    avgRagQueryTime: number;
    latestPromptChars: number;
    latestModelMessageCount: number;
}

export interface LogSourceInfo {
    id: string;
    label: string;
    filePath: string;
    type: 'jsonl' | 'text';
}

export interface LogReadResult {
    entries: LogViewerEntry[];
    skippedCount: number;
    totalSize: number;
    hasMore: boolean;
}
