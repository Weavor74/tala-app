/**
 * A2UI Primitive Component Catalog
 *
 * These are the base UI components that Tala's AI can dynamically render
 * via the A2UI (Agent-to-UI) protocol. The agent sends a JSON tree describing
 * which components to render, and `A2UIRenderer` maps component type strings
 * (e.g. `'button'`, `'card'`) to these React components.
 *
 * Each component is intentionally simple — styled inline for portability
 * and designed to accept any props via `React.FC<any>`.
 */
import React from 'react';

/**
 * A styled button component for A2UI.
 *
 * @param {string} label - Button text.
 * @param {Function} onClick - Click handler.
 * @param {'primary'|string} variant - Visual variant; 'primary' uses blue, others use dark gray.
 */
export const Button: React.FC<any> = ({ label, onClick, variant = 'primary' }) => (
    <button
        className={`tala-btn ${variant}`}
        onClick={onClick}
        style={{
            padding: '8px 16px',
            backgroundColor: variant === 'primary' ? '#007acc' : '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '2px',
            cursor: 'pointer',
            fontSize: '13px',
            fontFamily: 'Segoe UI'
        }}
    >
        {label}
    </button>
);

export const Card: React.FC<any> = ({ title, children }) => (
    <div style={{
        backgroundColor: '#252526',
        border: '1px solid #3e3e42',
        padding: '16px',
        marginBottom: '10px',
        borderRadius: '4px'
    }}>
        {title && <h3 style={{ marginTop: 0, fontSize: '14px', color: '#ccc' }}>{title}</h3>}
        <div>{children}</div>
    </div>
);


export const Input: React.FC<any> = ({ label, placeholder, value, onChange, name }) => (
    <div style={{ marginBottom: 10 }}>
        {label && <label style={{ display: 'block', marginBottom: 5, fontSize: 12, color: '#aaa' }}>{label}</label>}
        <input
            type="text"
            name={name}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            style={{
                width: '100%',
                backgroundColor: '#3c3c3c',
                border: '1px solid #3c3c3c',
                color: 'white',
                padding: '6px',
                outline: 'none',
                borderRadius: '2px'
            }}
        />
    </div>
);
// Assign displayName for Form detection
(Input as any).displayName = 'Input';

export const Text: React.FC<any> = ({ content }) => <p style={{ lineHeight: 1.5, marginTop: 0 }}>{content}</p>;

export const Table: React.FC<any> = ({ headers = [], rows = [] }) => (
    <div style={{ overflowX: 'auto', marginBottom: '10px', border: '1px solid #3e3e42', borderRadius: '4px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
                <tr style={{ backgroundColor: '#333', textAlign: 'left' }}>
                    {headers.map((h: string, i: number) => (
                        <th key={i} style={{ padding: '8px 12px', borderBottom: '1px solid #3e3e42', color: '#ccc' }}>{h}</th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {rows.map((row: string[], i: number) => (
                    <tr key={i} style={{ borderBottom: i < rows.length - 1 ? '1px solid #3e3e42' : 'none' }}>
                        {row.map((cell: string, j: number) => (
                            <td key={j} style={{ padding: '8px 12px', color: '#eee' }}>{cell}</td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
);


export const Badge: React.FC<any> = ({ label, color = '#007acc' }) => (
    <span style={{
        backgroundColor: color,
        color: 'white',
        padding: '2px 8px',
        borderRadius: '12px',
        fontSize: '11px',
        fontWeight: 600,
        display: 'inline-block',
        marginRight: '5px'
    }}>
        {label}
    </span>
);

export const ProgressBar: React.FC<any> = ({ value = 0, max = 100, label }) => {
    const percentage = Math.min(100, Math.max(0, (value / max) * 100));
    return (
        <div style={{ marginBottom: '10px' }}>
            {label && <div style={{ fontSize: '12px', color: '#aaa', marginBottom: '4px', display: 'flex', justifyContent: 'space-between' }}>
                <span>{label}</span>
                <span>{Math.round(percentage)}%</span>
            </div>}
            <div style={{ height: '6px', backgroundColor: '#3c3c3c', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{
                    width: `${percentage}%`,
                    height: '100%',
                    backgroundColor: '#007acc',
                    transition: 'width 0.3s ease'
                }} />
            </div>
        </div>
    );
};

// --- Layout Components ---

export const Heading: React.FC<any> = ({ level = 1, text }) => {
    const styles: any = { color: '#eee', marginTop: '20px', marginBottom: '10px', fontWeight: 600 };
    if (level === 1) { styles.fontSize = '24px'; styles.borderBottom = '1px solid #3e3e42'; styles.paddingBottom = '8px'; }
    else if (level === 2) { styles.fontSize = '20px'; }
    else if (level === 3) { styles.fontSize = '18px'; }
    else { styles.fontSize = '16px'; }

    const Tag = `h${Math.min(6, Math.max(1, level))}` as React.ElementType;
    return <Tag style={styles}>{text}</Tag>;
};

export const Image: React.FC<any> = ({ src, alt, width }) => (
    <div style={{ marginBottom: '10px' }}>
        <img
            src={src}
            alt={alt || 'Image'}
            style={{
                maxWidth: '100%',
                width: width || 'auto',
                borderRadius: '4px',
                border: '1px solid #3e3e42',
                display: 'block'
            }}
        />
        {alt && <div style={{ fontSize: 12, color: '#888', marginTop: 4, textAlign: 'center' }}>{alt}</div>}
    </div>
);

export const Divider: React.FC<any> = () => <hr style={{ border: 0, borderTop: '1px solid #3e3e42', margin: '20px 0' }} />;

export const Columns: React.FC<any> = ({ children }) => (
    <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginBottom: '10px' }}>
        {React.Children.map(children, (child) => (
            <div style={{ flex: 1, minWidth: '200px' }}>{child}</div>
        ))}
    </div>
);

export const CodeBlock: React.FC<any> = ({ language, code }) => (
    <div style={{
        backgroundColor: '#1e1e1e',
        padding: '12px',
        borderRadius: '4px',
        fontFamily: 'Consolas, monospace',
        fontSize: '13px',
        marginBottom: '10px',
        overflowX: 'auto',
        border: '1px solid #333'
    }}>
        {language && <div style={{
            fontSize: '10px',
            color: '#888',
            textTransform: 'uppercase',
            marginBottom: '4px',
            letterSpacing: '1px'
        }}>{language}</div>}
        <pre style={{ margin: 0 }}><code>{code}</code></pre>
    </div>
);

export const GoalTree: React.FC<any> = ({ goals = [] }) => (
    <div style={{
        backgroundColor: '#1e1e1e',
        border: '1px solid #333',
        borderRadius: '4px',
        padding: '12px',
        marginBottom: '10px'
    }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: '#888', marginBottom: '8px', textTransform: 'uppercase' }}>Current Roadmap</div>
        {goals.map((goal: any, i: number) => (
            <div key={i} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '4px 0',
                opacity: goal.status === 'completed' ? 0.6 : 1
            }}>
                <span style={{
                    fontSize: '14px',
                    color: goal.status === 'completed' ? '#4caf50' : goal.status === 'in-progress' ? '#007acc' : '#555'
                }}>
                    {goal.status === 'completed' ? '●' : goal.status === 'in-progress' ? '○' : '◌'}
                </span>
                <span style={{
                    fontSize: '13px',
                    color: goal.status === 'in-progress' ? '#eee' : '#aaa',
                    textDecoration: goal.status === 'completed' ? 'line-through' : 'none'
                }}>
                    {goal.title}
                </span>
            </div>
        ))}
    </div>
);


