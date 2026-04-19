import { describe, expect, it } from 'vitest';
import { ChatExecutionSpine } from '../electron/services/execution/ChatExecutionSpine';

describe('Turn mode is immutable per turn', () => {
    it('keeps authoritative turn mode when configured settings mode differs', () => {
        const spine = new ChatExecutionSpine({} as any);
        const resolved = (spine as any).resolveAuthoritativeTurnMode(
            { capabilitiesOverride: { authoritativeTurnMode: 'rp' } },
            'assistant',
            'turn-immutable',
        );
        expect(resolved).toBe('rp');
    });
});

