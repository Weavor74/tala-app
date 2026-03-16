/**
 * InferenceDiagnostics Tests — Priority 2A Objective B
 *
 * Validates that InferenceDiagnosticsService correctly tracks and exposes
 * inference state from provider selection and stream execution.
 *
 * Coverage:
 * - Selected provider reflected in state
 * - Active stream status reflected in state
 * - Fallback occurrence reflected in state
 * - Last failure reason/time reflected in state
 * - Provider inventory summary reflected after updateFromInventory()
 * - Stream status transitions (idle → opening → streaming → completed/failed)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InferenceDiagnosticsService } from '../../services/InferenceDiagnosticsService';
import type { InferenceProviderDescriptor, InferenceProviderInventory, StreamInferenceResult } from '../../../shared/inferenceProviderTypes';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<InferenceProviderDescriptor> = {}): InferenceProviderDescriptor {
    return {
        providerId: 'ollama',
        displayName: 'Ollama',
        providerType: 'ollama',
        scope: 'local',
        transport: 'http_ollama',
        endpoint: 'http://127.0.0.1:11434',
        configured: true,
        detected: true,
        ready: true,
        health: 'healthy',
        status: 'ready',
        priority: 1,
        capabilities: { streaming: true, tools: false, vision: false, json_mode: false },
        models: ['llama3:latest'],
        preferredModel: 'llama3:latest',
        ...overrides,
    };
}

function makeInventory(providers: InferenceProviderDescriptor[] = [], selectedId?: string): InferenceProviderInventory {
    return {
        providers,
        selectedProviderId: selectedId,
        lastRefreshed: new Date().toISOString(),
        refreshing: false,
    };
}

function makeStreamResult(overrides: Partial<StreamInferenceResult> = {}): StreamInferenceResult {
    return {
        success: true,
        content: 'Hello',
        streamStatus: 'completed',
        fallbackApplied: false,
        attemptedProviders: ['ollama'],
        providerId: 'ollama',
        providerType: 'ollama',
        modelName: 'llama3',
        turnId: 'turn-1',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 500,
        isPartial: false,
        ...overrides,
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InferenceDiagnosticsService — provider selection', () => {
    let svc: InferenceDiagnosticsService;

    beforeEach(() => {
        svc = new InferenceDiagnosticsService();
    });

    it('starts with unknown/empty state', () => {
        const state = svc.getState();
        expect(state.selectedProviderId).toBeUndefined();
        expect(state.selectedProviderReady).toBe(false);
        expect(state.streamStatus).toBe('idle');
    });

    it('reflects selected provider after recordProviderSelected()', () => {
        const provider = makeProvider();
        svc.recordProviderSelected(provider);

        const state = svc.getState();
        expect(state.selectedProviderId).toBe('ollama');
        expect(state.selectedProviderName).toBe('Ollama');
        expect(state.selectedProviderType).toBe('ollama');
        expect(state.selectedProviderReady).toBe(true);
    });

    it('reflects not-ready provider', () => {
        const provider = makeProvider({ ready: false, status: 'not_running', health: 'unavailable' });
        svc.recordProviderSelected(provider);

        expect(svc.getState().selectedProviderReady).toBe(false);
    });

    it('updates lastUpdated timestamp on selection', () => {
        const before = new Date().toISOString();
        const provider = makeProvider();
        svc.recordProviderSelected(provider);
        expect(svc.getState().lastUpdated >= before).toBe(true);
    });
});

describe('InferenceDiagnosticsService — stream lifecycle', () => {
    let svc: InferenceDiagnosticsService;

    beforeEach(() => {
        svc = new InferenceDiagnosticsService();
    });

    it('sets streamStatus to opening on recordStreamStart()', () => {
        svc.recordStreamStart('ollama', []);
        expect(svc.getState().streamStatus).toBe('opening');
    });

    it('sets streamStatus to streaming on recordStreamActive()', () => {
        svc.recordStreamStart('ollama', []);
        svc.recordStreamActive();
        expect(svc.getState().streamStatus).toBe('streaming');
    });

    it('sets streamStatus to completed after successful stream result', () => {
        svc.recordStreamResult(makeStreamResult({ streamStatus: 'completed' }));
        expect(svc.getState().streamStatus).toBe('completed');
    });

    it('sets lastStreamStatus on result', () => {
        svc.recordStreamResult(makeStreamResult({ streamStatus: 'completed' }));
        expect(svc.getState().lastStreamStatus).toBe('completed');
    });

    it('sets streamStatus to failed after failed stream result', () => {
        svc.recordStreamResult(makeStreamResult({
            success: false,
            streamStatus: 'failed',
            errorMessage: 'connection refused',
        }));
        expect(svc.getState().streamStatus).toBe('failed');
    });

    it('sets streamStatus to timed_out after timeout result', () => {
        svc.recordStreamResult(makeStreamResult({
            success: false,
            streamStatus: 'timeout',
            errorMessage: 'stream open timeout',
        }));
        expect(svc.getState().streamStatus).toBe('timed_out');
    });

    it('sets streamStatus to aborted after abort result', () => {
        svc.recordStreamResult(makeStreamResult({
            success: false,
            streamStatus: 'aborted',
        }));
        expect(svc.getState().streamStatus).toBe('aborted');
    });
});

describe('InferenceDiagnosticsService — fallback tracking', () => {
    let svc: InferenceDiagnosticsService;

    beforeEach(() => {
        svc = new InferenceDiagnosticsService();
    });

    it('reflects fallback applied in stream result', () => {
        svc.recordStreamResult(makeStreamResult({
            fallbackApplied: true,
            attemptedProviders: ['vllm', 'ollama'],
            providerId: 'ollama',
        }));
        const state = svc.getState();
        expect(state.fallbackApplied).toBe(true);
        expect(state.attemptedProviders).toContain('vllm');
        expect(state.attemptedProviders).toContain('ollama');
    });

    it('reflects last used provider id', () => {
        svc.recordStreamResult(makeStreamResult({ providerId: 'ollama' }));
        expect(svc.getState().lastUsedProviderId).toBe('ollama');
    });

    it('does not set fallback=true for single-provider success', () => {
        svc.recordStreamResult(makeStreamResult({ fallbackApplied: false, attemptedProviders: ['ollama'] }));
        expect(svc.getState().fallbackApplied).toBe(false);
    });
});

describe('InferenceDiagnosticsService — failure tracking', () => {
    let svc: InferenceDiagnosticsService;

    beforeEach(() => {
        svc = new InferenceDiagnosticsService();
    });

    it('records last failure reason on failed stream', () => {
        svc.recordStreamResult(makeStreamResult({
            success: false,
            streamStatus: 'failed',
            errorMessage: 'ECONNREFUSED',
        }));
        expect(svc.getState().lastFailureReason).toBe('ECONNREFUSED');
    });

    it('records last failure time on failed stream', () => {
        const before = new Date().toISOString();
        svc.recordStreamResult(makeStreamResult({
            success: false,
            streamStatus: 'failed',
            errorMessage: 'error',
        }));
        const state = svc.getState();
        expect(state.lastFailureTime).toBeDefined();
        expect(state.lastFailureTime! >= before).toBe(true);
    });

    it('records last timeout time for timed-out stream', () => {
        const before = new Date().toISOString();
        svc.recordStreamResult(makeStreamResult({
            success: false,
            streamStatus: 'timeout',
            errorMessage: 'timeout',
        }));
        const state = svc.getState();
        expect(state.lastTimeoutTime).toBeDefined();
        expect(state.lastTimeoutTime! >= before).toBe(true);
    });

    it('does not overwrite lastFailureReason on successful stream', () => {
        // First, record a failure
        svc.recordStreamResult(makeStreamResult({
            success: false,
            streamStatus: 'failed',
            errorMessage: 'first error',
        }));
        // Then, record a success
        svc.recordStreamResult(makeStreamResult({ success: true, streamStatus: 'completed' }));

        // The failure reason should be preserved (not cleared on success)
        expect(svc.getState().lastFailureReason).toBe('first error');
    });
});

describe('InferenceDiagnosticsService — inventory summary', () => {
    let svc: InferenceDiagnosticsService;

    beforeEach(() => {
        svc = new InferenceDiagnosticsService();
    });

    it('updates provider inventory summary', () => {
        const inventory = makeInventory(
            [
                makeProvider({ providerId: 'ollama', ready: true }),
                makeProvider({ providerId: 'vllm', ready: false, status: 'not_running', health: 'unavailable' }),
            ],
            'ollama'
        );

        svc.updateFromInventory(inventory);
        const state = svc.getState();
        expect(state.providerInventorySummary.total).toBe(2);
        expect(state.providerInventorySummary.ready).toBe(1);
        expect(state.providerInventorySummary.unavailable).toBe(1);
    });

    it('updates selected provider from inventory when selectedProviderId is set', () => {
        const provider = makeProvider({ providerId: 'ollama', displayName: 'Ollama Local' });
        const inventory = makeInventory([provider], 'ollama');
        svc.updateFromInventory(inventory);

        expect(svc.getState().selectedProviderId).toBe('ollama');
        expect(svc.getState().selectedProviderName).toBe('Ollama Local');
    });

    it('returns zero counts for empty inventory', () => {
        svc.updateFromInventory(makeInventory([]));
        const summary = svc.getState().providerInventorySummary;
        expect(summary.total).toBe(0);
        expect(summary.ready).toBe(0);
    });
});
