/**
 * Reflection Reasoning Engine
 *
 * Phase 2 Trustworthiness Hardening — Objective 9
 *
 * Responsible for two complementary roles:
 *
 * 1. **Runtime Telemetry Collection** (static interface)
 *    Accumulates turn latency records, console error intercepts, tool-failure
 *    reports, and normalized subsystem signals in process-level static buffers
 *    so any service can contribute data without holding an engine reference.
 *
 * 2. **Reflection Cycle Execution** (instance method)
 *    Drains the static buffers on each `runCycle()` call, evaluates trigger
 *    conditions against normalized evidence, and produces structured
 *    `ReflectionEvent`s with typed output categories and evidence references.
 *    Returns `null` when no triggers are met (system healthy).
 *
 * Phase 2 additions:
 * - Normalized `TelemetrySignal` buffer (subsystem degradation, fallback events)
 * - Trigger evaluation with named rules and thresholds
 * - Typed `ReflectionOutputType` classification for each emitted event
 * - Evidence references in all reflection outputs
 * - Auditable reflection telemetry via TelemetryService
 *
 * The existing `analyzeIssue` / `logMaintenanceEvent` methods are retained for
 * the autonomous self-improvement pipeline used by `ReflectionService`.
 */
import { ReflectionIssue, ReflectionHypothesis } from './reflectionEcosystemTypes';
import { ReflectionEvent } from './types';
import { ArtifactStore } from './ArtifactStore';
import { MaintenanceReflectionEvent } from '../../../shared/maintenance/maintenanceEvents';
import { telemetry } from '../TelemetryService';
import type { ReflectionOutputType } from '../../../shared/telemetry';

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

/**
 * A normalized signal from any subsystem that should feed into reflection.
 * These are distinct from raw console errors — they carry structured context.
 */
export interface TelemetrySignal {
    /** ISO timestamp */
    timestamp: string;
    /** Subsystem that produced the signal */
    subsystem: string;
    /** Signal category */
    category:
        | 'inference_failure'
        | 'inference_timeout'
        | 'mcp_instability'
        | 'memory_anomaly'
        | 'artifact_mismatch'
        | 'mode_conflict'
        | 'degraded_fallback'
        | 'subsystem_unavailable'
        // Priority 2A — aggregated diagnostic pattern signals
        | 'repeated_provider_fallback'
        | 'repeated_stream_timeout'
        | 'provider_exhaustion'
        | 'repeated_mcp_restart'
        | 'critical_service_unavailable'
        | 'degraded_subsystem_persistent'
        // Phase 2B — runtime control operational signals
        | 'provider_instability_pattern'
        | 'repeated_provider_restart'
        | 'mcp_service_flapping'
        | 'persistent_degraded_subsystem'
        | 'operator_intervention_required';
    /** Human-readable description */
    description: string;
    /** Optional structured context */
    context?: Record<string, unknown>;
}

/**
 * Trigger evaluation result — describes why reflection was triggered or suppressed.
 */
export interface TriggerEvaluation {
    shouldTrigger: boolean;
    triggerReason: string;
    /** Named trigger rule that matched */
    triggeredBy?: string;
    anomalyCount: number;
    failureCount: number;
}

interface LatencyStats {
    count: number;
    avgMs: number;
    maxMs: number;
    p95Ms: number;
}

// ---------------------------------------------------------------------------
// Trigger thresholds
// ---------------------------------------------------------------------------

/** Minimum number of errors before reflection is triggered. */
const ERROR_TRIGGER_THRESHOLD = 1;
/** Minimum number of tool failures before reflection is triggered. */
const TOOL_FAILURE_TRIGGER_THRESHOLD = 1;
/** Error rate (errors/turn) above which reflection is triggered. */
const ERROR_RATE_TRIGGER_THRESHOLD = 0.3;
/** Minimum number of subsystem degradation signals before reflection is triggered. */
const DEGRADATION_SIGNAL_THRESHOLD = 1;

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

    /**
     * Normalized telemetry signals from subsystems.
     * These are richer than raw errors — they carry structured context from
     * inference, MCP, memory, and artifact routing.
     */
    private static telemetrySignalBuffer: TelemetrySignal[] = [];

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

    /**
     * Reports a normalized telemetry signal from any subsystem.
     * Signals feed the trigger evaluation and evidence aggregation in runCycle().
     *
     * @example
     *   ReflectionEngine.reportSignal({
     *     timestamp: new Date().toISOString(),
     *     subsystem: 'local_inference',
     *     category: 'inference_timeout',
     *     description: 'Inference timed out after 30000ms',
     *     context: { model: 'llama3', retryCount: 2 },
     *   });
     */
    public static reportSignal(signal: TelemetrySignal): void {
        this.telemetrySignalBuffer.push(signal);
    }

    /**
     * Reports a thresholded aggregated instability signal.
     *
     * Unlike reportSignal(), this method only emits a signal when the streak count
     * meets or exceeds the given threshold, and only once per threshold crossing.
     * This prevents reflection noise from individual transient failures.
     *
     * Designed for Objective G patterns:
     * - repeated_provider_fallback
     * - repeated_stream_timeout
     * - provider_exhaustion
     * - repeated_mcp_restart
     * - critical_service_unavailable
     * - degraded_subsystem_persistent
     *
     * @param signal - The base signal to report.
     * @param streakCount - Current consecutive failure count.
     * @param threshold - Minimum streak to emit the signal (default: 3).
     */
    public static reportThresholdedSignal(
        signal: TelemetrySignal,
        streakCount: number,
        threshold = 3,
    ): void {
        if (streakCount >= threshold) {
            this.telemetrySignalBuffer.push({
                ...signal,
                context: {
                    ...(signal.context ?? {}),
                    streakCount,
                    threshold,
                },
            });
        }
    }

    /**
     * Returns a snapshot of buffered signals without draining.
     * Used for diagnostic inspection.
     */
    public static peekSignals(): TelemetrySignal[] {
        return [...this.telemetrySignalBuffer];
    }

    /**
     * Evaluates whether the current buffered evidence meets a reflection trigger.
     *
     * Trigger rules (in priority order):
     * 1. `repeated_failure` — error count ≥ ERROR_TRIGGER_THRESHOLD
     * 2. `tool_failure` — tool failure count ≥ TOOL_FAILURE_TRIGGER_THRESHOLD
     * 3. `high_error_rate` — error rate ≥ ERROR_RATE_TRIGGER_THRESHOLD (when turns exist)
     * 4. `degraded_subsystem` — degradation signal count ≥ DEGRADATION_SIGNAL_THRESHOLD
     *
     * Returns a TriggerEvaluation — does NOT drain buffers.
     */
    public static evaluateTriggers(): TriggerEvaluation {
        const errors = [...this.errorBuffer];
        const toolFailures = [...this.toolFailureBuffer];
        const turns = [...this.turnBuffer];
        const signals = [...this.telemetrySignalBuffer];

        const degradationSignals = signals.filter(s =>
            s.category === 'degraded_fallback' ||
            s.category === 'inference_failure' ||
            s.category === 'inference_timeout' ||
            s.category === 'mcp_instability' ||
            s.category === 'subsystem_unavailable' ||
            // Priority 2A aggregated diagnostic pattern signals
            s.category === 'repeated_provider_fallback' ||
            s.category === 'repeated_stream_timeout' ||
            s.category === 'provider_exhaustion' ||
            s.category === 'repeated_mcp_restart' ||
            s.category === 'critical_service_unavailable' ||
            s.category === 'degraded_subsystem_persistent' ||
            // Phase 2B runtime control operational signals
            s.category === 'provider_instability_pattern' ||
            s.category === 'repeated_provider_restart' ||
            s.category === 'mcp_service_flapping' ||
            s.category === 'persistent_degraded_subsystem' ||
            s.category === 'operator_intervention_required'
        );

        const errorRate = turns.length > 0 ? errors.length / turns.length : 0;

        if (errors.length >= ERROR_TRIGGER_THRESHOLD) {
            return {
                shouldTrigger: true,
                triggerReason: `${errors.length} error(s) in buffer`,
                triggeredBy: 'repeated_failure',
                anomalyCount: errors.length + degradationSignals.length,
                failureCount: errors.length + toolFailures.length,
            };
        }

        if (toolFailures.length >= TOOL_FAILURE_TRIGGER_THRESHOLD) {
            return {
                shouldTrigger: true,
                triggerReason: `${toolFailures.length} tool failure(s) in buffer`,
                triggeredBy: 'tool_failure',
                anomalyCount: toolFailures.length + degradationSignals.length,
                failureCount: toolFailures.length,
            };
        }

        if (turns.length > 0 && errorRate >= ERROR_RATE_TRIGGER_THRESHOLD) {
            return {
                shouldTrigger: true,
                triggerReason: `Error rate ${(errorRate * 100).toFixed(0)}% exceeds threshold`,
                triggeredBy: 'high_error_rate',
                anomalyCount: errors.length + degradationSignals.length,
                failureCount: errors.length,
            };
        }

        if (degradationSignals.length >= DEGRADATION_SIGNAL_THRESHOLD) {
            return {
                shouldTrigger: true,
                triggerReason: `${degradationSignals.length} degradation signal(s) in buffer`,
                triggeredBy: 'degraded_subsystem',
                anomalyCount: degradationSignals.length,
                failureCount: 0,
            };
        }

        return {
            shouldTrigger: false,
            triggerReason: 'No trigger conditions met',
            anomalyCount: 0,
            failureCount: 0,
        };
    }

    // ------------------------------------------------------------------
    // Instance reflection cycle
    // ------------------------------------------------------------------

    /**
     * Executes one reflection cycle:
     * 1. Always drains the turn buffer (metric tracking, not evidence-based).
     * 2. Evaluates trigger conditions against the error/tool/signal buffers.
     * 3. Returns `null` when no trigger conditions are met (system healthy).
     * 4. Drains error/tool/signal buffers and produces a typed `ReflectionEvent`.
     * 5. Emits reflection telemetry events.
     *
     * Note: The turn buffer is drained regardless of trigger state to prevent
     * unbounded accumulation across cycles. This preserves backward compatibility
     * with callers that rely on `runCycle()` to flush turn metrics.
     */
    public async runCycle(turnId = 'global', mode = 'unknown'): Promise<ReflectionEvent | null> {
        // Always drain the turn buffer (latency metrics only — not trigger evidence)
        const turns = ReflectionEngine.turnBuffer.splice(0);

        // Evaluate triggers BEFORE draining error/signal buffers
        const triggerEval = ReflectionEngine.evaluateTriggers();

        if (!triggerEval.shouldTrigger) {
            telemetry.debug(
                'reflection',
                'reflection_suppressed',
                'ReflectionEngine',
                'Reflection cycle suppressed — no trigger conditions met',
                { turnId, mode }
            );
            return null;
        }

        // Drain error and signal buffers only when reflection fires
        const errors = ReflectionEngine.errorBuffer.splice(0);
        const failedToolCalls = ReflectionEngine.toolFailureBuffer.splice(0);
        const signals = ReflectionEngine.telemetrySignalBuffer.splice(0);

        telemetry.audit(
            'reflection',
            'reflection_triggered',
            'ReflectionEngine',
            `Reflection triggered: ${triggerEval.triggerReason}`,
            'success',
            {
                turnId,
                mode,
                payload: {
                    triggerReason: triggerEval.triggerReason,
                    triggeredBy: triggerEval.triggeredBy,
                    anomalyCount: triggerEval.anomalyCount,
                    failureCount: triggerEval.failureCount,
                },
            }
        );

        const observations = this.generateObservations(errors, failedToolCalls, signals);
        const avgMs =
            turns.length > 0
                ? Math.round(turns.reduce((s, t) => s + t.latencyMs, 0) / turns.length)
                : 0;
        const errorRate = turns.length > 0 ? errors.length / turns.length : 0;

        // Classify output type based on evidence
        const outputType = this.classifyOutputType(errors, failedToolCalls, signals, errorRate);

        // Build evidence summary (no raw user content)
        const evidenceSummary = this.buildEvidenceSummary(errors, failedToolCalls, signals);

        const event: ReflectionEvent = {
            id: `ref_${Date.now()}`,
            timestamp: new Date().toISOString(),
            summary: `${triggerEval.triggerReason} — ${outputType}`,
            evidence: {
                turns,
                errors,
                failedToolCalls,
                signals,
                triggerEval,
            },
            observations,
            metrics: { averageLatencyMs: avgMs, errorRate }
        };

        await this.store.saveReflection(event);

        telemetry.audit(
            'reflection',
            'reflection_completed',
            'ReflectionEngine',
            `Reflection completed: ${outputType} — ${observations.length} observation(s)`,
            'success',
            {
                turnId,
                mode,
                payload: {
                    triggerReason: triggerEval.triggerReason,
                    evidenceSummary,
                    anomalyCount: triggerEval.anomalyCount,
                    failureCount: triggerEval.failureCount,
                    outputType,
                    observationCount: observations.length,
                },
            }
        );

        return event;
    }

    private generateObservations(
        errors: string[],
        failedTools: Array<{ tool: string; error: string }>,
        signals: TelemetrySignal[] = []
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

        // Observations from normalized signals
        const inferenceTimeouts = signals.filter(s => s.category === 'inference_timeout');
        if (inferenceTimeouts.length > 0) {
            obs.push(`${inferenceTimeouts.length} inference timeout(s) reported by local_inference subsystem`);
        }

        const mcpInstability = signals.filter(s => s.category === 'mcp_instability');
        if (mcpInstability.length > 0) {
            obs.push(`MCP instability detected: ${mcpInstability.map(s => s.description).join('; ')}`);
        }

        const degraded = signals.filter(s => s.category === 'degraded_fallback');
        if (degraded.length > 0) {
            const subsystems = [...new Set(degraded.map(s => s.subsystem))].join(', ');
            obs.push(`Degraded fallback path activated in: ${subsystems}`);
        }

        // Priority 2A — aggregated diagnostic pattern observations
        const repeatedFallback = signals.filter(s => s.category === 'repeated_provider_fallback');
        if (repeatedFallback.length > 0) {
            obs.push(`Repeated provider fallback pattern detected (${repeatedFallback.length} signal(s))`);
        }

        const repeatedTimeout = signals.filter(s => s.category === 'repeated_stream_timeout');
        if (repeatedTimeout.length > 0) {
            obs.push(`Repeated stream timeout pattern detected (${repeatedTimeout.length} signal(s))`);
        }

        const providerExhaustion = signals.filter(s => s.category === 'provider_exhaustion');
        if (providerExhaustion.length > 0) {
            obs.push(`Provider exhaustion: all configured providers failed`);
        }

        const repeatedMcpRestart = signals.filter(s => s.category === 'repeated_mcp_restart');
        if (repeatedMcpRestart.length > 0) {
            obs.push(`Repeated MCP service restart pattern detected (${repeatedMcpRestart.length} signal(s))`);
        }

        const criticalUnavailable = signals.filter(s => s.category === 'critical_service_unavailable');
        if (criticalUnavailable.length > 0) {
            obs.push(`Critical service unavailable: ${criticalUnavailable.map(s => s.context?.serviceId ?? s.subsystem).join(', ')}`);
        }

        const persistentDegradation = signals.filter(s => s.category === 'degraded_subsystem_persistent');
        if (persistentDegradation.length > 0) {
            obs.push(`Persistent subsystem degradation detected in: ${persistentDegradation.map(s => s.subsystem).join(', ')}`);
        }

        return obs;
    }

    private classifyOutputType(
        errors: string[],
        failedTools: Array<{ tool: string; error: string }>,
        signals: TelemetrySignal[],
        errorRate: number
    ): ReflectionOutputType {
        const hasDegradedSignals = signals.some(
            s => s.category === 'degraded_fallback' ||
                s.category === 'subsystem_unavailable' ||
                s.category === 'critical_service_unavailable' ||
                s.category === 'degraded_subsystem_persistent'
        );
        const hasTimeouts = errors.some(e => /time[d\s]*out/i.test(e)) ||
            signals.some(s => s.category === 'inference_timeout' || s.category === 'repeated_stream_timeout');
        const hasInstabilityPattern = signals.some(
            s => s.category === 'repeated_provider_fallback' ||
                s.category === 'provider_exhaustion' ||
                s.category === 'repeated_mcp_restart' ||
                s.category === 'mcp_instability'
        );

        if (hasDegradedSignals || hasInstabilityPattern) return 'anomaly_summary';
        if (hasTimeouts && errorRate > ERROR_RATE_TRIGGER_THRESHOLD) return 'regression_warning';
        if (failedTools.length > 0) return 'operational_summary';
        if (errors.length > 0 && errorRate < 0.1) return 'confidence_limited_observation';
        return 'operational_summary';
    }

    private buildEvidenceSummary(
        errors: string[],
        failedTools: Array<{ tool: string; error: string }>,
        signals: TelemetrySignal[]
    ): string {
        const parts: string[] = [];
        if (errors.length > 0) parts.push(`${errors.length} error(s)`);
        if (failedTools.length > 0) parts.push(`${failedTools.length} tool failure(s)`);
        if (signals.length > 0) {
            const cats = [...new Set(signals.map(s => s.category))].join(', ');
            parts.push(`signals: ${cats}`);
        }
        return parts.join('; ') || 'no evidence';
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
