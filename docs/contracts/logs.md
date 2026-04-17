# Contract: logs.ts

**Source**: [shared\logs.ts](../../shared/logs.ts)

## Interfaces

### `LogViewerEntry`
```typescript
interface LogViewerEntry {
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
```

### `SystemHealth`
```typescript
interface SystemHealth {
    status: 'online' | 'degraded' | 'offline' | 'unknown';
    latestTimestamp?: string;
    lastMessage?: string;
    metadata?: Record<string, any>;
}
```

### `LogHealthSnapshot`
```typescript
interface LogHealthSnapshot {
    [subsystem: string]: SystemHealth;
}
```

### `LogDiagnosticsSummary`
```typescript
interface LogDiagnosticsSummary {
    totalEntries: number;
    errorCount: number;
    warnCount: number;
    promptAuditCount: number;
    lastTimestamp?: string;
    uniqueSessions: number;
    uniqueTurns: number;
}
```

### `RuntimeErrorRecord`
```typescript
interface RuntimeErrorRecord {
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
```

### `PerformanceMetricRecord`
```typescript
interface PerformanceMetricRecord {
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
```

### `TimelineEvent`
```typescript
interface TimelineEvent {
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
```

### `PerformanceSummary`
```typescript
interface PerformanceSummary {
    avgOllamaLatency: number;
    avgPromptAssemblyTime: number;
    avgRagQueryTime: number;
    latestPromptChars: number;
    latestModelMessageCount: number;
}
```

### `LogSourceInfo`
```typescript
interface LogSourceInfo {
    id: string;
    label: string;
    filePath: string;
    type: 'jsonl' | 'text';
}
```

### `LogReadResult`
```typescript
interface LogReadResult {
    entries: LogViewerEntry[];
    skippedCount: number;
    totalSize: number;
    hasMore: boolean;
}
```

### `LogSeverity`
```typescript
type LogSeverity =  'debug' | 'info' | 'warn' | 'error' | 'unknown';
```

