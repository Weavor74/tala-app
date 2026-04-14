import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PolicyDeniedError } from '../../services/policy/PolicyGate';
import { ToolExecutionCoordinator } from '../../services/tools/ToolExecutionCoordinator';
import { MemoryAuthorityService } from '../../services/memory/MemoryAuthorityService';
import { InferenceService } from '../../services/InferenceService';
import { WorkflowEngine } from '../../services/WorkflowEngine';
import { OrchestratorService } from '../../services/OrchestratorService';
import type { IBrain } from '../../brains/IBrain';
import type { StreamInferenceRequest, InferenceProviderDescriptor } from '../../../shared/inferenceProviderTypes';

const enforceMock = vi.fn();

vi.mock('../../services/policy/PolicyEnforcement', () => ({
    enforceSideEffectWithGuardrails: (...args: unknown[]) => enforceMock(...args),
}));

vi.mock('electron', () => ({
    app: {
        getPath: () => '/tmp/tala-test',
        getAppPath: () => '/tmp/tala-test',
        isPackaged: false,
    },
    WebContents: {},
}));

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        emit: vi.fn(),
        operational: vi.fn(),
        audit: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('../../services/reflection/ReflectionEngine', () => ({
    ReflectionEngine: { reportSignal: vi.fn() },
}));

vi.mock('../../services/LocalEngineService', () => ({
    LocalEngineService: vi.fn().mockImplementation(function (this: any) {
        this.start = vi.fn();
        this.stop = vi.fn();
        this.extinguish = vi.fn();
        this.getStatus = vi.fn(() => 'stopped');
        this.isRunning = vi.fn(() => false);
    }),
}));

vi.mock('../../services/LocalInferenceOrchestrator', () => ({
    LocalInferenceOrchestrator: vi.fn().mockImplementation(function (this: any) {
        this.start = vi.fn();
        this.stop = vi.fn();
        this.isReady = vi.fn(() => false);
        this.getState = vi.fn(() => ({ status: 'disabled' }));
        this.shutdown = vi.fn();
    }),
}));

function denied(reason = 'blocked by test policy'): PolicyDeniedError {
    return new PolicyDeniedError({ allowed: false, reason, code: 'TEST_DENY' });
}

function provider(): InferenceProviderDescriptor {
    return {
        providerId: 'ollama-test',
        displayName: 'ollama-test',
        providerType: 'ollama',
        scope: 'local',
        transport: 'http_ollama',
        endpoint: 'http://127.0.0.1:11434',
        configured: true,
        detected: true,
        ready: true,
        health: 'healthy',
        status: 'ready',
        priority: 10,
        capabilities: { streaming: true, toolCalls: false, vision: false, embeddings: false },
        models: ['llama3:latest'],
        preferredModel: 'llama3',
    };
}

function streamRequest(overrides: Partial<StreamInferenceRequest> = {}): StreamInferenceRequest {
    return {
        provider: provider(),
        turnId: 'turn-1',
        sessionId: 'session-1',
        fallbackAllowed: false,
        ...overrides,
    };
}

describe('Universal guardrail enforcement', () => {
    beforeEach(() => {
        enforceMock.mockReset();
    });

    it('blocks tool execution when policy denies and does not run the tool', async () => {
        enforceMock.mockRejectedValueOnce(denied('tool blocked'));
        const executeTool = vi.fn();
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        await expect(coordinator.executeTool('fs_write_text', { path: 'x', content: 'y' }))
            .rejects.toBeInstanceOf(PolicyDeniedError);
        expect(executeTool).not.toHaveBeenCalled();
    });

    it('blocks canonical memory create when policy denies', async () => {
        enforceMock.mockRejectedValueOnce(denied('memory blocked'));
        const pool = { query: vi.fn() } as any;
        const service = new MemoryAuthorityService(pool);

        const result = await service.tryCreateCanonicalMemory({
            memory_type: 'observation',
            subject_type: 'user',
            subject_id: 'u-1',
            content_text: 'test memory',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('memory blocked');
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('filters inference output when policy denies post-generation output check', async () => {
        enforceMock.mockRejectedValueOnce(denied('inference output blocked'));
        const service = new InferenceService();
        const brain: IBrain = {
            id: 'test-brain',
            ping: async () => true,
            configure: () => {},
            generateResponse: async () => ({ content: '' }),
            streamResponse: async (_m, _s, onChunk) => {
                onChunk('secret');
                return { content: 'secret' };
            },
        };

        const result = await service.executeStream(brain, [], '', () => {}, streamRequest());

        expect(result.success).toBe(false);
        expect(result.errorCode).toBe('policy_violation');
        expect(result.content).toBe('');
    });

    it('halts workflow step when post-step policy check denies', async () => {
        enforceMock
            .mockResolvedValueOnce({ allowed: true, reason: 'ok' })
            .mockRejectedValueOnce(denied('post-step blocked'));

        const workflow = new WorkflowEngine({} as any, {} as any);
        const run = workflow.executeWorkflow(
            {
                nodes: [{ id: 'n1', type: 'start', data: {} }],
                edges: [],
            },
            undefined,
            { hello: 'world' },
            'assistant',
        );

        await expect(run).rejects.toBeInstanceOf(PolicyDeniedError);
    });

    it('does not allow bypass when coordinator context omits enforcePolicy', async () => {
        enforceMock.mockRejectedValueOnce(denied('no bypass'));
        const executeTool = vi.fn();
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        await expect(
            coordinator.executeTool('shell_run', { command: 'echo test' }, undefined, {
                executionType: 'direct_invocation',
                executionOrigin: 'api',
            }),
        ).rejects.toBeInstanceOf(PolicyDeniedError);
        expect(executeTool).not.toHaveBeenCalled();
    });

    it('routes orchestrator tool calls through coordinator enforcement', async () => {
        enforceMock.mockRejectedValueOnce(denied('orchestrator blocked'));
        const tools = {
            getToolDefinitions: () => [],
            executeTool: vi.fn(),
        } as any;
        const brain: IBrain = {
            id: 'orch-brain',
            ping: async () => true,
            configure: () => {},
            streamResponse: async () => ({ content: '' }),
            generateResponse: async (_messages) => {
                if ((_messages?.length ?? 0) <= 1) {
                    return {
                        content: '',
                        toolCalls: [{ id: '1', function: { name: 'fs_write_text', arguments: {} } }],
                    } as any;
                }
                return { content: 'done' } as any;
            },
        };

        const orchestrator = new OrchestratorService(brain, tools);
        const output = await orchestrator.runHeadlessLoop('test', 'system', 2);

        expect(output).toBe('done');
        expect(tools.executeTool).not.toHaveBeenCalled();
    });
});

