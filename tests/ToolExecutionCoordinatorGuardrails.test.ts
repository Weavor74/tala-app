import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolExecutionCoordinator } from '../electron/services/tools/ToolExecutionCoordinator';

const enforceMock = vi.fn();

vi.mock('../electron/services/policy/PolicyEnforcement', () => ({
    enforceSideEffectWithGuardrails: (...args: unknown[]) => enforceMock(...args),
}));

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({ emit: vi.fn() }),
    },
}));

describe('ToolExecutionCoordinator guardrail integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        enforceMock.mockResolvedValue({ allowed: true });
    });

    it('retries safe read-only tool calls on transient errors', async () => {
        const executeTool = vi.fn()
            .mockRejectedValueOnce(new Error('ETIMEDOUT'))
            .mockResolvedValueOnce('ok');
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        const result = await coordinator.executeTool('fs_read_text', { path: '/tmp/a.txt' });

        expect(result.success).toBe(true);
        expect(result.data).toBe('ok');
        expect(executeTool).toHaveBeenCalledTimes(2);
    });

    it('does not retry mutating tools by default', async () => {
        const executeTool = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        await expect(
            coordinator.executeTool('fs_write_text', { path: '/tmp/a.txt', content: 'x' }),
        ).rejects.toThrow('ETIMEDOUT');

        expect(executeTool).toHaveBeenCalledTimes(1);
    });
});

