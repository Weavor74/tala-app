/**
 * Embedded Browser Component
 *
 * Renders an Electron `<webview>` as an embedded browser panel
 * for web browsing, agent-driven web automation, and page scraping.
 *
 * **Architecture:**
 * - The `<webview>` loads `browser-preload.ts` which injects the agent's
 *   DOM interaction layer (`getInteractiveElements`, visual cursor, etc.).
 * - This component listens for IPC messages from the preload script
 *   (DOM snapshots, screenshots, action results) and relays them to
 *   `AgentService` via `tala.sendBrowserData()`.
 * - Agent events (navigate, click, type, scroll) are forwarded from
 *   `App.tsx` → `handleAgentEvent()` → `webview.send('agent-action', ...)`.
 *
 * **Features:**
 * - URL bar with navigation (back, forward, reload).
 * - Screenshot capture on agent request.
 * - Navigation history tracking.
 * - Browser path resolution for `file://` protocol.
 */
import React, { useEffect, useRef, useState } from 'react';

/**
 * Embedded browser panel with agent automation support.
 *
 * @param {string} initialUrl - Starting URL for the webview.
 * @param {Function} onClose - Callback to close the browser panel.
 * @param {Function} onUrlChange - Callback when the webview navigates to a new URL.
 */
const Browser: React.FC<any> = ({ initialUrl, onClose, onUrlChange, isActive }) => {
    const webviewRef = useRef<any>(null);
    const [url, setUrl] = useState(initialUrl || 'about:blank');
    const [inputUrl, setInputUrl] = useState(url);
    const [isLoading, setIsLoading] = useState(false);
    const [status, setStatus] = useState('Ready');
    const [cursor, setCursor] = useState<{ x: number, y: number, show: boolean }>({ x: 0, y: 0, show: false });

    // Stable partition ID to prevent resets
    const [partitionId] = useState(() => "tala-session-" + Date.now());
    const [preloadPath, setPreloadPath] = useState<string>('');

    useEffect(() => {
        if (initialUrl && initialUrl !== url) {
            console.log("Browser received new initialUrl:", initialUrl);
            handleNavigate(initialUrl);
        }
    }, [initialUrl]);

    useEffect(() => {
        const fetchPath = async () => {
            const api = (window as any).tala;
            if (api && api.getAssetPath) {
                try {
                    // Reverted: main.js is in dist-electron/electron/, so browser-preload is a sibling.
                    const rawPath = await api.getAssetPath('browser-preload.js');
                    console.log("Raw Browser Preload Path:", rawPath);

                    // On Windows, passing the absolute path typically works better than constructing a file:// URI manually
                    // for the <webview> preload attribute.
                    setPreloadPath(rawPath);
                } catch (e) {
                    console.error("Failed to resolve asset path", e);
                }
            }
        };
        fetchPath();
    }, []);

    const normalizeUrl = (u: string) => {
        if (!u) return 'about:blank';
        if (u.startsWith('http')) return u;
        if (u.includes('.') && !u.includes(' ')) return 'https://' + u;
        return 'https://duckduckgo.com/?q=' + encodeURIComponent(u);
    };

    const handleNavigate = (newUrl: string) => {
        const normalized = normalizeUrl(newUrl);
        setUrl(normalized);
        setInputUrl(normalized);
    };

    const handleWebviewUrlChange = (e: any) => {
        const newUrl = e.url;
        setInputUrl(newUrl);
        onUrlChange?.(newUrl);
    };

    useEffect(() => {
        const webview = webviewRef.current;
        console.log(`[Browser Component] Effect running. Preload: ${!!preloadPath}, Webview Ref: ${!!webview}`);

        if (webview) {
            const api = (window as any).tala;
            console.log("[Browser Component] Attaching IPC listeners to webview...");

            // IPC Listener for responses from preload script
            const handleIpcMessage = (event: any) => {
                // ... (existing handler code)
                if (!api) return;

                // Logging for verification
                if (event.channel === 'agent-response') {
                    const { type } = event.args[0];
                    console.log(`[Browser Component] IPC Received: ${type}`);
                }

                if (event.channel === 'agent-response') {
                    const { type, result, error } = event.args[0];
                    // console.log(`[Browser Component] Host received IPC: ${type}`, result || error);

                    if (type === 'click_coords') {
                        // ...
                        const { x, y, selector } = result;
                        setStatus(`Clicking at (${x}, ${y})...`);

                        // 0. VISUAL DEBUG (Smooth Cursor via Preload)
                        // Trigger smooth move inside webview
                        webview.send('agent-action', { type: 'cursor_move', data: { x, y } });
                        // Keep React state for debugging? Maybe not needed, but harmless.
                        setCursor({ x, y, show: true });

                        // 1. Focus & Move
                        webview.focus();
                        webview.sendInputEvent({ type: 'mouseMove', x, y });

                        // 2. Click Sequence (simulate human duration)
                        setTimeout(() => {
                            // Show "Ripple" visual
                            webview.send('agent-action', { type: 'click_visual', data: { x, y } });

                            webview.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });

                            setTimeout(() => {
                                webview.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });

                                // 3. Report Success
                                console.log(`[Browser Component] Clicked ${selector} at (${x},${y})`);
                                api.provideBrowserData('action-response', `Clicked ${selector} at (${x},${y})`);
                                setStatus('Ready');
                            }, 100); // Hold click for 100ms
                        }, 500); // Wait 500ms after move for visual travel time (preload transition is 0.5s)
                        return;
                    }

                    if (error) {
                        setStatus(`Error (${type}): ${error}`);
                        if (type === 'get_dom') api.provideBrowserData('dom', "Error: " + error);
                        else if (type === 'ping') api.provideBrowserData('pong', "Error: " + error);
                        else api.provideBrowserData('action-response', "Error: " + error);
                    } else {
                        setStatus(`Done (${type})`);
                        if (type === 'get_dom') {
                            api.provideBrowserData('dom', result);
                        } else if (type === 'pong') {
                            api.provideBrowserData('pong', result);
                        } else if (type === 'debug') {
                            // Forward debug logs to Main/Terminal
                            api.provideBrowserData('debug', result);
                        } else {
                            api.provideBrowserData('action-response', result);
                        }
                        // Reset status after short delay
                        setTimeout(() => setStatus('Ready'), 2000);
                    }
                }
            };

            // Attach listeners
            webview.addEventListener('ipc-message', handleIpcMessage);
            webview.addEventListener('did-navigate', handleWebviewUrlChange);
            webview.addEventListener('did-navigate-in-page', handleWebviewUrlChange);

            webview.addEventListener('did-start-loading', () => {
                setIsLoading(true);
                setStatus('NAVIGATING...');
            });

            webview.addEventListener('did-stop-loading', () => {
                setIsLoading(false);
                setStatus('LOADED');
                setTimeout(() => setStatus('Ready'), 3000);
            });

            webview.addEventListener('dom-ready', () => {
                console.log("Webview DOM Ready");
            });

            webview.addEventListener('console-message', (e: any) => {
                // Forward webview logs to main console for debugging
                console.log(`[Webview]: ${e.message} (Line ${e.line})`);
            });

            return () => {
                console.log("[Browser Component] Detaching IPC listeners...");
                webview.removeEventListener('ipc-message', handleIpcMessage);
                webview.removeEventListener('did-navigate', handleWebviewUrlChange);
                webview.removeEventListener('did-navigate-in-page', handleWebviewUrlChange);
            };
        } else {
            console.log("[Browser Component] Effect ran but webview ref is NULL.");
        }
    }, [partitionId, preloadPath]);

    // Listen for commands from the Agent Brain
    useEffect(() => {
        const api = (window as any).tala;
        if (!api) return;

        const handleAgentEvent = async (event: any) => {
            // Note: isActive check removed to allow background automation by AI
            console.log(`[Browser Component] Received Agent Event: ${event.type}`, event.data);
            const webview = webviewRef.current;
            if (!webview) return;

            try {
                if (event.type === 'browser-navigate') {
                    setStatus('NAVIGATING...');
                    handleNavigate(event.data.url);

                } else if (event.type === 'browser-click') {
                    setStatus('Clicking element...');
                    webview.send('agent-action', { type: 'click', data: event.data });

                } else if (event.type === 'browser-hover') {
                    setStatus('Hovering element...');
                    webview.send('agent-action', { type: 'hover', data: event.data });

                } else if (event.type === 'browser-type') {
                    setStatus('Typing input...');
                    webview.send('agent-action', { type: 'type', data: event.data });

                } else if (event.type === 'browser-scroll') {
                    setStatus('Scrolling page...');
                    webview.send('agent-action', { type: 'scroll', data: event.data });

                } else if (event.type === 'browser-press-key') {
                    setStatus('Pressing key...');
                    webview.send('agent-action', { type: 'press_key', data: event.data });

                } else if (event.type === 'browser-get-dom') {
                    setStatus('Scanning Page...');
                    console.log("[Browser Component] Sending 'get_dom' to webview...");
                    webview.send('agent-action', { type: 'get_dom', data: {} });

                    // Defensive Fallback: If no response in 5s, try executeJavaScript directly
                    setTimeout(() => {
                        if (status === 'Scanning Page...') {
                            console.warn("[Browser Component] IPC 'get_dom' seems stuck. Trying executeJavaScript fallback...");

                            // Check document.readyState first in fallback
                            const js = `
                                (function() {
                                    if (window.__tala_get_dom) {
                                        return window.__tala_get_dom();
                                    }
                                    return "Error: Preload script not yet ready or window.__tala_get_dom removed";
                                })()
                            `;

                            webview.executeJavaScript(js).then((result: any) => {
                                if (result && !result.startsWith('Error:')) {
                                    console.log("[Browser Component] Fallback 'get_dom' success.");
                                    api.provideBrowserData('dom', result);
                                    setStatus('Ready (Fallback)');
                                } else {
                                    console.error("[Browser Component] Fallback also failed:", result);
                                    api.provideBrowserData('dom', result || "Error: Unknown fallback failure");
                                    setStatus('Error: Scan Failed');
                                }
                            }).catch((err: any) => {
                                console.error("[Browser Component] JS Execution failed", err);
                                api.provideBrowserData('dom', "Error: Fallback JS execution failed - " + err.message);
                                setStatus('Error: JS Failed');
                            });
                        }
                    }, 5000);

                } else if (event.type === 'browser-ping') {
                    console.log("[Browser Component] Sending 'ping' to webview...");
                    webview.send('agent-action', { type: 'ping', data: {} });

                } else if (event.type === 'browser-screenshot') {
                    setStatus('Capturing Screenshot...');
                    console.log("[Browser Component] Capturing page...");
                    webview.capturePage().then((image: any) => {
                        const base64 = image.toDataURL().split(',')[1];
                        console.log("[Browser Component] Screenshot captured.");
                        api.provideBrowserData('screenshot', base64);
                        setStatus('Ready');
                    }).catch((err: any) => {
                        console.error("Screenshot failed", err);
                        api.provideBrowserData('screenshot', "Error: " + err.message);
                        setStatus('Error: Screenshot failed');
                    });
                }
            } catch (e: any) {
                console.error("Browser automation error", e);
                setStatus('Error: ' + e.message);

                // Fallback error reporting
                if (event.type === 'browser-get-dom') api.provideBrowserData('dom', "Error: " + e.message);
                else api.provideBrowserData('action-response', "Error: " + e.message);
            }
        };

        api.on('agent-event', handleAgentEvent);
        return () => api.off('agent-event', handleAgentEvent);
    }, [isActive]);

    if (!preloadPath) {
        return (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#333', color: '#ff6b6b', flexDirection: 'column' }}>
                <h3>Browser Initialization Failed</h3>
                <p>Preload path not found. Please restart the application completely.</p>
                <button onClick={() => window.location.reload()} style={{ padding: '8px 16px', marginTop: 10, cursor: 'pointer' }}>Reload UI</button>
            </div>
        );
    }

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#fff' }}>
            {/* Toolbar */}
            <div style={{
                padding: '8px',
                borderBottom: '1px solid #ddd',
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                background: '#f5f5f5'
            }}>
                <button
                    onClick={() => {
                        const webview = webviewRef.current;
                        if (webview && webview.canGoBack()) webview.goBack();
                    }}
                    style={{ padding: '4px 8px', cursor: 'pointer' }}
                >←</button>
                <button
                    onClick={() => {
                        const webview = webviewRef.current;
                        if (webview) webview.reload();
                    }}
                    style={{ padding: '4px 8px', cursor: 'pointer' }}
                >↻</button>

                <input
                    type="text"
                    value={inputUrl}
                    onChange={(e) => setInputUrl(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') handleNavigate(inputUrl);
                    }}
                    style={{ flex: 1, padding: '4px' }}
                />

                {!initialUrl && (
                    <button onClick={() => onClose && onClose()} style={{ padding: '4px 8px', cursor: 'pointer' }}>Close</button>
                )}
            </div>

            {/* Status Bar */}
            <div style={{
                background: '#eee',
                padding: '2px 8px',
                fontSize: '10px',
                textAlign: 'right',
                color: '#666',
                borderBottom: '1px solid #ddd'
            }}>
                {isLoading && <span style={{ marginRight: 8 }}>⏳ Loading...</span>}
                {status.toUpperCase()}
            </div>

            {/* Browser View */}
            <div style={{ flex: 1, position: 'relative' }}>
                {preloadPath ? (
                    <webview
                        ref={webviewRef}
                        src={url}
                        preload={preloadPath}
                        // MIMIC REAL BROWSER UA
                        useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                        // @ts-ignore
                        allowpopups="true"
                        // STABLE PARTITION
                        partition={partitionId}
                        // REQUIRED for ipcRenderer
                        webpreferences="contextIsolation=true, sandbox=false, nodeIntegration=false"
                        style={{
                            width: '100%',
                            height: '100%',
                            position: 'absolute',
                            top: 0,
                            left: 0
                        }}
                    />
                ) : (
                    <div style={{ padding: 20 }}>Loading Browser Engine...</div>
                )}

                {/* DEBUG: Host-side Cursor (Red Dot) to verify React state updates */}
                {cursor.show && (
                    <div style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        transform: `translate(${cursor.x}px, ${cursor.y}px)`,
                        width: '10px',
                        height: '10px',
                        background: 'red',
                        borderRadius: '50%',
                        pointerEvents: 'none',
                        zIndex: 999999,
                        opacity: 0.5,
                        border: '1px solid white'
                    }} title="Debug Host Cursor" />
                )}
            </div>
        </div>
    );
};

export { Browser };
export default Browser;
