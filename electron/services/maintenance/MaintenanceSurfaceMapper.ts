/**
 * MaintenanceSurfaceMapper — Phase 4C: A2UI Workspace Surfaces
 *
 * Maps a MaintenanceDiagnosticsSummary to a bounded A2UI component tree
 * suitable for rendering in the document/editor pane.
 *
 * Rules:
 * - Do not expose destructive or unsupported controls.
 * - Only show actions that are gated by policy (auto-safe vs approval-needed).
 * - All data from the typed diagnostics summary — no free-form injection.
 * - The resulting tree uses components registered in BasicComponents.tsx.
 */

import type { MaintenanceDiagnosticsSummary, MaintenanceSeverityLevel } from '../../../shared/maintenance/maintenanceTypes';
import type { A2UINode, A2UISurfacePayload } from '../../../shared/a2uiTypes';

const SURFACE_ID = 'maintenance' as const;
const TAB_ID = 'a2ui:maintenance';

function severityColor(sev: MaintenanceSeverityLevel): string {
    switch (sev) {
        case 'critical': return '#f44336';
        case 'high': return '#ff5722';
        case 'medium': return '#ff9800';
        case 'low': return '#fdd835';
        case 'info': return '#607d8b';
        default: return '#666';
    }
}

function modeLabel(mode: string): string {
    switch (mode) {
        case 'observation_only': return 'Observation Only';
        case 'recommend_only': return 'Recommend Only';
        case 'safe_auto_recovery': return 'Safe Auto-Recovery';
        default: return mode;
    }
}

/**
 * Maps a MaintenanceDiagnosticsSummary to an A2UI surface payload.
 * Returns a fallback payload if the summary is null/undefined.
 */
export function mapMaintenanceSurface(
    summary: MaintenanceDiagnosticsSummary | null | undefined
): A2UISurfacePayload {
    const now = new Date().toISOString();

    if (!summary) {
        return {
            surfaceId: SURFACE_ID,
            title: 'Maintenance',
            tabId: TAB_ID,
            assembledAt: now,
            dataSource: 'maintenance:no_data',
            focus: true,
            components: [
                {
                    id: 'maint-empty',
                    type: 'Card',
                    props: { title: 'Maintenance Data Not Available' },
                    children: [
                        {
                            id: 'maint-empty-text',
                            type: 'Text',
                            props: { content: 'Maintenance diagnostics are not yet available.' },
                        },
                    ],
                },
            ],
        };
    }

    // ─── Mode / status header ─────────────────────────────────────────────────
    const modeColor = summary.mode === 'safe_auto_recovery'
        ? '#4caf50'
        : summary.mode === 'recommend_only'
            ? '#ff9800'
            : '#607d8b';

    const headerSection: A2UINode = {
        id: 'maint-header',
        type: 'Card',
        props: { title: 'Maintenance Mode' },
        children: [
            {
                id: 'maint-mode-badge',
                type: 'Badge',
                props: { label: modeLabel(summary.mode), color: modeColor },
            },
            {
                id: 'maint-last-check',
                type: 'Text',
                props: { content: summary.lastCheckedAt ? `Last check: ${summary.lastCheckedAt}` : 'No maintenance check recorded.' },
            },
        ],
    };

    // ─── Issue counts summary ─────────────────────────────────────────────────
    const countEntries = (['critical', 'high', 'medium', 'low', 'info'] as MaintenanceSeverityLevel[])
        .filter(sev => (summary.issueCounts[sev] ?? 0) > 0)
        .map(sev => ({
            id: `maint-count-${sev}`,
            type: 'Badge',
            props: { label: `${sev}: ${summary.issueCounts[sev]}`, color: severityColor(sev) },
        }));

    const issueCountSection: A2UINode = {
        id: 'maint-issue-counts',
        type: 'Card',
        props: { title: 'Issue Summary' },
        children:
            countEntries.length > 0
                ? countEntries
                : [{ id: 'maint-no-issues', type: 'Text', props: { content: '✓ No active maintenance issues.' } }],
    };

    // ─── Active issues table ──────────────────────────────────────────────────
    const issueRows = summary.activeIssues.slice(0, 10).map(issue => [
        issue.severity,
        issue.category,
        `${Math.round(issue.confidence * 100)}%`,
        issue.recommendedAction || '—',
    ]);

    const issuesSection: A2UINode = {
        id: 'maint-active-issues',
        type: 'Card',
        props: { title: `Active Issues (${summary.activeIssues.length})` },
        children:
            issueRows.length > 0
                ? [
                    {
                        id: 'maint-issues-table',
                        type: 'Table',
                        props: {
                            headers: ['Severity', 'Category', 'Confidence', 'Recommendation'],
                            rows: issueRows,
                        },
                    },
                ]
                : [{ id: 'maint-no-active', type: 'Text', props: { content: '✓ No active issues.' } }],
    };

    // ─── Recent executions ────────────────────────────────────────────────────
    const execRows = summary.recentExecutions.slice(0, 5).map(exec => [
        exec.executedAt,
        exec.proposal.actionType,
        exec.status,
        exec.message,
    ]);

    const execSection: A2UINode = {
        id: 'maint-recent-exec',
        type: 'Card',
        props: { title: 'Recent Maintenance Actions' },
        children:
            execRows.length > 0
                ? [
                    {
                        id: 'maint-exec-table',
                        type: 'Table',
                        props: {
                            headers: ['When', 'Action', 'Status', 'Outcome'],
                            rows: execRows,
                        },
                    },
                ]
                : [{ id: 'maint-no-exec', type: 'Text', props: { content: 'No recent maintenance actions.' } }],
    };

    // ─── Pending actions notice ────────────────────────────────────────────────
    const pendingChildren: A2UINode[] = [];
    if (summary.hasPendingAutoAction) {
        pendingChildren.push({
            id: 'maint-pending-auto',
            type: 'Badge',
            props: { label: 'Auto-safe action pending', color: '#4caf50' },
        });
    }
    if (summary.hasApprovalNeededAction) {
        pendingChildren.push({
            id: 'maint-pending-approval',
            type: 'Badge',
            props: { label: 'Approval-needed action waiting', color: '#ff9800' },
        });
    }

    // ─── Available actions ────────────────────────────────────────────────────
    const actionsSection: A2UINode = {
        id: 'maint-actions',
        type: 'Card',
        props: { title: 'Actions' },
        children: [
            {
                id: 'maint-run-check',
                type: 'Button',
                props: {
                    label: 'Run Maintenance Check',
                    variant: 'primary',
                    'data-action': 'run_maintenance_check',
                    'data-surface': 'maintenance',
                },
            },
            ...(summary.mode !== 'safe_auto_recovery'
                ? [
                    {
                        id: 'maint-switch-mode',
                        type: 'Button',
                        props: {
                            label: 'Enable Safe Auto-Recovery',
                            variant: 'secondary',
                            'data-action': 'switch_maintenance_mode',
                            'data-mode': 'safe_auto_recovery',
                            'data-surface': 'maintenance',
                        },
                    },
                ]
                : [
                    {
                        id: 'maint-switch-mode-down',
                        type: 'Button',
                        props: {
                            label: 'Switch to Recommend Only',
                            variant: 'secondary',
                            'data-action': 'switch_maintenance_mode',
                            'data-mode': 'recommend_only',
                            'data-surface': 'maintenance',
                        },
                    },
                ]),
        ],
    };

    // ─── Cooldown notice ──────────────────────────────────────────────────────
    const cooldownSection: A2UINode | null = summary.cooldownEntities.length > 0
        ? {
            id: 'maint-cooldown',
            type: 'Card',
            props: { title: 'Cooldown Active' },
            children: [
                {
                    id: 'maint-cooldown-text',
                    type: 'Text',
                    props: { content: `Under cooldown: ${summary.cooldownEntities.join(', ')}` },
                },
            ],
        }
        : null;

    const components: A2UINode[] = [
        headerSection,
        issueCountSection,
        ...(pendingChildren.length > 0
            ? [{ id: 'maint-pending', type: 'Card', props: { title: 'Pending' }, children: pendingChildren }]
            : []),
        issuesSection,
        execSection,
        actionsSection,
        ...(cooldownSection ? [cooldownSection] : []),
        { id: 'maint-divider', type: 'Divider', props: {} },
        {
            id: 'maint-footer',
            type: 'Text',
            props: { content: `Surface assembled: ${now}` },
        },
    ];

    return {
        surfaceId: SURFACE_ID,
        title: 'Maintenance',
        tabId: TAB_ID,
        assembledAt: now,
        dataSource: 'maintenance:maintenance_loop_service',
        focus: true,
        components,
    };
}
