import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolExecutionCoordinator } from '../electron/services/tools/ToolExecutionCoordinator';

vi.mock('../electron/services/policy/PolicyGate', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../electron/services/policy/PolicyGate')>();
    return {
        ...actual,
        policyGate: { assertSideEffect: vi.fn() },
    };
});

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({ emit: vi.fn() }),
    },
}));

vi.mock('../electron/services/policy/PolicyEnforcement', () => ({
    enforceSideEffectWithGuardrails: vi.fn().mockResolvedValue({
        allowed: true,
        reason: 'test-allow',
    }),
}));

function makeCoordinator() {
    const tools = {
        executeTool: vi.fn().mockResolvedValue('ok'),
    } as any;
    return { coordinator: new ToolExecutionCoordinator(tools), tools };
}

const fullEnvelope = {
    turnId: 'turn-1',
    mode: 'goal_execution' as const,
    authorityLevel: 'full_authority' as const,
    workflowAuthority: true,
    canCreateDurableState: true,
    canReplan: true,
};

describe('Tool authority envelope', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('blocks kernel-managed tool execution when envelope is missing', async () => {
        const { coordinator } = makeCoordinator();
        await expect(
            coordinator.executeTool('fs_read_text', {}, undefined, {
                executionType: 'chat_turn',
            }),
        ).rejects.toThrow('TOOL_AUTHORITY_ENVELOPE_REQUIRED');
    });

    it('blocks non-readonly tool under lightweight authority', async () => {
        const { coordinator } = makeCoordinator();
        await expect(
            coordinator.executeTool('fs_write_text', {}, undefined, {
                executionType: 'chat_turn',
                authorityEnvelope: {
                    ...fullEnvelope,
                    mode: 'conversational',
                    authorityLevel: 'lightweight',
                    canCreateDurableState: false,
                    canReplan: false,
                },
            }),
        ).rejects.toThrow('TOOL_AUTHORITY_DENIED:lightweight:fs_write_text');
    });

    it('allows tool execution under full authority envelope', async () => {
        const { coordinator, tools } = makeCoordinator();
        await coordinator.executeTool('fs_write_text', { path: '/tmp/a.txt' }, undefined, {
            executionType: 'chat_turn',
            authorityEnvelope: fullEnvelope,
        });
        expect(tools.executeTool).toHaveBeenCalledOnce();
    });
});
