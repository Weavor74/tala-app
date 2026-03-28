/**
 * PlanningTelemetryStore.ts — Phase 2 P2I
 *
 * Telemetry batching, persistence, and refresh for the safe-change
 * planning pipeline.
 *
 * Design:
 * - Events are collected in-memory and flushed periodically (or on demand).
 * - Each flush writes a JSONL append to the telemetry log file.
 * - The store does NOT push individual events to the renderer; it
 *   batches them and lets the dashboard bridge own UI updates.
 * - Maximum in-memory buffer: 500 events (oldest dropped on overflow).
 * - Flush interval: configurable, default 10 seconds.
 *
 * P2I persistence model:
 *   <dataDir>/planning/telemetry.jsonl  — append-only event log
 *   <dataDir>/planning/runs/<runId>.json — full run record (written at each milestone)
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    PlanRun,
    PlanningTelemetryEvent,
    PlanPipelineStage,
} from '../../../shared/reflectionPlanTypes';
import { telemetry } from '../TelemetryService';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_BUFFER = 500;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;

// ─── PlanningTelemetryStore ───────────────────────────────────────────────────

export class PlanningTelemetryStore {
    private buffer: PlanningTelemetryEvent[] = [];
    private flushTimer: NodeJS.Timeout | null = null;
    private readonly telemetryFile: string;
    private readonly runsDir: string;

    constructor(dataDir: string) {
        const planningDir = path.join(dataDir, 'planning');
        this.telemetryFile = path.join(planningDir, 'telemetry.jsonl');
        this.runsDir = path.join(planningDir, 'runs');
        this._ensureDirs(planningDir, this.runsDir);
    }

    // ── Event recording ─────────────────────────────────────────────────────────

    /**
     * Records a telemetry event in the in-memory buffer.
     * Events are NOT flushed immediately — call `flush()` or start the
     * auto-flush timer with `startAutoFlush()`.
     */
    record(
        runId: string,
        stage: PlanPipelineStage | 'system',
        category: PlanningTelemetryEvent['category'],
        message: string,
        data?: Record<string, unknown>,
    ): void {
        const event: PlanningTelemetryEvent = {
            eventId: uuidv4(),
            runId,
            timestamp: new Date().toISOString(),
            stage,
            category,
            message,
            data,
        };

        this.buffer.push(event);

        // Drop oldest events on overflow
        if (this.buffer.length > MAX_BUFFER) {
            this.buffer.shift();
        }
    }

    /** Returns a copy of the current in-memory event buffer. */
    getBuffer(): PlanningTelemetryEvent[] {
        return [...this.buffer];
    }

    /**
     * Returns the most recent N events for a specific run.
     * Used by the IPC `planning:getTelemetry` handler.
     */
    getRunEvents(runId: string, limit = 100): PlanningTelemetryEvent[] {
        return this.buffer
            .filter(e => e.runId === runId)
            .slice(-limit);
    }

    // ── Flush / persistence ─────────────────────────────────────────────────────

    /**
     * Writes all buffered events to the telemetry JSONL file and clears
     * the buffer.
     *
     * Called automatically by the auto-flush timer or explicitly at
     * milestone boundaries.
     */
    flush(): void {
        if (this.buffer.length === 0) return;

        const lines = this.buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
        try {
            fs.appendFileSync(this.telemetryFile, lines, 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'planning',
                'planning.telemetry.flush_error',
                'warn',
                'PlanningTelemetryStore',
                `Failed to flush telemetry: ${err.message}`,
            );
        }

        this.buffer = [];
    }

    /**
     * Persists a complete run record to disk.
     * Called at each milestone so that partial results survive crashes.
     *
     * @param run The current state of the planning run.
     */
    persistRun(run: PlanRun): void {
        const filePath = path.join(this.runsDir, `${run.runId}.json`);
        try {
            fs.writeFileSync(filePath, JSON.stringify(run, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'planning',
                'planning.run.persist_error',
                'warn',
                'PlanningTelemetryStore',
                `Failed to persist run ${run.runId}: ${err.message}`,
            );
        }
    }

    /**
     * Loads a previously-persisted run record from disk.
     * Returns null if not found or on parse error.
     */
    loadRun(runId: string): PlanRun | null {
        const filePath = path.join(this.runsDir, `${runId}.json`);
        try {
            if (!fs.existsSync(filePath)) return null;
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content) as PlanRun;
        } catch {
            return null;
        }
    }

    /**
     * Returns the file paths of all persisted run records.
     * Used by the IPC `planning:listRuns` handler.
     */
    listPersistedRunIds(): string[] {
        try {
            return fs
                .readdirSync(this.runsDir)
                .filter(f => f.endsWith('.json'))
                .map(f => f.replace('.json', ''));
        } catch {
            return [];
        }
    }

    // ── Auto-flush timer ────────────────────────────────────────────────────────

    /**
     * Starts the periodic auto-flush timer.
     * Call once during service initialisation.
     */
    startAutoFlush(intervalMs = DEFAULT_FLUSH_INTERVAL_MS): void {
        if (this.flushTimer) return;
        this.flushTimer = setInterval(() => this.flush(), intervalMs);
        if (this.flushTimer.unref) this.flushTimer.unref(); // don't prevent process exit
    }

    /** Stops the auto-flush timer and performs a final flush. */
    stopAutoFlush(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        this.flush();
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _ensureDirs(...dirs: string[]): void {
        for (const d of dirs) {
            try {
                if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            } catch {
                // Non-fatal — file system may not be available in test environments
            }
        }
    }
}
