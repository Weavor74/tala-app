/**
 * StartupSplash
 * 
 * A high-priority loading overlay that manages the application's boot sequence.
 * 
 * **Responsibilities:**
 * - Visual Feedback: Displays a progress bar and status text (Initializing, Loading Core, Ready).
 * - IPC Sync: Listens to the `startup-status` event from the main process.
 * - Graceful Exit: Fades out upon 100% completion or triggers a safety timeout to prevent soft-locks.
 */
import React, { useEffect, useState } from 'react';

export const StartupSplash: React.FC = () => {
    const [status, setStatus] = useState<string>('Initializing...');
    const [progress, setProgress] = useState<number>(0);
    const [visible, setVisible] = useState<boolean>(true);
    const [isComplete, setIsComplete] = useState<boolean>(false);

    useEffect(() => {
        const api = (window as any).tala;
        if (!api) return;

        const handleStatus = (event: { step: string, progress: number }) => {
            setStatus(event.step);
            setProgress(event.progress);
            if (event.progress >= 100) {
                setIsComplete(true);
                setTimeout(() => setVisible(false), 1500); // Fade out after completion
            }
        };

        api.on('startup-status', handleStatus);

        // Safety timeout: Remove splash after 10s regardless of status
        const safetyTimer = setTimeout(() => {
            console.warn('Splash safety timeout triggered');
            setVisible(false);
        }, 10000);

        // Check initial status in case we missed events
        api.getStartupStatus().then((initial: { step: string, progress: number }) => {
            if (initial && initial.progress > 0) {
                handleStatus(initial);
            }
        }).catch((e: any) => console.error('Failed to get startup status:', e));

        return () => {
            api.off('startup-status', handleStatus);
            clearTimeout(safetyTimer);
        };
    }, []);

    if (!visible) return null;

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            backgroundColor: 'var(--bg-color)', // Assuming CSS var exists, else #1e1e1e
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'opacity 0.5s ease-out',
            opacity: isComplete ? 0 : 1,
            color: 'var(--text-color)'
        }}>
            <div style={{ marginBottom: 20, fontSize: '1.5em', fontWeight: 'bold' }}>
                TALA
            </div>

            <div style={{
                width: 300,
                height: 4,
                backgroundColor: '#333',
                borderRadius: 2,
                overflow: 'hidden',
                marginBottom: 10
            }}>
                <div style={{
                    width: `${progress}%`,
                    height: '100%',
                    backgroundColor: '#007acc', // VS Code blue-ish
                    transition: 'width 0.3s ease'
                }} />
            </div>

            <div style={{
                fontFamily: 'monospace',
                fontSize: '0.9em',
                color: '#888'
            }}>
                {status}
            </div>
        </div>
    );
};
