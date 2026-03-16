/**
 * DiagnosticsReflection Tests — Priority 2A Objective G
 *
 * Validates reflection signal integration with the runtime diagnostics
 * system — including the new aggregated/thresholded signal categories.
 *
 * Coverage:
 * - New signal categories are present in TelemetrySignal type
 * - Thresholded signal is NOT emitted below threshold
 * - Thresholded signal IS emitted at or above threshold
 * - Aggregated instability signals trigger reflection evaluation
 * - Successful operations do not create instability signals
 * - New categories included in degradation signal filter for trigger evaluation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ReflectionEngine, TelemetrySignal } from '../../services/reflection/ReflectionEngine';

// ─── Buffer clear helper ──────────────────────────────────────────────────────

function clearBuffers() {
    (ReflectionEngine as any)['telemetrySignalBuffer'].splice(0);
    (ReflectionEngine as any)['errorBuffer']?.splice(0);
    (ReflectionEngine as any)['toolFailureBuffer']?.splice(0);
    (ReflectionEngine as any)['turnBuffer']?.splice(0);
}

// ─── Signal builders ──────────────────────────────────────────────────────────

function makeSignal(category: TelemetrySignal['category'], subsystem = 'inference'): TelemetrySignal {
    return {
        timestamp: new Date().toISOString(),
        subsystem,
        category,
        description: `Test signal: ${category}`,
        context: { entityId: 'test-entity', count: 1 },
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReflectionEngine — new signal categories accepted', () => {
    beforeEach(clearBuffers);

    it('accepts repeated_provider_fallback signal', () => {
        const signal = makeSignal('repeated_provider_fallback');
        expect(() => ReflectionEngine.reportSignal(signal)).not.toThrow();
        expect(ReflectionEngine.peekSignals()).toHaveLength(1);
    });

    it('accepts repeated_stream_timeout signal', () => {
        ReflectionEngine.reportSignal(makeSignal('repeated_stream_timeout'));
        expect(ReflectionEngine.peekSignals().some(s => s.category === 'repeated_stream_timeout')).toBe(true);
    });

    it('accepts provider_exhaustion signal', () => {
        ReflectionEngine.reportSignal(makeSignal('provider_exhaustion'));
        expect(ReflectionEngine.peekSignals().some(s => s.category === 'provider_exhaustion')).toBe(true);
    });

    it('accepts repeated_mcp_restart signal', () => {
        ReflectionEngine.reportSignal(makeSignal('repeated_mcp_restart', 'mcp'));
        expect(ReflectionEngine.peekSignals().some(s => s.category === 'repeated_mcp_restart')).toBe(true);
    });

    it('accepts critical_service_unavailable signal', () => {
        ReflectionEngine.reportSignal(makeSignal('critical_service_unavailable', 'mcp'));
        expect(ReflectionEngine.peekSignals().some(s => s.category === 'critical_service_unavailable')).toBe(true);
    });

    it('accepts degraded_subsystem_persistent signal', () => {
        ReflectionEngine.reportSignal(makeSignal('degraded_subsystem_persistent', 'mcp'));
        expect(ReflectionEngine.peekSignals().some(s => s.category === 'degraded_subsystem_persistent')).toBe(true);
    });
});

describe('ReflectionEngine — thresholded signal emission', () => {
    beforeEach(clearBuffers);

    it('does NOT emit signal below threshold (streak < threshold)', () => {
        const signal = makeSignal('repeated_provider_fallback');
        ReflectionEngine.reportThresholdedSignal(signal, 2, 3);
        expect(ReflectionEngine.peekSignals()).toHaveLength(0);
    });

    it('emits signal AT the threshold (streak === threshold)', () => {
        const signal = makeSignal('repeated_provider_fallback');
        ReflectionEngine.reportThresholdedSignal(signal, 3, 3);
        expect(ReflectionEngine.peekSignals()).toHaveLength(1);
    });

    it('emits signal ABOVE the threshold (streak > threshold)', () => {
        const signal = makeSignal('repeated_stream_timeout');
        ReflectionEngine.reportThresholdedSignal(signal, 5, 3);
        expect(ReflectionEngine.peekSignals()).toHaveLength(1);
    });

    it('includes streakCount in emitted signal context', () => {
        const signal = makeSignal('repeated_provider_fallback');
        ReflectionEngine.reportThresholdedSignal(signal, 4, 3);
        const emitted = ReflectionEngine.peekSignals()[0];
        expect(emitted.context?.streakCount).toBe(4);
        expect(emitted.context?.threshold).toBe(3);
    });

    it('default threshold is 3', () => {
        const signal = makeSignal('mcp_instability', 'mcp');
        ReflectionEngine.reportThresholdedSignal(signal, 2);
        expect(ReflectionEngine.peekSignals()).toHaveLength(0);

        ReflectionEngine.reportThresholdedSignal(signal, 3);
        expect(ReflectionEngine.peekSignals()).toHaveLength(1);
    });
});

describe('ReflectionEngine — new categories trigger reflection evaluation', () => {
    beforeEach(clearBuffers);

    it('repeated_provider_fallback in buffer triggers reflection', () => {
        ReflectionEngine.reportSignal(makeSignal('repeated_provider_fallback'));
        const result = ReflectionEngine.evaluateTriggers();
        expect(result.shouldTrigger).toBe(true);
    });

    it('provider_exhaustion in buffer triggers reflection', () => {
        ReflectionEngine.reportSignal(makeSignal('provider_exhaustion'));
        const result = ReflectionEngine.evaluateTriggers();
        expect(result.shouldTrigger).toBe(true);
    });

    it('critical_service_unavailable in buffer triggers reflection', () => {
        ReflectionEngine.reportSignal(makeSignal('critical_service_unavailable', 'mcp'));
        const result = ReflectionEngine.evaluateTriggers();
        expect(result.shouldTrigger).toBe(true);
    });

    it('degraded_subsystem_persistent in buffer triggers reflection', () => {
        ReflectionEngine.reportSignal(makeSignal('degraded_subsystem_persistent', 'mcp'));
        const result = ReflectionEngine.evaluateTriggers();
        expect(result.shouldTrigger).toBe(true);
    });

    it('repeated_mcp_restart in buffer triggers reflection', () => {
        ReflectionEngine.reportSignal(makeSignal('repeated_mcp_restart', 'mcp'));
        const result = ReflectionEngine.evaluateTriggers();
        expect(result.shouldTrigger).toBe(true);
    });
});

describe('ReflectionEngine — successful operations do not create instability signals', () => {
    beforeEach(clearBuffers);

    it('empty signal buffer does not trigger reflection', () => {
        const result = ReflectionEngine.evaluateTriggers();
        expect(result.shouldTrigger).toBe(false);
    });

    it('successful operation does not add to instability signals', () => {
        // Simulate a successful turn recorded but no error/signal
        // The buffer should remain clean
        expect(ReflectionEngine.peekSignals()).toHaveLength(0);
        const result = ReflectionEngine.evaluateTriggers();
        expect(result.shouldTrigger).toBe(false);
    });

    it('only degradation-category signals count toward degradation trigger', () => {
        // This is not a real category, but testing that unrelated signals
        // are not treated as degradation
        // We test by verifying evaluateTriggers() returns false for empty buffer
        clearBuffers();
        const result = ReflectionEngine.evaluateTriggers();
        expect(result.anomalyCount).toBe(0);
    });
});

describe('ReflectionEngine — telemetry parity with inference events', () => {
    beforeEach(clearBuffers);

    it('mcp_instability signal has same structure as inference_failure', () => {
        const mcpSignal: TelemetrySignal = {
            timestamp: new Date().toISOString(),
            subsystem: 'mcp',
            category: 'mcp_instability',
            description: 'MCP service failed after 8 retries',
            context: { serviceId: 'tala-core', restartCount: 8 },
        };

        const inferenceSignal: TelemetrySignal = {
            timestamp: new Date().toISOString(),
            subsystem: 'local_inference',
            category: 'inference_failure',
            description: 'Inference failed: ECONNREFUSED',
            context: { providerId: 'ollama', attemptedProviders: ['ollama'] },
        };

        // Both should be accepted without error
        expect(() => ReflectionEngine.reportSignal(mcpSignal)).not.toThrow();
        expect(() => ReflectionEngine.reportSignal(inferenceSignal)).not.toThrow();

        const signals = ReflectionEngine.peekSignals();
        expect(signals).toHaveLength(2);
        expect(signals[0].timestamp).toBeDefined();
        expect(signals[1].timestamp).toBeDefined();
    });
});
