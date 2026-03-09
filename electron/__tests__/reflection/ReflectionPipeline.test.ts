import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ReflectionService } from '../../services/reflection/ReflectionService';
import { SelfImprovementGoal } from '../../services/reflection/reflectionEcosystemTypes';

describe('ReflectionPipeline End-to-End', () => {
    let tmpDir: string;
    let service: ReflectionService;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-test-reflection-'));
        // ReflectionService takes userDataDir, settingsPath, rootDir
        const fakeSettingsPath = path.join(tmpDir, 'settings.json');
        fs.writeFileSync(fakeSettingsPath, JSON.stringify({ reflection: { enabled: true } }));

        service = new ReflectionService(tmpDir, fakeSettingsPath, tmpDir);

        // Mock the internal engines so test doesn't try to use LLM/Git/Filesystem directly
        (service as any).selfImprovement.scanIssue = vi.fn().mockResolvedValue({
            issueId: 'test_iss_123',
            title: 'Test Issue',
            symptoms: ['Testing'],
            severity: 'high',
            suspectedComponents: []
        });

        (service as any).reflection.analyzeIssue = vi.fn().mockResolvedValue({
            selectedHypothesis: 'This is a test hypothesis',
            confidence: 0.9,
            rejectedHypotheses: []
        });
    });

    afterEach(() => {
        service.stop();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('submitting goal creates queue item and increments queue depth', async () => {
        const goalDef = { title: 'Test Goal', description: 'Testing the queue', priority: 'high', source: 'user' };

        // Use the GoalService to create goal and then enqueue simulating the IPC handler
        const goal = await (service as any).goals.createGoal(goalDef);
        expect(goal).toBeDefined();

        await (service as any).queue.enqueue({
            type: 'goal',
            source: 'user',
            priority: 'high',
            goalId: goal.goalId,
            triggerMode: 'engineering',
            requestedBy: 'user'
        });

        const dashboard = await service.getDashboardState('engineering');
        expect(dashboard.queuedGoals).toBe(1);
        expect(dashboard.pipelineActivity?.queueDepth).toBe(1);
    });

    it('process next goal locks and runs queued item, writing journal entry', async () => {
        const goalDef = { title: 'Process Me', description: 'Testing execution', priority: 'high', source: 'user' };
        const goal = await (service as any).goals.createGoal(goalDef);

        await (service as any).queue.enqueue({
            type: 'goal',
            source: 'user',
            priority: 'high',
            goalId: goal.goalId,
            triggerMode: 'engineering',
            requestedBy: 'user'
        });

        // Trigger tickNow which should process the goal
        const result = await (service as any).scheduler.tickNow();
        expect(result.success).toBe(true);
        expect(result.message).toContain('Successfully executed goal pipeline');

        // Check if goal was marked as completed
        const updatedGoal = await (service as any).goals.getGoal(goal.goalId);
        expect(updatedGoal.status).toBe('completed');

        // Check if journal entry was written
        const journalEntries = await (service as any).journal.readRecentEntries(10);
        expect(journalEntries.length).toBeGreaterThan(0);
        expect(journalEntries[0].summary).toContain('Goal Execution logic mapped for Process Me');
    });

    it('manual processing does not instantly return success without work if no anomalies', async () => {
        // Mock to return low severity
        (service as any).selfImprovement.scanIssue = vi.fn().mockResolvedValue({
            issueId: 'test_iss_low',
            title: 'No issues',
            severity: 'low'
        });

        const result = await service.triggerReflection('engineering');
        expect(result.success).toBe(false); // We changed this from true to false in our implementation
        expect(result.message).toContain('No severe anomalies detected');

        const state = await service.getDashboardState();
        expect(state.pipelineActivity?.lastOutcome).toBe('success');
        expect(state.pipelineActivity?.lastSummary).toContain('No severe anomalies detected');
    });

    it('goal execution creates reflection issue and transitions states', async () => {
        const goalDef = { title: 'Issue Goal', description: 'Test', priority: 'medium', source: 'user' };
        const goal = await (service as any).goals.createGoal(goalDef);

        await (service as any).queue.enqueue({
            type: 'goal',
            source: 'user',
            priority: 'medium',
            goalId: goal.goalId,
            triggerMode: 'engineering',
            requestedBy: 'user'
        });

        const schedulerSpy = vi.spyOn((service as any).scheduler, 'updateActivityPhase');

        await (service as any).scheduler.tickNow();

        // Verify state transitions were called
        expect(schedulerSpy).toHaveBeenCalledWith('queueing', expect.anything());
        expect(schedulerSpy).toHaveBeenCalledWith('observing', expect.anything());
        expect(schedulerSpy).toHaveBeenCalledWith('reflecting', expect.anything());
        expect(schedulerSpy).toHaveBeenCalledWith('journaling');
        expect(schedulerSpy).toHaveBeenCalledWith('completed', expect.anything());

        // Verify issue ID was linked to goal
        const updatedGoal = await (service as any).goals.getGoal(goal.goalId);
        expect(updatedGoal.linkedIssueIds).toContain('test_iss_123'); // From our mock
    });
});
