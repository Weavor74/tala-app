import { describe, it, expect, vi } from 'vitest';
import { ReflectionScheduler } from '../../services/reflection/ReflectionScheduler';

describe('ReflectionScheduler trace logging', () => {
    it('logs idle reason when no runnable items exist', async () => {
        const queue: any = {
            listActive: vi.fn().mockResolvedValue([]),
            getNextRunnable: vi.fn().mockResolvedValue(null),
            listQueued: vi.fn().mockResolvedValue([])
        };
        const goals: any = { listGoals: vi.fn().mockResolvedValue([]) };
        const journal: any = { writeEntry: vi.fn() };
        const execute = vi.fn();
        const scheduler = new ReflectionScheduler(queue, goals, journal, execute);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const result = await scheduler.tickNow();

        expect(result.success).toBe(false);
        expect(result.message).toContain('No runnable items');
        const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
        expect(output).toContain('[ReflectionScheduler] tick');
        expect(output).toContain('reason=\"no_runnable_items\"');
        logSpy.mockRestore();
    });
});

