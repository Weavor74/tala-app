import * as path from 'path';
import * as fs from 'fs';
import { SelfImprovementGoal, GoalStatus } from './reflectionEcosystemTypes';
import { ReflectionDataDirectories } from './DataDirectoryPaths';

export class GoalService {
    private dirs: ReflectionDataDirectories;

    constructor(dirs: ReflectionDataDirectories) {
        this.dirs = dirs;
    }

    private getGoalPath(goalId: string): string {
        return path.join(this.dirs.goalsDir, `${goalId}.json`);
    }

    public async createGoal(goalDef: Partial<SelfImprovementGoal>): Promise<SelfImprovementGoal> {
        const goalId = `goal_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const now = new Date().toISOString();

        const newGoal: SelfImprovementGoal = {
            goalId,
            createdAt: now,
            updatedAt: now,
            title: goalDef.title || 'Untitled Goal',
            description: goalDef.description || '',
            category: goalDef.category || 'tooling',
            priority: goalDef.priority || 'medium',
            status: goalDef.status || 'queued',
            source: goalDef.source || 'user',
            linkedIssueIds: goalDef.linkedIssueIds || [],
            linkedPatchIds: goalDef.linkedPatchIds || [],
            successCriteria: goalDef.successCriteria || [],
            notes: goalDef.notes || ''
        };

        await this.saveGoal(newGoal);
        return newGoal;
    }

    public async saveGoal(goal: SelfImprovementGoal): Promise<void> {
        goal.updatedAt = new Date().toISOString();
        fs.writeFileSync(this.getGoalPath(goal.goalId), JSON.stringify(goal, null, 2), 'utf8');
    }

    public async getGoal(goalId: string): Promise<SelfImprovementGoal | null> {
        const fPath = this.getGoalPath(goalId);
        if (!fs.existsSync(fPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(fPath, 'utf8'));
        } catch (e) {
            console.error(`Failed to parse goal file ${goalId}`, e);
            return null;
        }
    }

    public async listGoals(): Promise<SelfImprovementGoal[]> {
        const goals: SelfImprovementGoal[] = [];
        if (!fs.existsSync(this.dirs.goalsDir)) return [];

        const files = fs.readdirSync(this.dirs.goalsDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(this.dirs.goalsDir, file), 'utf8'));
                goals.push(data);
            } catch (e) {
                console.error(`Error reading goal file ${file}`, e);
            }
        }

        // Sort by priority then newest
        const priorityScore = { critical: 4, high: 3, medium: 2, low: 1 };
        goals.sort((a, b) => {
            if (a.status !== 'completed' && b.status === 'completed') return -1;
            if (a.status === 'completed' && b.status !== 'completed') return 1;

            const pA = priorityScore[a.priority] || 0;
            const pB = priorityScore[b.priority] || 0;
            if (pA !== pB) return pB - pA;

            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });

        return goals;
    }

    public async updateGoalStatus(goalId: string, status: GoalStatus): Promise<boolean> {
        const goal = await this.getGoal(goalId);
        if (!goal) return false;

        goal.status = status;
        await this.saveGoal(goal);
        return true;
    }

    public async linkIssueToGoal(goalId: string, issueId: string): Promise<boolean> {
        const goal = await this.getGoal(goalId);
        if (!goal) return false;

        if (!goal.linkedIssueIds.includes(issueId)) {
            goal.linkedIssueIds.push(issueId);
            await this.saveGoal(goal);
        }
        return true;
    }
}
