import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReflectionAppService } from '../../services/reflection/ReflectionAppService';
import { ReflectionService } from '../../services/reflection/ReflectionService';
import { ipcMain } from 'electron';

// Mock electron ipcMain
vi.mock('electron', () => ({
    ipcMain: {
        handle: vi.fn(),
        on: vi.fn()
    }
}));

describe('ReflectionAppService (Facade)', () => {
    let mockReflectionService: any;
    let mockGoals: any;
    let mockQueue: any;
    let mockScheduler: any;
    let facade: ReflectionAppService;

    beforeEach(() => {
        vi.clearAllMocks();

        mockGoals = {
            createGoal: vi.fn().mockResolvedValue({ goalId: 'g-123' }),
            listGoals: vi.fn().mockResolvedValue([{ goalId: 'g-123' }])
        };

        mockQueue = {
            enqueue: vi.fn().mockResolvedValue(true)
        };

        mockScheduler = {
            tickNow: vi.fn().mockResolvedValue({ success: true, message: 'Tick' })
        };

        mockReflectionService = {
            getDashboardState: vi.fn().mockResolvedValue({ totalReflections: 1 }),
            getGoalsService: () => mockGoals,
            getQueueService: () => mockQueue,
            getScheduler: () => mockScheduler,
            logTelemetry: vi.fn()
        };

        facade = new ReflectionAppService(mockReflectionService as unknown as ReflectionService);
    });

    it('registers all IPC routes on instantiation', () => {
        expect(ipcMain.handle).toHaveBeenCalledWith('reflection:getDashboardState', expect.any(Function));
        expect(ipcMain.handle).toHaveBeenCalledWith('reflection:trigger', expect.any(Function));
        expect(ipcMain.handle).toHaveBeenCalledWith('reflection:createGoal', expect.any(Function));
    });

    it('routes getDashboardState correctly and logs telemetry', async () => {
        const handler = (ipcMain.handle as any).mock.calls.find((c: any) => c[0] === 'reflection:getDashboardState')[1];

        await handler({} as any, 'hybrid');

        expect(mockReflectionService.getDashboardState).toHaveBeenCalledWith('hybrid');
        expect(mockReflectionService.logTelemetry).toHaveBeenCalledWith(
            'reflection.ipc.getDashboardState.success', 'debug', 'ReflectionAppService', expect.stringContaining('Successfully executed getDashboardState in')
        );
    });

    it('routes createGoal and enqueues immediately', async () => {
        const handler = (ipcMain.handle as any).mock.calls.find((c: any) => c[0] === 'reflection:createGoal')[1];

        const goalDef = { title: 'Test Goal', description: 'desc', priority: 'medium' };
        const result = await handler({} as any, goalDef);

        expect(mockGoals.createGoal).toHaveBeenCalledWith(goalDef);
        expect(mockQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
            type: 'goal',
            goalId: 'g-123'
        }));
        expect(mockScheduler.tickNow).toHaveBeenCalled();
        expect(result.goalId).toBe('g-123');

        expect(mockReflectionService.logTelemetry).toHaveBeenCalledWith(
            'reflection.ipc.createGoal.success', 'debug', 'ReflectionAppService', expect.stringContaining('Successfully executed createGoal in')
        );
    });

    it('handles failures gracefully and logs error telemetry', async () => {
        mockReflectionService.getDashboardState.mockRejectedValue(new Error('Backend error'));

        const handler = (ipcMain.handle as any).mock.calls.find((c: any) => c[0] === 'reflection:getDashboardState')[1];

        await expect(handler({} as any, undefined)).rejects.toThrow('Backend error');

        expect(mockReflectionService.logTelemetry).toHaveBeenCalledWith(
            'reflection.ipc.getDashboardState.error', 'error', 'ReflectionAppService', 'Failed during getDashboardState: Backend error'
        );
    });
});
