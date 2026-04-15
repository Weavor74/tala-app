import type { CriticalSeamId, SeamContractDefinition } from './SeamContracts';

export type SeamStabilityClassification = 'stable' | 'guarded' | 'volatile' | 'unknown';

export type SeamStabilityReasonCode =
    | 'protected_seam_unchanged'
    | 'protected_change_with_contract_update'
    | 'protected_change_justified'
    | 'unjustified_protected_change'
    | 'contract_coverage_missing'
    | 'unknown_seam_state';

export interface SeamStabilityStatus {
    seamId: CriticalSeamId;
    protectionStatus: 'protected' | 'unprotected';
    recentStructuralChangeDetected: boolean;
    contractCoveragePresent: boolean;
    stabilityClassification: SeamStabilityClassification;
    reasonCodes: SeamStabilityReasonCode[];
}

export interface SeamStabilityReport {
    generatedAt: string;
    statuses: SeamStabilityStatus[];
}

export interface BuildSeamStabilityReportInput {
    seams: ReadonlyArray<SeamContractDefinition>;
    touchedSeamIds: Set<CriticalSeamId>;
    contractUpdatePresent: boolean;
    justificationUsed: boolean;
    governanceFailed: boolean;
    generatedAt?: string;
}

function classifySeamStatus(
    seam: SeamContractDefinition,
    touched: boolean,
    contractUpdatePresent: boolean,
    justificationUsed: boolean,
    governanceFailed: boolean
): SeamStabilityStatus {
    const contractCoveragePresent =
        seam.requiredInvariants.length > 0 &&
        seam.forbiddenBehaviors.length > 0 &&
        Boolean(seam.docPath);

    if (!contractCoveragePresent) {
        return {
            seamId: seam.id,
            protectionStatus: seam.protected ? 'protected' : 'unprotected',
            recentStructuralChangeDetected: touched,
            contractCoveragePresent,
            stabilityClassification: 'volatile',
            reasonCodes: ['contract_coverage_missing'],
        };
    }

    if (!touched) {
        return {
            seamId: seam.id,
            protectionStatus: seam.protected ? 'protected' : 'unprotected',
            recentStructuralChangeDetected: false,
            contractCoveragePresent,
            stabilityClassification: 'stable',
            reasonCodes: ['protected_seam_unchanged'],
        };
    }

    if (governanceFailed) {
        return {
            seamId: seam.id,
            protectionStatus: seam.protected ? 'protected' : 'unprotected',
            recentStructuralChangeDetected: true,
            contractCoveragePresent,
            stabilityClassification: 'volatile',
            reasonCodes: ['unjustified_protected_change'],
        };
    }

    if (contractUpdatePresent) {
        return {
            seamId: seam.id,
            protectionStatus: seam.protected ? 'protected' : 'unprotected',
            recentStructuralChangeDetected: true,
            contractCoveragePresent,
            stabilityClassification: 'guarded',
            reasonCodes: ['protected_change_with_contract_update'],
        };
    }

    if (justificationUsed) {
        return {
            seamId: seam.id,
            protectionStatus: seam.protected ? 'protected' : 'unprotected',
            recentStructuralChangeDetected: true,
            contractCoveragePresent,
            stabilityClassification: 'guarded',
            reasonCodes: ['protected_change_justified'],
        };
    }

    return {
        seamId: seam.id,
        protectionStatus: seam.protected ? 'protected' : 'unprotected',
        recentStructuralChangeDetected: true,
        contractCoveragePresent,
        stabilityClassification: 'unknown',
        reasonCodes: ['unknown_seam_state'],
    };
}

export function buildSeamStabilityReport(input: BuildSeamStabilityReportInput): SeamStabilityReport {
    const statuses = input.seams.map((seam) =>
        classifySeamStatus(
            seam,
            input.touchedSeamIds.has(seam.id),
            input.contractUpdatePresent,
            input.justificationUsed,
            input.governanceFailed
        )
    );

    return {
        generatedAt: input.generatedAt ?? new Date().toISOString(),
        statuses,
    };
}
