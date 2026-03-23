/**
 * RuntimeFlags — Centralized Feature Configuration for Tala
 *
 * Provides a unified way to read operational feature flags from process.env.
 * Used to isolate risky seams (e.g. remote memory, external search) during 
 * stabilization phases (Phase 0).
 */

export const RuntimeFlags = {
    /**
     * ENABLE_MEM0_REMOTE
     * If true, MemoryService will attempt to ignite and use the mem0-core MCP server.
     * If false, all memory operations skip the remote path and fall back to local/canonical.
     */
    get ENABLE_MEM0_REMOTE(): boolean {
        return process.env.ENABLE_MEM0_REMOTE !== 'false';
    },

    /**
     * ENABLE_LEGACY_REMOTE_SEARCH
     * If true, RetrievalOrchestrator will register and use the ExternalApiSearchProvider.
     * If false, external API providers (Google/Brave) are effectively disabled.
     */
    get ENABLE_LEGACY_REMOTE_SEARCH(): boolean {
        return process.env.ENABLE_LEGACY_REMOTE_SEARCH !== 'false';
    },

    /**
     * ENABLE_EXTERNAL_PROVIDER_REFRESH_ON_SAVE
     * If true, saving settings will trigger a refresh of external retrieval providers.
     * If false, the refresh is skipped to prevent potential deadlocks or instability.
     */
    get ENABLE_EXTERNAL_PROVIDER_REFRESH_ON_SAVE(): boolean {
        return process.env.ENABLE_EXTERNAL_PROVIDER_REFRESH_ON_SAVE !== 'false';
    },

    /**
     * ENABLE_DUCKDUCKGO_SEARCH
     * If true, RetrievalOrchestrator will register and use the DuckDuckGoSearchProvider.
     * This provides a universal, zero-config web search fallback.
     */
    get ENABLE_DUCKDUCKGO_SEARCH(): boolean {
        return process.env.ENABLE_DUCKDUCKGO_SEARCH !== 'false';
    },

    /**
     * ENABLE_PG_CANONICAL_ONLY
     * If true, MemoryService skips remote search entirely and only uses the canonical 
     * database path. This is a stricter form of isolation than ENABLE_MEM0_REMOTE=false.
     */
    get ENABLE_PG_CANONICAL_ONLY(): boolean {
        return process.env.ENABLE_PG_CANONICAL_ONLY === 'true';
    }
};
