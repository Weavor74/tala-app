import { ImmutableIdentityRule } from './reflectionEcosystemTypes';
import * as path from 'path';

export class ImmutableIdentityRegistry {
    private rules: ImmutableIdentityRule[] = [];

    constructor() {
        this.loadDefaultRules();
    }

    private loadDefaultRules() {
        this.rules.push({
            ruleId: 'IMMUTABLE-001',
            scope: 'persona-boundaries',
            description: 'Tala must not merge debug persona into user-facing persona',
            pathPattern: '*/AgentService.ts', // Adjust later based on exact file
            forbiddenOperations: ['delete'],
            reviewRequired: true,
            notes: 'AgentService contains core mode differentiation.'
        });

        this.rules.push({
            ruleId: 'IMMUTABLE-002',
            scope: 'mode-preservation',
            description: 'Tala must not erase user-selected mode boundaries or silently coerce modes',
            pathPattern: '*/SettingsManager.ts',
            forbiddenOperations: ['delete'],
            reviewRequired: true,
            notes: 'Settings persistence must remain authoritative.'
        });

        this.rules.push({
            ruleId: 'IMMUTABLE-003',
            scope: 'reflection-safeguards',
            description: 'Tala must not disable archive-before-overwrite or journaling',
            pathPattern: '*/SelfImprovementService.ts', // Future file
            forbiddenOperations: ['delete'],
            reviewRequired: true,
            notes: 'Self improvement components are self-protecting.'
        });

        this.rules.push({
            ruleId: 'IMMUTABLE-004',
            scope: 'identity-files',
            description: 'Direct rewrites of immutable identity files are forbidden',
            pathPattern: 'data/identity/immutable/**',
            forbiddenOperations: ['write_live', 'delete'],
            reviewRequired: true,
            notes: 'Core identity assertions.'
        });
    }

    public getRules(): ImmutableIdentityRule[] {
        return this.rules;
    }

    /**
     * Checks if a proposed operation on a file violates any immutable identity constraints.
     */
    public checkIdentitySafety(filePath: string, operation: 'read' | 'write_staged' | 'write_live' | 'delete'): { safe: boolean; reason?: string; ruleId?: string } {
        const normalizedPath = filePath.replace(/\\/g, '/');

        for (const rule of this.rules) {
            // Simple glob-like path matching. Expand to proper minimatch/glob if needed.
            const matches = rule.pathPattern.includes('**')
                ? normalizedPath.includes(rule.pathPattern.replace('**', ''))
                : rule.pathPattern.includes('*')
                    ? normalizedPath.endsWith(rule.pathPattern.replace('*', ''))
                    : normalizedPath === rule.pathPattern;

            if (matches && rule.forbiddenOperations.includes(operation)) {
                return {
                    safe: false,
                    reason: `Identity Violation: ${rule.description}`,
                    ruleId: rule.ruleId
                };
            }
        }

        return { safe: true };
    }
}
