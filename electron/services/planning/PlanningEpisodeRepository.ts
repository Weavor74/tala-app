import { v4 as uuidv4 } from 'uuid';
import type { Pool } from 'pg';
import type {
    PlanningEpisode,
    PlanningSimilarityFeatures,
    StrategyPatternBias,
    ToolReliabilityBias,
} from '../../../shared/planning/PlanningMemoryTypes';
import { getCanonicalMemoryRepository } from '../db/initMemoryStore';
import { PostgresMemoryRepository } from '../db/PostgresMemoryRepository';

const PLANNING_EPISODE_TYPE = 'planning_episode';
const PLANNING_EPISODE_META_KEY = 'planning_episode_v1';
const MAX_CACHE_SIZE = 500;

function clamp01(value: number): number {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

function calculateEpisodeSimilarity(
    episode: PlanningEpisode,
    features: PlanningSimilarityFeatures,
): number {
    let score = 0;
    let weight = 0;

    const addWeighted = (matched: boolean, w: number): void => {
        weight += w;
        if (matched) score += w;
    };

    addWeighted(episode.similarityFeatures.goalClass === features.goalClass, 4);
    addWeighted(episode.similarityFeatures.requestCategory === features.requestCategory, 2);
    addWeighted(episode.similarityFeatures.userIntentClass === features.userIntentClass, 1);
    addWeighted(
        (episode.similarityFeatures.requiresRetrieval ?? false) ===
        (features.requiresRetrieval ?? false),
        1,
    );
    addWeighted(
        (episode.similarityFeatures.requiresArtifacts ?? false) ===
        (features.requiresArtifacts ?? false),
        1,
    );
    addWeighted(
        (episode.similarityFeatures.requiresCodeChange ?? false) ===
        (features.requiresCodeChange ?? false),
        1,
    );
    addWeighted(
        (episode.similarityFeatures.requiresVerification ?? false) ===
        (features.requiresVerification ?? false),
        1,
    );
    addWeighted(
        (episode.similarityFeatures.requiresExternalIO ?? false) ===
        (features.requiresExternalIO ?? false),
        1,
    );
    addWeighted(episode.similarityFeatures.riskLevel === features.riskLevel, 1);

    const expectedDomains = new Set(features.toolingDomain ?? []);
    const observedDomains = new Set(episode.similarityFeatures.toolingDomain ?? []);
    if (expectedDomains.size > 0 || observedDomains.size > 0) {
        weight += 2;
        let overlap = 0;
        for (const d of expectedDomains) {
            if (observedDomains.has(d)) overlap++;
        }
        score += Math.min(2, overlap);
    }

    if (weight === 0) return 0;
    return clamp01(score / weight);
}

export class PlanningEpisodeRepository {
    private readonly _episodes = new Map<string, PlanningEpisode>();
    private readonly _orderedEpisodeIds: string[] = [];
    private readonly _pool: Pool | null;
    private _canonicalLoaded = false;

    constructor(pool?: Pool | null) {
        this._pool = pool ?? this._resolveCanonicalPool();
        void this.refreshFromCanonical();
    }

    createEpisode(
        input: Omit<PlanningEpisode, 'id' | 'createdAt'> & {
            id?: string;
            createdAt?: string;
        },
    ): PlanningEpisode {
        const episode: PlanningEpisode = {
            ...input,
            id: input.id ?? uuidv4(),
            createdAt: input.createdAt ?? new Date().toISOString(),
        };
        this._upsertCache(episode);
        this._persistEpisode(episode);
        return episode;
    }

    completeEpisode(
        id: string,
        update: Partial<Omit<PlanningEpisode, 'id' | 'createdAt'>>,
    ): PlanningEpisode | undefined {
        const existing = this._episodes.get(id);
        if (!existing) return undefined;
        const merged: PlanningEpisode = {
            ...existing,
            ...update,
            id: existing.id,
            createdAt: existing.createdAt,
        };
        this._upsertCache(merged);
        this._persistEpisode(merged);
        return merged;
    }

    querySimilarEpisodes(
        features: PlanningSimilarityFeatures,
        options?: { limit?: number; minSimilarity?: number },
    ): PlanningEpisode[] {
        const limit = options?.limit ?? 10;
        const minSimilarity = options?.minSimilarity ?? 0.45;

        return this._orderedEpisodeIds
            .map(id => this._episodes.get(id))
            .filter((ep): ep is PlanningEpisode => ep !== undefined)
            .map(ep => ({
                ep,
                similarity: calculateEpisodeSimilarity(ep, features),
            }))
            .filter(item => item.similarity >= minSimilarity)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit)
            .map(item => item.ep);
    }

    summarizeStrategyPatterns(episodes: PlanningEpisode[]): StrategyPatternBias[] {
        const buckets = new Map<
            string,
            {
                strategyFamily: NonNullable<PlanningEpisode['strategyFamily']>;
                total: number;
                successes: number;
                failures: number;
            }
        >();

        for (const ep of episodes) {
            if (!ep.strategyFamily) continue;
            const key = ep.strategyFamily;
            const bucket = buckets.get(key) ?? {
                strategyFamily: ep.strategyFamily,
                total: 0,
                successes: 0,
                failures: 0,
            };
            bucket.total++;
            if (ep.outcome === 'succeeded' || ep.outcome === 'partially_succeeded') bucket.successes++;
            if (ep.outcome === 'failed' || ep.outcome === 'blocked' || ep.outcome === 'abandoned') bucket.failures++;
            buckets.set(key, bucket);
        }

        return Array.from(buckets.values())
            .map(bucket => {
                const successRate = bucket.total > 0 ? bucket.successes / bucket.total : 0;
                const preferred = bucket.total >= 2 && successRate >= 0.6;
                const avoid = bucket.total >= 2 && bucket.failures / bucket.total >= 0.6;
                const reasonCodes: string[] = [];
                if (preferred) reasonCodes.push('memory:similar_task_preferred_strategy');
                if (avoid) reasonCodes.push('memory:similar_task_avoid_strategy');
                return {
                    strategyFamily: bucket.strategyFamily,
                    preferred,
                    avoid,
                    reasonCodes,
                    supportingEpisodeCount: bucket.total,
                    successRate: clamp01(successRate),
                };
            })
            .sort((a, b) => b.supportingEpisodeCount - a.supportingEpisodeCount);
    }

    summarizeToolPatterns(episodes: PlanningEpisode[]): ToolReliabilityBias[] {
        const buckets = new Map<
            string,
            {
                toolId: string;
                total: number;
                successes: number;
                failures: number;
                failurePatterns: Map<string, number>;
            }
        >();

        for (const ep of episodes) {
            for (const toolId of ep.toolIds) {
                const bucket = buckets.get(toolId) ?? {
                    toolId,
                    total: 0,
                    successes: 0,
                    failures: 0,
                    failurePatterns: new Map<string, number>(),
                };
                bucket.total++;
                if (ep.outcome === 'succeeded' || ep.outcome === 'partially_succeeded') bucket.successes++;
                if (ep.outcome === 'failed' || ep.outcome === 'blocked' || ep.outcome === 'abandoned') {
                    bucket.failures++;
                    if (ep.failureClass) {
                        bucket.failurePatterns.set(
                            ep.failureClass,
                            (bucket.failurePatterns.get(ep.failureClass) ?? 0) + 1,
                        );
                    }
                }
                buckets.set(toolId, bucket);
            }
        }

        return Array.from(buckets.values())
            .map(bucket => {
                const successRate = bucket.total > 0 ? bucket.successes / bucket.total : 0;
                const preferred = bucket.total >= 2 && successRate >= 0.65;
                const avoid = bucket.total >= 2 && bucket.failures / bucket.total >= 0.6;
                const failurePatterns = Array.from(bucket.failurePatterns.entries())
                    .sort((a, b) => b[1] - a[1])
                    .map(([pattern]) => pattern);
                const reasonCodes: string[] = [];
                if (preferred) reasonCodes.push('memory:tool_success_pattern');
                if (avoid) reasonCodes.push('memory:tool_failure_pattern');
                return {
                    toolId: bucket.toolId,
                    preferred,
                    avoid,
                    reasonCodes,
                    successRate: clamp01(successRate),
                    failurePatterns,
                };
            })
            .sort((a, b) => (b.successRate ?? 0) - (a.successRate ?? 0));
    }

    summarizeFailurePatterns(episodes: PlanningEpisode[]): string[] {
        const counts = new Map<string, number>();
        for (const ep of episodes) {
            if (!ep.failureClass) continue;
            counts.set(ep.failureClass, (counts.get(ep.failureClass) ?? 0) + 1);
        }
        return Array.from(counts.entries())
            .filter(([, count]) => count >= 2)
            .sort((a, b) => b[1] - a[1])
            .map(([pattern]) => pattern);
    }

    summarizeRecoveryPatterns(episodes: PlanningEpisode[]): string[] {
        const counts = new Map<string, number>();
        for (const ep of episodes) {
            if (!ep.recoveryAction) continue;
            counts.set(ep.recoveryAction, (counts.get(ep.recoveryAction) ?? 0) + 1);
        }
        return Array.from(counts.entries())
            .filter(([, count]) => count >= 2)
            .sort((a, b) => b[1] - a[1])
            .map(([pattern]) => pattern);
    }

    async refreshFromCanonical(): Promise<void> {
        if (!this._pool || this._canonicalLoaded) return;
        try {
            const res = await this._pool.query<{
                id: string;
                created_at: string;
                observed_at: string;
                metadata: Record<string, unknown>;
            }>(
                `SELECT id::text AS id, created_at::text, observed_at::text, metadata
                   FROM episodes
                  WHERE episode_type = $1
               ORDER BY observed_at DESC
                  LIMIT $2`,
                [PLANNING_EPISODE_TYPE, MAX_CACHE_SIZE],
            );
            for (const row of res.rows) {
                const parsed = this._decodeEpisodeFromMetadata(row.metadata, row.id, row.created_at, row.observed_at);
                if (parsed) this._upsertCache(parsed);
            }
            this._canonicalLoaded = true;
        } catch {
            // Non-fatal: planning memory remains runtime-local if canonical read fails.
        }
    }

    private _resolveCanonicalPool(): Pool | null {
        const repo = getCanonicalMemoryRepository();
        if (!repo) return null;
        if (repo instanceof PostgresMemoryRepository) {
            try {
                return repo.getSharedPool();
            } catch {
                return null;
            }
        }
        return null;
    }

    private _persistEpisode(episode: PlanningEpisode): void {
        if (!this._pool) return;
        const payload = {
            [PLANNING_EPISODE_META_KEY]: episode,
        };
        void this._pool.query(
            `INSERT INTO episodes (
                id,
                episode_type,
                title,
                summary,
                content,
                source_type,
                source_ref,
                importance,
                confidence,
                observed_at,
                metadata
            ) VALUES (
                $1::uuid,
                $2,
                $3,
                $4,
                $5,
                'planning',
                $6,
                0,
                $7,
                $8::timestamptz,
                $9::jsonb
            )
            ON CONFLICT (id) DO UPDATE SET
                title = EXCLUDED.title,
                summary = EXCLUDED.summary,
                content = EXCLUDED.content,
                source_ref = EXCLUDED.source_ref,
                confidence = EXCLUDED.confidence,
                observed_at = EXCLUDED.observed_at,
                metadata = EXCLUDED.metadata`,
            [
                episode.id,
                PLANNING_EPISODE_TYPE,
                `planning:${episode.goalClass}`,
                `${episode.outcome}:${episode.strategyFamily ?? 'unknown'}`,
                JSON.stringify({
                    outcome: episode.outcome,
                    failureClass: episode.failureClass ?? null,
                    recoveryAction: episode.recoveryAction ?? null,
                }),
                episode.goalClass,
                0.5,
                episode.createdAt,
                JSON.stringify(payload),
            ],
        ).catch(() => {
            // Non-fatal: cache remains authoritative for current process.
        });
    }

    private _decodeEpisodeFromMetadata(
        metadata: Record<string, unknown> | null | undefined,
        fallbackId: string,
        createdAt: string,
        observedAt: string,
    ): PlanningEpisode | null {
        if (!metadata || typeof metadata !== 'object') return null;
        const embedded = metadata[PLANNING_EPISODE_META_KEY];
        if (!embedded || typeof embedded !== 'object') return null;
        const candidate = embedded as Partial<PlanningEpisode>;
        if (!candidate.goalClass || !candidate.similarityFeatures || !candidate.outcome) return null;
        return {
            ...candidate,
            id: candidate.id ?? fallbackId,
            createdAt: candidate.createdAt ?? createdAt ?? observedAt,
            toolIds: Array.isArray(candidate.toolIds) ? candidate.toolIds : [],
            workflowIds: Array.isArray(candidate.workflowIds) ? candidate.workflowIds : [],
            runtimeConditions: candidate.runtimeConditions ?? {},
            similarityFeatures: candidate.similarityFeatures,
            outcome: candidate.outcome,
            goalClass: candidate.goalClass,
        };
    }

    private _upsertCache(episode: PlanningEpisode): void {
        const exists = this._episodes.has(episode.id);
        this._episodes.set(episode.id, episode);
        if (!exists) {
            this._orderedEpisodeIds.unshift(episode.id);
            if (this._orderedEpisodeIds.length > MAX_CACHE_SIZE) {
                const removed = this._orderedEpisodeIds.splice(MAX_CACHE_SIZE);
                for (const id of removed) this._episodes.delete(id);
            }
        }
    }
}

