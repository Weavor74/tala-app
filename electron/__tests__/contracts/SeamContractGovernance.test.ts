import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    SEAM_CONTRACTS,
    getSeamContractById,
    listCriticalSeamIds,
} from '../../../shared/governance/SeamContracts';

const ROOT = path.resolve(__dirname, '../../..');

describe('Seam contract governance', () => {
    it('declares all critical seam contracts with docs and doctrine payloads', () => {
        const seamIds = listCriticalSeamIds().sort();
        expect(seamIds).toEqual([
            'diagnostics_truth_contracts',
            'runtime_mode_control',
            'storage_authority',
            'workspace_surfaces',
        ]);

        for (const seam of SEAM_CONTRACTS) {
            expect(seam.protected).toBe(true);
            expect(seam.requiredInvariants.length).toBeGreaterThan(0);
            expect(seam.forbiddenBehaviors.length).toBeGreaterThan(0);
            expect(seam.requiredDiagnosticsFields.length).toBeGreaterThan(0);
            expect(seam.requiredTestCoverageTags.length).toBeGreaterThan(0);
            expect(seam.changeControlLevel).toBe('strict');
            const docPath = path.join(ROOT, seam.docPath);
            expect(fs.existsSync(docPath)).toBe(true);
        }
    });

    it('enforces storage authority doctrine in contract metadata', () => {
        const seam = getSeamContractById('storage_authority');
        expect(seam).toBeDefined();
        expect(seam?.requiredInvariants).toContain('postgres_is_canonical_authority');
        expect(seam?.requiredInvariants).toContain('pgvector_is_capability_not_authority');
        expect(seam?.requiredInvariants).toContain('degraded_state_does_not_reassign_canonical_authority');
        expect(seam?.forbiddenBehaviors).toContain('silent_canonical_reassignment_on_degraded_or_unreachable_state');
    });

    it('enforces diagnostics truth doctrine in contract metadata', () => {
        const seam = getSeamContractById('diagnostics_truth_contracts');
        expect(seam).toBeDefined();
        expect(seam?.requiredInvariants).toContain('machine_usable_reason_codes_required_for_material_states');
        expect(seam?.requiredInvariants).toContain('evidence_links_explicitly_present_or_marked_unavailable');
        expect(seam?.requiredInvariants).toContain('renderer_cannot_fabricate_backend_truth');
        expect(seam?.forbiddenBehaviors).toContain('optimistic_health_without_backend_evidence');
    });

    it('enforces runtime mode doctrine in contract metadata', () => {
        const seam = getSeamContractById('runtime_mode_control');
        expect(seam).toBeDefined();
        expect(seam?.forbiddenBehaviors).toContain('renderer_authority_inference_for_runtime_mode');
        expect(seam?.forbiddenBehaviors).toContain('implicit_action_availability_for_critical_controls');
        expect(seam?.requiredInvariants).toContain('runtime_mode_authority_is_singular_and_backend_owned');
    });

    it('enforces workspace surfaces doctrine in contract metadata', () => {
        const seam = getSeamContractById('workspace_surfaces');
        expect(seam).toBeDefined();
        expect(seam?.requiredInvariants).toContain('controls_are_registered_not_inferred');
        expect(seam?.requiredInvariants).toContain('surface_state_is_serializable_and_versioned');
        expect(seam?.requiredInvariants).toContain('invalid_or_unsupported_surface_state_degrades_explicitly');
        expect(seam?.forbiddenBehaviors).toContain('non_serializable_surface_state_persistence');
    });
});
