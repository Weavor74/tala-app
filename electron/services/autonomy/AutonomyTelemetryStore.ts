/**
 * AutonomyTelemetryStore.ts — Phase 4 P4I
 *
 * Telemetry batching and persistence for the autonomous self-improvement pipeline.
 *
 * Mirrors PlanningTelemetryStore (Phase 2) and ExecutionTelemetryStore (Phase 3):
 * - Events buffered in-memory, flushed periodically.
 * - Max buffer: 500 events (oldest dropped on overflow).
 * - Flush interval: 10 seconds.
 * - Persistence: <dataDir>/autonomy/telemetry.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    AutonomyTelemetryEvent,
    AutonomyTelemetryEventType,
} from '../../../shared/autonomyTypes';
import { telemetry } from '../TelemetryService';

const MAX_BUFFER = 500;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;

// ─── AutonomyTelemetryStore ───────────────────────────────────────────────────

export class AutonomyTelemetryStore {
    private buffer: AutonomyTelemetryEvent[] = [];
    private flushTimer: NodeJS.Timeout | null = null;
    private readonly telemetryFile: string;

    constructor(dataDir: string) {
        const autonomyDir = path.join(dataDir, 'autonomy');
        this.telemetryFile = path.join(autonomyDir, 'telemetry.jsonl');
        try {
            if (!fs.existsSync(autonomyDir)) {
                fs.mkdirSync(autonomyDir, { recursive: true });
            }
        } catch {
            // Non-fatal
        }
    }

    // ── Record ──────────────────────────────────────────────────────────────────

    record(
        type: AutonomyTelemetryEventType,
        detail: string,
        opts: {
            goalId?: string;
            runId?: string;
            subsystemId?: string;
            data?: Record<string, unknown>;
        } = {},
    ): AutonomyTelemetryEvent {
        const event: AutonomyTelemetryEvent = {
            eventId: uuidv4(),
            timestamp: new Date().toISOString(),
            type,
            detail,
            goalId: opts.goalId,
            runId: opts.runId,
            subsystemId: opts.subsystemId,
            data: opts.data,
        };

        this.buffer.push(event);
        if (this.buffer.length > MAX_BUFFER) {
            this.buffer.shift(); // Drop oldest
        }

        return event;
    }

    // ── Query ───────────────────────────────────────────────────────────────────

    getBuffer(): AutonomyTelemetryEvent[] {
        return [...this.buffer];
    }

    getRecentEvents(limit = 100): AutonomyTelemetryEvent[] {
        return this.buffer.slice(-limit);
    }

    getRunEvents(runId: string, limit = 50): AutonomyTelemetryEvent[] {
        return this.buffer
            .filter(e => e.runId === runId)
            .slice(-limit);
    }

    // ── Flush ───────────────────────────────────────────────────────────────────

    flush(): void {
        if (this.buffer.length === 0) return;
        const lines = this.buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
        try {
            fs.appendFileSync(this.telemetryFile, lines, 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'AutonomyTelemetryStore',
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
