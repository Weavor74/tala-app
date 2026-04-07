/**
 * ContextAssemblerService — Telemetry-Emitting Context Assembly Wrapper
 *
 * **Role:**
 *   ContextAssemblerService is the runtime-facing entry point for context assembly.
 *   It wraps the pure, static ContextAssembler and adds:
 *     - TelemetryBus event emission (context.assembly_requested, context.assembled,
 *       context.truncated, context.section_excluded)
 *     - Observability hooks for monitoring context composition in production
 *
 * **Purity contract:**
 *   ContextAssembler.assembleContext() remains side-effect-free and pure.
 *   All IO (telemetry, logging) happens in this wrapper, not inside the assembler.
 *
 * **Telemetry events emitted:**
 *   context.assembly_requested — before assembly begins; includes executionId, turnId, mode
 *   context.assembled          — after successful assembly; includes assemblyId, counts, tokens, durationMs
 *   context.truncated          — if any section was truncated by budget enforcement
 *   context.section_excluded   — once per excluded section with exclusion reason (bounded by section count)
 *
 * **Usage:**
 *   const service = new ContextAssemblerService();
 *   const ctx = service.assemble(inputs);
 *   // ctx.metadata.assemblyId can be used to correlate with emitted events
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import { TelemetryBus } from '../telemetry/TelemetryBus';
import { ContextAssembler } from './ContextAssembler';
import type { AssembledContext, ContextAssemblerInputs } from '../../../shared/context/assembledContextTypes';

/**
 * Runtime wrapper around ContextAssembler that emits TelemetryBus events
 * for each assembly invocation.
 *
 * Instantiate once (or per-subsystem). The service holds no mutable state between calls.
 */
export class ContextAssemblerService {
    private readonly _bus: TelemetryBus;

    /**
     * @param bus - Optional TelemetryBus instance. Defaults to the process singleton.
     *              Pass an explicit instance in tests to capture emitted events.
     */
    constructor(bus?: TelemetryBus) {
        this._bus = bus ?? TelemetryBus.getInstance();
    }

    /**
     * Assembles a structured AssembledContext, emitting telemetry events for observability.
     *
     * Events emitted:
     *   1. context.assembly_requested — immediately before delegation to ContextAssembler
     *   2. context.assembled          — after successful assembly
     *   3. context.truncated          — if truncatedSectionCount > 0
     *   4. context.section_excluded   — once per excluded section (included=false)
     *
     * @param inputs - All pre-gathered context inputs for this turn.
     * @returns The AssembledContext produced by ContextAssembler.assembleContext().
     */
    public assemble(inputs: ContextAssemblerInputs): AssembledContext {
        const executionId = inputs.executionId ?? '';
        const subsystem = 'agent' as const;

        // ── 1. Emit: context.assembly_requested ───────────────────────────
        this._bus.emit({
            executionId,
            subsystem,
            event: 'context.assembly_requested',
            phase: 'context_assembly',
            payload: {
                turnId: inputs.turnId,
                mode: inputs.mode,
                intentClass: inputs.intentClass,
                isGreeting: inputs.isGreeting,
                hasPolicyFilter: !!inputs.assemblyPolicy,
                totalBudgetTokensOverride: inputs.totalBudgetTokensOverride ?? null,
            },
        });

        // ── 2. Delegate to the pure assembler ─────────────────────────────
        const ctx: AssembledContext = ContextAssembler.assembleContext(inputs);
        const { metadata } = ctx;

        // ── 3. Emit: context.assembled ────────────────────────────────────
        this._bus.emit({
            executionId,
            correlationId: metadata.assemblyId,
            subsystem,
            event: 'context.assembled',
            phase: 'context_assembly',
            payload: {
                assemblyId: metadata.assemblyId,
                turnId: metadata.turnId,
                mode: metadata.mode,
                intentClass: metadata.intentClass,
                sectionCount: metadata.sectionCount,
                includedSectionCount: metadata.includedSectionCount,
                totalEstimatedTokens: metadata.totalEstimatedTokens,
                totalBudgetTokens: metadata.totalBudgetTokens,
                budgetUtilization: metadata.budgetUtilization,
                totalEvidenceCount: metadata.totalEvidenceCount,
                truncatedSectionCount: metadata.truncatedSectionCount,
                droppedSectionCount: metadata.droppedSectionCount,
                policyExcludedCount: metadata.policyExcludedCount,
                wasCompacted: metadata.wasCompacted,
                assemblyDurationMs: metadata.assemblyDurationMs,
                sourceCategories: metadata.sourceCategories,
            },
        });

        // ── 4. Emit: context.truncated (if any section was truncated) ─────
        if (metadata.truncatedSectionCount > 0) {
            const truncatedNames = metadata.sectionBudgets
                .filter(b => b.wasTruncated)
                .map(b => b.name);
            this._bus.emit({
                executionId,
                correlationId: metadata.assemblyId,
                subsystem,
                event: 'context.truncated',
                phase: 'context_assembly',
                payload: {
                    assemblyId: metadata.assemblyId,
                    turnId: metadata.turnId,
                    truncatedSectionCount: metadata.truncatedSectionCount,
                    truncatedSections: truncatedNames,
                    totalBudgetTokens: metadata.totalBudgetTokens,
                    totalEstimatedTokens: metadata.totalEstimatedTokens,
                },
            });
        }

        // ── 5. Emit: context.section_excluded (once per excluded section) ─
        for (const section of ctx.sections) {
            if (!section.included) {
                this._bus.emit({
                    executionId,
                    correlationId: metadata.assemblyId,
                    subsystem,
                    event: 'context.section_excluded',
                    phase: 'context_assembly',
                    payload: {
                        assemblyId: metadata.assemblyId,
                        turnId: metadata.turnId,
                        sectionName: section.name,
                        exclusionReason: section.exclusionReason ?? 'no_content',
                        suppressionReason: section.suppressionReason,
                    },
                });
            }
        }

        return ctx;
    }
}
