import { describe, expect, it } from 'vitest';
import { ChatExecutionSpine } from '../electron/services/execution/ChatExecutionSpine';

describe('RP budget priority preserves persona and canon blocks', () => {
    it('prioritizes identity and memory budgets in RP mode under pressure', () => {
        const spine = new ChatExecutionSpine({} as any);
        const budgets = (spine as any).selectPromptBlockBudgets({
            activeMode: 'rp',
            intentClass: 'unknown',
            isGreeting: false,
            isBrowserTask: false,
            toolsEnabled: false,
        });

        expect(budgets.identity).toBeGreaterThan(budgets.task_policy);
        expect(budgets.memory).toBeGreaterThan(budgets.task_policy);
        expect(budgets.memory).toBeGreaterThan(budgets.reflection);
        expect(budgets.tools).toBe(0);
    });
});
