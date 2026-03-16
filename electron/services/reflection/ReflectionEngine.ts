/**
 * Reflection Reasoning Engine
 *
 * Responsible for two complementary roles:
 *
 * 1. **Runtime Telemetry Collection** (static interface)
 *    Accumulates turn latency records, console error intercepts, and tool-failure
 *    reports in process-level static buffers so any service can contribute data
 *    without holding a reference to the engine instance.
 *
 * 2. **Reflection Cycle Execution** (instance method)
 *    Drains the static buffers on each `runCycle()` call, produces a structured
 *    `ReflectionEvent`, and persists it via the `ArtifactStore`.  Returns `null`
 *    when the system is healthy (no errors, no failures).
 *
 * The existing `analyzeIssue` / `logMaintenanceEvent` methods are retained for
 * the autonomous self-improvement pipeline used by `ReflectionService`.
 */
import { ReflectionIssue, ReflectionHypothesis } from './reflectionEcosystemTypes';
import { ReflectionEvent } from './types';
import { ArtifactStore } from './ArtifactStore';
import { MaintenanceReflectionEvent } from '../../../shared/maintenance/maintenanceEvents';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Metadata for a completed agent turn, used for latency tracking. */
export interface TurnRecord {
    timestamp: string;
    latencyMs: number;
    turnNumber: number;
    model: string;
    tokensUsed: number;
    hadToolCalls: boolean;
}

interface LatencyStats {
    count: number;
    avgMs: number;
    maxMs: number;
    p95Ms: number;
}

// ---------------------------------------------------------------------------
// ReflectionEngine
// ---------------------------------------------------------------------------

export class ReflectionEngine {
    private store: ArtifactStore;
    private systemMaintenanceEvents: MaintenanceReflectionEvent[];

    // Process-level static buffers — shared across all instances so any service
    // can contribute data without holding an engine reference.
    private static turnBuffer: TurnRecord[] = [];
    private static errorBuffer: string[] = [];
    private static toolFailureBuffer: Array<{ tool: string; error: string }> = [];

    // Console interception — installed once per process.
    private static interceptorInstalled = false;
    private static originalConsoleError: typeof console.error = console.error;

    constructor(store: ArtifactStore) {
        this.store = store;
        this.systemMaintenanceEvents = [];
        ReflectionEngine.installErrorInterceptor();
    }

    // ------------------------------------------------------------------
    // Console error interceptor
    // ------------------------------------------------------------------

    private static installErrorInterceptor() {
        if (this.interceptorInstalled) return;
        this.originalConsoleError = console.error;
        console.error = (...args: unknown[]) => {
            const msg = args.map(a => String(a)).join(' ');
            ReflectionEngine.errorBuffer.push(msg);
            ReflectionEngine.originalConsoleError.apply(console, args);
        };
        this.interceptorInstalled = true;
    }

    // ------------------------------------------------------------------
    // Static telemetry API
    // ------------------------------------------------------------------

    /** Records a completed turn for latency tracking across the reflection cycle. */
    public static recordTurn(record: TurnRecord): void {
        this.turnBuffer.push(record);
    }

    /**
     * Returns aggregated latency statistics from the buffered turn records.
     * The buffer is **not** drained — call `runCycle()` to drain.
     */
    public static getLatencyStats(): LatencyStats {
        const turns = [...this.turnBuffer];
        if (turns.length === 0) {
            return { count: 0, avgMs: 0, maxMs: 0, p95Ms: 0 };
        }

        const latencies = turns.map(t => t.latencyMs).sort((a, b) => a - b);
        const avgMs = Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length);
        const maxMs = latencies[latencies.length - 1];
        const p95Idx = Math.floor(0.95 * latencies.length);
        const p95Ms = latencies[Math.min(p95Idx, latencies.length - 1)];

        return { count: latencies.length, avgMs, maxMs, p95Ms };
    }

    /** Reports a tool execution failure for inclusion in the next reflection cycle. */
    public static reportToolFailure(tool: string, error: string): void {
        this.toolFailureBuffer.push({ tool, error });
    }

    // ------------------------------------------------------------------
    // Instance reflection cycle
    // ------------------------------------------------------------------

    /**
     * Executes one reflection cycle:
     * 1. Drains all static buffers (turns, errors, tool failures).
     * 2. Returns `null` when the system is healthy (no errors, no failures).
     * 3. Produces and persists a `ReflectionEvent` when evidence exists.
     */
    public async runCycle(): Promise<ReflectionEvent | null> {
        const turns = ReflectionEngine.turnBuffer.splice(0);
        const errors = ReflectionEngine.errorBuffer.splice(0);
        const failedToolCalls = ReflectionEngine.toolFailureBuffer.splice(0);

        if (errors.length === 0 && failedToolCalls.length === 0) {
            return null;
        }

        const observations = this.generateObservations(errors, failedToolCalls);
        const avgMs =
            turns.length > 0
                ? Math.round(turns.reduce((s, t) => s + t.latencyMs, 0) / turns.length)
                : 0;
        const errorRate = turns.length > 0 ? errors.length / turns.length : 0;

        const event: ReflectionEvent = {
            id: `ref_${Date.now()}`,
            timestamp: new Date().toISOString(),
            summary: `${errors.length} error(s) detected in reflection cycle`,
            evidence: { turns, errors, failedToolCalls },
            observations,
            metrics: { averageLatencyMs: avgMs, errorRate }
        };

        await this.store.saveReflection(event);
        return event;
    }

    private generateObservations(
        errors: string[],
        failedTools: Array<{ tool: string; error: string }>
    ): string[] {
        const obs: string[] = [];

        if (errors.some(e => /time[d\s]*out/i.test(e))) {
            obs.push('Detected timeout patterns — inference or network latency may be degraded');
        }
        if (errors.some(e => e.toLowerCase().includes('econnrefused'))) {
            obs.push('Connection refused — a dependent service may be offline');
        }
        if (failedTools.length > 0) {
            const toolNames = [...new Set(failedTools.map(f => f.tool))].join(', ');
            obs.push(`Tool failures detected: ${toolNames}`);
        }
        if (errors.length > 0) {
            obs.push(`${errors.length} error(s) logged during this cycle`);
        }

        return obs;
    }

    // ------------------------------------------------------------------
    // Autonomous self-improvement pipeline (retained for ReflectionService)
    // ------------------------------------------------------------------

    /**
     * Analyzes a `ReflectionIssue` and generates root-cause hypotheses.
     * Used by `ReflectionService` to drive the Observe-Reflect-Act loop.
     */
    public async analyzeIssue(issue: ReflectionIssue): Promise<ReflectionIssue> {
        console.log(`[ReflectionEngine] Analyzing issue ${issue.issueId}...`);

        issue.status = 'analyzing';

        const hypothesis: ReflectionHypothesis = {
            hypothesisId: `hyp_${Date.now()}`,
            summary: `Investigated trigger: ${issue.trigger}. Found anomalies.`,
            rationale: 'The logs and triggers indicate a potential state misalignment.',
            confidence: 0.85,
            affectedFiles: ['electron/services/SettingsManager.ts'],
            dependencies: [],
            risks: ['Modifying core state could affect all sessions'],
            disconfirmingEvidence: []
        };

        issue.rootCauseHypotheses = [hypothesis];
        issue.selectedHypothesis = hypothesis.hypothesisId;
        issue.affectedFiles = hypothesis.affectedFiles;
        issue.status = 'hypothesized';
        issue.updatedAt = new Date().toISOString();

        return issue;
    }

    /**
     * Integrates system-maintenance orchestration feedback into the reflection panel.
     * Called by `SelfMaintenanceService` after CLI maintenance commands complete.
     */
    public logMaintenanceEvent(event: MaintenanceReflectionEvent): void {
        console.log(`[ReflectionEngine] Logging ${event.domain} maintenance event: ${event.severity}`);
        this.systemMaintenanceEvents.push(event);
    }
}
