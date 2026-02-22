import React from 'react';

/**
 * ErrorBoundary
 * 
 * A React class component that catches JavaScript errors in any child
 * component tree and renders a styled fallback UI instead of crashing
 * the entire application.
 * 
 * **Usage:**
 * ```tsx
 * <ErrorBoundary name="File Explorer">
 *   <FileExplorer />
 * </ErrorBoundary>
 * ```
 * 
 * Shows the error message and a "Retry" button that resets the boundary,
 * giving the child component a fresh chance to mount successfully.
 */

interface Props {
    /** Human-readable name for the protected section (shown in fallback UI). */
    name: string;
    children: React.ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error(`[ErrorBoundary:${this.props.name}]`, error, info.componentStack);
    }

    handleRetry = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    padding: 20,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    background: '#1e1e1e',
                    color: '#ccc',
                    textAlign: 'center',
                    gap: 12
                }}>
                    <div style={{ fontSize: 32, opacity: 0.3 }}>⚠</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#e06c75' }}>
                        {this.props.name} crashed
                    </div>
                    <div style={{
                        fontSize: 11,
                        opacity: 0.6,
                        maxWidth: 300,
                        wordBreak: 'break-word',
                        fontFamily: 'Consolas, monospace'
                    }}>
                        {this.state.error?.message || 'Unknown error'}
                    </div>
                    <button
                        onClick={this.handleRetry}
                        style={{
                            marginTop: 8,
                            padding: '6px 16px',
                            background: '#0e639c',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 3,
                            cursor: 'pointer',
                            fontSize: 12,
                            fontFamily: 'Segoe UI, sans-serif'
                        }}
                    >
                        Retry
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
