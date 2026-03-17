/**
 * A2UIWorkspaceSurface — Phase 4C: A2UI Workspace Surfaces
 *
 * React component that renders a normalized A2UI component tree in the
 * document/editor pane. Uses the BasicComponents catalog for rendering.
 *
 * Rendering contract:
 * - Renders ONLY in the document/editor pane — never inline in chat.
 * - Receives an A2UI component tree via the `components` prop.
 * - User actions dispatch through `onAction` → IPC → A2UIActionBridge.
 * - Failures render a bounded error notice, not a crash.
 *
 * Action dispatch:
 * Actions are extracted from component `data-action` and `data-*` props.
 * The rendered Button with `data-action` triggers the onAction callback.
 */
import React, { useCallback } from 'react';
import type { A2UINode, A2UISurfaceId, A2UIActionDispatch } from '../../shared/a2uiTypes';
import * as Catalog from './catalog/BasicComponents';
import { ErrorBoundary } from './components/ErrorBoundary';

// ─── Prop types ───────────────────────────────────────────────────────────────

export interface A2UIWorkspaceSurfaceProps {
    /** The surface ID (cognition, world, maintenance). */
    surfaceId: A2UISurfaceId;
    /** The component tree to render. */
    components: A2UINode[];
    /** Action dispatch callback — routes to main process via IPC. */
    onAction?: (action: A2UIActionDispatch) => void;
    /** Optional surface title for the header. */
    title?: string;
}

// ─── Component catalog map ────────────────────────────────────────────────────

const COMPONENT_MAP: Record<string, React.FC<any>> = {
    Button: Catalog.Button,
    Card: Catalog.Card,
    Input: Catalog.Input,
    Text: Catalog.Text,
    Table: Catalog.Table,
    Badge: Catalog.Badge,
    ProgressBar: Catalog.ProgressBar,
    Heading: Catalog.Heading,
    Image: Catalog.Image,
    Divider: Catalog.Divider,
    Columns: Catalog.Columns,
    CodeBlock: Catalog.CodeBlock,
    GoalTree: Catalog.GoalTree,
};

// ─── Node renderer ────────────────────────────────────────────────────────────

interface RenderNodeProps {
    node: A2UINode;
    surfaceId: A2UISurfaceId;
    onAction?: (action: A2UIActionDispatch) => void;
}

const RenderNode: React.FC<RenderNodeProps> = ({ node, surfaceId, onAction }) => {
    const Component = COMPONENT_MAP[node.type];

    if (!Component) {
        console.warn(`[A2UIWorkspaceSurface] Unknown component type: '${node.type}'`);
        return null;
    }

    // Build resolved props — handle action wiring for Button components
    const resolvedProps: Record<string, unknown> = { ...(node.props ?? {}) };

    if (node.type === 'Button' && typeof resolvedProps['data-action'] === 'string' && onAction) {
        const rawAction = resolvedProps['data-action'] as string;
        // Build a normalized payload from data-* props
        const actionPayload: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(resolvedProps)) {
            if (k.startsWith('data-') && k !== 'data-action' && k !== 'data-surface') {
                actionPayload[k.slice(5)] = v; // strip 'data-' prefix
            }
        }

        resolvedProps['onClick'] = () => {
            onAction({
                surfaceId,
                actionName: rawAction as A2UIActionDispatch['actionName'],
                payload: Object.keys(actionPayload).length > 0 ? actionPayload : undefined,
            });
        };

        // Clean up data-* from rendered props to avoid React warnings
        for (const k of Object.keys(resolvedProps)) {
            if (k.startsWith('data-')) {
                delete resolvedProps[k];
            }
        }
    }

    const renderedChildren = node.children?.map(child => (
        <RenderNode key={child.id} node={child} surfaceId={surfaceId} onAction={onAction} />
    ));

    return (
        <Component {...resolvedProps}>
            {renderedChildren}
        </Component>
    );
};

// ─── Surface renderer ─────────────────────────────────────────────────────────

/**
 * A2UIWorkspaceSurface
 *
 * Renders a complete A2UI surface in the document/editor pane.
 * This component is the host for Tala's structured workspace surfaces —
 * cognition, world model, and maintenance.
 */
export const A2UIWorkspaceSurface: React.FC<A2UIWorkspaceSurfaceProps> = ({
    surfaceId,
    components,
    onAction,
    title,
}) => {
    const handleAction = useCallback(
        (action: A2UIActionDispatch) => {
            if (onAction) {
                onAction(action);
            }
        },
        [onAction]
    );

    return (
        <ErrorBoundary>
            <div
                style={{
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    background: '#1e1e1e',
                    color: '#d4d4d4',
                    overflow: 'hidden',
                }}
                data-surface-id={surfaceId}
            >
                {/* Surface header */}
                <div
                    style={{
                        padding: '8px 16px',
                        background: '#252526',
                        borderBottom: '1px solid #333',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexShrink: 0,
                    }}
                >
                    <span style={{ fontWeight: 600, fontSize: '13px', color: '#ccc' }}>
                        {title ?? surfaceId.charAt(0).toUpperCase() + surfaceId.slice(1)}
                    </span>
                    <span
                        style={{
                            fontSize: '10px',
                            color: '#555',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                        }}
                    >
                        Tala Workspace Surface
                    </span>
                </div>

                {/* Component tree */}
                <div
                    style={{
                        flex: 1,
                        overflowY: 'auto',
                        padding: '16px',
                    }}
                >
                    {components.length === 0 ? (
                        <div style={{ color: '#555', fontSize: '13px' }}>
                            Surface has no content. Tala will populate it when data is available.
                        </div>
                    ) : (
                        components.map(node => (
                            <RenderNode
                                key={node.id}
                                node={node}
                                surfaceId={surfaceId}
                                onAction={handleAction}
                            />
                        ))
                    )}
                </div>
            </div>
        </ErrorBoundary>
    );
};

export default A2UIWorkspaceSurface;
