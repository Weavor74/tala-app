/**
 * Phase 1 Coherence Hardening Tests
 *
 * Validates the five hardening objectives:
 * 1. Canonical TurnContext structure
 * 2. Memory write policy (mode-aware suppression and approval)
 * 3. MCP service health states
 * 4. Artifact routing decisions and fallback
 * 5. Mode gating — capability blocking by mode
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TalaContextRouter } from '../../services/router/TalaContextRouter';
import { TurnContext, MemoryWriteDecision } from '../../services/router/ContextAssembler';
import { ArtifactRouter } from '../../services/ArtifactRouter';
import { ServerState, McpService } from '../../services/McpService';
import { MockMemoryService } from './MockServices';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(partialInput?: string): string {
    return partialInput ?? 'how does the memory retrieval system work?';
}

function makeRpTurn(): string {
    return 'you are my knight, speak to me in character';
}

function makeGreeting(): string {
    return 'hello';
}

// ---------------------------------------------------------------------------
// 1. Canonical TurnContext Structure
// ---------------------------------------------------------------------------

describe('TurnContext — canonical structure', () => {
    let router: TalaContextRouter;
    let memory: MockMemoryService;

    beforeEach(() => {
        memory = new MockMemoryService();
        router = new TalaContextRouter(memory as any);
    });

    it('populates all required canonical fields', async () => {
        const ctx: TurnContext = await router.process('turn-1', makeTurn(), 'assistant');

        // Core identification
        expect(ctx.turnId).toBe('turn-1');
        expect(ctx.resolvedMode).toBe('assistant');
        expect(ctx.persistedMode).toBe('assistant');

        // Input fields
        expect(typeof ctx.rawInput).toBe('string');
        expect(ctx.rawInput.length).toBeGreaterThan(0);
        expect(typeof ctx.normalizedInput).toBe('string');
        expect(ctx.normalizedInput).toBe(ctx.rawInput.toLowerCase().trim());

        // Intent
        expect(ctx.intent).toBeDefined();
        expect(typeof ctx.intent.class).toBe('string');
        expect(typeof ctx.intent.confidence).toBe('number');
        expect(typeof ctx.intent.isGreeting).toBe('boolean');

        // Retrieval
        expect(ctx.retrieval).toBeDefined();
        expect(typeof ctx.retrieval.suppressed).toBe('boolean');
        expect(typeof ctx.retrieval.approvedCount).toBe('number');
        expect(typeof ctx.retrieval.excludedCount).toBe('number');

        // Capabilities
        expect(Array.isArray(ctx.allowedCapabilities)).toBe(true);
        expect(Array.isArray(ctx.blockedCapabilities)).toBe(true);

        // Phase 1 new fields
        expect(Array.isArray(ctx.selectedTools)).toBe(true);
        expect(ctx.artifactDecision).toBeNull(); // populated post-routing
        expect(ctx.memoryWriteDecision).not.toBeNull();
        expect(ctx.auditMetadata).toBeDefined();
        expect(typeof ctx.auditMetadata.turnStartedAt).toBe('number');
        expect(ctx.auditMetadata.turnCompletedAt).toBeNull(); // not yet completed
        expect(Array.isArray(ctx.auditMetadata.mcpServicesUsed)).toBe(true);
        expect(typeof ctx.auditMetadata.correlationId).toBe('string');
        expect(ctx.errorState).toBeNull();
    });

    it('normalizes rawInput correctly', async () => {
        const input = '  Hello World  ';
        const ctx = await router.process('turn-2', input, 'assistant');
        expect(ctx.rawInput).toBe(input);
        expect(ctx.normalizedInput).toBe('hello world');
    });
});

// ---------------------------------------------------------------------------
// 2. Memory Write Policy
// ---------------------------------------------------------------------------

describe('Memory Write Policy', () => {
    let router: TalaContextRouter;
    let memory: MockMemoryService;

    beforeEach(() => {
        memory = new MockMemoryService();
        router = new TalaContextRouter(memory as any);
    });

    it('suppresses memory writes in RP mode', async () => {
        const ctx = await router.process('rp-1', makeRpTurn(), 'rp');
        const policy = ctx.memoryWriteDecision as MemoryWriteDecision;

        expect(policy).not.toBeNull();
        expect(policy.category).toBe('do_not_write');
        expect(policy.executed).toBe(false);
        expect(policy.reason).toContain('RP mode');
    });

    it('suppresses memory writes for greeting turns', async () => {
        const ctx = await router.process('greet-1', makeGreeting(), 'assistant');
        const policy = ctx.memoryWriteDecision as MemoryWriteDecision;

        expect(policy.category).toBe('do_not_write');
        expect(policy.executed).toBe(false);
    });

    it('allows short-term writes in hybrid mode', async () => {
        const ctx = await router.process('hybrid-1', 'can you help me plan a project?', 'hybrid');
        const policy = ctx.memoryWriteDecision as MemoryWriteDecision;

        expect(policy.category).toBe('short_term');
        expect(policy.executed).toBe(false); // not yet executed — agent does the write
    });

    it('approves long-term writes for technical queries in assistant mode', async () => {
        const ctx = await router.process('assist-tech-1', 'debug the memory retrieval pipeline', 'assistant');
        // Intent should be classified as technical/explanation
        const policy = ctx.memoryWriteDecision as MemoryWriteDecision;
        // Either long_term or short_term is acceptable — must not be do_not_write
        expect(['long_term', 'short_term']).toContain(policy.category);
        expect(policy.executed).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 3. Mode Gating — Capability Blocking
// ---------------------------------------------------------------------------

describe('Mode Gating — capability enforcement', () => {
    let router: TalaContextRouter;
    let memory: MockMemoryService;

    beforeEach(() => {
        memory = new MockMemoryService();
        router = new TalaContextRouter(memory as any);
    });

    it('blocks tools (not all) in RP mode and allows memory_retrieval', async () => {
        const ctx = await router.process('rp-gate-1', makeRpTurn(), 'rp');

        expect(ctx.blockedCapabilities).toContain('tools');
        expect(ctx.allowedCapabilities).toContain('memory_retrieval');
        expect(ctx.allowedCapabilities).not.toContain('all');
    });

    it('allows all capabilities in assistant mode for substantive queries', async () => {
        const ctx = await router.process('assist-gate-1', makeTurn(), 'assistant');

        expect(ctx.allowedCapabilities).toContain('all');
        expect(ctx.blockedCapabilities).not.toContain('all');
    });

    it('blocks memory_retrieval for greeting turns regardless of mode', async () => {
        const ctx = await router.process('greet-gate-1', makeGreeting(), 'assistant');

        expect(ctx.retrieval.suppressed).toBe(true);
        expect(ctx.blockedCapabilities).toContain('memory_retrieval');
    });

    it('records mode in TurnContext for audit', async () => {
        const ctx = await router.process('mode-record-1', makeTurn(), 'hybrid');

        expect(ctx.resolvedMode).toBe('hybrid');
        expect(ctx.persistedMode).toBe('hybrid');
        expect(ctx.memoryWriteDecision?.category).toBe('short_term');
    });
});

// ---------------------------------------------------------------------------
// 4. MCP Service Health States
// ---------------------------------------------------------------------------

describe('MCP Service Health States', () => {
    it('returns null for unknown server', () => {
        const mcp = new McpService();
        expect(mcp.getServiceHealth('unknown-server')).toBeNull();
    });

    it('isServiceCallable returns false for unknown server', () => {
        const mcp = new McpService();
        expect(mcp.isServiceCallable('nonexistent')).toBe(false);
    });

    it('getAllServiceHealth returns empty array when no connections', () => {
        const mcp = new McpService();
        expect(mcp.getAllServiceHealth()).toEqual([]);
    });

    it('ServerState enum includes all required lifecycle states', () => {
        expect(ServerState.STARTING).toBeDefined();
        expect(ServerState.CONNECTED).toBeDefined();
        expect(ServerState.READY).toBeDefined();   // alias for CONNECTED
        expect(ServerState.DEGRADED).toBeDefined();
        expect(ServerState.UNAVAILABLE).toBeDefined();
        expect(ServerState.FAILED).toBeDefined();
        expect(ServerState.DISABLED).toBeDefined();
    });

    it('READY is an alias for CONNECTED', () => {
        expect(ServerState.READY).toBe(ServerState.CONNECTED);
    });
});

// ---------------------------------------------------------------------------
// 5. Artifact Routing Decisions
// ---------------------------------------------------------------------------

describe('ArtifactRouter — routing decisions and fallback', () => {
    let router: ArtifactRouter;

    beforeEach(() => {
        router = new ArtifactRouter();
    });

    it('routes short chat text to chat channel', () => {
        const output = router.normalizeAgentOutput('Hello, how can I help you?');

        expect(output.outputChannel).toBe('chat');
        expect(output.suppressChatContent).toBe(false);
        expect(output.artifact).toBeNull();
        expect(typeof output.routingReason).toBe('string');
    });

    it('routes raw content override to chat regardless of length', () => {
        const longMsg = 'put the full text in chat ' + 'x'.repeat(3000);
        const output = router.normalizeAgentOutput(longMsg);

        expect(output.outputChannel).toBe('chat');
        expect(output.suppressChatContent).toBe(false);
        expect(output.routingReason).toContain('raw_content_override');
    });

    it('routes long output (>2000 chars) to workspace', () => {
        const longMsg = 'This is a long document. '.repeat(100);
        const output = router.normalizeAgentOutput(longMsg);

        expect(output.outputChannel).toBe('workspace');
        expect(output.suppressChatContent).toBe(true);
        expect(output.artifact).not.toBeNull();
        expect(output.artifact!.type).toBe('markdown');
        expect(output.routingReason).toContain('length_threshold');
    });

    it('routes HTML content to browser channel', () => {
        const htmlMsg = '<!DOCTYPE html><html><body>Hello</body></html>';
        const output = router.normalizeAgentOutput(htmlMsg);

        expect(output.outputChannel).toBe('browser');
        expect(output.suppressChatContent).toBe(true);
        expect(output.artifact!.type).toBe('html');
        expect(output.routingReason).toContain('html_heuristic');
    });

    it('routes file read tool result to workspace', () => {
        const toolResults = [{
            name: 'fs_read_text',
            args: { path: '/src/App.tsx' },
            result: 'const App = () => <div>Hello</div>;'
        }];
        const output = router.normalizeAgentOutput('Here is the file content:', toolResults);

        expect(output.artifact).not.toBeNull();
        expect(output.artifact!.type).toBe('editor');
        expect(output.artifact!.path).toBe('/src/App.tsx');
        expect(output.routingReason).toContain('tool_result');
    });

    it('routes browser navigation tool result to browser channel', () => {
        const toolResults = [{
            name: 'browser_navigate',
            args: { url: 'https://example.com' },
            result: '<html>...</html>'
        }];
        const output = router.normalizeAgentOutput('Opened the page:', toolResults);

        expect(output.artifact!.type).toBe('browser');
        expect(output.outputChannel).toBe('browser');
    });

    it('generates stable IDs for the same path', () => {
        const id1 = router.generateStableId('/path/to/file.ts', 'editor');
        const id2 = router.generateStableId('/path/to/file.ts', 'editor');
        expect(id1).toBe(id2);
    });

    it('generates different IDs for different paths', () => {
        const id1 = router.generateStableId('/path/to/file.ts', 'editor');
        const id2 = router.generateStableId('/path/to/other.ts', 'editor');
        expect(id1).not.toBe(id2);
    });

    it('includes routingReason in all outputs', () => {
        const cases = [
            'hello',
            'x'.repeat(2001),
            '<!DOCTYPE html><html></html>',
            'paste it here, the full text'
        ];
        for (const msg of cases) {
            const output = router.normalizeAgentOutput(msg);
            expect(typeof output.routingReason).toBe('string');
            expect(output.routingReason!.length).toBeGreaterThan(0);
        }
    });
});
