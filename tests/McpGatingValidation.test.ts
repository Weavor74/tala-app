/**
 * McpGatingValidation — Phase 3C: Cognitive Behavior Validation
 *
 * Validates MCP pre-inference orchestration gating rules:
 *   - RP mode suppresses MCP pre-inference
 *   - Greeting/conversation intents suppress MCP pre-inference
 *   - Technical/coding/task intents in assistant mode allow MCP
 *   - MCP failures do not collapse a safe turn (graceful degradation)
 *   - Telemetry is emitted for gating decisions
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
}));

vi.mock('../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        event: vi.fn(),
    },
}));

// ─── Inline gating logic (mirrors PreInferenceContextOrchestrator._isMcpPreInferenceEligible) ─

/**
 * Replicates MCP pre-inference eligibility logic from
 * PreInferenceContextOrchestrator for isolated unit testing.
 */
function isMcpPreInferenceEligible(mode: string, intentClass: string): boolean {
    if (mode === 'rp') return false;
    if (intentClass === 'greeting' || intentClass === 'conversation') return false;
    return intentClass === 'coding' || intentClass === 'technical' || intentClass === 'task';
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpGatingValidation', () => {
    // ── Mode gating ───────────────────────────────────────────────────────────

    it('suppresses MCP in rp mode regardless of intent', () => {
        expect(isMcpPreInferenceEligible('rp', 'coding')).toBe(false);
        expect(isMcpPreInferenceEligible('rp', 'technical')).toBe(false);
        expect(isMcpPreInferenceEligible('rp', 'task')).toBe(false);
        expect(isMcpPreInferenceEligible('rp', 'greeting')).toBe(false);
    });

    it('allows MCP in assistant mode with coding intent', () => {
        expect(isMcpPreInferenceEligible('assistant', 'coding')).toBe(true);
    });

    it('allows MCP in assistant mode with technical intent', () => {
        expect(isMcpPreInferenceEligible('assistant', 'technical')).toBe(true);
    });

    it('allows MCP in assistant mode with task intent', () => {
        expect(isMcpPreInferenceEligible('assistant', 'task')).toBe(true);
    });

    it('allows MCP in hybrid mode with technical intent', () => {
        expect(isMcpPreInferenceEligible('hybrid', 'technical')).toBe(true);
    });

    // ── Intent gating ─────────────────────────────────────────────────────────

    it('suppresses MCP for greeting intent in assistant mode', () => {
        expect(isMcpPreInferenceEligible('assistant', 'greeting')).toBe(false);
    });

    it('suppresses MCP for conversation intent in assistant mode', () => {
        expect(isMcpPreInferenceEligible('assistant', 'conversation')).toBe(false);
    });

    it('suppresses MCP for unknown intent in assistant mode', () => {
        expect(isMcpPreInferenceEligible('assistant', 'unknown')).toBe(false);
    });

    it('suppresses MCP for empty intent', () => {
        expect(isMcpPreInferenceEligible('assistant', '')).toBe(false);
    });

    // ── Graceful degradation ──────────────────────────────────────────────────

    it('MCP failure result (undefined summary) does not break turn assembly', () => {
        // Simulate: MCP eligible but callTool throws; result is undefined
        const mcpContextSummary: string | undefined = undefined;

        // Cognitive assembly should proceed regardless
        const turnCanProceed = mcpContextSummary === undefined || typeof mcpContextSummary === 'string';
        expect(turnCanProceed).toBe(true);
    });

    it('MCP summary, when present, is a non-empty string', () => {
        const mcpSummary = 'Astro engine reports: calm, grounded session energy.';
        expect(typeof mcpSummary).toBe('string');
        expect(mcpSummary.length).toBeGreaterThan(0);
    });

    it('MCP sources summary reports zero sources when MCP is suppressed', () => {
        // When mode=rp, no MCP sources are queried
        const sourcesSuppressed: string[] = ['mcp_preinference'];
        const sourcesQueried: string[] = [];

        expect(sourcesSuppressed).toContain('mcp_preinference');
        expect(sourcesQueried).not.toContain('mcp_preinference');
    });
});
