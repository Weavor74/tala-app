/**
 * CognitionSurfaceMapper — Phase 4C: A2UI Workspace Surfaces
 *
 * Maps a CognitiveDiagnosticsSnapshot to a bounded A2UI component tree
 * suitable for rendering in the document/editor pane.
 *
 * Rules:
 * - Never expose raw prompts or raw memory content.
 * - All counts and category data come from the diagnostics snapshot only.
 * - The resulting tree uses components registered in BasicComponents.tsx.
 * - The tree is compact, readable, and safe to serialize over IPC.
 */

import type { CognitiveDiagnosticsSnapshot } from '../../../shared/cognitiveTurnTypes';
import type { A2UINode, A2UISurfacePayload } from '../../../shared/a2uiTypes';

const SURFACE_ID = 'cognition' as const;
const TAB_ID = 'a2ui:cognition';

/**
 * Maps a CognitiveDiagnosticsSnapshot to an A2UI surface payload.
 * Returns a fallback minimal payload if the snapshot is null/undefined.
 */
export function mapCognitionSurface(
    snapshot: CognitiveDiagnosticsSnapshot | null | undefined
): A2UISurfacePayload {
    const now = new Date().toISOString();

    if (!snapshot) {
        return {
            surfaceId: SURFACE_ID,
            title: 'Cognition',
            tabId: TAB_ID,
            assembledAt: now,
            dataSource: 'cognition:no_data',
            focus: true,
            components: [
                {
                    id: 'cog-empty',
                    type: 'Card',
                    props: { title: 'No Cognitive Data Available' },
                    children: [
                        {
                            id: 'cog-empty-text',
                            type: 'Text',
                            props: { content: 'Cognitive diagnostics are not yet available. Start a conversation to populate this surface.' },
                        },
                    ],
                },
            ],
        };
    }

    const mem = snapshot.memoryContributionSummary;
    const doc = snapshot.docContributionSummary;
    const emo = snapshot.emotionalModulationStatus;
    const ref = snapshot.reflectionNoteStatus;

    // ─── Mode badge ───────────────────────────────────────────────────────────
    const modeColor = snapshot.activeMode === 'assistant'
        ? '#007acc'
        : snapshot.activeMode === 'rp'
            ? '#9c4dcc'
            : '#f09d13'; // hybrid

    const modeSection: A2UINode = {
        id: 'cog-mode-section',
        type: 'Card',
        props: { title: 'Active Mode' },
        children: [
            {
                id: 'cog-mode-badge',
                type: 'Badge',
                props: {
                    label: snapshot.activeMode.toUpperCase(),
                    color: modeColor,
                },
            },
        ],
    };

    // ─── Memory contributions ─────────────────────────────────────────────────
    const memCategories = Object.entries(mem.byCategory || {})
        .filter(([, count]) => (count ?? 0) > 0)
        .map(([cat, count]) => `${cat}: ${count}`);

    const memSection: A2UINode = {
        id: 'cog-memory-section',
        type: 'Card',
        props: { title: 'Memory Contributions' },
        children: [
            {
                id: 'cog-mem-total',
                type: 'Text',
                props: {
                    content: mem.retrievalSuppressed
                        ? 'Memory retrieval suppressed for this turn.'
                        : `Applied: ${mem.totalApplied} memory contributions`,
                },
            },
            ...(memCategories.length > 0
                ? [
                    {
                        id: 'cog-mem-categories',
                        type: 'Text',
                        props: { content: `By category — ${memCategories.join(' | ')}` },
                    },
                ]
                : []),
        ],
    };

    // ─── Documentation context ────────────────────────────────────────────────
    const docSection: A2UINode = {
        id: 'cog-doc-section',
        type: 'Card',
        props: { title: 'Documentation Context' },
        children: [
            {
                id: 'cog-doc-status',
                type: 'Badge',
                props: {
                    label: doc.applied ? 'Applied' : 'Not Applied',
                    color: doc.applied ? '#4caf50' : '#666',
                },
            },
            ...(doc.applied
                ? [
                    {
                        id: 'cog-doc-count',
                        type: 'Text',
                        props: { content: `Sources used: ${doc.sourceCount}` },
                    },
                ]
                : []),
        ],
    };

    // ─── Emotional modulation ─────────────────────────────────────────────────
    const emoColor = emo.applied
        ? emo.strength === 'capped' ? '#f44336' : emo.strength === 'medium' ? '#ff9800' : '#4caf50'
        : '#666';

    const emoSection: A2UINode = {
        id: 'cog-emo-section',
        type: 'Card',
        props: { title: 'Emotional Modulation' },
        children: [
            {
                id: 'cog-emo-badge',
                type: 'Badge',
                props: {
                    label: emo.applied ? `${emo.strength.toUpperCase()}` : 'NOT APPLIED',
                    color: emoColor,
                },
            },
            ...(emo.astroUnavailable
                ? [
                    {
                        id: 'cog-emo-unavail',
                        type: 'Text',
                        props: { content: 'Astro engine unavailable — degraded modulation.' },
                    },
                ]
                : []),
        ],
    };

    // ─── Reflection notes ─────────────────────────────────────────────────────
    const refSection: A2UINode = {
        id: 'cog-ref-section',
        type: 'Card',
        props: { title: 'Reflection Notes' },
        children: [
            {
                id: 'cog-ref-applied',
                type: 'Text',
                props: {
                    content: ref.applied
                        ? `Applied: ${ref.activeNoteCount} note${ref.activeNoteCount !== 1 ? 's' : ''}`
                        : 'No reflection notes applied.',
                },
            },
            ...(ref.suppressedNoteCount > 0
                ? [
                    {
                        id: 'cog-ref-suppressed',
                        type: 'Text',
                        props: { content: `Suppressed: ${ref.suppressedNoteCount} note${ref.suppressedNoteCount !== 1 ? 's' : ''}` },
                    },
                ]
                : []),
        ],
    };

    // ─── Snapshot timestamp ────────────────────────────────────────────────────
    const footerSection: A2UINode = {
        id: 'cog-footer',
        type: 'Text',
        props: {
            content: `Snapshot assembled: ${snapshot.timestamp}${snapshot.lastPolicyAppliedAt ? ` | Policy applied: ${snapshot.lastPolicyAppliedAt}` : ''}`,
        },
    };

    return {
        surfaceId: SURFACE_ID,
        title: 'Cognition',
        tabId: TAB_ID,
        assembledAt: now,
        dataSource: 'cognition:diagnostics_snapshot',
        focus: true,
        components: [
            modeSection,
            memSection,
            docSection,
            emoSection,
            refSection,
            { id: 'cog-divider', type: 'Divider', props: {} },
            footerSection,
        ],
    };
}
