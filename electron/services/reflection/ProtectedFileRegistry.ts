import { ProtectedFileRule } from './reflectionEcosystemTypes';

export class ProtectedFileRegistry {
    private rules: ProtectedFileRule[] = [];

    constructor() {
        this.loadDefaultRules();
    }

    private loadDefaultRules() {
        this.rules.push({
            ruleId: 'PROT-ROUTING',
            pathPattern: 'electron/services/router/*',
            category: 'core_routing',
            protectionLevel: 'promotion_required',
            allowStagedEdit: true,
            allowDirectPromotion: false,
            extraValidationRequired: ['build', 'typecheck', 'tests'],
            notes: 'Core router logic dictates agent dispatch. Must be fully validated before live replacement.'
        });

        this.rules.push({
            ruleId: 'PROT-MODE',
            pathPattern: 'electron/services/SettingsManager.ts',
            category: 'mode_persistence',
            protectionLevel: 'promotion_required',
            allowStagedEdit: true,
            allowDirectPromotion: false,
            extraValidationRequired: ['build', 'smoke'],
            notes: 'Mode persistence is vital for identity constraints.'
        });

        this.rules.push({
            ruleId: 'PROT-IDENTITY',
            pathPattern: 'data/identity/immutable/*',
            category: 'identity_definitions',
            protectionLevel: 'immutable',
            allowStagedEdit: false,
            allowDirectPromotion: false,
            extraValidationRequired: [],
            notes: 'Immutable identity values cannot be modified via automated processes.'
        });

        this.rules.push({
            ruleId: 'PROT-PROMPT',
            pathPattern: 'electron/services/SystemPrompts.ts',
            category: 'prompt_assembly',
            protectionLevel: 'promotion_required',
            allowStagedEdit: true,
            allowDirectPromotion: false,
            extraValidationRequired: ['build', 'smoke'],
            notes: 'Core prompts dictate foundational agent persona.'
        });

        this.rules.push({
            ruleId: 'PROT-TOOLS',
            pathPattern: 'electron/services/ToolService.ts',
            category: 'tool_service',
            protectionLevel: 'promotion_required',
            allowStagedEdit: true,
            allowDirectPromotion: false,
            extraValidationRequired: ['build', 'typecheck'],
            notes: 'Tool execution bounds must remain secure.'
        });
    }

    public getRules(): ProtectedFileRule[] {
        return this.rules;
    }

    /**
     * Determines the protection level for a given file path.
     */
    public getFileProtection(filePath: string): ProtectedFileRule | null {
        const normalizedPath = filePath.replace(/\\/g, '/');

        for (const rule of this.rules) {
            const matches = rule.pathPattern.includes('*')
                ? normalizedPath.includes(rule.pathPattern.replace('*', ''))
                : normalizedPath.endsWith(rule.pathPattern); // Simplified match

            if (matches) {
                return rule;
            }
        }
        return null; // Normal protection level
    }
}
