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
 * 
 * @capability [CAPABILITY 5.3] Real Evidence Collection & Analysis
 */
export class ReflectionEngine {
    private store: ArtifactStore;

    /** Rolling buffer of captured console errors (max 200 entries). */
    private static errorBuffer: string[] = [];
    private static failedToolBuffer: Array<{ tool: string; error: string }> = [];
    private static readonly MAX_BUFFER_SIZE = 200;

    constructor(store: ArtifactStore) {
        this.store = store;
        ReflectionEngine.installLogInterceptor();
    }

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

    /**
     * Allows external code (e.g., AgentService) to report a tool failure directly.
     */
    static reportToolFailure(tool: string, error: string) {
        ReflectionEngine.failedToolBuffer.push({ tool, error });
    }

    /**
     * Runs a reflection cycle based on real captured evidence.
     */
    async runCycle(): Promise<ReflectionEvent | null> {
        console.log('[ReflectionEngine] Starting reflection cycle...');

        // 1. Capture real evidence
        const evidence = await this.collectEvidence();

        if (evidence.errors.length === 0 && evidence.failedToolCalls.length === 0) {
            console.log('[ReflectionEngine] No critical evidence found. System healthy.');
            return null;
        }

        // 2. Synthesize into a ReflectionEvent
        const errorSummary = evidence.errors.length > 3
            ? `${evidence.errors.length} errors detected (showing first 3)`
            : `${evidence.errors.length} error(s) detected`;

        const event: ReflectionEvent = {
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            summary: `${errorSummary}, ${evidence.failedToolCalls.length} tool failure(s).`,
            evidence: evidence,
            observations: this.generateObservations(evidence),
            metrics: {
                averageLatencyMs: 0, // TODO: instrument AgentService with timing
                errorRate: evidence.errors.length / Math.max(evidence.turns.length, 1)
            }
        };

        await this.store.saveReflection(event);
        console.log(`[ReflectionEngine] Reflection saved: ${event.id} — ${event.summary}`);
        return event;
    }

    /**
     * Collects REAL evidence from the rolling error buffer.
     * Drains the buffer after collection (each error is analyzed once).
     */
    private async collectEvidence() {
        // Drain the buffers (snapshot + clear)
        const errors = [...ReflectionEngine.errorBuffer];
        const failedToolCalls = [...ReflectionEngine.failedToolBuffer];

        // Clear after collection so we don't re-analyze the same errors
        ReflectionEngine.errorBuffer = [];
        ReflectionEngine.failedToolBuffer = [];

        // Filter out noise (internal framework messages, etc.)
        const significantErrors = errors.filter(e =>
            !e.includes('[ReflectionEngine]') &&
            !e.includes('[Heartbeat]') &&
            !e.includes('DevTools')
        );

        return {
            turns: [], // TODO: instrument AgentService to track turn counts
            errors: significantErrors.slice(0, 20), // Cap at 20 per cycle
            failedToolCalls: failedToolCalls.slice(0, 10) // Cap at 10 per cycle
        };
    }

    /**
     * Generates human-readable observations from evidence patterns.
     */
    private generateObservations(evidence: { errors: string[]; failedToolCalls: any[] }): string[] {
        const obs: string[] = [];

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

        // If no patterns matched, report clean state
        if (obs.length === 0 && evidence.errors.length > 0) {
            obs.push(`${evidence.errors.length} miscellaneous error(s) detected. Review artifacts for details.`);
        }

        return obs;
    }
}
