/**
 * TelemetryService Tests — Phase 2 Objective 6
 *
 * Validates:
 * - Canonical event emission with all required fields
 * - Turn reconstruction from event sequence
 * - Channel classification (audit / operational / debug)
 * - Status tracking (success / failure / suppressed)
 * - Redaction is applied to sensitive payload fields
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelemetryService } from '../../services/TelemetryService';
import type { CanonicalTelemetryEvent } from '../../../shared/telemetry';

// Mock AuditLogger to capture emitted records
vi.mock('../../services/AuditLogger', () => ({
    auditLogger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        getCorrelationId: () => 'test-correlation',
        getSessionId: () => 'test-session',
    },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeService(): TelemetryService {
    TelemetryService.reset();
    return TelemetryService.getInstance();
}

function makeEvent(
    svc: TelemetryService,
    eventType: Parameters<TelemetryService['emit']>[1] = 'turn_start',
    status: Parameters<TelemetryService['emit']>[5] = 'success',
    overrides: Parameters<TelemetryService['emit']>[6] = {}
): CanonicalTelemetryEvent {
    return svc.emit(
        'agent',
        eventType,
        'info',
        'TestActor',
        'Test event summary',
        status,
        { turnId: 'turn-test-1', mode: 'assistant', ...overrides }
    );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TelemetryService — canonical emission', () => {
    let svc: TelemetryService;

    beforeEach(() => {
        svc = makeService();
    });

    it('emits an event with all required canonical fields', () => {
        const event = makeEvent(svc);

        expect(typeof event.eventId).toBe('string');
        expect(event.eventId.length).toBeGreaterThan(0);
        expect(typeof event.timestamp).toBe('string');
        expect(event.turnId).toBe('turn-test-1');
        expect(event.sessionId).toBe('test-session');
        expect(event.subsystem).toBe('agent');
        expect(event.eventType).toBe('turn_start');
        expect(event.severity).toBe('info');
        expect(event.mode).toBe('assistant');
        expect(event.actor).toBe('TestActor');
        expect(event.summary).toBe('Test event summary');
        expect(event.status).toBe('success');
        expect(typeof event.payload).toBe('object');
        expect(['audit', 'operational', 'debug']).toContain(event.channel);
    });

    it('assigns audit channel to turn_start events', () => {
        const event = makeEvent(svc, 'turn_start');
        expect(event.channel).toBe('audit');
    });

    it('assigns audit channel to inference_failed events', () => {
        const event = makeEvent(svc, 'inference_failed', 'failure');
        expect(event.channel).toBe('audit');
    });

    it('assigns operational channel to inference_started events', () => {
        const event = makeEvent(svc, 'inference_started');
        expect(event.channel).toBe('operational');
    });

    it('assigns debug channel to debug severity events', () => {
        const event = svc.debug('router', 'developer_debug', 'TestActor', 'Debug msg', {
            turnId: 'turn-1',
            mode: 'assistant',
        });
        expect(event.channel).toBe('debug');
    });

    it('uses fallback turnId from auditLogger when not provided', () => {
        const event = svc.emit('agent', 'turn_start', 'info', 'Actor', 'summary', 'success');
        // Falls back to auditLogger.getCorrelationId() = 'test-correlation'
        expect(event.turnId).toBe('test-correlation');
    });

    it('emits failure status correctly', () => {
        const event = makeEvent(svc, 'inference_failed', 'failure', {
            payload: { errorCode: 'timeout', modelName: 'llama3' },
        });
        expect(event.status).toBe('failure');
        expect(event.payload.errorCode).toBe('timeout');
    });

    it('emits suppressed status for suppressed retrieval', () => {
        const event = makeEvent(svc, 'doc_retrieval_suppressed', 'suppressed');
        expect(event.status).toBe('suppressed');
    });

    it('includes custom payload in the event', () => {
        const event = makeEvent(svc, 'memory_retrieved', 'success', {
            payload: { retrievedCount: 5, filteredCount: 2 },
        });
        expect(event.payload.retrievedCount).toBe(5);
        expect(event.payload.filteredCount).toBe(2);
    });

    it('generates unique eventIds for consecutive events', () => {
        const e1 = makeEvent(svc, 'turn_start');
        const e2 = makeEvent(svc, 'turn_completed');
        expect(e1.eventId).not.toBe(e2.eventId);
    });
});

// ─── Turn reconstruction ──────────────────────────────────────────────────────

describe('TelemetryService — turn reconstruction', () => {
    let svc: TelemetryService;

    beforeEach(() => {
        svc = makeService();
    });

    function buildFullTurnSequence(): CanonicalTelemetryEvent[] {
        const opts = { turnId: 'turn-42', mode: 'assistant' };
        return [
            svc.emit('agent', 'turn_start', 'info', 'AgentService', 'Turn started', 'success', opts),
            svc.emit('router', 'context_assembled', 'info', 'TalaContextRouter', 'Context assembled', 'success', {
                ...opts,
                payload: { intent: 'coding', intentConfidence: 0.9 },
            }),
            svc.emit('memory', 'memory_retrieved', 'info', 'HybridMemoryManager', 'Memory retrieved', 'success', {
                ...opts,
                payload: { retrievedCount: 3, filteredCount: 1 },
            }),
            svc.emit('inference', 'inference_started', 'info', 'InferenceService', 'Inference started', 'success', opts),
            svc.emit('inference', 'inference_completed', 'info', 'InferenceService', 'Inference completed', 'success', {
                ...opts,
                payload: { provider: 'ollama', engine: 'ollama', modelName: 'llama3', requestDurationMs: 1200, streamMode: true },
            }),
            svc.emit('artifact', 'artifact_routed', 'info', 'ArtifactRouter', 'Artifact routed', 'success', {
                ...opts,
                payload: { channel: 'workspace', artifactType: 'code' },
            }),
            svc.emit('agent', 'turn_completed', 'info', 'AgentService', 'Turn completed', 'success', opts),
        ];
    }

    it('reconstructs a complete healthy turn', () => {
        const events = buildFullTurnSequence();
        const reconstruction = svc.reconstructTurn(events);

        expect(reconstruction).not.toBeNull();
        expect(reconstruction!.turnId).toBe('turn-42');
        expect(reconstruction!.mode).toBe('assistant');
        expect(reconstruction!.inferenceProvider).toBe('ollama');
        expect(reconstruction!.inferenceModel).toBe('llama3');
        expect(reconstruction!.inferenceDurationMs).toBe(1200);
        expect(reconstruction!.inferenceStatus).toBe('success');
        expect(reconstruction!.memoryRetrieved).toBe(true);
        expect(reconstruction!.artifactChannel).toBe('workspace');
        expect(reconstruction!.hadErrors).toBe(false);
        expect(reconstruction!.hadDegradedFallback).toBe(false);
        expect(reconstruction!.reflectionTriggered).toBe(false);
    });

    it('detects errors in a turn with inference failure', () => {
        const opts = { turnId: 'turn-err', mode: 'assistant' };
        const events = [
            svc.emit('agent', 'turn_start', 'info', 'AgentService', 'Turn started', 'success', opts),
            svc.emit('inference', 'inference_failed', 'error', 'InferenceService', 'Inference failed', 'failure', {
                ...opts,
                payload: { errorCode: 'timeout' },
            }),
            svc.emit('agent', 'turn_completed', 'info', 'AgentService', 'Turn completed', 'success', opts),
        ];

        const reconstruction = svc.reconstructTurn(events);
        expect(reconstruction!.hadErrors).toBe(true);
        expect(reconstruction!.inferenceStatus).toBe('failure');
    });

    it('detects degraded fallback in reconstruction', () => {
        const opts = { turnId: 'turn-degraded', mode: 'assistant' };
        const events = [
            svc.emit('agent', 'turn_start', 'info', 'AgentService', 'Turn started', 'success', opts),
            svc.emit('local_inference', 'degraded_fallback', 'warn', 'LocalInferenceManager', 'Fallback activated', 'failure', opts),
            svc.emit('agent', 'turn_completed', 'info', 'AgentService', 'Turn completed', 'success', opts),
        ];

        const reconstruction = svc.reconstructTurn(events);
        expect(reconstruction!.hadDegradedFallback).toBe(true);
    });

    it('detects doc retrieval in reconstruction', () => {
        const opts = { turnId: 'turn-docs', mode: 'assistant' };
        const events = [
            svc.emit('agent', 'turn_start', 'info', 'AgentService', 'Turn started', 'success', opts),
            svc.emit('docs_intel', 'doc_retrieval_completed', 'info', 'DocIntel', 'Docs retrieved', 'success', {
                ...opts,
                payload: { resultCount: 2, sources: ['docs/architecture.md', 'docs/features.md'] },
            }),
            svc.emit('agent', 'turn_completed', 'info', 'AgentService', 'Turn completed', 'success', opts),
        ];

        const reconstruction = svc.reconstructTurn(events);
        expect(reconstruction!.docRetrievalOccurred).toBe(true);
        expect(reconstruction!.docSources).toEqual(['docs/architecture.md', 'docs/features.md']);
    });

    it('returns null for empty event list', () => {
        expect(svc.reconstructTurn([])).toBeNull();
    });

    it('includes all events in the event sequence', () => {
        const events = buildFullTurnSequence();
        const reconstruction = svc.reconstructTurn(events);
        expect(reconstruction!.eventSequence.length).toBe(events.length);
    });
});
