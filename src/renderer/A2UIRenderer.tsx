/**
 * A2UI (Agent-to-UI) Renderer
 *
 * Enables Tala's AI agent to dynamically generate UI by sending a JSON tree
 * of component descriptions. This module recursively walks the tree and renders
 * each node using the `COMPONENT_MAP` lookup.
 *
 * **Data flow:**
 * 1. Agent produces an `A2UIComponent` JSON tree (type + props + children).
 * 2. `AgentService` emits it as an `agent-event` of type `a2ui-render`.
 * 3. `App.tsx` passes the tree to `<A2UIRenderer root={tree} />`.
 * 4. `RecursiveRenderer` walks the tree depth-first, rendering each node.
 *
 * **Supported component types:** button, card, input, text, container, html.
 * Unknown types render a red error placeholder.
 *
 * @capability [CAPABILITY 2.1] Render JSON → React UI
 */
import React from 'react';
import type { A2UIComponent } from './types';
import { Button, Card, Input, Text, Table, Badge, ProgressBar, Heading, Image, Divider, Columns, CodeBlock, GoalTree } from './catalog/BasicComponents';
import { Form } from './catalog/FormComponents';

/**
 * Maps A2UI component type strings to their React component implementations.
 * Agent-generated JSON uses these keys as `component.type`.
 */
const COMPONENT_MAP: Record<string, React.FC<any>> = {
    'button': Button,
    'card': Card,
    'input': Input,
    'text': Text,
    'table': Table,
    'badge': Badge,
    'progress': ProgressBar,
    'form': Form,
    'heading': Heading,
    'image': Image,
    'divider': Divider,
    'columns': Columns,
    'code': CodeBlock,
    'goal_tree': GoalTree,
    'container': ({ children }) => <div style={{ padding: 10 }}>{children}</div>,
    'html': ({ content }) => <div dangerouslySetInnerHTML={{ __html: content }} />
};

/** Props for the top-level `A2UIRenderer` component. */
interface Props {
    /** The root node of the A2UI component tree. */
    root: A2UIComponent;
    /** Callback invoked when an interactive element's action is triggered. */
    onAction?: (action: any) => void;
}

/**
 * Recursively renders an A2UI component tree.
 *
 * For each node, looks up the component type in `COMPONENT_MAP`,
 * injects an `onClick` handler if the component has an `action` prop,
 * and recursively renders all children.
 */
const RecursiveRenderer: React.FC<{ component: A2UIComponent, onAction?: (action: any) => void }> = ({ component, onAction }) => {
    const Component = COMPONENT_MAP[component.type] || (() => <div style={{ color: 'red' }}>Unknown Component: {component.type}</div>);

    const handleAction = () => {
        if (component.props?.action && onAction) {
            onAction(component.props.action);
        }
    };

    // Inject onClick for action-capable components if not already defined
    const extraProps: any = {};
    if (component.props?.action) {
        // If it's a button or interactive element, bind onClick
        extraProps.onClick = handleAction;
    }

    return (
        <Component {...component.props} {...extraProps}>
            {component.children?.map((child: A2UIComponent, i: number) => (
                <RecursiveRenderer key={child.id || i} component={child} onAction={onAction} />
            ))}
        </Component>
    );
}

export const A2UIRenderer: React.FC<Props> = ({ root, onAction }) => {
    return (
        <div className="a2ui-root" style={{ width: '100%', maxWidth: '800px', padding: '20px' }}>
            <RecursiveRenderer component={root} onAction={onAction} />
        </div>
    );
};
