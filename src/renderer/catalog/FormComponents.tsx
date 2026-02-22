/**
 * A2UI Form Components
 * 
 * Interactive components that manage local state and trigger actions.
 */
import React, { useState } from 'react';
import { Button } from './BasicComponents';

/**
 * A container that collects values from child inputs and submits them.
 * 
 * @param {string} title - Optional form title.
 * @param {object} action - The base action payload to dispatch on submit.
 * @param {string} submitLabel - Label for the submit button.
 * @param {React.ReactNode} children - Child components (Input, Text, etc).
 * @param {Function} onAction - Callback to emit the action.
 */
export const Form: React.FC<any> = ({ title, action, submitLabel = "Submit", children, onAction }) => {
    const [formData, setFormData] = useState<Record<string, string>>({});

    const handleInputChange = (name: string, value: string) => {
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleSubmit = () => {
        if (onAction) {
            // Merge form data into the action payload
            onAction({
                ...action,
                data: formData
            });
        }
    };

    // Recursively clone children to inject onChange handler for Inputs
    const renderChildren = (nodes: React.ReactNode): React.ReactNode => {
        return React.Children.map(nodes, child => {
            if (!React.isValidElement(child)) return child;

            const props: any = child.props;

            // If it's an A2UI Component wrapper, we need to look deeper or pass props down
            // But A2UIRenderer renders standard React components.
            // Tala's Input component needs to accept `onChange` and `name`.

            if ((child.type as any).displayName === 'Input' || (child.props as any).name) {
                return React.cloneElement(child, {
                    // @ts-ignore
                    onChange: (e: any) => handleInputChange(props.name, e.target.value),
                    value: formData[props.name] || ''
                } as any);
            }

            if (props.children) {
                return React.cloneElement(child, {
                    children: renderChildren(props.children)
                } as any);
            }

            return child;
        });
    };

    return (
        <div style={{
            border: '1px solid #3e3e42',
            padding: '16px',
            borderRadius: '4px',
            backgroundColor: '#252526',
            marginBottom: '10px'
        }}>
            {title && <h3 style={{ marginTop: 0, marginBottom: '15px', color: '#fff' }}>{title}</h3>}
            <div style={{ marginBottom: '15px' }}>
                {renderChildren(children)}
            </div>
            <div style={{ textAlign: 'right' }}>
                <Button label={submitLabel} onClick={handleSubmit} />
            </div>
        </div>
    );
};
