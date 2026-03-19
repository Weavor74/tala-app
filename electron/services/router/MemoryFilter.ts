/**
 * MemoryFilter - Retrieval-Shaping Logic
 * 
 * This class is responsible for filtering, reranking, and de-conflicting memories
 * after retrieval but before they are injected into the context. It acts as a 
 * security and relevance gate between the `MemoryService` and `ContextAssembler`.
 * 
 * **Filtering Criteria:**
 * - **Mode Isolation**: Prevents RP memories from leaking into Assistant mode (and vice versa).
 * - **Status Discipline**: Excludes archived, superseded, or contested memories based on policy.
 * - **Greeting Suppression**: Bypasses memory injection for low-substance turns.
 * - **Source Policy**: Enforces strictness/looseness of information sources based on the active mode.
 * 
 * **Contradiction Resolution:**
 * - Uses a two-pass approach (Explicit associations and Semantic deduplication).
 * - Prefers explicit user-provided facts over inferred RAG results.
 * - Deduplicates overlapping claims based on confidence and salience metrics.
 */

import { MemoryItem } from '../MemoryService';
import { Mode, ModePolicyEngine } from './ModePolicyEngine';
import { Intent } from './IntentClassifier';

/**
 * Result of a single memory item evaluation.
 */
export interface ExclusionResult {
    /** `true` if the memory is allowed in the current context. */
    allowed: boolean;
    /** Description of the policy that triggered an exclusion (for debugging). */
    reason?: string;
}

export class MemoryFilter {
    /**
     * Strictly filters candidates based on mode policy, memory status, and intent.
     * Strictly filters candidate memories against the active mode and turn intent.
     * 
     * This is the primary entry point for ensuring context safety and relevance.
     */
    public static filter(candidates: MemoryItem[], mode: Mode, intent: Intent): MemoryItem[] {
        return candidates.filter(m => {
            const result = this.evaluate(m, mode, intent);
            if (!result.allowed) {
                console.log(`[RouterFilter] EXCLUDE id=${m.id} reason=${result.reason} mode=${mode}`);
            }
            return result.allowed;
        });
    }

    private static evaluate(m: MemoryItem, mode: Mode, intent: Intent): ExclusionResult {
        // 1. Mode Scope Isolation
        const mRole = m.metadata?.role || 'core';

        if (mode === 'rp') {
            // RP mode allows:
            //   - Memories explicitly tagged for RP (role='rp')
            //   - General core memories (role='core') from RP-allowed sources
            //     (e.g. mem0, graph, explicit user facts) for autobiographical grounding
            // Memories with any other role tag (e.g. 'assistant', 'task') are excluded
            // to prevent mode bleed. Source filtering (step 4) handles source enforcement.
            if (mRole !== 'rp' && mRole !== 'core') {
                return { allowed: false, reason: 'blocked_by_memory_read_policy (rp_role_mismatch)' };
            }
        }
        if (mode === 'assistant' && mRole === 'rp') {
            return { allowed: false, reason: 'wrong_mode_scope (assistant_isolation)' };
        }

        // 2. Status Policy
        if (m.status === 'archived') {
            return { allowed: false, reason: 'blocked_by_safety (archived)' };
        }
        if (m.status === 'superseded' && intent.class !== 'technical') {
            return { allowed: false, reason: 'blocked_by_safety (superseded)' };
        }
        if (m.status === 'contested' && mode !== 'assistant') {
            // Contested memories are unsafe for RP/Hybrid — they carry unresolved accuracy risk
            return { allowed: false, reason: 'blocked_by_safety (contested)' };
        }

        // 3. Greeting Suppression
        if (intent.class === 'greeting') {
            return { allowed: false, reason: 'intent_greeting_suppression' };
        }

        // 4. Source Policy
        if (!ModePolicyEngine.isSourceAllowed(mode, m.metadata?.source || 'unknown')) {
            // 'any' in hybrid allows all, but assistant/rp are strict
            if (mode !== 'hybrid') {
                return { allowed: false, reason: `blocked_by_memory_read_policy (disallowed_source_${m.metadata?.source})` };
            }
        }

        return { allowed: true };
    }

    /**
     * Resolves contradictions by preferring explicit over inferred, or more recent over older.
     * Two-pass approach:
     *  1. Explicit contradiction links via m.associations[type=contradicts]
     *  2. Semantic deduplication: detect overlapping claims and keep the most authoritative
     */
    /**
     * Resolves contradictions and deduplicates overlapping memories.
     * 
     * **Phases:**
     * 1. **Explicit Links**: Checks for `contradicts` associations in memory metadata.
     * 2. **Semantic Deduplication**: Identifies topically overlapping memories (keyword-based)
     *    and retains only the most authoritative version based on salience and source rank.
     */
    public static resolveContradictions(candidates: MemoryItem[]): MemoryItem[] {
        if (candidates.length < 2) return candidates;

        // Sort candidates: explicit source first, then by confidence*salience, then recency
        const sourceRank = (source?: string): number => {
            if (source === 'explicit') return 3;
            if (source === 'mem0' || source === 'conversation') return 2;
            if (source === 'rag') return 1;
            return 0;
        };

        const sortScore = (m: MemoryItem): number => {
            const confidence = m.metadata?.confidence ?? 0.5;
            const salience = m.metadata?.salience ?? 0.5;
            return (confidence * salience) + (sourceRank(m.metadata?.source) * 0.1);
        };

        const sorted = [...candidates].sort((a, b) => sortScore(b) - sortScore(a));
        const approved: MemoryItem[] = [];
        const rejected = new Set<string>();

        // Pass 1: Explicit association-based contradiction resolution
        const processed = new Set<string>();
        for (const m of sorted) {
            if (processed.has(m.id) || rejected.has(m.id)) continue;

            const rivals = m.associations?.filter(a => a.type === 'contradicts') || [];
            let isOutranked = false;

            for (const r of rivals) {
                if (processed.has(r.target_id)) {
                    isOutranked = true;
                    break;
                }
            }

            if (!isOutranked) {
                approved.push(m);
                processed.add(m.id);
                // Mark rivals as rejected
                for (const r of rivals) {
                    rejected.add(r.target_id);
                }
            }
        }

        // Pass 2: Semantic deduplication for memories without explicit associations
        // Detect likely topical conflicts by looking for short, overlapping keyword sets
        const finalApproved: MemoryItem[] = [];
        const topicGroups = new Map<string, MemoryItem>();

        for (const m of approved) {
            // Normalize: lowercase, strip punctuation, split to words
            const words = new Set(
                (m.text || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter((w: string) => w.length > 3)
            );
            // Find a topic key: the 2 highest-frequency content words
            const topicKey = [...words].slice(0, 2).sort().join('_');

            const existing = topicGroups.get(topicKey);
            if (!existing) {
                topicGroups.set(topicKey, m);
            } else {
                // Keep the more authoritative one
                if (sortScore(m) > sortScore(existing)) {
                    topicGroups.set(topicKey, m);
                    console.log(`[MemoryFilter] SEMANTIC_DEDUP: ${existing.id} outranked by ${m.id} on topic [${topicKey}]`);
                } else {
                    console.log(`[MemoryFilter] SEMANTIC_DEDUP: ${m.id} rejected, ${existing.id} wins on topic [${topicKey}]`);
                }
            }
        }

        return [...topicGroups.values()];
    }
}
