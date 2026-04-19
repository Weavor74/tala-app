import { describe, expect, it, vi } from 'vitest';
import { SelfInspectionExecutionService } from '../electron/services/agent/SelfInspectionExecutionService';

describe('SelfInspectionExecutionService', () => {
    it('uses fs_read_text first for concrete README request', async () => {
        const executeTool = vi.fn().mockResolvedValue({ data: '# Tala README' });
        const service = new SelfInspectionExecutionService();

        const result = await service.executeSelfInspectionTurn({
            text: 'You should read your local README.md',
            allowWritesThisTurn: false,
            toolExecutionCoordinator: { executeTool } as any,
        });

        expect(result.executed).toBe(true);
        expect(result.operation).toBe('read');
        expect(executeTool).toHaveBeenCalledWith(
            'fs_read_text',
            { path: 'README.md' },
            expect.any(Set),
            expect.any(Object),
        );
        expect(result.summary).toContain('Read README.md');
    });

    it('falls back to recursive search when direct read misses', async () => {
        const executeTool = vi.fn(async (toolId: string, args: Record<string, unknown>) => {
            if (toolId === 'fs_read_text' && args.path === 'README.md') {
                return { data: 'Error: File not found or access denied.' };
            }
            if (toolId === 'fs_list' && args.recursive === true) {
                return { data: '[FILE] docs/README.md\n[FILE] package.json' };
            }
            if (toolId === 'fs_read_text' && args.path === 'docs/README.md') {
                return { data: '# Docs README' };
            }
            return { data: 'Error: unexpected call' };
        });
        const service = new SelfInspectionExecutionService();

        const result = await service.executeSelfInspectionTurn({
            text: 'read your README.md',
            allowWritesThisTurn: false,
            toolExecutionCoordinator: { executeTool } as any,
        });

        expect(result.executed).toBe(true);
        expect(result.blockedReason).toBeUndefined();
        expect(result.summary).toContain('docs/README.md');
        expect(executeTool.mock.calls.map((call) => call[0])).toEqual([
            'fs_read_text',
            'fs_list',
            'fs_read_text',
        ]);
    });

    it('lists root for local files request', async () => {
        const executeTool = vi.fn(async (toolId: string) => {
            if (toolId === 'fs_list') {
                return { data: '[FILE] README.md\n[DIR] docs' };
            }
            return { data: 'Error: unexpected call' };
        });
        const service = new SelfInspectionExecutionService();

        const result = await service.executeSelfInspectionTurn({
            text: 'Did you read your local files?',
            allowWritesThisTurn: false,
            toolExecutionCoordinator: { executeTool } as any,
        });

        expect(result.executed).toBe(true);
        expect(result.operation).toBe('list');
        expect(executeTool).toHaveBeenCalledWith(
            'fs_list',
            { path: '' },
            expect.any(Set),
            expect.any(Object),
        );
        expect(result.summary).toContain('Listed workspace root entries');
    });

    it('blocks write request when writes are not allowed', async () => {
        const executeTool = vi.fn();
        const service = new SelfInspectionExecutionService();

        const result = await service.executeSelfInspectionTurn({
            text: 'Please update your README.md',
            allowWritesThisTurn: false,
            toolExecutionCoordinator: { executeTool } as any,
        });

        expect(result.executed).toBe(true);
        expect(result.operation).toBe('edit');
        expect(result.blockedReason).toBe('write_not_allowed_this_turn');
        expect(executeTool).not.toHaveBeenCalled();
    });

    it('allows deterministic write when writes are permitted', async () => {
        const executeTool = vi.fn(async (toolId: string, args: Record<string, unknown>) => {
            if (toolId === 'fs_read_text') {
                return { data: '# Title\n' };
            }
            if (toolId === 'fs_write_text') {
                return { data: `Success: File written to ${String(args.path)}` };
            }
            return { data: 'Error: unexpected call' };
        });
        const service = new SelfInspectionExecutionService();

        const result = await service.executeSelfInspectionTurn({
            text: 'Please update your README.md and append "Architecture is policy-governed."',
            allowWritesThisTurn: true,
            toolExecutionCoordinator: { executeTool } as any,
        });

        expect(result.executed).toBe(true);
        expect(result.blockedReason).toBeUndefined();
        expect(executeTool.mock.calls.map((call) => call[0])).toEqual(['fs_read_text', 'fs_write_text']);
        expect(result.summary).toContain('Updated README.md');
    });
});

