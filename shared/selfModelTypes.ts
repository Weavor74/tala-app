/**
 * selfModelTypes.ts — Shared Self-Model Type Definitions
 *
 * Phase 1 Self-Model Foundation
 *
 * Defines the canonical types for Tala's self-model system:
 * architectural invariants, runtime capabilities, component inventory,
 * ownership mapping, and query/snapshot contracts.
 *
 * These types are shared between the Electron main process and the renderer.
 */

// ─── Invariant types ──────────────────────────────────────────────────────────

export type InvariantCategory = 'architectural' | 'behavioral' | 'safety' | 'ethical';
export type InvariantStatus = 'active' | 'deprecated' | 'candidate';

export interface SelfModelInvariant {
    id: string;
    label: string;
    description: string;
    category: InvariantCategory;
    status: InvariantStatus;
    enforcedBy?: string;  // service/module name
    addedAt: string;      // ISO date
}

// ─── Capability types ─────────────────────────────────────────────────────────

export type CapabilityCategory = 'inference' | 'memory' | 'retrieval' | 'ui' | 'tools' | 'identity';
export type CapabilityStatus = 'available' | 'degraded' | 'unavailable' | 'optional';

export interface SelfModelCapability {
    id: string;
    label: string;
    description: string;
    category: CapabilityCategory;
    status: CapabilityStatus;
    requiredFor?: string[];  // feature names that require this capability
    addedAt: string;
}

// ─── Component types ──────────────────────────────────────────────────────────

export type ComponentLayer = 'renderer' | 'main' | 'shared' | 'mcp' | 'data';

export interface SelfModelComponent {
    id: string;
    label: string;
    layer: ComponentLayer;
    responsibilities: string[];
    ownedBy?: string;
    path?: string;
}

// ─── Ownership ────────────────────────────────────────────────────────────────

export interface OwnershipEntry {
    componentId: string;
    subsystem: string;
    layer: ComponentLayer;
    primaryFile: string;
}

// ─── Refresh result ───────────────────────────────────────────────────────────

export interface SelfModelRefreshResult {
    success: boolean;
    timestamp: string;
    invariantsLoaded: number;
    capabilitiesLoaded: number;
    componentsScanned: number;
    error?: string;
}

// ─── Full snapshot ────────────────────────────────────────────────────────────

export interface SelfModelSnapshot {
    generatedAt: string;
    invariants: SelfModelInvariant[];
    capabilities: SelfModelCapability[];
    components: SelfModelComponent[];
    ownershipMap: OwnershipEntry[];
}

// ─── IPC query types ──────────────────────────────────────────────────────────

export interface InvariantQueryResult {
    invariants: SelfModelInvariant[];
    total: number;
    filteredBy?: { category?: InvariantCategory; status?: InvariantStatus };
}

export interface CapabilityQueryResult {
    capabilities: SelfModelCapability[];
    total: number;
    filteredBy?: { category?: CapabilityCategory; status?: CapabilityStatus };
}

export interface ArchitectureSummary {
    totalInvariants: number;
    activeInvariants: number;
    totalCapabilities: number;
    availableCapabilities: number;
    totalComponents: number;
    lastRefreshed: string | null;
}
