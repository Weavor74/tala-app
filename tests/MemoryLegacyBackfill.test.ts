import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryService, type MemoryItem } from '../electron/services/MemoryService';
import { LegacyMemoryBackfillService } from '../electron/services/memory/LegacyMemoryBackfillService';
import { MemoryAuthorityService } from '../electron/services/memory/MemoryAuthorityService';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

const repoState = vi.hoisted(() => ({ repo: null as any }));
vi.mock('../electron/services/db/initMemoryStore', () => ({
  getCanonicalMemoryRepository: () => repoState.repo,
}));

function makeLegacyMemory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = Date.now();
  return {
    id: 'legacy-1',
    text: 'Legacy memory content',
    metadata: { source: 'legacy-local', role: 'core' },
    timestamp: now,
    salience: 0.5,
    confidence: 0.7,
    created_at: now,
    last_accessed_at: null,
    last_reinforced_at: null,
    access_count: 0,
    associations: [],
    status: 'active',
    ...overrides,
  };
}

function makeAuthorityMock() {
  return {
    detectDuplicates: vi.fn(),
    tryCreateCanonicalMemory: vi.fn(),
  } as unknown as MemoryAuthorityService & {
    detectDuplicates: ReturnType<typeof vi.fn>;
    tryCreateCanonicalMemory: ReturnType<typeof vi.fn>;
  };
}

function setCanonicalRepoStatus(statusById: Record<string, 'canonical' | 'superseded' | 'tombstoned'>): void {
  repoState.repo = {
    getSharedPool: () => ({
      query: vi.fn().mockImplementation((_sql: string, params?: unknown[]) => {
        const id = String((params ?? [])[0] ?? '');
        const status = statusById[id];
        return Promise.resolve({ rows: status ? [{ authority_status: status }] : [] });
      }),
    }),
  };
}

describe('LegacyMemoryBackfillService', () => {
  beforeEach(() => {
    repoState.repo = null;
  });

  it('canonicalizes eligible legacy memory through authority and anchors local projection', async () => {
    const canonicalId = '00000000-0000-0000-0000-0000000000a1';
    setCanonicalRepoStatus({ [canonicalId]: 'canonical' });

    const memoryService = new MemoryService();
    (memoryService as unknown as { localMemories: MemoryItem[] }).localMemories = [
      makeLegacyMemory({ id: 'legacy-a1', text: 'Remember project kickoff details' }),
    ];

    const authority = makeAuthorityMock();
    authority.detectDuplicates.mockResolvedValue({
      duplicate_found: false,
      matched_memory_id: null,
      match_score: 0,
      match_kind: 'none',
    });
    authority.tryCreateCanonicalMemory.mockResolvedValue({
      success: true,
      data: canonicalId,
      durationMs: 1,
    });

    const service = new LegacyMemoryBackfillService(authority, memoryService);
    const report = await service.backfillLegacyMemories({ fullBackfill: true });

    expect(report.scanned_count).toBe(1);
    expect(report.eligible_count).toBe(1);
    expect(report.migrated_count).toBe(1);
    expect(report.failed_count).toBe(0);
    expect(report.outcomes[0]?.status).toBe('migrated');
    expect(authority.tryCreateCanonicalMemory).toHaveBeenCalledTimes(1);

    const authoritative = await memoryService.getAll();
    expect(authoritative).toHaveLength(1);
    expect(authoritative[0]?.metadata?.canonical_memory_id).toBe(canonicalId);
  });

  it('links duplicate legacy memory to existing canonical record instead of creating duplicates', async () => {
    const canonicalId = '00000000-0000-0000-0000-0000000000a2';
    setCanonicalRepoStatus({ [canonicalId]: 'canonical' });

    const memoryService = new MemoryService();
    (memoryService as unknown as { localMemories: MemoryItem[] }).localMemories = [
      makeLegacyMemory({ id: 'legacy-a2', text: 'Existing canonical memory equivalent' }),
    ];

    const authority = makeAuthorityMock();
    authority.detectDuplicates.mockResolvedValue({
      duplicate_found: true,
      matched_memory_id: canonicalId,
      match_score: 1,
      match_kind: 'exact',
    });
    authority.tryCreateCanonicalMemory.mockResolvedValue({
      success: true,
      data: 'should-not-be-used',
      durationMs: 1,
    });

    const service = new LegacyMemoryBackfillService(authority, memoryService);
    const report = await service.backfillLegacyMemories({ fullBackfill: true });

    expect(report.duplicate_merged_count).toBe(1);
    expect(report.migrated_count).toBe(0);
    expect(report.outcomes[0]?.status).toBe('linked_existing');
    expect(authority.tryCreateCanonicalMemory).not.toHaveBeenCalled();
  });

  it('quarantines invalid legacy records and skips inactive records without canonicalizing', async () => {
    const memoryService = new MemoryService();
    (memoryService as unknown as { localMemories: MemoryItem[] }).localMemories = [
      makeLegacyMemory({ id: 'legacy-empty', text: '   ', status: 'active' }),
      makeLegacyMemory({ id: 'legacy-archived', text: 'Old archived note', status: 'archived' }),
    ];

    const authority = makeAuthorityMock();
    authority.detectDuplicates.mockResolvedValue({
      duplicate_found: false,
      matched_memory_id: null,
      match_score: 0,
      match_kind: 'none',
    });
    authority.tryCreateCanonicalMemory.mockResolvedValue({
      success: true,
      data: '00000000-0000-0000-0000-0000000000a3',
      durationMs: 1,
    });

    const service = new LegacyMemoryBackfillService(authority, memoryService);
    const report = await service.backfillLegacyMemories({ fullBackfill: true });

    expect(report.eligible_count).toBe(0);
    expect(report.quarantined_count).toBe(1);
    expect(report.skipped_count).toBe(1);
    expect(report.migrated_count).toBe(0);
    expect(authority.detectDuplicates).not.toHaveBeenCalled();
    expect(authority.tryCreateCanonicalMemory).not.toHaveBeenCalled();
  });

  it('supports dry-run mode without canonical writes', async () => {
    const memoryService = new MemoryService();
    (memoryService as unknown as { localMemories: MemoryItem[] }).localMemories = [
      makeLegacyMemory({ id: 'legacy-dry-run', text: 'Dry run candidate memory' }),
    ];

    const authority = makeAuthorityMock();
    authority.detectDuplicates.mockResolvedValue({
      duplicate_found: false,
      matched_memory_id: null,
      match_score: 0,
      match_kind: 'none',
    });

    const service = new LegacyMemoryBackfillService(authority, memoryService);
    const report = await service.backfillLegacyMemories({ dryRun: true, fullBackfill: true });

    expect(report.dry_run).toBe(true);
    expect(report.scanned_count).toBe(1);
    expect(report.eligible_count).toBe(1);
    expect(report.migrated_count).toBe(0);
    expect(report.skipped_count).toBe(1);
    expect(authority.detectDuplicates).not.toHaveBeenCalled();
    expect(authority.tryCreateCanonicalMemory).not.toHaveBeenCalled();
  });

  it('is repeat-safe: second run does not remigrate already anchored records', async () => {
    const canonicalId = '00000000-0000-0000-0000-0000000000a4';
    setCanonicalRepoStatus({ [canonicalId]: 'canonical' });

    const memoryService = new MemoryService();
    (memoryService as unknown as { localMemories: MemoryItem[] }).localMemories = [
      makeLegacyMemory({ id: 'legacy-repeat', text: 'Repeat-safe legacy memory' }),
    ];

    const authority = makeAuthorityMock();
    authority.detectDuplicates.mockResolvedValue({
      duplicate_found: false,
      matched_memory_id: null,
      match_score: 0,
      match_kind: 'none',
    });
    authority.tryCreateCanonicalMemory.mockResolvedValue({
      success: true,
      data: canonicalId,
      durationMs: 1,
    });

    const service = new LegacyMemoryBackfillService(authority, memoryService);
    const first = await service.backfillLegacyMemories({ fullBackfill: true });
    const second = await service.backfillLegacyMemories({ fullBackfill: true });

    expect(first.migrated_count).toBe(1);
    expect(second.scanned_count).toBe(0);
    expect(second.migrated_count).toBe(0);
    expect(authority.tryCreateCanonicalMemory).toHaveBeenCalledTimes(1);
  });

  it('reports partial failures when canonicalization succeeds but projection re-anchoring fails', async () => {
    const canonicalId = '00000000-0000-0000-0000-0000000000a5';
    setCanonicalRepoStatus({});

    const memoryService = new MemoryService();
    (memoryService as unknown as { localMemories: MemoryItem[] }).localMemories = [
      makeLegacyMemory({ id: 'legacy-anchor-fail', text: 'Anchor failure memory' }),
    ];

    const authority = makeAuthorityMock();
    authority.detectDuplicates.mockResolvedValue({
      duplicate_found: false,
      matched_memory_id: null,
      match_score: 0,
      match_kind: 'none',
    });
    authority.tryCreateCanonicalMemory.mockResolvedValue({
      success: true,
      data: canonicalId,
      durationMs: 1,
    });

    const service = new LegacyMemoryBackfillService(authority, memoryService);
    const report = await service.backfillLegacyMemories({ fullBackfill: true });

    expect(report.failed_count).toBe(1);
    expect(report.partial_failure).toBe(true);
    expect(report.outcomes[0]?.status).toBe('failed');
    expect(report.outcomes[0]?.reason).toContain('Canonical memory not found');
  });
});
