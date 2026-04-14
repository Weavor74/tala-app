import { describe, expect, it } from 'vitest';
import { DeterministicIntentRouter } from '../electron/services/router/DeterministicIntentRouter';

describe('DeterministicIntentRouter expanded deterministic coverage', () => {
    it('routes browser open-url to deterministic browse operation', () => {
        const routed = DeterministicIntentRouter.route('open example.com/docs');
        expect(routed.intent).toBe('browser_navigate');
        expect(routed.requires_llm).toBe(false);
        expect(routed.deterministicOperation?.toolName).toBe('browse');
        expect(routed.deterministicOperation?.args).toEqual({ url: 'https://example.com/docs' });
    });

    it('keeps ambiguous open/navigation phrasing on llm path', () => {
        const routed = DeterministicIntentRouter.route('open router docs and explain the flow');
        expect(routed.requires_llm).toBe(true);
        expect(routed.isDeterministic).toBe(false);
        expect(routed.deterministicOperation).toBeUndefined();
    });

    it('routes memory add to mem0_add deterministic operation', () => {
        const routed = DeterministicIntentRouter.route('remember I prefer concise commit messages');
        expect(routed.intent).toBe('memory_add');
        expect(routed.requires_llm).toBe(false);
        expect(routed.deterministicOperation?.toolName).toBe('mem0_add');
        expect(routed.deterministicOperation?.args).toEqual({ text: 'I prefer concise commit messages' });
    });

    it('routes memory list to mem0_get_recent deterministic operation', () => {
        const routed = DeterministicIntentRouter.route('show recent memories last 7');
        expect(routed.intent).toBe('memory_list');
        expect(routed.requires_llm).toBe(false);
        expect(routed.deterministicOperation?.toolName).toBe('mem0_get_recent');
        expect(routed.deterministicOperation?.args).toEqual({ limit: 7 });
    });

    it('routes memory search to mem0_search deterministic operation', () => {
        const routed = DeterministicIntentRouter.route('search memory for migration notes');
        expect(routed.intent).toBe('memory_search');
        expect(routed.requires_llm).toBe(false);
        expect(routed.deterministicOperation?.toolName).toBe('mem0_search');
        expect(routed.deterministicOperation?.args).toEqual({ query: 'migration notes' });
    });

    it('preserves deterministic file read routing', () => {
        const routed = DeterministicIntentRouter.route('read electron/services/ToolService.ts');
        expect(routed.intent).toBe('file_read');
        expect(routed.deterministicOperation?.toolName).toBe('fs_read_text');
    });

    it('preserves deterministic git branch routing', () => {
        const routed = DeterministicIntentRouter.route('what branch am i on');
        expect(routed.intent).toBe('git_branch');
        expect(routed.deterministicOperation?.toolName).toBe('shell_run');
        expect(routed.deterministicOperation?.args).toEqual({ command: 'git branch --show-current' });
    });

    it('keeps explanatory requests on llm path', () => {
        const routed = DeterministicIntentRouter.route('explain why this branch changed');
        expect(routed.intent).toBe('explanation');
        expect(routed.requires_llm).toBe(true);
        expect(routed.deterministicOperation).toBeUndefined();
    });
});
