import type { SelfKnowledgeAspect } from '../../../shared/agent/SelfKnowledgeIntent';
import { resolveSelfKnowledgeRequest } from '../../../shared/agent/SelfKnowledgeIntent';

type SelfModelCapabilityLike = {
    id: string;
    category?: string;
    status?: string;
};

type SelfModelInvariantLike = {
    id: string;
    statement?: string;
    category?: string;
    status?: string;
};

type SelfModelArchitectureLike = {
    totalInvariants?: number;
    activeInvariants?: number;
    totalCapabilities?: number;
    availableCapabilities?: number;
    totalComponents?: number;
};

export type SelfKnowledgeSnapshot = {
    identity: {
        agentName?: string;
        runtimeRole?: string;
        personaMode?: string;
        summary?: string;
    };
    capabilities: {
        filesystemRead: boolean;
        filesystemWrite: boolean;
        toolUsage: boolean;
        memoryRead: boolean;
        memoryWrite: boolean;
        selfInspection: boolean;
        reflectionAccess: boolean;
        architectureAccess: boolean;
        invariantsAccess: boolean;
    };
    currentTurn: {
        writesAllowed: boolean;
        toolsAllowed: boolean;
        mode?: string;
        blockedDomains?: string[];
        reasonCodes?: string[];
    };
    runtime: {
        selfModelAvailable: boolean;
        toolRegistryAvailable: boolean;
        memoryAvailable?: boolean;
        graphAvailable?: boolean;
        filesystemAvailable?: boolean;
        degradedReasons?: string[];
    };
    tools: Array<{
        id: string;
        server?: string;
        category?: string;
        available: boolean;
    }>;
    architecture?: {
        summary?: string;
        invariants?: string[];
        capabilitiesSummary?: string;
    };
    permissions?: {
        allowedRoot?: string;
        writePolicy?: string;
    };
};

export type SelfKnowledgeExecutionResult = {
    executed: boolean;
    snapshot: SelfKnowledgeSnapshot;
    sourceTruths: string[];
    blockedReason?: string;
    summary: string;
};

export interface ToolRegistryLike {
    getAllTools?: () => Array<{ name?: string; source?: string; description?: string }>;
}

export interface SelfModelAppServiceLike {
    getCapabilities?: () => Array<SelfModelCapabilityLike>;
    queryCapabilities?: () => { capabilities: Array<SelfModelCapabilityLike> };
    getArchitectureSummary?: () => SelfModelArchitectureLike;
    getInvariants?: () => Array<SelfModelInvariantLike>;
    queryInvariants?: () => { invariants: Array<SelfModelInvariantLike> };
}

export interface RuntimeDiagnosticsLike {
    getSnapshot?: () => {
        systemHealth?: {
            active_degradation_flags?: string[];
            capability_matrix?: Array<{ capability: string; status: string }>;
        };
        degradedSubsystems?: string[];
    };
}

export interface FilesystemPolicyLike {
    getAllowedRoot?: () => string | undefined;
    getWritePolicy?: () => string | undefined;
}

function summarizeCapabilities(snapshot: SelfKnowledgeSnapshot): string {
    const cap = snapshot.capabilities;
    return [
        `filesystemRead=${cap.filesystemRead}`,
        `filesystemWrite=${cap.filesystemWrite}`,
        `toolUsage=${cap.toolUsage}`,
        `memoryRead=${cap.memoryRead}`,
        `memoryWrite=${cap.memoryWrite}`,
        `architectureAccess=${cap.architectureAccess}`,
    ].join(', ');
}

function buildBroadSummary(snapshot: SelfKnowledgeSnapshot, sourceTruths: string[]): string {
    const parts: string[] = [];
    const identity = snapshot.identity.summary
        ?? `I am ${snapshot.identity.agentName ?? 'Tala'}, a local agent runtime.`;
    parts.push(identity);
    parts.push(`Capabilities: ${summarizeCapabilities(snapshot)}.`);
    parts.push(
        `Current turn: toolsAllowed=${snapshot.currentTurn.toolsAllowed}, writesAllowed=${snapshot.currentTurn.writesAllowed}, mode=${snapshot.currentTurn.mode ?? 'unknown'}.`,
    );
    if ((snapshot.runtime.degradedReasons ?? []).length > 0) {
        parts.push(`Runtime degradation: ${(snapshot.runtime.degradedReasons ?? []).join(', ')}.`);
    }
    if (snapshot.permissions?.allowedRoot) {
        parts.push(`Filesystem scope: allowedRoot=${snapshot.permissions.allowedRoot}.`);
    }
    parts.push(`Authority sources: ${sourceTruths.join(', ')}.`);
    return parts.join('\n');
}

function buildSpecificSummary(
    snapshot: SelfKnowledgeSnapshot,
    sourceTruths: string[],
    aspects: SelfKnowledgeAspect[],
): string {
    const lines: string[] = [];
    if (aspects.includes('tools')) {
        lines.push(`Tools: ${snapshot.tools.map((tool) => tool.id).slice(0, 25).join(', ') || 'none'}.`);
    }
    if (aspects.includes('filesystem') || aspects.includes('permissions')) {
        lines.push(
            `Filesystem: read=${snapshot.capabilities.filesystemRead}, writeInPrinciple=${snapshot.capabilities.filesystemWrite}, writeThisTurn=${snapshot.currentTurn.writesAllowed}.`,
        );
        if (snapshot.permissions?.allowedRoot) {
            lines.push(`Allowed root: ${snapshot.permissions.allowedRoot}.`);
        }
    }
    if (aspects.includes('memory')) {
        lines.push(
            `Memory: read=${snapshot.capabilities.memoryRead}, writeInPrinciple=${snapshot.capabilities.memoryWrite}, availableNow=${snapshot.runtime.memoryAvailable ?? false}.`,
        );
    }
    if (aspects.includes('runtime_mode') || aspects.includes('limits')) {
        lines.push(
            `Current mode and limits: mode=${snapshot.currentTurn.mode ?? 'unknown'}, toolsAllowed=${snapshot.currentTurn.toolsAllowed}, writesAllowed=${snapshot.currentTurn.writesAllowed}.`,
        );
    }
    if (aspects.includes('architecture') || aspects.includes('systems') || aspects.includes('invariants')) {
        lines.push(snapshot.architecture?.summary ?? 'Architecture summary unavailable.');
    }
    if (lines.length === 0) {
        lines.push(buildBroadSummary(snapshot, sourceTruths));
    }
    lines.push(`Authority sources: ${sourceTruths.join(', ')}.`);
    return lines.join('\n');
}

export class SelfKnowledgeExecutionService {
    async executeSelfKnowledgeTurn(input: {
        text: string;
        mode?: string;
        allowWritesThisTurn: boolean;
        toolRegistry: ToolRegistryLike;
        selfModelService?: SelfModelAppServiceLike;
        runtimeDiagnostics?: RuntimeDiagnosticsLike;
        filesystemPolicy?: FilesystemPolicyLike;
        toolsAllowedThisTurn?: boolean;
        reasonCodes?: string[];
    }): Promise<SelfKnowledgeExecutionResult> {
        const decision = resolveSelfKnowledgeRequest({
            text: input.text,
            mode: input.mode,
        });
        if (!decision.isSelfKnowledgeRequest) {
            return {
                executed: false,
                snapshot: {
                    identity: {},
                    capabilities: {
                        filesystemRead: false,
                        filesystemWrite: false,
                        toolUsage: false,
                        memoryRead: false,
                        memoryWrite: false,
                        selfInspection: false,
                        reflectionAccess: false,
                        architectureAccess: false,
                        invariantsAccess: false,
                    },
                    currentTurn: {
                        writesAllowed: input.allowWritesThisTurn,
                        toolsAllowed: input.toolsAllowedThisTurn ?? false,
                        mode: input.mode,
                    },
                    runtime: {
                        selfModelAvailable: false,
                        toolRegistryAvailable: false,
                    },
                    tools: [],
                },
                sourceTruths: [],
                blockedReason: 'not_self_knowledge_request',
                summary: 'No self-knowledge request detected.',
            };
        }

        const sourceTruths: string[] = [];
        const reasonCodes = [...(input.reasonCodes ?? []), ...decision.reasonCodes];

        const capabilities = input.selfModelService?.getCapabilities?.()
            ?? input.selfModelService?.queryCapabilities?.().capabilities
            ?? [];
        const architectureSummary = input.selfModelService?.getArchitectureSummary?.();
        const invariants = input.selfModelService?.getInvariants?.()
            ?? input.selfModelService?.queryInvariants?.().invariants
            ?? [];
        const selfModelAvailable = Boolean(input.selfModelService && (capabilities.length > 0 || architectureSummary));
        if (selfModelAvailable) sourceTruths.push('self_model');

        const toolEntries = input.toolRegistry.getAllTools?.() ?? [];
        const toolRegistryAvailable = toolEntries.length > 0;
        if (toolRegistryAvailable) sourceTruths.push('tool_registry');

        const diagnosticsSnapshot = input.runtimeDiagnostics?.getSnapshot?.();
        if (diagnosticsSnapshot) sourceTruths.push('runtime_diagnostics');

        const allowedRoot = input.filesystemPolicy?.getAllowedRoot?.();
        const writePolicy = input.filesystemPolicy?.getWritePolicy?.();
        if (allowedRoot || writePolicy) sourceTruths.push('filesystem_policy');

        const runtimeFlags = diagnosticsSnapshot?.systemHealth?.active_degradation_flags ?? [];
        const degradedSubsystems = diagnosticsSnapshot?.degradedSubsystems ?? [];
        const degradedReasons = [...runtimeFlags, ...degradedSubsystems];
        const capabilityMatrix = diagnosticsSnapshot?.systemHealth?.capability_matrix ?? [];
        const resolveCapability = (capabilityId: string): boolean => {
            const found = capabilityMatrix.find((entry) => entry.capability === capabilityId);
            if (!found) return true;
            return found.status === 'available' || found.status === 'degraded';
        };

        const toolNames = toolEntries.map((entry) => entry.name ?? '').filter((value) => value.length > 0);
        const hasTool = (name: string): boolean => toolNames.includes(name);

        const snapshot: SelfKnowledgeSnapshot = {
            identity: {
                agentName: 'Tala',
                runtimeRole: 'local_agent',
                personaMode: input.mode,
                summary: 'I am Tala, a local agent running inside the Tala app runtime.',
            },
            capabilities: {
                filesystemRead: hasTool('fs_read_text') || hasTool('fs_list'),
                filesystemWrite: hasTool('fs_write_text'),
                toolUsage: toolRegistryAvailable,
                memoryRead: hasTool('mem0_search') || hasTool('mem0_get_recent') || capabilities.some((cap) => cap.id.includes('memory.read')),
                memoryWrite: hasTool('mem0_add') || capabilities.some((cap) => cap.id.includes('memory.write')),
                selfInspection: hasTool('fs_read_text') && hasTool('fs_list'),
                reflectionAccess: hasTool('reflection_clean') || hasTool('reflection_create_goal'),
                architectureAccess: Boolean(architectureSummary),
                invariantsAccess: invariants.length > 0,
            },
            currentTurn: {
                writesAllowed: input.allowWritesThisTurn,
                toolsAllowed: input.toolsAllowedThisTurn ?? resolveCapability('tool_execute_read'),
                mode: input.mode,
                blockedDomains: degradedReasons.length > 0 ? degradedReasons : undefined,
                reasonCodes,
            },
            runtime: {
                selfModelAvailable,
                toolRegistryAvailable,
                memoryAvailable: resolveCapability('memory_canonical_read'),
                graphAvailable: resolveCapability('tool_execute_read'),
                filesystemAvailable: resolveCapability('tool_execute_read'),
                degradedReasons: degradedReasons.length > 0 ? degradedReasons : undefined,
            },
            tools: toolEntries.map((entry) => ({
                id: entry.name ?? 'unknown',
                server: entry.source,
                category: entry.description?.includes('memory') ? 'memory' : undefined,
                available: true,
            })),
            architecture: {
                summary: architectureSummary
                    ? `Architecture: components=${architectureSummary.totalComponents ?? 0}, capabilities=${architectureSummary.availableCapabilities ?? 0}/${architectureSummary.totalCapabilities ?? 0}, invariants=${architectureSummary.activeInvariants ?? 0}/${architectureSummary.totalInvariants ?? 0}.`
                    : undefined,
                invariants: invariants.slice(0, 10).map((inv) => inv.statement ?? inv.id).filter(Boolean),
                capabilitiesSummary: architectureSummary
                    ? `Available capabilities: ${architectureSummary.availableCapabilities ?? 0}.`
                    : undefined,
            },
            permissions: {
                allowedRoot,
                writePolicy: writePolicy ?? (input.allowWritesThisTurn ? 'writes_allowed_this_turn' : 'writes_blocked_this_turn'),
            },
        };

        const summary = decision.requestedScope === 'broad'
            ? buildBroadSummary(snapshot, sourceTruths)
            : buildSpecificSummary(snapshot, sourceTruths, decision.requestedAspects);

        return {
            executed: true,
            snapshot,
            sourceTruths,
            summary,
        };
    }
}
