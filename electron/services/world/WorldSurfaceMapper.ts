/**
 * WorldSurfaceMapper — Phase 4C: A2UI Workspace Surfaces
 *
 * Maps a TalaWorldModel to a bounded A2UI component tree suitable for
 * rendering in the document/editor pane.
 *
 * Rules:
 * - Never dump raw file trees or giant JSON blobs.
 * - Present summaries, not exhaustive data.
 * - All fields come from the typed world model — no free-form injection.
 * - The resulting tree uses components registered in BasicComponents.tsx.
 */

import type { TalaWorldModel } from '../../../shared/worldModelTypes';
import type { A2UINode, A2UISurfacePayload } from '../../../shared/a2uiTypes';

const SURFACE_ID = 'world' as const;
const TAB_ID = 'a2ui:world';

/** Maps availability + freshness to a display color. */
function availabilityColor(avail: string, fresh: string): string {
    if (avail === 'unavailable') return '#f44336';
    if (avail === 'degraded') return '#ff9800';
    if (fresh === 'stale') return '#ff9800';
    if (avail === 'partial') return '#fdd835';
    return '#4caf50';
}

/**
 * Maps a TalaWorldModel to an A2UI surface payload.
 * Returns a fallback payload if the world model is null/undefined.
 */
export function mapWorldSurface(
    world: TalaWorldModel | null | undefined
): A2UISurfacePayload {
    const now = new Date().toISOString();

    if (!world) {
        return {
            surfaceId: SURFACE_ID,
            title: 'World Model',
            tabId: TAB_ID,
            assembledAt: now,
            dataSource: 'world:no_data',
            focus: true,
            components: [
                {
                    id: 'world-empty',
                    type: 'Card',
                    props: { title: 'World Model Not Available' },
                    children: [
                        {
                            id: 'world-empty-text',
                            type: 'Text',
                            props: { content: 'World model data is not yet available. The model assembles on first turn.' },
                        },
                    ],
                },
            ],
        };
    }

    const ws = world.workspace;
    const rs = world.repo;
    const rt = world.runtime;
    const pv = world.providers;
    const ug = world.goals;

    // ─── Workspace section ────────────────────────────────────────────────────
    const wsColor = availabilityColor(ws.meta.availability, ws.meta.freshness);
    const wsSection: A2UINode = {
        id: 'world-workspace',
        type: 'Card',
        props: { title: 'Workspace' },
        children: [
            { id: 'world-ws-badge', type: 'Badge', props: { label: ws.meta.availability.toUpperCase(), color: wsColor } },
            { id: 'world-ws-root', type: 'Text', props: { content: ws.rootResolved ? `Root: ${ws.workspaceRoot}` : 'Workspace root not resolved.' } },
            { id: 'world-ws-class', type: 'Text', props: { content: `Classification: ${ws.classification}` } },
            ...(ws.knownDirectories.length > 0
                ? [{ id: 'world-ws-dirs', type: 'Text', props: { content: `Key dirs: ${ws.knownDirectories.slice(0, 8).join(', ')}${ws.knownDirectories.length > 8 ? ' …' : ''}` } }]
                : []),
            ...(ws.meta.degradedReason ? [{ id: 'world-ws-warn', type: 'Text', props: { content: `⚠ ${ws.meta.degradedReason}` } }] : []),
        ],
    };

    // ─── Repo section ─────────────────────────────────────────────────────────
    const rsColor = availabilityColor(rs.meta.availability, rs.meta.freshness);
    const rsChildren: A2UINode[] = [
        { id: 'world-rs-badge', type: 'Badge', props: { label: rs.meta.availability.toUpperCase(), color: rsColor } },
    ];
    if (rs.isRepo) {
        rsChildren.push(
            { id: 'world-rs-branch', type: 'Text', props: { content: `Branch: ${rs.branch || '(unknown)'}` } },
            { id: 'world-rs-dirty', type: 'Text', props: { content: rs.isDirty ? '⚠ Uncommitted changes present.' : '✓ Working tree clean.' } },
        );
    } else {
        rsChildren.push({ id: 'world-rs-nogit', type: 'Text', props: { content: 'No Git repository detected.' } });
    }
    if (rs.meta.degradedReason) {
        rsChildren.push({ id: 'world-rs-warn', type: 'Text', props: { content: `⚠ ${rs.meta.degradedReason}` } });
    }
    const rsSection: A2UINode = { id: 'world-repo', type: 'Card', props: { title: 'Repository' }, children: rsChildren };

    // ─── Runtime / services section ───────────────────────────────────────────
    const rtColor = availabilityColor(rt.meta.availability, rt.meta.freshness);
    const rtChildren: A2UINode[] = [
        { id: 'world-rt-badge', type: 'Badge', props: { label: rt.meta.availability.toUpperCase(), color: rtColor } },
        {
            id: 'world-rt-inference',
            type: 'Text',
            props: {
                content: rt.selectedProviderId
                    ? `Inference: ${rt.selectedProviderName || rt.selectedProviderId} — ${rt.inferenceReady ? 'ready' : 'unavailable'}`
                    : 'Inference provider: not selected',
            },
        },
        {
            id: 'world-rt-providers',
            type: 'Text',
            props: { content: `Providers — total: ${rt.totalProviders}, ready: ${rt.readyProviders}` },
        },
    ];
    if (rt.degradedSubsystems.length > 0) {
        rtChildren.push({ id: 'world-rt-degraded', type: 'Text', props: { content: `Degraded subsystems: ${rt.degradedSubsystems.join(', ')}` } });
    }
    const rtSection: A2UINode = { id: 'world-runtime', type: 'Card', props: { title: 'Runtime / Inference' }, children: rtChildren };

    // ─── Providers section ────────────────────────────────────────────────────
    const pvColor = availabilityColor(pv.meta.availability, pv.meta.freshness);
    const pvSection: A2UINode = {
        id: 'world-providers',
        type: 'Card',
        props: { title: 'Provider Inventory' },
        children: [
            { id: 'world-pv-badge', type: 'Badge', props: { label: pvColor === '#4caf50' ? 'AVAILABLE' : 'DEGRADED', color: pvColor } },
            { id: 'world-pv-total', type: 'Text', props: { content: `Total: ${pv.totalProviders}, available: ${pv.availableProviders.length}, degraded: ${pv.degradedProviders.length}` } },
            ...(pv.preferredProviderName ? [{ id: 'world-pv-preferred', type: 'Text', props: { content: `Preferred: ${pv.preferredProviderName}` } }] : []),
        ],
    };

    // ─── User goal section ────────────────────────────────────────────────────
    const ugColor = availabilityColor(ug.meta.availability, ug.meta.freshness);
    const ugChildren: A2UINode[] = [
        { id: 'world-ug-badge', type: 'Badge', props: { label: ug.meta.availability.toUpperCase(), color: ugColor } },
    ];
    if (ug.immediateTask) {
        ugChildren.push({ id: 'world-ug-immediate', type: 'Text', props: { content: `Task: ${ug.immediateTask}` } });
    }
    if (ug.currentProjectFocus) {
        ugChildren.push({ id: 'world-ug-focus', type: 'Text', props: { content: `Project focus: ${ug.currentProjectFocus}` } });
    }
    if (ug.stableDirection) {
        ugChildren.push({ id: 'world-ug-direction', type: 'Text', props: { content: `Direction: ${ug.stableDirection}` } });
    }
    if (!ug.immediateTask && !ug.currentProjectFocus) {
        ugChildren.push({ id: 'world-ug-none', type: 'Text', props: { content: 'No active user goal inferred.' } });
    }
    if (ug.isStale) {
        ugChildren.push({ id: 'world-ug-stale', type: 'Text', props: { content: '⚠ Goal data may be stale.' } });
    }
    const ugSection: A2UINode = { id: 'world-usergoal', type: 'Card', props: { title: 'User Goal' }, children: ugChildren };

    // ─── Footer ───────────────────────────────────────────────────────────────
    const footer: A2UINode = {
        id: 'world-footer',
        type: 'Text',
        props: { content: `World model assembled: ${world.timestamp}` },
    };

    return {
        surfaceId: SURFACE_ID,
        title: 'World Model',
        tabId: TAB_ID,
        assembledAt: now,
        dataSource: 'world:world_model_assembler',
        focus: true,
        components: [wsSection, rsSection, rtSection, pvSection, ugSection, { id: 'world-divider', type: 'Divider', props: {} }, footer],
    };
}
