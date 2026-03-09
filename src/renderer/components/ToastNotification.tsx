/**
 * Toast Notification System
 *
 * A reactive, globally-accessible alerting mechanism for ephemeral system feedback.
 * 
 * **Architecture:**
 * - **Provider-Pattern**: Wraps the application root to manage the toast stack.
 * - **Hook Engagement**: Exposes `useToast()` for any child component to trigger alerts.
 * - **Management**: Automatically prioritizes and dismisses messages via timer-based removal.
 * 
 * **Alert Types:**
 * - Success: Affirmative operations (e.g., Save, Deploy).
 * - Error: Critical failures or permission blocks.
 * - Info/Warning: Contextual status updates.
 */
import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

export interface Toast {
    id: number;
    type: 'success' | 'error' | 'info' | 'warning';
    message: string;
}

interface ToastContextValue {
    addToast: (t: Omit<Toast, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue>({ addToast: () => { } });
export const useToast = () => useContext(ToastContext);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const nextId = useRef(0);

    const addToast = useCallback((t: Omit<Toast, 'id'>) => {
        const id = nextId.current++;
        setToasts(prev => [...prev.slice(-4), { ...t, id }]); // max 5
        setTimeout(() => {
            setToasts(prev => prev.filter(x => x.id !== id));
        }, 5000);
    }, []);

    const dismiss = useCallback((id: number) => {
        setToasts(prev => prev.filter(x => x.id !== id));
    }, []);

    return (
        <ToastContext.Provider value={{ addToast }}>
            {children}
            <div style={{
                position: 'fixed',
                bottom: 30,
                right: 16,
                zIndex: 9999,
                display: 'flex',
                flexDirection: 'column-reverse',
                gap: 8,
                pointerEvents: 'none',
                maxWidth: 360,
            }}>
                {toasts.map(t => (
                    <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
                ))}
            </div>
        </ToastContext.Provider>
    );
};

const COLORS: Record<Toast['type'], { bg: string; border: string; icon: string }> = {
    success: { bg: '#1a3a2a', border: '#2ea043', icon: '\u2713' },
    error: { bg: '#3a1a1a', border: '#f85149', icon: '\u2717' },
    info: { bg: '#1a2a3a', border: '#58a6ff', icon: '\u24d8' },
    warning: { bg: '#3a2a1a', border: '#d29922', icon: '\u26a0' },
};

const ToastItem: React.FC<{ toast: Toast; onDismiss: (id: number) => void }> = ({ toast, onDismiss }) => {
    const [exiting, setExiting] = useState(false);
    const c = COLORS[toast.type];

    useEffect(() => {
        const t = setTimeout(() => setExiting(true), 4500); // start fade 500ms before removal
        return () => clearTimeout(t);
    }, []);

    return (
        <div
            style={{
                background: c.bg,
                border: `1px solid ${c.border}`,
                borderRadius: 6,
                padding: '10px 14px',
                color: '#e6e6e6',
                fontSize: 13,
                fontFamily: 'Inter, -apple-system, sans-serif',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                pointerEvents: 'auto',
                boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                opacity: exiting ? 0 : 1,
                transform: exiting ? 'translateX(40px)' : 'translateX(0)',
                transition: 'opacity 0.4s ease, transform 0.4s ease',
                animation: 'toast-slide-in 0.3s ease',
            }}
        >
            <span style={{ fontSize: 16, flexShrink: 0 }}>{c.icon}</span>
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{toast.message}</span>
            <span
                style={{ cursor: 'pointer', opacity: 0.6, fontSize: 16, flexShrink: 0 }}
                onClick={() => onDismiss(toast.id)}
            >
                \u00d7
            </span>
        </div>
    );
};
