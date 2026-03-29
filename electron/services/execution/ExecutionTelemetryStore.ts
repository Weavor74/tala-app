/**
 * ExecutionTelemetryStore.ts — Phase 3 P3I
 *
 * Telemetry batching and persistence for the controlled execution pipeline.
 *
 * Mirrors PlanningTelemetryStore (Phase 2 P2I):
 * - Events buffered in-memory, flushed periodically.
 * - Max buffer: 500 events (oldest dropped on overflow).
 * - Flush interval: 10 seconds.
 * - Persistence: <dataDir>/execution/telemetry.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    ExecutionTelemetryEvent,
    ExecutionAuditStage,
} from '../../../shared/executionTypes';
import { telemetry } from '../TelemetryService';

const MAX_BUFFER = 500;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;

// ─── ExecutionTelemetryStore ──────────────────────────────────────────────────

export class ExecutionTelemetryStore {
    private buffer: ExecutionTelemetryEvent[] = [];
    private flushTimer: NodeJS.Timeout | null = null;
    private readonly telemetryFile: string;

    constructor(dataDir: string) {
        const execDir = path.join(dataDir, 'execution');
        this.telemetryFile = path.join(execDir, 'telemetry.jsonl');
        try {
            if (!fs.existsSync(execDir)) fs.mkdirSync(execDir, { recursive: true });
        } catch {
            // Non-fatal
        }
    }

    record(
        executionId: string,
        stage: ExecutionAuditStage | 'system',
        category: ExecutionTelemetryEvent['category'],
        message: string,
        data?: Record<string, unknown>,
    ): void {
        const event: ExecutionTelemetryEvent = {
            eventId: uuidv4(),
            executionId,
            timestamp: new Date().toISOString(),
            stage,
            category,
            message,
            data,
        };

        this.buffer.push(event);
        if (this.buffer.length > MAX_BUFFER) {
            this.buffer.shift();
        }
    }

    getBuffer(): ExecutionTelemetryEvent[] {
        return [...this.buffer];
    }

    getRunEvents(executionId: string, limit = 100): ExecutionTelemetryEvent[] {
        return this.buffer
            .filter(e => e.executionId === executionId)
            .slice(-limit);
    }

    flush(): void {
        if (this.buffer.length === 0) return;
        const lines = this.buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
        try {
            fs.appendFileSync(this.telemetryFile, lines, 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'execution',
                'execution.telemetry.flush_error',
                'warn',
                'ExecutionTelemetryStore',
                `Failed to flush telemetry: ${err.message}`,
            );
        }
        this.buffer = [];
    }

    startAutoFlush(intervalMs = DEFAULT_FLUSH_INTERVAL_MS): void {
        if (this.flushTimer) return;
        this.flushTimer = setInterval(() => this.flush(), intervalMs);
        if (this.flushTimer.unref) this.flushTimer.unref();
    }

    stopAutoFlush(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        this.flush();
    }
}
