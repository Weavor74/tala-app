import { MemoryItem } from '../../services/MemoryService';

/**
 * Mock Memory Service for Router/Filter testing.
 * Prevents actual DB/Vector calls during unit tests.
 */
export class MockMemoryService {
    private memories: MemoryItem[] = [];
    public mockResults: any[] = [];

    public setMemories(memories: MemoryItem[]) {
        this.memories = memories;
    }

    public async search(query: string, limit: number, mode: string): Promise<MemoryItem[]> {
        if (this.mockResults.length > 0) {
            return this.mockResults;
        }
        // Simple mock search: filter by mode_scope if present in metadata
        return this.memories.filter(m => {
            if (!m.metadata?.role) return true;
            if (mode === 'rp') return m.metadata.role === 'rp';
            if (mode === 'assistant') return m.metadata.role !== 'rp';
            return true;
        }).slice(0, limit);
    }
}

/**
 * Validation Helper for Prompt Audit Logs
 */
export class AuditLogValidator {
    public static validateLog(log: string, expected: { intent?: string, count?: number }) {
        if (expected.intent && !log.includes(`intent=${expected.intent}`)) {
            throw new Error(`Audit Log missing intent: ${expected.intent}`);
        }
        if (expected.count !== undefined && !log.includes(`count=${expected.count}`)) {
            throw new Error(`Audit Log mismatch count: expected ${expected.count}`);
        }
        return true;
    }
}
