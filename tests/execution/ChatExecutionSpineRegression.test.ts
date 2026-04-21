import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalToolCall } from '../../shared/inferenceProviderTypes';
import {
    ChatExecutionSpine,
    type ExecutionPlan,
    type PreLoopResolvedToolPolicy,
} from '../../electron/services/execution/ChatExecutionSpine';
import { runtimeSafety } from '../../electron/services/RuntimeSafety';

function createAgentMock(overrides: Record<string, any> = {}): any {
    return {
        settingsPath: 'D:/src/client1/tala-app/.tmp-missing-settings.json',
        activeSessionId: 'session_test',
        activeTurnId: null,
        currentTurnAuditRecord: undefined,
        brain: {},
        getActiveMode: vi.fn(() => 'assistant'),
        coordinator: {
            executeTool: vi.fn(async () => ({ data: 'ok' })),
        },
        parseToolArguments: vi.fn((_toolName: string, args: any) => {
            if (typeof args === 'string') return JSON.parse(args);
            return args;
        }),
        validateToolArguments: vi.fn(),
        getToolTimeout: vi.fn(() => 1000),
        dispatchBrowserCommand: vi.fn(async (cmd: string) => {
            if (cmd === 'BROWSER_GET_DOM: REQUEST') return '<dom>ok</dom>';
            return `BROWSER_ACK:${cmd}`;
        }),
        streamWithBrain: vi.fn(async () => ({ content: 'fallback content', toolCalls: [] })),
        enforceCanonRequiredAutobioFallbackReply: vi.fn((content: string) => content),
        commitAssistantMessage: vi.fn((transient: any[], msg: any) => {
            transient.push(msg);
        }),
        ...overrides,
    };
}

function createPlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
    return {
        chatStartedAt: Date.now(),
        turnId: 'turn_test',
        settings: {},
        activeMode: 'assistant',
        routedIntent: {
            intent: 'unknown',
            confidence: 0,
            isDeterministic: false,
            requires_llm: true,
        },
        path: 'llm_loop',
        requiresLlm: true,
        requiresToolUse: false,
        isGreeting: false,
        isBrowserTask: false,
        directAnswerPreferred: false,
        hardBlockAllTools: false,
        toolExposureProfile: 'balanced',
        toolDirection: 'policy_controlled',
        deterministicOperation: null,
        ...overrides,
    };
}

describe('ChatExecutionSpine regression contracts', () => {
    beforeEach(() => {
        runtimeSafety.reset();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        runtimeSafety.reset();
    });

    describe('ExecutionPlan behavior', () => {
        it('selects deterministic path when deterministic operation exists', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const plan = (spine as any).planTurn({ userMessage: 'show recent memories last 3' });
            expect(plan.path).toBe('deterministic_fast_path');
            expect(plan.requiresLlm).toBe(false);
            expect(plan.deterministicOperation?.kind).toBe('memory_list');
            expect(plan.deterministicOperation?.toolName).toBe('mem0_get_recent');
        });

        it('blocks deterministic tool bypass in rp mode', () => {
            const spine = new ChatExecutionSpine(createAgentMock({ getActiveMode: vi.fn(() => 'rp') }));
            const plan = (spine as any).planTurn({ userMessage: 'show recent memories last 3' });
            expect(plan.path).toBe('llm_loop');
            expect(plan.requiresLlm).toBe(true);
            expect(plan.toolDirection).toBe('blocked');
            expect(plan.activeMode).toBe('rp');
        });

        it('marks greeting plan with no tool-required direction', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const plan = (spine as any).planTurn({ userMessage: 'hello' });
            expect(plan.isGreeting).toBe(true);
            expect(plan.requiresToolUse).toBe(false);
            expect(plan.path).toBe('llm_loop');
        });

        it('selects browser-task deterministic plan for open-url requests', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const plan = (spine as any).planTurn({ userMessage: 'open example.com/docs' });
            expect(plan.isBrowserTask).toBe(true);
            expect(plan.requiresToolUse).toBe(true);
            expect(plan.path).toBe('deterministic_fast_path');
            expect(plan.deterministicOperation?.kind).toBe('browser_navigate');
        });
    });

    describe('Pre-loop tool policy', () => {
        it('propagates hardBlockAllTools and directAnswerPreferred from plan', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const policy = (spine as any).resolvePreLoopToolPolicyFromPlan(
                createPlan({ hardBlockAllTools: true, directAnswerPreferred: true }),
            ) as PreLoopResolvedToolPolicy;
            expect(policy.hardBlockAllTools).toBe(true);
            expect(policy.directAnswerPreferred).toBe(true);
        });

        it('sets required tool choice for tool-required plans and preserves browser palette', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const policy = (spine as any).resolvePreLoopToolPolicyFromPlan(
                createPlan({ requiresToolUse: true, isBrowserTask: true }),
            ) as PreLoopResolvedToolPolicy;
            expect(policy.initialToolChoice).toBe('required');
            expect(policy.browserTaskToolNames.has('browse')).toBe(true);
            expect(policy.browserTaskToolNames.has('browser_get_dom')).toBe(true);
        });
    });

    describe('Iteration tool shaping', () => {
        const filteredTools = [
            { function: { name: 'browse' } },
            { function: { name: 'browser_click' } },
            { function: { name: 'mem0_search' } },
            { function: { name: 'shell_run' } },
        ];

        it('strips tools for greeting turns', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const req = (spine as any).shapeIterationToolRequest({
                executionPlan: createPlan(),
                preLoopPolicy: {
                    ...(spine as any).resolvePreLoopToolPolicyFromPlan(createPlan()),
                    blockedTools: [],
                },
                turnPolicy: { toolExposureProfile: 'balanced' },
                activeMode: 'assistant',
                intentClass: 'greeting',
                isGreeting: true,
                allowedCapabilities: ['all'],
                policyToolAllowList: null,
                filteredTools,
            });
            expect(req.toolsToSend).toHaveLength(0);
            expect(req.toolChoice).toBeUndefined();
        });

        it('strips tools for rp turns', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const req = (spine as any).shapeIterationToolRequest({
                executionPlan: createPlan({ activeMode: 'rp' }),
                preLoopPolicy: {
                    ...(spine as any).resolvePreLoopToolPolicyFromPlan(createPlan({ activeMode: 'rp' })),
                    blockedTools: [],
                },
                turnPolicy: { toolExposureProfile: 'balanced' },
                activeMode: 'rp',
                intentClass: 'conversation',
                isGreeting: false,
                allowedCapabilities: ['all'],
                policyToolAllowList: null,
                filteredTools,
            });
            expect(req.toolsToSend).toHaveLength(0);
        });

        it('applies browser-only palette shaping and required tool choice', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const plan = createPlan({ isBrowserTask: true, requiresToolUse: true });
            const pre = {
                ...(spine as any).resolvePreLoopToolPolicyFromPlan(plan),
                blockedTools: [],
            };
            const req = (spine as any).shapeIterationToolRequest({
                executionPlan: plan,
                preLoopPolicy: pre,
                turnPolicy: { toolExposureProfile: 'balanced' },
                activeMode: 'assistant',
                intentClass: 'browser',
                isGreeting: false,
                allowedCapabilities: ['all'],
                policyToolAllowList: null,
                filteredTools,
            });
            expect(req.browserPaletteFiltered).toBe(true);
            expect(req.toolsToSend.every((t: any) => pre.browserTaskToolNames.has(t.function.name))).toBe(true);
            expect(req.toolChoice).toBe('required');
        });

        it('removes blocked tools and enforces hard-block-all-tools', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const req = (spine as any).shapeIterationToolRequest({
                executionPlan: createPlan(),
                preLoopPolicy: {
                    ...(spine as any).resolvePreLoopToolPolicyFromPlan(createPlan()),
                    blockedTools: ['mem0_search'],
                    hardBlockAllTools: true,
                },
                turnPolicy: { toolExposureProfile: 'balanced' },
                activeMode: 'assistant',
                intentClass: 'coding',
                isGreeting: false,
                allowedCapabilities: ['all'],
                policyToolAllowList: null,
                filteredTools,
            });
            expect(req.blockedTools).toContain('mem0_search');
            expect(req.hardBlockAllTools).toBe(true);
            expect(req.toolsToSend).toHaveLength(0);
            expect(req.toolChoice).toBeUndefined();
        });
    });

    describe('Bounded prompt packet render parity', () => {
        it('enforces budgets and records truncation + render parity metadata', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const plan = createPlan({ isGreeting: false, isBrowserTask: false, activeMode: 'assistant' });
            const packet = (spine as any).buildBoundedPromptPacket({
                executionPlan: plan,
                turnObject: {
                    intent: { class: 'coding' },
                    blockedCapabilities: [],
                    turnBehavior: { astroLevel: 'full', reflectionLevel: 'full' },
                },
                turnPolicy: { toolExposureProfile: 'balanced', memoryReadPolicy: 'allow' },
                activeProfileSystemPrompt: 'A'.repeat(4000),
                userIdentity: 'User identity note',
                dynamicContext: 'Task policy section',
                memoryContext: 'M'.repeat(5000),
                docContextText: 'D'.repeat(5000),
                toolSigs: 'T'.repeat(12000),
                notebookActive: true,
                goalsAndReflections: 'R'.repeat(5000),
                astroState: 'A'.repeat(3000),
            });

            const blockByKind = new Map(packet.blocks.map((b: any) => [b.kind, b]));
            const identity = blockByKind.get('identity');
            const docs = blockByKind.get('docs_retrieval');
            const notebook = blockByKind.get('notebook');
            const astro = blockByKind.get('astro');
            const reflection = blockByKind.get('reflection');
            const memory = blockByKind.get('memory');

            expect(identity.selected).toBe(true);
            expect(identity.rendered).toBe(true);
            expect(identity.merged).toBe(true);
            expect(identity.renderTargets).toContain('systemPromptBase');
            expect(identity.renderTargets).toContain('userIdentity');

            expect(memory.truncated).toBe(true);
            expect(packet.truncatedBlocks).toContain('memory');

            expect(docs.selected).toBe(true);
            expect(docs.rendered).toBe(false);
            expect(docs.skipped).toBe(true);

            expect(notebook.selected).toBe(true);
            expect(notebook.merged).toBe(true);
            expect(notebook.renderTargets).toContain('notebookGrounded');

            expect(astro.selected).toBe(true);
            expect(astro.rendered).toBe(false);
            expect(astro.skipped).toBe(true);

            expect(reflection.selected).toBe(true);
            expect(reflection.rendered).toBe(true);
            expect(packet.selectedBlocks).toEqual(expect.arrayContaining([
                'identity',
                'task_policy',
                'memory',
                'docs_retrieval',
                'tools',
                'notebook',
                'astro',
                'reflection',
            ]));
        });

        it('marks policy-omitted blocks explicitly', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const packet = (spine as any).buildBoundedPromptPacket({
                executionPlan: createPlan({ activeMode: 'rp' }),
                turnObject: {
                    intent: { class: 'conversation' },
                    blockedCapabilities: ['all'],
                    turnBehavior: { astroLevel: 'off', reflectionLevel: 'off' },
                },
                turnPolicy: { toolExposureProfile: 'none', memoryReadPolicy: 'blocked' },
                activeProfileSystemPrompt: 'base',
                userIdentity: '',
                dynamicContext: 'policy',
                memoryContext: 'memory',
                docContextText: 'docs',
                toolSigs: 'tools',
                notebookActive: false,
                goalsAndReflections: 'reflection',
                astroState: 'astro',
            });

            const blockByKind = new Map(packet.blocks.map((b: any) => [b.kind, b]));
            expect(blockByKind.get('memory').omittedByPolicy).toBe(true);
            expect(blockByKind.get('tools').omittedByPolicy).toBe(true);
            expect(blockByKind.get('reflection').omittedByPolicy).toBe(true);
            expect(blockByKind.get('astro').omittedByPolicy).toBe(true);
            expect(packet.omittedByPolicyBlocks).toEqual(expect.arrayContaining(['memory', 'tools', 'reflection', 'astro']));
        });
    });

    describe('Post-turn memory write gating', () => {
        it('does not persist when memoryWriteDecision is do_not_write', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const shouldPersist = (spine as any).shouldPersistPostTurnMemory({
                finalResponse: 'reply',
                memoryCapabilityEnabled: true,
                memoryWriteDecisionCategory: 'do_not_write',
            });
            expect(shouldPersist).toBe(false);
        });

        it('persists normal allowed-write turns', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const shouldPersist = (spine as any).shouldPersistPostTurnMemory({
                finalResponse: 'reply',
                memoryCapabilityEnabled: true,
                memoryWriteDecisionCategory: 'short_term',
            });
            expect(shouldPersist).toBe(true);
        });

        it('keeps RP greeting/opening turns non-persistent when marked do_not_write', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const shouldPersist = (spine as any).shouldPersistPostTurnMemory({
                finalResponse: 'hey there',
                memoryCapabilityEnabled: true,
                memoryWriteDecisionCategory: 'do_not_write',
            });
            expect(shouldPersist).toBe(false);
        });

        it('keeps unrelated memory-capable turns unchanged when writes are allowed', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const shouldPersist = (spine as any).shouldPersistPostTurnMemory({
                finalResponse: 'done',
                memoryCapabilityEnabled: true,
                memoryWriteDecisionCategory: 'long_term',
            });
            expect(shouldPersist).toBe(true);
        });
    });

    describe('Loop helper behavior', () => {
        it('continues browser no-tool iteration when continuation steps remain', () => {
            const spine = new ChatExecutionSpine(createAgentMock());
            const transientMessages: any[] = [];
            const result = (spine as any).handleNoToolCallsIteration({
                isBrowserTask: true,
                activeMode: 'assistant',
                browserContinuationStep: 0,
                browserMaxContinuationSteps: 3,
                transientMessages,
                browserTaskHadSuccessfulAction: false,
                responseContent: '',
                enforceCanonRequiredAutobioOverride: false,
            });
            expect(result.continued).toBe(true);
            expect(result.browserContinuationStep).toBe(1);
            expect(transientMessages.at(-1)?.content).toContain('[BROWSER_TASK_CONTINUATION]');
        });

        it('handles timeout fallback and commits fallback assistant message', async () => {
            const agent = createAgentMock();
            const spine = new ChatExecutionSpine(agent);
            const transientMessages: any[] = [];
            const result = await (spine as any).handleIterationTimeoutFallback({
                error: { name: 'StreamOpenTimeoutError', message: 'Stream open timeout' },
                toolsSentThisIteration: [{ function: { name: 'shell_run' } }],
                turn: 1,
                turnId: 'turn_timeout',
                signal: new AbortController().signal,
                truncated: [{ role: 'user', content: 'x' }],
                systemPrompt: 'sys',
                turnObject: { intent: { class: 'coding' } },
                enforceCanonRequiredAutobioOverride: false,
                executionLog: { toolCalls: [] },
                transientMessages,
                turnSeenHashes: new Set<string>(),
                activeMode: 'assistant',
            });
            expect(result.handled).toBe(true);
            expect(result.finalResponse).toBe('fallback content');
            expect(agent.streamWithBrain).toHaveBeenCalled();
            expect(agent.commitAssistantMessage).toHaveBeenCalled();
        });

        it('accumulates tool execution results and wraps tool output', async () => {
            vi.spyOn(runtimeSafety, 'isToolCooldownActive').mockReturnValue(false);
            const agent = createAgentMock({
                coordinator: {
                    executeTool: vi.fn(async () => ({ data: 'tool-ok' })),
                },
            });
            const spine = new ChatExecutionSpine(agent);
            const transientMessages: any[] = [];
            const executionLog: any = { toolCalls: [] };
            const calls: CanonicalToolCall[] = [{
                id: 'call_1',
                type: 'function',
                function: {
                    name: 'shell_run',
                    arguments: JSON.stringify({ command: 'git status' }),
                },
            }];
            const result = await (spine as any).executeToolCallsIteration({
                calls,
                allowedToolNames: new Set(['shell_run']),
                activeMode: 'assistant',
                turnId: 'turn_exec',
                executionLog,
                transientMessages,
                isBrowserTask: false,
                browserTaskToolNames: new Set<string>(),
                browserMutatingToolNames: new Set<string>(),
                browserTaskHadSuccessfulAction: false,
            });
            expect(result.browserTaskHadSuccessfulAction).toBe(false);
            expect(executionLog.toolCalls).toHaveLength(1);
            expect(executionLog.toolCalls[0].ok).toBe(true);
            expect(transientMessages[0].role).toBe('tool');
            expect(transientMessages[0].content).toContain('[TOOL_RESULT]');
        });
    });
});

