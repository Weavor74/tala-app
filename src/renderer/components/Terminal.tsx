/**
 * Terminal Component
 *
 * Embeds a fully interactive terminal (xterm.js) in the bottom panel.
 * Bridges the renderer to the main process PTY via the preload API:
 * - **Outbound:** `term.onData` → `tala.sendTerminalInput(data)` → `TerminalService.write()`
 * - **Inbound:** `tala.on('terminal-data')` → `term.write(data)`
 *
 * Features:
 * - Clickable hyperlinks (WebLinksAddon).
 * - Auto-resize via ResizeObserver + FitAddon.
 * - Dark theme consistent with the IDE aesthetic.
 */
import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

/**
 * React wrapper around an xterm.js terminal instance.
 * Initializes on mount, connects to the backend PTY, and auto-disposes on unmount.
 */
export const Terminal: React.FC<{ id: string }> = ({ id }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<XTerm | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        // Initialize XTerm
        const term = new XTerm({
            cursorBlink: true,
            fontSize: 12,
            fontFamily: 'Consolas, monospace',
            theme: {
                background: '#1e1e1e',
                foreground: '#cccccc'
            },
            convertEol: true, // Helper for raw \n
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());

        term.open(containerRef.current);
        fitAddon.fit();

        terminalRef.current = term;
        fitAddonRef.current = fitAddon;

        // API Bridge
        const api = (window as any).tala;
        if (api) {
            // Outbound
            term.onData(data => {
                api.sendTerminalInput(id, data);
            });

            // Inbound
            const handleData = (event: any) => {
                // Determine if event is raw string (legacy) or object (new)
                // New format: { id, data }
                if (typeof event === 'string') {
                    // Fallback for broadcast messages or errors not bound to ID
                    term.write(event);
                } else if (event.id === id) {
                    term.write(event.data);
                }
            };

            api.on('terminal-data', handleData);

            // Initial Resize
            api.initTerminal(id);

            // Handle Resize
            const resizeObserver = new ResizeObserver(() => {
                try {
                    fitAddon.fit();
                    // Optional: sync size to backend if using PTY
                    if (api.resizeTerminal) api.resizeTerminal(id, term.cols, term.rows);
                } catch (e) { console.error(e); }
            });
            resizeObserver.observe(containerRef.current);

            return () => {
                term.dispose();
                resizeObserver.disconnect();
                // Cleanup listener if possible, though api.off might remove all.
                // ideally we'd have a named function reference to remove.
                // For now, we rely on component unmount behavior or weak refs in typical event emitter patterns.
                // BUT: api.off removes ALL listeners for the channel in our preload implementation.
                // This is a problem for multi-terminal if they share the channel.
                // FIX: We shouldn't call api.off('terminal-data') here if it wipes others.
                // Preload.ts implementation of `off` is: ipcRenderer.removeAllListeners(channel);
                // So unmounting one terminal would kill others' input.
                // Workaround: Don't call off('terminal-data'). Leak is minimal (one listener per mount).
                // Better fix later: unique channels or proper listener tracking.
            };
        }

        return () => {
            term.dispose();
        };
    }, [id]);

    return (
        <div
            ref={containerRef}
            style={{ width: '100%', height: '100%', overflow: 'hidden', padding: 5, background: '#1e1e1e' }}
        />
    );
};
