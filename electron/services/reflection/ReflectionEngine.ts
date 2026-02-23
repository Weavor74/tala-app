import fs from 'fs';
import path from 'path';
import { ReflectionEvent } from './types';
import { ArtifactStore } from './ArtifactStore';
import { v4 as uuidv4 } from 'uuid';

/**
 * Handles the collection of evidence and the high-level analysis of system performance.
 * 
 * Evidence sources (real):
 * - Rolling console log buffer (captured from stdout/stderr intercept)
 * - Previous reflection/outcome artifacts from disk
 * - Turn tracking data from AgentService (latency + turn counts)
 * 
 * @capability [CAPABILITY 5.3] Real Evidence Collection & Analysis
 */
export class ReflectionEngine {
    private store: ArtifactStore;

    /** Rolling buffer of captured console errors (max 200 entries). */
    private static errorBuffer: string[] = [];
    private static failedToolBuffer: Array<{ tool: string; error: string }> = [];
    private static readonly MAX_BUFFER_SIZE = 200;

    /** ── Turn Tracking ────────────────────────────────────── */
    /** Records of individual agent turns (latency + metadata). */
    private static turnRecords: TurnRecord[] = [];
    private static readonly MAX_TURN_RECORDS = 500;

    constructor(store: ArtifactStore) {
        this.store = store;
        ReflectionEngine.installLogInterceptor();
    }

    // ═══════════════════════════════════════════════════════════
    //  Turn Tracking — Public API for AgentService instrumentation
    // ═══════════════════════════════════════════════════════════

    /**
     * Records a completed agent turn with timing and metadata.
     * Called by AgentService after each inference call.
     */
    static recordTurn(record: TurnRecord) {
        ReflectionEngine.turnRecords.push(record);
        if (ReflectionEngine.turnRecords.length > ReflectionEngine.MAX_TURN_RECORDS) {
            ReflectionEngine.turnRecords = ReflectionEngine.turnRecords.slice(
                -ReflectionEngine.MAX_TURN_RECORDS
            );
        }
    }

    /**
     * Allows external code (e.g., AgentService) to report a tool failure directly.
     */
    static reportToolFailure(tool: string, error: string) {
        ReflectionEngine.failedToolBuffer.push({ tool, error });
    }

    /**
     * Returns current latency statistics (for external monitoring/metrics).
     */
    static getLatencyStats(): { count: number; avgMs: number; p95Ms: number; maxMs: number } {
        const records = ReflectionEngine.turnRecords;
        if (records.length === 0) return { count: 0, avgMs: 0, p95Ms: 0, maxMs: 0 };

        const latencies = records.map(r => r.latencyMs).sort((a, b) => a - b);
        const sum = latencies.reduce((a, b) => a + b, 0);
        const p95Index = Math.floor(latencies.length * 0.95);

        return {
            count: latencies.length,
            avgMs: Math.round(sum / latencies.length),
            p95Ms: latencies[p95Index] || latencies[latencies.length - 1],
            maxMs: latencies[latencies.length - 1]
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  Log Interceptor
    // ═══════════════════════════════════════════════════════════

    /**
     * Installs a one-time interceptor on console.error to capture errors
     * into the rolling buffer for evidence collection.
     */
    private static interceptorInstalled = false;
    private static installLogInterceptor() {
        if (ReflectionEngine.interceptorInstalled) return;
        ReflectionEngine.interceptorInstalled = true;

        const originalError = console.error;
        console.error = (...args: any[]) => {
            // Capture the error string
            const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
            ReflectionEngine.errorBuffer.push(msg);

            // Trim buffer if too large
            if (ReflectionEngine.errorBuffer.length > ReflectionEngine.MAX_BUFFER_SIZE) {
                ReflectionEngine.errorBuffer = ReflectionEngine.errorBuffer.slice(-ReflectionEngine.MAX_BUFFER_SIZE);
            }

            // Detect tool failures
            if (msg.includes('Error executing tool') || msg.includes('Tool call failed')) {
                const toolMatch = msg.match(/tool\s+(\w+)/i);
                ReflectionEngine.failedToolBuffer.push({
                    tool: toolMatch ? toolMatch[1] : 'unknown',
                    error: msg.substring(0, 200)
                });
                if (ReflectionEngine.failedToolBuffer.length > 50) {
                    ReflectionEngine.failedToolBuffer = ReflectionEngine.failedToolBuffer.slice(-50);
                }
            }

            // Pass through to original
            originalError.apply(console, args);
        };

        console.log('[ReflectionEngine] Log interceptor installed — capturing real errors.');
    }

    // ═══════════════════════════════════════════════════════════
    //  Reflection Cycle
    // ═══════════════════════════════════════════════════════════

    /**
     * Runs a reflection cycle based on real captured evidence.
     */
    async runCycle(): Promise<ReflectionEvent | null> {
        console.log('[ReflectionEngine] Starting reflection cycle...');

        // 1. Capture real evidence
        const evidence = await this.collectEvidence();

        if (evidence.errors.length === 0 && evidence.failedToolCalls.length === 0 && evidence.turns.length === 0) {
            console.log('[ReflectionEngine] No critical evidence found. System healthy.');
            return null;
        }

        // 2. Compute latency metrics from turn records
        const latencyStats = this.computeLatencyFromTurns(evidence.turns);

        // 3. Synthesize into a ReflectionEvent
        const errorSummary = evidence.errors.length > 3
            ? `${evidence.errors.length} errors detected (showing first 3)`
            : `${evidence.errors.length} error(s) detected`;

        const turnSummary = evidence.turns.length > 0
            ? `, ${evidence.turns.length} agent turn(s) tracked`
            : '';

        const event: ReflectionEvent = {
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            summary: `${errorSummary}, ${evidence.failedToolCalls.length} tool failure(s)${turnSummary}.`,
            evidence: evidence,
            observations: this.generateObservations(evidence, latencyStats),
            metrics: {
                averageLatencyMs: latencyStats.avgMs,
                errorRate: evidence.turns.length > 0
                    ? evidence.errors.length / evidence.turns.length
                    : (evidence.errors.length > 0 ? 1.0 : 0)
            }
        };

        await this.store.saveReflection(event);
        console.log(`[ReflectionEngine] Reflection saved: ${event.id} — ${event.summary}`);
        console.log(`[ReflectionEngine] Metrics: avgLatency=${latencyStats.avgMs}ms, p95=${latencyStats.p95Ms}ms, errorRate=${(event.metrics.errorRate * 100).toFixed(1)}%`);
        return event;
    }

    /**
     * Collects REAL evidence from the rolling buffers.
     * Drains all buffers after collection (each data point is analyzed once).
     */
    private async collectEvidence() {
        // Drain the buffers (snapshot + clear)
        const errors = [...ReflectionEngine.errorBuffer];
        const failedToolCalls = [...ReflectionEngine.failedToolBuffer];
        const turns = [...ReflectionEngine.turnRecords];

        // Clear after collection so we don't re-analyze
        ReflectionEngine.errorBuffer = [];
        ReflectionEngine.failedToolBuffer = [];
        ReflectionEngine.turnRecords = [];

        // Filter out noise (internal framework messages, etc.)
        const significantErrors = errors.filter(e =>
            !e.includes('[ReflectionEngine]') &&
            !e.includes('[Heartbeat]') &&
            !e.includes('DevTools')
        );

        return {
            turns: turns.map(t => ({
                timestamp: t.timestamp,
                latencyMs: t.latencyMs,
                turnNumber: t.turnNumber,
                model: t.model,
                tokensUsed: t.tokensUsed,
                hadToolCalls: t.hadToolCalls,
                error: t.error
            })),
            errors: significantErrors.slice(0, 20), // Cap at 20 per cycle
            failedToolCalls: failedToolCalls.slice(0, 10) // Cap at 10 per cycle
        };
    }

    /**
     * Computes latency statistics from collected turn records.
     */
    private computeLatencyFromTurns(turns: any[]): {
        avgMs: number;
        p95Ms: number;
        maxMs: number;
        totalTurns: number;
        failedTurns: number;
    } {
        if (turns.length === 0) {
            return { avgMs: 0, p95Ms: 0, maxMs: 0, totalTurns: 0, failedTurns: 0 };
        }

        const latencies = turns.map(t => t.latencyMs).sort((a: number, b: number) => a - b);
        const sum = latencies.reduce((a: number, b: number) => a + b, 0);
        const p95Index = Math.floor(latencies.length * 0.95);
        const failedTurns = turns.filter(t => t.error).length;

        return {
            avgMs: Math.round(sum / latencies.length),
            p95Ms: latencies[p95Index] || latencies[latencies.length - 1],
            maxMs: latencies[latencies.length - 1],
            totalTurns: turns.length,
            failedTurns
        };
    }

    /**
     * Generates human-readable observations from evidence patterns.
     */
    private generateObservations(
        evidence: { errors: string[]; failedToolCalls: any[]; turns: any[] },
        latencyStats: { avgMs: number; p95Ms: number; maxMs: number; totalTurns: number; failedTurns: number }
    ): string[] {
        const obs: string[] = [];

        // Turn tracking observations
        if (latencyStats.totalTurns > 0) {
            obs.push(`Tracked ${latencyStats.totalTurns} agent turn(s) — avg latency: ${latencyStats.avgMs}ms, p95: ${latencyStats.p95Ms}ms, max: ${latencyStats.maxMs}ms.`);

            if (latencyStats.avgMs > 15000) {
                obs.push(`⚠️ Average latency exceeds 15s — inference performance may be degraded.`);
            }

            if (latencyStats.p95Ms > 30000) {
                obs.push(`⚠️ P95 latency exceeds 30s — consider model optimization or provider change.`);
            }

            if (latencyStats.failedTurns > 0) {
                obs.push(`${latencyStats.failedTurns}/${latencyStats.totalTurns} turn(s) ended with errors.`);
            }
        }

        // Check for timeout patterns
        const timeoutErrors = evidence.errors.filter(e => /timeout|timed? out/i.test(e));
        if (timeoutErrors.length > 0) {
            obs.push(`Detected ${timeoutErrors.length} timeout error(s) — possible slow inference or network issues.`);
        }

        // Check for inference errors
        const inferenceErrors = evidence.errors.filter(e => /inference|ollama|fetch|400|500|ECONNREFUSED/i.test(e));
        if (inferenceErrors.length > 0) {
            obs.push(`Detected ${inferenceErrors.length} inference-related error(s) — LLM service may be unstable.`);
        }

        // Check for tool failures
        if (evidence.failedToolCalls.length > 0) {
            const toolNames = [...new Set(evidence.failedToolCalls.map(t => t.tool))];
            obs.push(`Failed tools: ${toolNames.join(', ')}.`);
        }

        // Model diversity check
        if (evidence.turns.length > 0) {
            const models = [...new Set(evidence.turns.map(t => t.model).filter(Boolean))];
            if (models.length > 0) {
                obs.push(`Models used: ${models.join(', ')}.`);
            }
        }

        // If no patterns matched, report clean state
        if (obs.length === 0 && evidence.errors.length > 0) {
            obs.push(`${evidence.errors.length} miscellaneous error(s) detected. Review artifacts for details.`);
        }

        return obs;
    }
}

/**
 * Represents a single agent turn with performance data.
 * Recorded by AgentService, consumed by ReflectionEngine.
 */
export interface TurnRecord {
    /** ISO timestamp of when the turn completed. */
    timestamp: string;
    /** Time in milliseconds from inference request to response. */
    latencyMs: number;
    /** Which turn number within the agent loop (1-indexed). */
    turnNumber: number;
    /** Which model/brain was used for this turn. */
    model?: string;
    /** Total tokens used in this turn. */
    tokensUsed?: number;
    /** Whether the turn included tool calls. */
    hadToolCalls: boolean;
    /** Error message if the turn failed. */
    error?: string;
}
