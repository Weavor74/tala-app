/**
 * SettingsManagerNormalization.test.ts
 *
 * Regression coverage for the SettingsManager provider normalization contract.
 *
 * These tests lock in the two-stage normalization applied to search provider
 * entries loaded from settings:
 *
 *   Stage 1 — Legacy ID migration
 *     Rewrites 'default-brave' / 'default-google' / 'default-serper' /
 *     'default-tavily' to canonical short IDs and corrects the 'type' field.
 *
 *   Stage 2 — ID/type mismatch guard
 *     Detects entries like {id:'google', type:'brave'} and corrects 'type'.
 *     This prevents corrupt settings from routing external:google to the
 *     Brave endpoint (or vice versa).
 *
 * Tests use the exported normalizeProviderEntry() function directly so they
 * do not require a real settings file on disk.
 */

import { describe, it, expect } from 'vitest';
import { normalizeProviderEntry } from '../electron/services/SettingsManager';

describe('SettingsManager — normalizeProviderEntry', () => {

    // ── Stage 1: Legacy ID migration ──────────────────────────────────────────

    describe('Stage 1: legacy ID migration', () => {
        it('normalizes default-brave to canonical brave id and type', () => {
            const result = normalizeProviderEntry({ id: 'default-brave', type: 'brave', name: 'Brave', enabled: true });
            expect(result.id).toBe('brave');
            expect(result.type).toBe('brave');
        });

        it('normalizes default-google to canonical google id and type', () => {
            const result = normalizeProviderEntry({ id: 'default-google', type: 'google', name: 'Google', enabled: true });
            expect(result.id).toBe('google');
            expect(result.type).toBe('google');
        });

        it('normalizes default-serper to canonical serper id and type', () => {
            const result = normalizeProviderEntry({ id: 'default-serper', type: 'serper', name: 'Serper', enabled: true });
            expect(result.id).toBe('serper');
            expect(result.type).toBe('serper');
        });

        it('normalizes default-tavily to canonical tavily id and type', () => {
            const result = normalizeProviderEntry({ id: 'default-tavily', type: 'tavily', name: 'Tavily', enabled: true });
            expect(result.id).toBe('tavily');
            expect(result.type).toBe('tavily');
        });

        it('corrects mismatched type when migrating legacy id (default-google with type brave)', () => {
            // Corrupt legacy entry: id was default-google but type was set to brave
            const result = normalizeProviderEntry({ id: 'default-google', type: 'brave', name: 'Mix', enabled: true });
            expect(result.id).toBe('google');
            expect(result.type).toBe('google');
        });

        it('migrates legacy id even when type is missing, adding the canonical type', () => {
            const result = normalizeProviderEntry({ id: 'default-brave', name: 'Brave', enabled: true });
            expect(result.id).toBe('brave');
            // canonical type is added when migrating from a legacy id
            expect(result.type).toBe('brave');
        });

        it('preserves all other fields when migrating legacy id', () => {
            const result = normalizeProviderEntry({
                id: 'default-brave',
                type: 'brave',
                name: 'Brave Search',
                enabled: true,
                apiKey: 'key-abc',
                endpoint: 'https://api.search.brave.com',
            });
            expect(result.name).toBe('Brave Search');
            expect(result.enabled).toBe(true);
            expect(result.apiKey).toBe('key-abc');
            expect(result.endpoint).toBe('https://api.search.brave.com');
        });
    });

    // ── Stage 2: ID/type mismatch guard ───────────────────────────────────────

    describe('Stage 2: id/type mismatch guard', () => {
        it('corrects type when id is google but type is brave (the critical drift scenario)', () => {
            // This is the exact corruption vector: external:google would route to Brave
            const result = normalizeProviderEntry({ id: 'google', type: 'brave', name: 'Google', enabled: true });
            expect(result.id).toBe('google');
            expect(result.type).toBe('google');
        });

        it('corrects type when id is brave but type is google', () => {
            const result = normalizeProviderEntry({ id: 'brave', type: 'google', name: 'Brave', enabled: true });
            expect(result.id).toBe('brave');
            expect(result.type).toBe('brave');
        });

        it('corrects type when id is serper but type is tavily', () => {
            const result = normalizeProviderEntry({ id: 'serper', type: 'tavily', name: 'Serper', enabled: true });
            expect(result.id).toBe('serper');
            expect(result.type).toBe('serper');
        });

        it('does not modify a correctly-formed provider', () => {
            const input = { id: 'brave', type: 'brave', name: 'Brave', enabled: true, apiKey: 'k' };
            const result = normalizeProviderEntry({ ...input });
            expect(result).toEqual(input);
        });

        it('does not modify providers with unknown ids (passthrough)', () => {
            const input = { id: 'custom-provider', type: 'rest', name: 'Custom', enabled: true };
            const result = normalizeProviderEntry({ ...input });
            expect(result).toEqual(input);
        });

        it('does not modify a provider with no type field (unknown custom entry)', () => {
            const input = { id: 'my-api', name: 'My API', enabled: true };
            const result = normalizeProviderEntry({ ...input });
            expect(result).toEqual(input);
        });

        it('preserves all other fields when correcting mismatch', () => {
            const result = normalizeProviderEntry({
                id: 'google',
                type: 'brave',
                name: 'Google via corrupt settings',
                enabled: true,
                apiKey: 'google-key',
                endpoint: 'https://serpapi.com',
            });
            expect(result.id).toBe('google');
            expect(result.type).toBe('google');
            expect(result.name).toBe('Google via corrupt settings');
            expect(result.enabled).toBe(true);
            expect(result.apiKey).toBe('google-key');
            expect(result.endpoint).toBe('https://serpapi.com');
        });
    });
});
