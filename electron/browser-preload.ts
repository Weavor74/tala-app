/**
 * Electron Preload Script — Browser WebView (browser-use agent injection)
 * 
 * This script is injected into the `<webview>` tag managed by `Browser.tsx`.
 * It enables Tala's AI agent to perceive and interact with web pages by:
 * 
 * 1. **DOM Extraction** (`getInteractiveElements`):
 *    Scans the page for interactive elements (links, buttons, inputs, etc.),
 *    assigns numeric IDs (`data-tala-id`), and creates visual red markers.
 *    Returns a structured text representation the AI can reason about.
 * 
 * 2. **Agent Actions** (IPC `agent-action` listener):
 *    Handles commands from the main process:
 *    - `ping` — Health check.
 *    - `get_dom` — Extracts and returns the interactive DOM.
 *    - `click` — Clicks an element by numeric ID or CSS selector.
 *    - `type` — Types text into an input element.
 *    - `scroll` — Scrolls the page in a given direction.
 *    - `cursor_move` / `click_visual` — Visual cursor animation.
 * 
 * 3. **Visual Cursor** — A blue SVG cursor that animates smoothly
 *    to show where the agent is "looking" on the page.
 * 
 * **Communication:**
 * Uses `ipcRenderer.sendToHost('agent-response', ...)` to send results
 * back to the parent `<webview>` host (`Browser.tsx`), which relays them
 * to the main process and ultimately to `AgentService.provideBrowserData()`.
 * 
 * **Safety:**
 * - Element scanning is capped at 500 elements max.
 * - Visual markers are limited to 200 to avoid DOM pollution.
 * - Text content is truncated to 50 characters per element.
 * - The entire script is wrapped in a try/catch for resilience.
 */
const { ipcRenderer, contextBridge } = require('electron');

try {
    console.log("[Tala Browser] Preload script initializing...");

    /**
     * Scans the current page for interactive elements and builds a text-based
     * DOM representation for the AI agent.
     * 
     * **Process:**
     * 1. Removes any existing red marker overlays from previous scans.
     * 2. Queries for interactive elements using a comprehensive selector list
     *    (links, buttons, inputs, textareas, selects, ARIA roles, etc.).
     * 3. Filters out invisible, off-screen, or tiny (<2px) elements.
     * 4. Assigns a sequential numeric ID (`data-tala-id`) to each element.
     * 5. Extracts the element's label (text, placeholder, aria-label, alt text).
     * 6. Creates red visual markers (positioned overlay divs) for visible elements.
     * 7. Returns a formatted string with page info and element list.
     * 
     * **Output format:**
     * ```
     * [PAGE INFO]
     * Title: ...
     * URL: ...
     * Scroll: ...
     * 
     * [INTERACTIVE ELEMENTS]
     * (ID [V]=Visible [H]=Hidden/Scrolled)
     * 1[:V] <a> Click here
     * 2[:V] <input:text> Search...
     * ```
     * 
     * @returns {string} The formatted DOM text, or an error message.
     */
    function getInteractiveElements() {
        try {
            // 0. Check Page State
            const isPageLoading = document.readyState !== 'complete';

            // 1. Cleanup old markers
            const existing = document.querySelectorAll('.tala-browser-marker');
            existing.forEach(e => (e as HTMLElement).remove());

            let idCounter = 1;
            const items: string[] = [];

            // Targeted selectors for interactive elements
            const interactiveSelectors = [
                'a[href]', 'button:not(:disabled)', 'input:not([type="hidden"])',
                'textarea', 'select', '[role="button"]', '[role="link"]',
                '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
                '[role="menuitem"]', '[role="combobox"]', '[role="searchbox"]',
                '[role="textbox"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
                'iframe', '[contenteditable="true"]'
            ];

            const all = document.querySelectorAll(interactiveSelectors.join(','));
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            const MAX_ELEMENTS = 800;
            const MAX_MARKERS = 300;
            const arrayAll = Array.from(all);

            // Track processed elements to avoid nested redundancy
            const processedSet = new Set<Element>();

            for (let i = 0; i < arrayAll.length && items.length < MAX_ELEMENTS; i++) {
                const element = arrayAll[i];

                // Redundancy filter: If we already processed an ancestor that is also in the list, 
                // and this ancestor is a link or button, we might want to skip this child to reduce noise.
                let ancestor = element.parentElement;
                let redundant = false;
                while (ancestor) {
                    if (processedSet.has(ancestor)) {
                        const tag = ancestor.tagName.toLowerCase();
                        if (tag === 'button' || tag === 'a' || ancestor.getAttribute('role') === 'button') {
                            redundant = true;
                            break;
                        }
                    }
                    ancestor = ancestor.parentElement;
                }
                if (redundant) continue;

                const rect = element.getBoundingClientRect();

                // Fast rejection: outside viewport or too small
                if (rect.width < 2 || rect.height < 2) continue;
                if (rect.bottom < -100 || rect.top > viewportHeight + 100) continue;

                // Visibility check
                const style = window.getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                if (style.opacity === '0' && element.tagName !== 'INPUT' && element.tagName !== 'TEXTAREA') continue;

                // Set ID
                const tid = idCounter++;
                element.setAttribute('data-tala-id', String(tid));
                processedSet.add(element);

                // Extract metadata and label
                let tagName = element.tagName.toLowerCase();
                const role = element.getAttribute('role');
                const ariaLabel = element.getAttribute('aria-label');
                const title = element.getAttribute('title');

                let content = "";
                if (tagName === 'input') {
                    const input = element as HTMLInputElement;
                    content = input.placeholder || input.value || ariaLabel || "";
                    tagName = `input:${input.type}`;
                } else if (tagName === 'textarea') {
                    const area = element as HTMLTextAreaElement;
                    content = area.placeholder || area.value || ariaLabel || "";
                } else if (tagName === 'select') {
                    const sel = element as HTMLSelectElement;
                    content = sel.options[sel.selectedIndex]?.text || "Select Menu";
                } else {
                    content = ariaLabel || title || "";
                    if (!content) {
                        const img = element.querySelector('img');
                        if (img) content = `img: ${(img as HTMLImageElement).alt || 'unlabeled'}`;
                    }
                    if (!content) {
                        content = (element as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() || "";
                    }
                }

                // Truncate and clean content
                content = content.substring(0, 60).replace(/\n/g, ' ');
                const isVisible = (rect.top >= 0 && rect.left >= 0 && rect.bottom <= viewportHeight && rect.right <= viewportWidth);
                const visibilityTag = isVisible ? '[:V]' : '[:H]';
                const roleTag = role ? ` [role=${role}]` : '';

                items.push(`${tid}${visibilityTag} <${tagName}>${roleTag} ${content || '(no text)'}`);

                // Visual Marker
                if (isVisible && items.length <= MAX_MARKERS) {
                    const marker = document.createElement('div');
                    marker.className = 'tala-browser-marker';
                    marker.textContent = String(tid);
                    Object.assign(marker.style, {
                        position: 'fixed',
                        top: (rect.top) + 'px',
                        left: (rect.left) + 'px',
                        background: '#ff0033',
                        color: 'white',
                        fontWeight: 'bold',
                        fontSize: '11px',
                        padding: '1px 3px',
                        borderRadius: '2px',
                        zIndex: '2147483647',
                        pointerEvents: 'none',
                        boxShadow: '0 0 2px rgba(0,0,0,0.5)',
                        border: '1px solid white',
                        opacity: '0.9'
                    });
                    document.body.appendChild(marker);
                }
            }

            const titleStr = document.title;
            const urlStr = window.location.href;
            const pageState = isPageLoading ? ' [LOADING...]' : '';

            let output = `[PAGE INFO]\nTitle: ${titleStr}${pageState}\nURL: ${urlStr}\nScroll: ${Math.round(window.scrollY)}\n\n`;

            if (items.length === 0) {
                output += `[CONTENT]\n(No interactive elements found. Try scrolling or check if page is still loading.)\n\n[TEXT PREVIEW]\n${document.body.innerText.substring(0, 1000).replace(/\s+/g, ' ')}`;
            } else {
                output += `[INTERACTIVE ELEMENTS]\n(ID [V]=Visible [H]=Hidden/Scrolled)\n${items.join('\n')}`;
            }

            return output;
        } catch (e: any) {
            return `Error extracting DOM: ${e.message}`;
        }
    }

    /** Exposes `getInteractiveElements` on `window` for `webContents.executeJavaScript()` fallback. */
    if (contextBridge) {
        contextBridge.exposeInMainWorld('__tala_get_dom', getInteractiveElements);
    } else {
        (window as any).__tala_get_dom = getInteractiveElements;
    }

    // ─── Visual Agent Cursor ──────────────────────────────────────
    /**
     * A blue SVG cursor element fixed-positioned on the page.
     * Animates smoothly to show where the agent is interacting.
     * Uses `pointer-events: none` so it doesn't interfere with clicks.
     */
    const cursor = document.createElement('div');
    cursor.id = 'tala-agent-cursor';
    Object.assign(cursor.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '24px',
        height: '24px',
        zIndex: '2147483647',
        pointerEvents: 'none',
        transition: 'transform 0.5s cubic-bezier(0.19, 1, 0.22, 1)',
        transform: 'translate(-100px, -100px)', // Start off-screen
        filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))'
    });
    cursor.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19841L11.7841 12.3673H5.65376Z" fill="#73C2FB" stroke="white" strokeWidth="1"/>
        </svg>
    `;

    /** Ensures the visual cursor element is always present in the DOM. */
    function ensureCursor() {
        if (!document.getElementById('tala-agent-cursor')) {
            document.body.appendChild(cursor);
        }
    }

    // ─── IPC Action Listener ──────────────────────────────────────
    /**
     * Handles agent commands relayed from `Browser.tsx` via webview IPC.
     * 
     * Each action type corresponds to an AI tool call:
     * - `ping` → responds with `'Ready'` for liveness check.
     * - `get_dom` → calls `getInteractiveElements()` and sends result.
     * - `cursor_move` → animates the visual cursor to (x, y).
     * - `click_visual` → shows a red ripple animation at (x, y).
     * - `click` → finds element by ID/selector, scrolls to it, sends coordinates.
     * - `type` → sets value on an input/textarea and dispatches events.
     * - `scroll` → scrolls the page (up, down, top, bottom).
     */
    ipcRenderer.on('agent-action', (event: any, { type, data }: { type: string, data: any }) => {
        console.log(`[Tala Browser] Received action: ${type}`, data);

        try {
            ensureCursor();

            if (type === 'ping') {
                ipcRenderer.sendToHost('agent-response', { type: 'pong', result: 'Ready' });
            }
            else if (type === 'get_dom') {
                try {
                    ipcRenderer.sendToHost('agent-response', { type: 'debug', result: 'Processing get_dom request...' });
                    const result = getInteractiveElements();
                    ipcRenderer.sendToHost('agent-response', { type: 'debug', result: `DOM extracted. Length: ${result.length}` });
                    ipcRenderer.sendToHost('agent-response', { type: 'get_dom', result });
                    ipcRenderer.sendToHost('agent-response', { type: 'debug', result: 'DOM sent successfully' });
                } catch (e: any) {
                    ipcRenderer.sendToHost('agent-response', { type: 'debug', result: `ERROR in get_dom: ${e.message}` });
                    ipcRenderer.sendToHost('agent-response', { type: 'error', error: e.message });
                }
            }
            else if (type === 'cursor_move') {
                const { x, y } = data;
                cursor.style.transform = `translate(${x}px, ${y}px)`;
            }
            else if (type === 'click_visual') {
                const ripple = document.createElement('div');
                Object.assign(ripple.style, {
                    position: 'fixed',
                    left: (data.x - 10) + 'px',
                    top: (data.y - 10) + 'px',
                    width: '20px', height: '20px', borderRadius: '50%',
                    background: 'rgba(255, 0, 0, 0.5)',
                    zIndex: '2147483647', pointerEvents: 'none',
                    transition: 'all 0.4s ease-out', transform: 'scale(0)'
                });
                document.body.appendChild(ripple);
                requestAnimationFrame(() => { ripple.style.transform = 'scale(2)'; ripple.style.opacity = '0'; });
                setTimeout(() => ripple.remove(), 500);
            }
            else if (type === 'click') {
                const selector = data.selector;
                let el = null;
                if (/^\d+$/.test(selector)) el = document.querySelector(`[data-tala-id="${selector}"]`);
                else el = document.querySelector(selector);

                if (el) {
                    el.scrollIntoView({ behavior: 'instant', block: 'center' }); // Use instant to ensure coords are ready immediately

                    setTimeout(() => {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            const x = Math.round(rect.left + (rect.width / 2));
                            const y = Math.round(rect.top + (rect.height / 2));

                            // Validate coordinates are within viewport
                            if (x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight) {
                                ipcRenderer.sendToHost('agent-response', {
                                    type: 'click_coords',
                                    result: { x, y, selector }
                                });
                            } else {
                                // Fallback to synthetic click if element is outside viewport (shouldn't happen with scrollIntoView)
                                console.warn("Element coordinates out of viewport, falling back to synthetic click");
                                el.click();
                                ipcRenderer.sendToHost('agent-response', { type: 'action-response', result: `Clicked ${selector} (synthetic fallback)` });
                            }
                        } else {
                            ipcRenderer.sendToHost('agent-response', { type: 'error', error: `Element ${selector} is not visible (0x0 size)` });
                        }
                    }, 150); // Increased delay for layout settle
                } else {
                    ipcRenderer.sendToHost('agent-response', { type: 'error', error: `Element ${selector} not found` });
                }
            }
            else if (type === 'type') {
                const { selector, text } = data;
                let el = null;
                if (/^\d+$/.test(selector)) el = document.querySelector(`[data-tala-id="${selector}"]`);
                else el = document.querySelector(selector);

                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.focus();
                    el.value = text;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    if (text.includes('\n')) {
                        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                    }
                    ipcRenderer.sendToHost('agent-response', { type: 'type', result: `Typed into ${selector}` });
                } else {
                    ipcRenderer.sendToHost('agent-response', { type: 'type', result: `Element ${selector} not found` });
                }
            }
            else if (type === 'scroll') {
                const direction = data.direction;
                const amount = data.amount || 300;
                if (direction === 'down') window.scrollBy({ top: amount, behavior: 'smooth' });
                else if (direction === 'up') window.scrollBy({ top: -amount, behavior: 'smooth' });
                else if (direction === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
                else if (direction === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                ipcRenderer.sendToHost('agent-response', { type: 'scroll', result: `Scrolled ${direction}` });
            }
        } catch (e: any) {
            ipcRenderer.sendToHost('agent-response', { type, error: e.message });
        }
    });

    console.log("[Tala Browser] Preload script ready.");
} catch (outerError: any) {
    console.error("[Tala Browser] Critical Preload Error:", outerError);
}
