import { IBrain, ChatMessage } from '../brains/IBrain';
import { auditLogger } from './AuditLogger';

/**
 * SmartRouterService
 * 
 * Implements "Economic Intelligence" by selecting the most cost-effective
 * model for a given task. 
 */
export class SmartRouterService {
    private localBrain: IBrain;
    private cloudBrain: IBrain;
    private mode: 'auto' | 'local-only' | 'cloud-only' = 'auto';

    constructor(local: IBrain, cloud: IBrain) {
        this.localBrain = local;
        this.cloudBrain = cloud;
    }

    public setMode(mode: 'auto' | 'local-only' | 'cloud-only') {
        this.mode = mode;
    }

    /**
     * Routes a specific task to the optimal brain.
     */
    public async route(messages: ChatMessage[], systemPrompt: string): Promise<IBrain> {
        if (this.mode === 'local-only') {
            auditLogger.info('route_decision', 'SmartRouter', { mode: 'local-only', picked: 'local', reason: 'User setting' });
            return this.localBrain;
        }
        if (this.mode === 'cloud-only') {
            auditLogger.info('route_decision', 'SmartRouter', { mode: 'cloud-only', picked: 'cloud', reason: 'User setting' });
            return this.cloudBrain;
        }

        // Auto-routing logic
        const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || "";
        const isComplex = this.isComplexTask(lastUserMessage, systemPrompt);

        if (isComplex) {
            auditLogger.info('route_decision', 'SmartRouter', {
                mode: 'auto',
                picked: 'cloud',
                reasons: 'Complex task detected (keywords/heuristic)'
            });
            return this.cloudBrain;
        }

        auditLogger.info('route_decision', 'SmartRouter', {
            mode: 'auto',
            picked: 'local',
            reasons: 'Simple task detected'
        });
        return this.localBrain;
    }

    private isComplexTask(prompt: string, system: string): boolean {
        const p = prompt.toLowerCase();
        const s = system.toLowerCase();

        // Keywords that suggest high-reasoning requirements
        const complexKeywords = [
            'calculate_strategies',
            'delegate_task',
            'refactor',
            'implement',
            'design',
            'analyze architecture',
            'optimize'
        ];

        // If the system prompt contains instructions for complex roles (Engineer/Sec)
        if (s.includes('maintenance & repair drone') || s.includes('tactical defense grid')) return true;

        return complexKeywords.some(k => p.includes(k));
    }
}
