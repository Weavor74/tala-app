/**
 * ToolGatekeeper.ts
 *
 * Deterministic tool-decision layer that produces an explicit gate decision
 * before tools are sent to the model or retried.  Rules are purely data-driven
 * — no model inference is involved.
 *
 * Rule Groups
 * ───────────
 * A — Lore / autobiographical memory protection
 *     Blocks mem0_search when canon RAG/LTMF memory is already approved,
 *     or when the response mode is memory-grounded (soft or strict).
 *
 * B — Degraded tool suppression
 *     Suppresses any tool that has exceeded the recent-failure threshold
 *     within a rolling 5-minute window, unless it is critical to the intent
 *     and has no fallback.
 *
 * C — Direct-answer preference
 *     Sets directAnswerPreferred = true when grounded context makes
 *     exploratory tool calls redundant.
 *
 * D — Intent-based requiresToolUse flag
 *     Signals that the model MUST use tools for coding / browser intents.
 *
 * E — Retry discipline
 *     On isRetry = true, previously blocked tools are preserved so the
 *     retry pass never silently re-expands the tool universe.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Produced by ToolGatekeeper.evaluate().  Consumed by AgentService to finalize
 * which tools are sent to the model and whether a direct answer is preferred.
 */
export interface ToolGateDecision {
    /** Tool names that passed all gate rules and may be sent to the model. */
    allowedTools: string[];
    /** Tool names that were suppressed for this turn. */
    blockedTools: string[];
    /** Human-readable explanation for each gate action taken. */
    gatingReasons: string[];
    /** True when existing context is sufficient — model should prefer prose over tool calls. */
    directAnswerPreferred: boolean;
    /** True when the intent mandates at least one tool call (coding, browser). */
    requiresToolUse: boolean;
}

/**
 * Input provided to ToolGatekeeper.evaluate() for a single turn.
 */
export interface ToolGateContext {
    /** Classified intent class (e.g. 'lore', 'coding', 'browser', 'conversation'). */
    intentClass: string;
    /** Active chat mode ('rp' | 'hybrid' | 'assistant'). */
    activeMode: string;
    /** Response mode set by TalaContextRouter, if any. */
    responseMode?: string;
    /** Number of approved RAG/LTMF/graph memory candidates for this turn. */
    approvedMemoryCount: number;
    /** Names of the candidate tools after capability / mode filtering. */
    candidateToolNames: string[];
    /** True when the turn is running in browser-task mode. */
    isBrowserTask: boolean;
    /** True on ToolRequired retry passes; preserves priorBlockedTools. */
    isRetry: boolean;
    /**
     * Blocked tool names from the previous gate decision.
     * Must be provided when isRetry = true to preserve gate discipline.
     */
    priorBlockedTools?: string[];
}

// ─── Internal health record ───────────────────────────────────────────────────

interface ToolHealthRecord {
    /** Failures recorded within the current rolling window. */
    failureCount: number;
    /** True once failureCount reaches DEGRADED_THRESHOLD. */
    degraded: boolean;
    /** Epoch ms of the most recent failure. */
    lastFailAt: number;
}

// ─── ToolGatekeeper ───────────────────────────────────────────────────────────

/**
 * Deterministic gate that decides which tools may be used for a turn.
 *
 * A module-level singleton (`toolGatekeeper`) is exported for use in
 * AgentService.  The class itself is also exported for unit testing.
 */
export class ToolGatekeeper {
    /** Failures before a tool is considered degraded within the rolling window. */
    private static readonly DEGRADED_THRESHOLD = 3;

    /**
     * Rolling window for failure counting (ms).
     * A tool is never permanently suppressed — health resets automatically
     * once no failures have occurred within this window.
     */
    private static readonly HEALTH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

    /**
     * Tools that are critical infrastructure and MUST NOT be suppressed by
     * the degraded-tool rule regardless of failure count.
     */
    private static readonly CRITICAL_TOOLS = new Set([
        'manage_goals',
        'reflection_create_goal',
    ]);

    /** Per-tool runtime health state. */
    private toolHealth: Map<string, ToolHealthRecord> = new Map();

    // ─── Health tracking API ──────────────────────────────────────────────

    /**
     * Record a tool failure (timeout, error response, or disconnection).
     * Increments the rolling failure counter; promotes to degraded when the
     * threshold is exceeded.
     */
    recordToolFailure(toolName: string): void {
        const now = Date.now();
        const existing = this.toolHealth.get(toolName);

        if (!existing || now - existing.lastFailAt > ToolGatekeeper.HEALTH_WINDOW_MS) {
            // Outside rolling window — start a fresh counter.
            this.toolHealth.set(toolName, { failureCount: 1, degraded: false, lastFailAt: now });
            return;
        }

        const newCount = existing.failureCount + 1;
        this.toolHealth.set(toolName, {
            failureCount: newCount,
            degraded: newCount >= ToolGatekeeper.DEGRADED_THRESHOLD,
            lastFailAt: now,
        });
    }

    /**
     * Immediately mark a tool as degraded (e.g. on explicit disconnection or
     * a structured degraded-state response from an MCP server).
     */
    markToolDegraded(toolName: string): void {
        const existing = this.toolHealth.get(toolName) ?? {
            failureCount: 0,
            degraded: false,
            lastFailAt: 0,
        };
        this.toolHealth.set(toolName, { ...existing, degraded: true, lastFailAt: Date.now() });
    }

    /**
     * Clear health state for a tool (e.g. on successful reconnection or
     * explicit health-restore signal).
     */
    clearToolHealth(toolName: string): void {
        this.toolHealth.delete(toolName);
    }

    /**
     * Returns true if the tool is currently considered degraded.
     * Automatically clears stale records outside the rolling window.
     */
    isToolDegraded(toolName: string): boolean {
        const record = this.toolHealth.get(toolName);
        if (!record) return false;

        if (Date.now() - record.lastFailAt > ToolGatekeeper.HEALTH_WINDOW_MS) {
            this.toolHealth.delete(toolName);
            return false;
        }

        return record.degraded;
    }

    // ─── Gate evaluation ──────────────────────────────────────────────────

    /**
     * Evaluate all gate rules for the given turn context.
     *
     * Returns a ToolGateDecision that must be applied by the caller before
     * sending tools to the model.  The decision is deterministic and contains
     * a full audit trail in gatingReasons.
     */
    evaluate(context: ToolGateContext): ToolGateDecision {
        const {
            intentClass,
            responseMode,
            approvedMemoryCount,
            candidateToolNames,
            isBrowserTask,
            isRetry,
            priorBlockedTools,
        } = context;

        const blockedSet = new Set<string>();
        const gatingReasons: string[] = [];
        let directAnswerPreferred = false;
        let requiresToolUse = false;

        // ── Rule Group E: Retry discipline ─────────────────────────────────
        // On a retry pass, re-apply previously blocked tools so the expanded
        // model request never silently reinstates suppressed tools.
        if (isRetry && priorBlockedTools && priorBlockedTools.length > 0) {
            for (const t of priorBlockedTools) {
                blockedSet.add(t);
            }
            gatingReasons.push(
                `retry:preserving ${priorBlockedTools.length} blocked tool(s) from prior gate decision`
            );
        }

        // ── Rule Group A: Lore / autobiographical memory protection ────────
        const isMemoryGrounded =
            responseMode === 'memory_grounded_soft' ||
            responseMode === 'memory_grounded_strict';
        const isLoreWithMemory =
            intentClass === 'lore' && approvedMemoryCount > 0;

        if (isLoreWithMemory || isMemoryGrounded) {
            blockedSet.add('mem0_search');
            gatingReasons.push(
                `ruleA:mem0_search blocked — lore/memory-grounded turn ` +
                `(intent=${intentClass} responseMode=${responseMode ?? 'none'} ` +
                `approvedMemories=${approvedMemoryCount})`
            );

            // ── Rule Group C: Direct-answer preference ─────────────────────
            // Grounded memory is already available; the model should synthesize
            // from that context rather than launching exploratory tool calls.
            directAnswerPreferred = true;
            gatingReasons.push(
                'ruleC:directAnswerPreferred=true — grounded memory context is sufficient'
            );
        }

        // ── Rule Group B: Degraded tool suppression ────────────────────────
        // Suppress any tool that has accumulated failures above the threshold
        // within the rolling window.  Critical infrastructure tools are exempt.
        for (const toolName of candidateToolNames) {
            if (ToolGatekeeper.CRITICAL_TOOLS.has(toolName)) continue;
            if (!blockedSet.has(toolName) && this.isToolDegraded(toolName)) {
                blockedSet.add(toolName);
                gatingReasons.push(
                    `ruleB:${toolName} suppressed — degraded (failure count exceeded threshold in window)`
                );
            }
        }

        // ── Rule Group D: Intent-based requiresToolUse flag ────────────────
        // For coding and browser intents the model is expected to produce at
        // least one tool call; signal this to the caller.
        if (intentClass === 'coding' || isBrowserTask) {
            requiresToolUse = true;
        }

        const blockedTools = [...blockedSet];
        const allowedTools = candidateToolNames.filter(t => !blockedSet.has(t));

        return { allowedTools, blockedTools, gatingReasons, directAnswerPreferred, requiresToolUse };
    }
}

// ─── Module-level singleton ───────────────────────────────────────────────────

/**
 * Shared singleton used by AgentService.  Health state persists across turns
 * within the same process lifetime.
 */
export const toolGatekeeper = new ToolGatekeeper();
