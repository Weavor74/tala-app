/**
 * App — Root Application Component
 *
 * The top-level React component that composes the entire Tala IDE.
 * Renders a VS Code–style layout with:
 * - **Activity bar** (left icon strip) — switches sidebar views.
 * - **Left sidebar** — FileExplorer, Search, Library, SourceControl, Settings, Profile.
 * - **Main content** — tabbed code editor and/or embedded Browser.
 * - **Right panel** — AI chat interface (message list + input).
 * - **Bottom panel** — integrated Terminal.
 *
 * **IPC event handling:**
 * - `chat-token` — streaming LLM tokens into the chat.
 * - `chat-done` — marks the end of an LLM response.
 * - `chat-error` — displays error messages.
 * - `agent-event` — dispatches agent commands (navigate, click, type, a2ui-render).
 * - `external-chat` — receives messages from Discord mirroring.
 *
 * **Panel resizing:**
 * All three panels (left, right, bottom) support drag-to-resize via
 * mouse event handlers (`handleMove`, `handleUp`).
 *
 * **File editing:**
 * Open files are tracked in `openFiles` state; each tab shows a
 * `<textarea>` editor with save functionality via `tala.createFile()`.
 *
 * @capability [CAPABILITY 2.1] UI Rendering & Orchestration
 * @capability [CAPABILITY 2.2] Browser View Integration
 * @capability [CAPABILITY 2.3] File Explorer Handlers
 * @capability [CAPABILITY 2.4] Terminal Execution Bridge
 */
import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import type { Tab, WorkspaceArtifact, WorkspaceDocument } from './renderer/types';

import { UserProfile } from './renderer/UserProfile';
import { Settings } from './renderer/Settings';
import { FileExplorer } from './renderer/components/FileExplorer';
import { Terminal } from './renderer/components/Terminal';
import Browser from './renderer/components/Browser';
import { SourceControl } from './renderer/components/SourceControl';
import { ToastProvider, useToast } from './renderer/components/ToastNotification';
import { ChatSessions } from './renderer/components/ChatSessions';
import { EmotionDisplay } from './renderer/components/EmotionDisplay';
import { FirstRunWizard } from './renderer/components/FirstRunWizard';
import { ConflictEditor } from './renderer/components/ConflictEditor';
import { StartupSplash } from './renderer/components/StartupSplash';
import { Notebooks } from './renderer/components/Notebooks';
import { CoreWorkspace } from './renderer/components/CoreWorkspace';
import { AgentModeConfigPanel } from './renderer/components/AgentModeConfigPanel';
import { A2UIWorkspaceSurface } from './renderer/A2UIWorkspaceSurface';
import type { A2UISurfacePayload, A2UIActionDispatch } from '../shared/a2uiTypes';
import WorkspaceSurfaceHost from './renderer/workspace/WorkspaceSurfaceHost';
import { createWorkspaceDocumentFromArtifact, createWorkspaceDocumentFromFile } from './renderer/workspace/WorkspaceDocumentFactory';
import { resolveWorkspaceContentType } from './renderer/workspace/WorkspaceContentTypeResolver';


/** A single chat message in the conversation history. */
interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** True while the assistant is still streaming tokens for this message. */
  isStream?: boolean;
  /** Optional base64 images attached to the message. */
  images?: string[];
  /** Optional metadata (token usage, etc.) */
  metadata?: any;
}

/** Inline SVG icon components for the activity bar. */
const IconMenu = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" /></svg>;
const IconSourceControl = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>;
const IconSettings = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>;
const IconPanel = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="15" x2="21" y2="15" /></svg>;
const IconProfile = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>;
const IconBrowser = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>;
const IconHistory = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
const IconBrain = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" /><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" /></svg>;
const IconNotebook = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>;
const IconSun = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>;
const IconMoon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>;
const IconPower = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>;
const IconStop = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>;

/**
 * Root application component.
 * Manages layout state, file tabs, chat messaging, and agent event routing.
 */
function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [allowWrites, setAllowWrites] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const api = (window as any).tala;
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const { addToast } = useToast();


  // Layout State
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const [isBottomPanelOpen, setIsBottomPanelOpen] = useState(true);
  const [activeView, setActiveView] = useState('explorer');
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [chatWidth, setChatWidth] = useState(300);
  const [terminalHeight, setTerminalHeight] = useState(200);
  const [resizingPanel, setResizingPanel] = useState<'left' | 'right' | 'bottom' | null>(null);

  // TAB STATE
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // TERMINAL STATE
  const [terminals, setTerminals] = useState<{ id: string, title: string }[]>([{ id: 'default', title: 'Terminal 1' }]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>('default');

  const activeTab = tabs.find(t => t.id === activeTabId);

  // Layout & General UI State
  const [statusText, setStatusText] = useState('Loading...');
  const [showWizard, setShowWizard] = useState(false);

  // Engine Status
  const [localEngineRunning, setLocalEngineRunning] = useState(false);
  const [isStartingEngine, setIsStartingEngine] = useState(false);
  const [activeMode, setActiveMode] = useState<'rp' | 'hybrid' | 'assistant'>('hybrid');
  const [showModeSettings, setShowModeSettings] = useState(false);

  // Model Warning State
  const [modelStatus, setModelStatus] = useState<{ id: string, isLowFidelity: boolean, warning?: string } | null>(null);

  useEffect(() => {
    if (!api || !api.getSettings) return;
    const loadStatus = async () => {
      try {
        const result = await api.getSettings();
        if (result && result.global) {
          const settings = result.global;

          if (settings.appearance?.theme) {
            setTheme(settings.appearance.theme);
          }

          // Check First Run
          if (settings.system?.firstRunCompleted === false || settings.system?.firstRunCompleted === undefined) {
            setShowWizard(true);
          }

          if (settings.inference && settings.inference.instances) {
            const inf = settings.inference;
            if (inf.instances && inf.instances.length > 0) {
              const active = inf.mode === 'cloud-only'
                ? (inf.instances.find((i: any) => i.source === 'cloud') || inf.instances[0])
                : (inf.instances.find((i: any) => i.id === inf.activeLocalId) || inf.instances.sort((a: any, b: any) => a.priority - b.priority)[0]);

              if (active) {
                const engine = active.engine.charAt(0).toUpperCase() + active.engine.slice(1);
                const modePrefix = inf.mode === 'cloud-only' ? '[Cloud] ' : (inf.mode === 'local-only' ? '[Local] ' : '[Smart] ');
                setStatusText(`${modePrefix}${engine}: ${active.model}`);
              } else {
                setStatusText('No Provider Active');
              }
            }
          }
        }

        if (api.getLocalEngineStatus) {
          const engineStatus = await api.getLocalEngineStatus();
          setLocalEngineRunning(engineStatus.isRunning);
        }

        // Fetch Model Status
        if (api.getModelStatus) {
          const status = await api.getModelStatus();
          if (status) setModelStatus(status);
        }
        // Fetch Active Mode
        if (api.settings?.getActiveMode) {
          const mode = await api.settings.getActiveMode();
          if (mode) setActiveMode(mode);
        } else if (api.getActiveMode) {
          const mode = await api.getActiveMode();
          if (mode) setActiveMode(mode);
        }
      } catch (e) {
        console.error("Failed to load status", e);
        setStatusText('Status Unknown');
      }
    };
    loadStatus();
    // Poll every 5s for engine status & model info
    const interval = setInterval(loadStatus, 5000);
    return () => clearInterval(interval);
  }, [api]);

  const handleWizardComplete = async () => {
    if (api && api.getSettings && api.saveSettings) {
      try {
        const result = await api.getSettings();
        const globalSettings = result.global || {};
        const newSettings = {
          ...globalSettings,
          system: { ...(globalSettings.system || {}), firstRunCompleted: true }
        };
        await api.saveSettings(newSettings);
        setShowWizard(false);
      } catch (e) { console.error("Failed to save wizard completion", e); }
    } else {
      setShowWizard(false);
    }
  };

  // --- TAB MANAGEMENT ----------------------------------

  const activateTab = (id: string) => {
    setActiveTabId(id);
    const tab = tabs.find(t => t.id === id);
    if (tab && tab.type === 'browser') {
      setActiveView('browser');
    } else if (tab && tab.type === 'file') {
      setActiveView('explorer');
    }
  };

  const closeTab = (id: string) => {
    const newTabs = tabs.filter(t => t.id !== id);
    setTabs(newTabs);

    // If we closed the active tab, switch to another
    if (activeTabId === id) {
      if (newTabs.length > 0) {
        const index = tabs.findIndex(t => t.id === id);
        // Try next, or prev
        const nextTab = newTabs[index] || newTabs[index - 1];
        if (nextTab) {
          setActiveTabId(nextTab.id);
        } else {
          setActiveTabId(null);
        }
      } else {
        setActiveTabId(null);
      }
    }
  };

  const resolveFilePayloadReadRequirement = (path: string): boolean => {
    const contentType = resolveWorkspaceContentType({ path });
    return contentType === 'text' || contentType === 'html' || contentType === 'rtf' || contentType === 'board';
  };

  const openFileTab = async (path: string) => {
    const existing = tabs.find(t => t.type === 'file' && (t.document?.path === path || t.data?.path === path));
    if (existing) {
      activateTab(existing.id);
      return;
    }
    try {
      const payload = resolveFilePayloadReadRequirement(path) ? await api.readFile(path) : undefined;
      const tabId = 'tab-' + Math.random().toString(36).substr(2, 9);
      const title = path.split('/').pop() || 'File';
      const document = createWorkspaceDocumentFromFile({
        id: tabId,
        title,
        path,
        payload
      });
      const newTab: Tab = {
        id: tabId,
        type: 'file',
        title,
        data: { path, content: payload },
        document,
        active: true
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
      setActiveView('explorer');
    } catch (e) {
      console.error("Failed to read file", e);
    }
  };

  const openBrowserTab = (url: string = 'https://duckduckgo.com') => {
    const newTab: Tab = {
      id: 'tab-' + Math.random().toString(36).substr(2, 9),
      type: 'browser',
      title: 'Browser',
      data: { url },
      active: true
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    setActiveView('browser');
  };

  const openConflictTab = async (path: string) => {
    try {
      const content = await api.readFile(path);
      const newTab: Tab = {
        id: 'conflict-' + Math.random().toString(36).substr(2, 9),
        type: 'conflict',
        title: `Merge: ${path.split('/').pop()}`,
        data: { path, content },
        active: true,
        conflictPath: path
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
    } catch (e) {
      console.error("Failed to open conflict", e);
    }
  };

  const handleResolveConflict = async (path: string, newContent: string) => {
    try {
      await api.createFile(path, newContent);
      await api.gitStage(path); // Stage resolved file
      addToast({ type: 'success', message: `Resolved and staged ${path}` });

      // Close conflict tab
      const tab = tabs.find(t => t.type === 'conflict' && t.data.path === path);
      if (tab) closeTab(tab.id);
    } catch (e: any) {
      addToast({ type: 'error', message: `Resolution failed: ${e.message}` });
    }
  };


  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = async () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    if (api && api.getSettings && api.saveSettings) {
      try {
        const settings = await api.getSettings();
        const newSettings = {
          ...settings,
          appearance: { ...(settings?.appearance || {}), theme: newTheme }
        };
        await api.saveSettings(newSettings);
      } catch (e) { console.error("Failed to save theme", e); }
    }
  };

  useEffect(() => {
    const handleUp = () => setResizingPanel(null);
    const handleMove = (e: MouseEvent) => {
      if (!resizingPanel) return;
      e.preventDefault(); // Prevent text selection

      if (resizingPanel === 'left') {
        const newWidth = e.clientX - 50; // 50 is activity bar width
        if (newWidth > 150 && newWidth < 800) setSidebarWidth(newWidth);
      } else if (resizingPanel === 'right') {
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth > 200 && newWidth < 800) setChatWidth(newWidth);
      } else if (resizingPanel === 'bottom') {
        // Bottom panel height = window height - mouse Y - status bar height (approx 22)
        const newHeight = window.innerHeight - e.clientY - 25;
        if (newHeight > 100 && newHeight < 800) setTerminalHeight(newHeight);
      }
    };

    if (resizingPanel) {
      window.addEventListener('mouseup', handleUp);
      window.addEventListener('mousemove', handleMove);
    }
    return () => {
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('mousemove', handleMove);
    };
  }, [resizingPanel]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      // Escape — cancel streaming
      if (e.key === 'Escape' && isStreaming && api?.cancelChat) {
        e.preventDefault();
        api.cancelChat();
        return;
      }

      // Ctrl+Shift+P — focus chat input
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        chatInputRef.current?.focus();
        return;
      }

      // Ctrl+B — toggle left sidebar
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setIsLeftPanelOpen(prev => !prev);
        return;
      }

      // Ctrl+J — toggle terminal
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setIsBottomPanelOpen(prev => !prev);
        return;
      }

      // Ctrl+Shift+B — toggle chat panel
      if (mod && e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setIsRightPanelOpen(prev => !prev);
        return;
      }

      // Ctrl+N — new chat session
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setMessages([]);
        if (api?.clearChatHistory) api.clearChatHistory();
        chatInputRef.current?.focus();
        return;
      }

      // Ctrl+1-7 — switch sidebar views
      const viewKeys: Record<string, string> = {
        '1': 'explorer', '2': 'search', '3': 'browser',
        '4': 'library', '5': 'source_control', '6': 'profile', '7': 'settings'
      };
      if (mod && viewKeys[e.key]) {
        e.preventDefault();
        toggleSidebar(viewKeys[e.key]);
        return;
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isStreaming, api]);

  const toggleSidebar = (view: string) => {
    if (activeView === view) {
      setIsLeftPanelOpen(!isLeftPanelOpen);
    } else {
      setActiveView(view);
      setIsLeftPanelOpen(true);
    }
  };

  // Session Persistence
  useEffect(() => {

    const loadSession = async () => {
      try {
        const session = await (window as any).tala.getSession();
        if (session && session.tabs && Array.isArray(session.tabs)) {
          console.log('[App] Restoring session:', session);

          // Re-hydrate tabs (e.g. read file content again to ensure freshness)
          const hydratedTabs = await Promise.all(session.tabs.map(async (t: Tab) => {
            if (t.type === 'file') {
              const persistedPath = t.document?.path || t.data?.path;
              const title = t.title || persistedPath?.split(/[/\\]/).pop() || 'File';
              if (!persistedPath) return t;
              try {
                const contentType = resolveWorkspaceContentType({ path: persistedPath });
                const content = (contentType === 'text' || contentType === 'html' || contentType === 'rtf' || contentType === 'board')
                  ? await (window as any).tala.readFile(persistedPath)
                  : undefined;
                const doc = createWorkspaceDocumentFromFile({
                  id: t.id,
                  title,
                  path: persistedPath,
                  payload: content,
                  metadata: t.document?.metadata
                });
                return { ...t, title, data: { ...t.data, path: persistedPath, content }, document: doc };
              } catch (e) {
                console.error(`Failed to restore file ${persistedPath}`, e);
                return t; // Keep it, it might just be missing context or deleted
              }
            }
            if (t.type === 'artifact' && t.artifact) {
              const normalized = createWorkspaceDocumentFromArtifact(t.artifact);
              if (t.document) {
                return {
                  ...t,
                  document: {
                    ...normalized,
                    ...t.document,
                    payload: t.document.payload ?? normalized.payload ?? (typeof t.data === 'string' ? t.data : undefined),
                  }
                };
              }
              return {
                ...t,
                document: {
                  ...normalized,
                  payload: normalized.payload ?? (typeof t.data === 'string' ? t.data : undefined),
                }
              };
            }
            return t;
          }));

          setTabs(hydratedTabs);
          if (session.activeTabId) {
            setActiveTabId(session.activeTabId);
            // also set active view based on the restored active tab
            const active = hydratedTabs.find(t => t.id === session.activeTabId);
            if (active) {
              if (active.type === 'browser') setActiveView('browser');
              else if (active.type === 'file') setActiveView('explorer');
            }
          }
        }
      } catch (e) {
        console.error('[App] Failed to load session', e);
      }
    };
    loadSession();
  }, []);

  // Auto-save Session
  useEffect(() => {
    if (tabs.length === 0 && !activeTabId) return; // Don't wipe session on empty init

    const saveTimer = setTimeout(() => {
      const sessionData = {
        tabs: tabs.map(t => ({
          ...t,
          data: t.type === 'file' ? { path: t.document?.path || t.data?.path } : t.data, // Don't save huge file content, just path
          document: t.document
            ? {
              ...t.document,
              payload: t.type === 'file' ? undefined : t.document.payload,
              dirty: false
            }
            : undefined
        })),
        activeTabId
      };
      (window as any).tala.saveSession(sessionData);
    }, 1000); // Debounce 1s

    return () => clearTimeout(saveTimer);
  }, [tabs, activeTabId]);

  const updateActiveTabContent = (newContent: string) => {
    if (!activeTabId) return;
    setTabs(prev => prev.map(t => {
      if (t.id === activeTabId && t.type === 'file') {
        return {
          ...t,
          data: { ...t.data, content: newContent },
          document: t.document ? { ...t.document, payload: newContent, dirty: true } : t.document
        };
      }
      return t;
    }));
  };

  const updateActiveTabDocumentMetadata = (metadata: Record<string, unknown>) => {
    if (!activeTabId) return;
    setTabs(prev => prev.map(t => {
      if (t.id !== activeTabId || !t.document) return t;
      const mergedMetadata = { ...(t.document.metadata || {}), ...metadata };
      if (JSON.stringify(mergedMetadata) === JSON.stringify(t.document.metadata || {})) {
        return t;
      }
      return {
        ...t,
        document: {
          ...t.document,
          metadata: mergedMetadata,
        }
      };
    }));
  };

  const handleSaveFile = async () => {
    const tab = activeTab;
    if (!tab || tab.type !== 'file') return;
    const path = tab.document?.path || tab.data?.path;
    const content = tab.document?.payload ?? tab.data?.content ?? '';
    if (!path) return;
    try {
      await api.createFile(path, content);
      setTabs(prev => prev.map(t => {
        if (t.id !== tab.id || !t.document) return t;
        return { ...t, document: { ...t.document, dirty: false } };
      }));
      // If in memory folder, re-ingest
      if (path.startsWith('memory/')) {
        console.log(`[App] Re-ingesting ${path}...`);
        await api.ingestFile(path);
      }
      addToast({ type: 'success', message: `Saved ${tab.title}` });
    } catch (e: any) {
      addToast({ type: 'error', message: `Save failed: ${e.message}` });
    }
  };

  const chatEndRef = useRef<HTMLDivElement>(null);
  // api definition moved to top

  const [userName, setUserName] = useState('USER');

  useEffect(() => {
    if (api && api.getProfile) {
      api.getProfile().then((p: any) => {
        if (p && p.firstName) setUserName(p.firstName.toUpperCase());
      });
    }
  }, [api]);



  const activeViewRef = useRef(activeView);
  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);

  useEffect(() => {
    if (!api) return;

    const handleToken = (token: string) => {
      setIsStreaming(true);
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant' && last.isStream) {
          return [...prev.slice(0, -1), { ...last, content: last.content + token }];
        }
        return [...prev, { role: 'assistant', content: token, isStream: true }];
      });
    };

    const handleDone = (payload?: any) => {
      setIsStreaming(false);
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant') {
          // If the payload contains a sanitized/complete message, use it
          const finalContent = payload?.message || last.content;
          return [...prev.slice(0, -1), { ...last, content: finalContent, isStream: false }];
        }
        return prev;
      });
    }


    const handleError = (error: string) => {
      setIsStreaming(false);
      setMessages(prev => [...prev, { role: 'system', content: `Error: ${error}` }]);
      addToast({ type: 'error', message: error.length > 80 ? error.slice(0, 80) + '…' : error });
    };

    const handleAgentEvent = (event: { type: string, data: any }) => {
      console.log(`[Agent Event] Type: ${event.type}`, event.data);

      // --- A2UI SURFACE OPENING (Phase 4C) ---
      // Routes structured workspace surfaces to the document/editor pane.
      // Chat receives only a lightweight toast notice, not the full surface.
      if (event.type === 'a2ui-surface-open') {
        const payload = event.data as A2UISurfacePayload;
        if (!payload || !payload.surfaceId || !payload.tabId) {
          console.warn('[A2UIBridge] Received malformed a2ui-surface-open payload:', payload);
          return;
        }

        setTabs(prev => {
          // Stable tab: update existing surface tab in place if it exists
          const existingIndex = prev.findIndex(t => t.id === payload.tabId && t.type === 'a2ui');
          if (existingIndex >= 0) {
            const updated = prev.map((t, i) =>
              i === existingIndex ? { ...t, title: payload.title, data: payload } : t
            );
            if (payload.focus !== false) {
              setActiveTabId(payload.tabId);
            }
            return updated;
          }
          // Create new a2ui tab
          const newTab: Tab = {
            id: payload.tabId,
            type: 'a2ui',
            title: payload.title,
            active: true,
            data: payload,
          };
          if (payload.focus !== false) {
            setActiveTabId(payload.tabId);
          }
          return [...prev, newTab];
        });

        console.log(`[A2UIBridge] Surface '${payload.surfaceId}' opened. Tab: ${payload.tabId}`);
        return;
      }

      // --- ARTIFACT OPENING (CANONICAL) ---
      if (event.type === 'artifact-open') {
        const artifact = event.data as WorkspaceArtifact;

        // 1. BRIDGE TO REAL EDITOR (for local files)
        if ((artifact.type === 'editor' || artifact.type === 'code') && artifact.path && !artifact.readOnly) {
          console.log(`[ArtifactBridge] Redirecting to openFileTab: ${artifact.path}`);
          openFileTab(artifact.path);
          return;
        }

        // 2. BRIDGE TO REAL BROWSER (for URLs)
        if (artifact.type === 'browser' && artifact.url) {
          console.log(`[ArtifactBridge] Redirecting to openBrowserTab: ${artifact.url}`);
          openBrowserTab(artifact.url);
          return;
        }

        const tid = artifact.id || ('tab-' + Math.random().toString(36).substr(2, 9));
        const document = createWorkspaceDocumentFromArtifact(artifact);

        setTabs(prev => {
          const existing = prev.find(t => t.artifact?.id === artifact.id || (t.type === 'file' && (t.document?.path === artifact.path || t.data?.path === artifact.path)));
          if (existing) {
            setActiveTabId(existing.id);
            return prev;
          }
          const newTab: Tab = {
            id: tid,
            type: 'artifact',
            title: document.title,
            active: true,
            artifact: artifact,
            data: artifact.content || artifact.url,
            document,
          };
          setActiveTabId(tid);
          return [...prev, newTab];
        });

        // Smart view routing for non-bridged artifacts
        if (artifact.type === 'html' || artifact.type === 'markdown' || artifact.type === 'report') {
          setActiveView('explorer'); // View pane is usually in explorer/aside
        }
        addToast({ type: 'success', message: `Opened ${artifact.title || 'artifact'}` });
        return;
      }

      // --- BROWSER NAVIGATION (LEGACY COMPAT) ---
      if (event.type === 'browser-navigate') {
        const browserTab = tabs.find(t => t.type === 'browser');
        if (browserTab) {
          // Update the tab's URL in state so it persists if unmounted/remounted
          setTabs(prev => prev.map(t => t.id === browserTab.id ? { ...t, data: { ...t.data, url: event.data?.url } } : t));
          activateTab(browserTab.id);
        } else {
          openBrowserTab(event.data?.url);
        }
        addToast({ type: 'info', message: `Navigating to ${event.data?.url || 'page'}…` });
        return;
      }

      // --- BROWSER ACTIONS (DEFENSIVE & PROACTIVE) ---
      // Ensure browser is visible/ready for other actions too
      if (event.type.startsWith('browser-')) {
        const browserTab = tabs.find(t => t.type === 'browser');
        if (!browserTab) {
          console.log("[App] Auto-opening browser for agent event:", event.type);
          openBrowserTab('about:blank');
        } else {
          // If we have a tab but it's not active, maybe we should activate it?
          // For now, let's at least switch the view if it's get-dom or something visual
          if (activeTabId !== browserTab.id) {
            activateTab(browserTab.id);
          }
        }
      }

      if (event.type === 'terminal-run') {
        setIsBottomPanelOpen(true);
        addToast({ type: 'info', message: 'Running terminal command…' });
        if (api && api.sendTerminalInput) {
          setTimeout(() => api.sendTerminalInput(event.data.command + '\n'), 100);
        }
      } else if (event.type === 'mcp-reconnect') {
        addToast({ type: 'warning', message: `MCP service "${event.data?.name || 'unknown'}" reconnected` });
      } else if (event.type === 'backup-complete') {
        addToast({ type: 'success', message: 'Workspace backup complete' });
      } else if (event.type === 'usage-update') {
        // Update the last assistant message with usage metadata
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant') {
            return [...prev.slice(0, -1), { ...last, metadata: { ...last.metadata, usage: event.data } }];
          }
          return prev;
        });
      }
    };

    const handleExternalChat = (msg: { role: 'user' | 'assistant', content: string, source: string }) => {
      setMessages(prev => [...prev, { role: msg.role, content: msg.content }]);
    };

    const handleSystemNotification = (notif: { type: 'success' | 'error' | 'warning' | 'info', message: string }) => {
      console.log(`[System Notification]`, notif);
      addToast(notif);
      if (notif.type === 'error') {
        setMessages(prev => [...prev, { role: 'system', content: `System Error: ${notif.message}` }]);
      }
    };

    api.on('chat-token', handleToken);
    api.on('chat-done', handleDone);
    api.on('chat-error', handleError);
    api.on('agent-event', handleAgentEvent);
    (api as any).on('external-chat', handleExternalChat);
    (api as any).on('system:notification', handleSystemNotification);

    // Listen for model status updates
    const handleModelStatus = (status: any) => {
      console.log('[App] Received model status:', status);
      setModelStatus(status);
    };
    (api as any).on('model-status', handleModelStatus);

    return () => {
      api.off('chat-token', handleToken);
      api.off('chat-done', handleDone);
      api.off('chat-error', handleError);
      api.off('agent-event', handleAgentEvent);
      (api as any).off('external-chat', handleExternalChat);
      (api as any).off('system:notification', handleSystemNotification);
      (api as any).off('model-status', handleModelStatus);
    };
  }, [api]); // REMOVED activeView dependency

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() && pendingImages.length === 0) return;
    const msg = input;
    const imgs = [...pendingImages];

    setInput('');
    setPendingImages([]);

    setMessages(prev => [...prev, { role: 'user', content: msg, images: imgs }]);

    if (api) {
      api.send('chat-message', {
        text: msg,
        images: imgs,
        capabilitiesOverride: { allowWritesThisTurn: allowWrites }
      });
    }
    // Auto-reset checkbox after sending if it was checked
    setAllowWrites(false);
  };

  const handleEdit = (index: number) => {
    setEditingIndex(index);
    setEditText(messages[index].content);
  };

  const handleSaveEdit = async () => {
    if (editingIndex === null) return;
    const idx = editingIndex;
    const text = editText;
    const imgs = messages[idx].images || [];

    setEditingIndex(null);
    setEditText("");

    // Truncate locally
    setMessages(prev => prev.slice(0, idx));

    // Truncate backend & resend
    if (api && api.rewindChat) {
      await api.rewindChat(idx);
      setMessages(prev => [...prev, { role: 'user', content: text, images: imgs }]);
      api.send('chat-message', {
        text,
        images: imgs,
        capabilitiesOverride: { allowWritesThisTurn: allowWrites }
      });
      setAllowWrites(false);
    }
  };

  const handleBranch = async (index: number) => {
    if (!api || !api.branchSession) return;
    try {
      const newId = await api.branchSession(activeSessionId, index);
      if (newId) {
        const msgs = await api.loadSession(newId);
        setActiveSessionId(newId);
        setMessages(msgs.map((m: any) => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
          images: m.images,
          metadata: m.metadata,
          tool_calls: m.tool_calls
        })));
        addToast({ type: 'success', message: 'Branched conversation' });
        // Force refresh sessions view if it's open
        if (activeView === 'sessions') setActiveView('sessions');
      }
    } catch (e) {
      console.error('[App] Branching failed:', e);
      addToast({ type: 'error', message: 'Failed to branch conversation' });
    }
  };

  const handleRewind = async (index: number) => {
    if (!api || !api.rewindChat) return;
    if (!confirm("Are you sure you want to truncate the conversation at this point? This action is permanent for the current session.")) return;

    try {
      await api.rewindChat(index);
      setMessages(prev => prev.slice(0, index + 1));
      addToast({ type: 'info', message: 'Conversation rewound' });
    } catch (e) {
      console.error('[App] Rewind failed:', e);
      addToast({ type: 'error', message: 'Failed to rewind history' });
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.indexOf("image") !== -1) {
        e.preventDefault();
        const blob = item.getAsFile();
        const reader = new FileReader();
        reader.onload = (event) => {
          if (event.target?.result) {
            setPendingImages(prev => [...prev, event.target!.result as string]);
          }
        };
        if (blob) reader.readAsDataURL(blob);
      }
    }
  };

  const handleSelectImage = async () => {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.onchange = (e: any) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          if (ev.target?.result) setPendingImages(prev => [...prev, ev.target!.result as string]);
        };
        reader.readAsDataURL(file);
      }
    };
    fileInput.click();
  };

  const handleIgniteEngine = async () => {
    if (!api) return;
    if (localEngineRunning) {
      if (confirm("Stop local inference engine?")) {
        await api.stopLocalEngine();
        setLocalEngineRunning(false);
        addToast({ type: 'info', message: 'Inference Engine Offline' });
      }
      return;
    }

    const { global } = await api.getSettings();
    const { localEngine } = global?.inference || {};
    if (!localEngine || !localEngine.modelPath) {
      addToast({ type: 'error', message: 'No local model configured. Go to Settings.' });
      return;
    }

    setIsStartingEngine(true);
    addToast({ type: 'info', message: 'Igniting Local Engine...' });
    try {
      await api.startLocalEngine({
        modelPath: localEngine.modelPath,
        options: localEngine.options
      });
      setLocalEngineRunning(true);
      addToast({ type: 'success', message: 'Local Engine Ignite Sequence Complete' });
    } catch (e: any) {
      addToast({ type: 'error', message: `Ignition Failed: ${e.message}` });
    } finally {
      setIsStartingEngine(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSaveFile();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
      e.preventDefault();
      setMessages([]);
      chatInputRef.current?.focus();
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
      e.preventDefault();
      (window as any).tala?.exportSessionFile?.('markdown')
        .then((result: any) => {
          if (result?.success) {
            setMessages(prev => [...prev, {
              role: 'assistant' as const,
              content: `📄 Conversation exported to: ${result.path}`
            }]);
          }
        })
        .catch(() => { });
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = e.currentTarget.selectionStart;
      const end = e.currentTarget.selectionEnd;
      const value = e.currentTarget.value;
      const newValue = value.substring(0, start) + "    " + value.substring(end);
      if (activeTab && activeTab.type === 'file') {
        updateActiveTabContent(newValue);
        setTimeout(() => {
          if (e.currentTarget) {
            e.currentTarget.selectionStart = e.currentTarget.selectionEnd = start + 4;
          }
        }, 0);
      }
    }
  };

  const buildWorkspaceDocumentForTab = (tab: Tab): WorkspaceDocument | null => {
    if (tab.document) {
      if (tab.type === 'artifact' && !tab.document.payload) {
        return { ...tab.document, payload: typeof tab.data === 'string' ? tab.data : tab.document.payload };
      }
      return tab.document;
    }

    if (tab.type === 'file' && tab.data?.path) {
      return createWorkspaceDocumentFromFile({
        id: tab.id,
        title: tab.title,
        path: tab.data.path,
        payload: tab.data.content
      });
    }

    if (tab.type === 'artifact' && tab.artifact) {
      return createWorkspaceDocumentFromArtifact(tab.artifact);
    }

    return null;
  };

  return (
    <div className="ide-shell">
      <StartupSplash />

      <div className="left-panel-container">
        <div className="activity-bar">
          <div
            className={`activity-item ${activeView === 'explorer' && isLeftPanelOpen ? 'active' : ''}`}
            onClick={() => toggleSidebar('explorer')}
          >
            <IconMenu />
          </div>

          <div
            className={`activity-item ${activeView === 'browser' && isLeftPanelOpen ? 'active' : ''}`}
            onClick={() => toggleSidebar('browser')}
            title="Browser"
          >
            <IconBrowser />
          </div>

          <div
            className={`activity-item ${activeView === 'notebooks' && isLeftPanelOpen ? 'active' : ''}`}
            onClick={() => toggleSidebar('notebooks')}
            title="Notebooks & Search"
          >
            <IconNotebook />
          </div>

          <div
            className={`activity-item ${activeView === 'core' && isLeftPanelOpen ? 'active' : ''}`}
            onClick={() => toggleSidebar('core')}
            title="Core Systems (Memory & Reflection)"
          >
            <IconBrain />
          </div>

          <div
            className={`activity-item ${activeView === 'source_control' && isLeftPanelOpen ? 'active' : ''}`}
            onClick={() => toggleSidebar('source_control')}
            title="Source Control"
          >
            <IconSourceControl />
          </div>

          <div
            className={`activity-item ${activeView === 'sessions' && isLeftPanelOpen ? 'active' : ''}`}
            onClick={() => toggleSidebar('sessions')}
            title="Chat History"
          >
            <IconHistory />
          </div>

          <div
            className={`activity-item ${activeView === 'profile' && isLeftPanelOpen ? 'active' : ''}`}
            onClick={() => toggleSidebar('profile')}
            title="User Profile"
          >
            <IconProfile />
          </div>

          <div className="spacer" />

          <div
            className={`activity-item`}
            onClick={() => {
              if (confirm("Are you sure you want to shut down TALA? All background processes and local engines will be cleanly terminated.")) {
                api?.shutdown?.();
              }
            }}
            title="Shut Down TALA"
            style={{ color: '#ff4444' }}
          >
            <IconPower />
          </div>

          <div
            className={`activity-item ${activeView === 'settings' && isLeftPanelOpen ? 'active' : ''}`}
            onClick={() => toggleSidebar('settings')}
            title="Settings"
            style={{ marginTop: '0' }}
          >
            <IconSettings />
          </div>
        </div>

        <div className={`side-bar ${!isLeftPanelOpen ? 'hidden' : ''}`} style={{ width: isLeftPanelOpen ? sidebarWidth : 0, overflow: 'hidden', padding: isLeftPanelOpen ? undefined : 0, borderRight: isLeftPanelOpen ? undefined : 'none' }}>
          <div style={{ minWidth: isLeftPanelOpen ? sidebarWidth : 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div className="sidebar-header">
              {activeView === 'explorer' && 'EXPLORER'}
              {activeView === 'notebooks' && 'RESEARCH'}
              {activeView === 'source_control' && 'SOURCE CONTROL'}
              {activeView === 'profile' && 'PROFILE'}
              {activeView === 'settings' && 'SETTINGS'}
              {activeView === 'browser' && 'BROWSER'}
              {activeView === 'sessions' && 'CHAT HISTORY'}
              {activeView === 'core' && 'CORE SYSTEMS'}
            </div>
            <div className="sidebar-content">
              {activeView === 'explorer' && (
                <FileExplorer onOpenFile={openFileTab} />
              )}
              {activeView === 'source_control' && (
                <SourceControl onOpenConflict={openConflictTab} />
              )}
              {activeView === 'browser' && (
                <div style={{ padding: 10, color: '#ccc' }}>Internal Browser Active</div>
              )}
              {activeView === 'sessions' && (
                <ChatSessions
                  activeId={activeSessionId}
                  onSessionSelect={async (id, msgs) => {
                    const messages = msgs || await api.loadSession(id);
                    setActiveSessionId(id);
                    setMessages(messages.map((m: any) => ({
                      role: m.role as 'user' | 'assistant',
                      content: m.content,
                      images: m.images,
                      metadata: m.metadata,
                      tool_calls: m.tool_calls
                    })));
                  }}
                  onLoadSession={(msgs) => setMessages(msgs.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })))}
                />
              )}
              {activeView === 'core' && (
                <CoreWorkspace />
              )}
              {activeView === 'notebooks' && (
                <Notebooks
                  onOpenFile={(path) => openFileTab(path)}
                  onOpenBrowser={(url) => openBrowserTab(url)}
                />
              )}
            </div>
          </div>
        </div>
      </div >

      {/* RESIZER */}
      {
        isLeftPanelOpen && (
          <div
            className="resizer"
            onMouseDown={() => setResizingPanel('left')}
            style={{
              width: 4,
              cursor: 'col-resize',
              background: resizingPanel === 'left' ? '#007acc' : 'transparent',
              zIndex: 100,
              height: '100%',
              position: 'absolute',
              left: 50 + sidebarWidth, // Activity bar + sidebar
            }}
            title="Drag to resize"
          />
        )
      }

      {/* 2. CENTER PANEL (Main Canvas) */}
      <div className="center-panel">
        <div className="editor-tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab ${activeTabId === tab.id ? 'active' : ''}`}
              onClick={() => activateTab(tab.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              title={tab.type === 'file' ? (tab.document?.path || tab.data?.path || tab.title) : tab.title}
            >
              {tab.type === 'browser' ? '🌐 ' : ''}
              {tab.title}
              <span
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                style={{ opacity: 0.5, fontSize: 14, padding: '2px 4px' }}
                className="close-tab"
              >
                ×
              </span>
            </div>
          ))}
          {/* Add New Browser Tab Button */}
          <div
            className="tab new-tab"
            onClick={() => openBrowserTab()}
            title="New Browser Tab"
            style={{ width: 30, display: 'flex', justifyContent: 'center', padding: 0 }}
          >
            +
          </div>
          <div
            className={`tab ${activeView === 'profile' ? 'active' : ''}`}
            onClick={() => setActiveView('profile')}
            style={{ marginLeft: 'auto' }}
          >
            User Profile.json
          </div>
        </div>

        <div className="editor-content">
          <div className={`view-container ${activeView !== 'profile' ? 'hidden' : ''}`}><UserProfile /></div>
          <div className={`view-container ${activeView !== 'settings' ? 'hidden' : ''}`}><Settings /></div>

          {/* SEARCH VIEW (Results) */}
          <div className={`view-container ${activeView !== 'search' ? 'hidden' : ''}`}>
            <div>
              <h3>No Search Results</h3>
              <p>Ask Tala to "Search for..."</p>
            </div>
          </div>

          {/* TAB CONTENT */}
          {tabs.map(tab => (
            <div key={tab.id} className={`view-container ${activeTabId === tab.id && activeView !== 'profile' && activeView !== 'settings' && activeView !== 'search' ? '' : 'hidden'}`}>
              {tab.type === 'browser' && (
                <Browser key={tab.id} initialUrl={tab.data.url} isActive={activeTabId === tab.id} />
              )}
              {(tab.type === 'file' || tab.type === 'artifact') && (
                <WorkspaceSurfaceHost
                  document={buildWorkspaceDocumentForTab(tab)}
                  onContentChange={updateActiveTabContent}
                  onSave={tab.type === 'file' ? handleSaveFile : undefined}
                  onEditorKeyDown={handleEditorKeyDown}
                  onDocumentMetadataChange={updateActiveTabDocumentMetadata}
                />
              )}
              {tab.type === 'conflict' && (
                <ConflictEditor
                  path={tab.data.path}
                  content={tab.data.content}
                  onResolve={handleResolveConflict}
                  onCancel={() => closeTab(tab.id)}
                />
              )}
              {/* A2UI WORKSPACE SURFACE (Phase 4C) — renders in document/editor pane only */}
              {tab.type === 'a2ui' && tab.data && (
                <A2UIWorkspaceSurface
                  surfaceId={(tab.data as A2UISurfacePayload).surfaceId}
                  components={(tab.data as A2UISurfacePayload).components}
                  title={(tab.data as A2UISurfacePayload).title}
                  onAction={(action: A2UIActionDispatch) => {
                    const talaApi = (window as any).tala;
                    if (talaApi?.a2ui?.dispatchAction) {
                      talaApi.a2ui.dispatchAction(action).catch((err: Error) => {
                        console.error('[A2UIAction] Dispatch failed:', err);
                      });
                    }
                  }}
                />
              )}
            </div>
          ))}

          <div className={`view-container ${tabs.length === 0 && activeView !== 'profile' && activeView !== 'settings' && activeView !== 'search' ? '' : 'hidden'}`}>
            <div style={{ textAlign: 'center', marginTop: 100, opacity: 0.5 }}>
              <h2 style={{ color: '#444' }}>TALA IDE</h2>
              <p>Select a file or open a browser tab</p>
            </div>
          </div>
        </div>

        {/* Bottom Panel Overlay */}
        <div className={`bottom-panel ${!isBottomPanelOpen ? 'hidden' : ''}`} style={{ height: isBottomPanelOpen ? terminalHeight : 0 }}>
          {/* Bottom Resizer (Top Edge) */}
          <div
            className="resizer-h"
            onMouseDown={() => setResizingPanel('bottom')}
            style={{
              height: 4,
              cursor: 'row-resize',
              background: resizingPanel === 'bottom' ? '#007acc' : 'transparent',
              width: '100%',
              position: 'absolute',
              top: 0,
              left: 0,
              zIndex: 10
            }}
          />
          <div className="panel-header" style={{ display: 'flex', gap: 0, padding: 0 }}>
            {terminals.map((term: any) => (
              <div
                key={term.id}
                onClick={() => setActiveTerminalId(term.id)}
                style={{
                  padding: '5px 15px',
                  cursor: 'pointer',
                  background: activeTerminalId === term.id ? '#1e1e1e' : 'transparent',
                  borderRight: '1px solid #333',
                  opacity: activeTerminalId === term.id ? 1 : 0.6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8
                }}
              >
                <span>{term.title}</span>
                {terminals.length > 1 && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      if (api && api.killTerminal) api.killTerminal(term.id);
                      setTerminals(prev => prev.filter(t => t.id !== term.id));
                      if (activeTerminalId === term.id) {
                        const remain = terminals.filter(t => t.id !== term.id);
                        setActiveTerminalId(remain.length > 0 ? remain[remain.length - 1].id : null);
                      }
                    }}
                    style={{ fontSize: 12, opacity: 0.5 }}
                  >×</span>
                )}
              </div>
            ))}
            <div
              onClick={() => {
                const newId = Math.random().toString(36).substr(2, 9);
                setTerminals(prev => [...prev, { id: newId, title: `Terminal ${prev.length + 1}` }]);
                setActiveTerminalId(newId);
              }}
              style={{ padding: '5px 10px', cursor: 'pointer', opacity: 0.6, fontSize: 16 }}
              title="New Terminal"
            >+</div>
          </div>
          <div style={{ flex: 1, overflow: 'hidden', background: '#1e1e1e', position: 'relative' }}>
            {isBottomPanelOpen && terminals.map((term: any) => (
              <div key={term.id} style={{ display: activeTerminalId === term.id ? 'block' : 'none', height: '100%' }}>
                <Terminal id={term.id} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 3. RIGHT PANEL (Chat Interface) */}
      <div className={`right-panel ${!isRightPanelOpen ? 'hidden' : ''}`} style={{ width: isRightPanelOpen ? chatWidth : 0 }}>
        {/* Right Resizer (Left Edge) */}
        <div
          className="resizer"
          onMouseDown={() => setResizingPanel('right')}
          style={{
            width: 4,
            cursor: 'col-resize',
            background: resizingPanel === 'right' ? '#007acc' : 'transparent',
            height: '100%',
            position: 'absolute',
            left: 0,
            top: 0,
            zIndex: 10
          }}
        />
        <div className="sidebar-header" style={{ justifyContent: 'space-between', gap: 10, borderBottom: '1px solid #333' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>AGENT CHAT</span>
            <EmotionDisplay isStreaming={isStreaming} />
            <div style={{ display: 'flex', gap: 5, marginLeft: 10 }}>
              <button onClick={() => api.exportChat && api.exportChat('md')} title="Export Markdown" style={{ background: 'transparent', border: '1px solid #444', color: '#888', borderRadius: 3, cursor: 'pointer', fontSize: 10, padding: '2px 5px' }}>MD</button>
              <button onClick={() => api.exportChat && api.exportChat('json')} title="Export JSON" style={{ background: 'transparent', border: '1px solid #444', color: '#888', borderRadius: 3, cursor: 'pointer', fontSize: 10, padding: '2px 5px' }}>JSON</button>
              <div className="mode-toggle" style={{ display: 'flex', background: '#252526', borderRadius: 4, padding: 2, border: '1px solid #444', marginLeft: 5 }}>
                <button
                  onClick={async () => {
                    const newMode = 'rp';
                    console.log(`[UI] Mode button clicked: ${newMode}`);
                    if (api?.settings?.setActiveMode) {
                      await api.settings.setActiveMode(newMode);
                      const confirmed = await api.settings.getActiveMode?.();
                      if (confirmed) setActiveMode(confirmed);
                    } else if (api?.setMode) {
                      await api.setMode(newMode);
                      const confirmed = await api.getActiveMode?.();
                      if (confirmed) setActiveMode(confirmed);
                    } else {
                      setActiveMode(newMode);
                    }
                  }}
                  style={{
                    background: activeMode === 'rp' ? '#0e639c' : 'transparent',
                    color: activeMode === 'rp' ? 'white' : '#888',
                    border: 'none', padding: '2px 8px', fontSize: 10, cursor: 'pointer', borderRadius: 2
                  }}
                  title="Roleplay Mode"
                >RP</button>
                <button
                  onClick={async () => {
                    const newMode = 'hybrid';
                    console.log(`[UI] Mode button clicked: ${newMode}`);
                    if (api?.settings?.setActiveMode) {
                      await api.settings.setActiveMode(newMode);
                      const confirmed = await api.settings.getActiveMode?.();
                      if (confirmed) setActiveMode(confirmed);
                    } else if (api?.setMode) {
                      await api.setMode(newMode);
                      const confirmed = await api.getActiveMode?.();
                      if (confirmed) setActiveMode(confirmed);
                    } else {
                      setActiveMode(newMode);
                    }
                  }}
                  style={{
                    background: activeMode === 'hybrid' ? '#0e639c' : 'transparent',
                    color: activeMode === 'hybrid' ? 'white' : '#888',
                    border: 'none', padding: '2px 8px', fontSize: 10, cursor: 'pointer', borderRadius: 2
                  }}
                  title="Hybrid Mode"
                >Hyb</button>
                <button
                  onClick={async () => {
                    const newMode = 'assistant';
                    console.log(`[UI] Mode button clicked: ${newMode}`);
                    if (api?.settings?.setActiveMode) {
                      await api.settings.setActiveMode(newMode);
                      const confirmed = await api.settings.getActiveMode?.();
                      if (confirmed) setActiveMode(confirmed);
                    } else if (api?.setMode) {
                      await api.setMode(newMode);
                      const confirmed = await api.getActiveMode?.();
                      if (confirmed) setActiveMode(confirmed);
                    } else {
                      setActiveMode(newMode);
                    }
                  }}
                  style={{
                    background: activeMode === 'assistant' ? '#0e639c' : 'transparent',
                    color: activeMode === 'assistant' ? 'white' : '#888',
                    border: 'none', padding: '2px 8px', fontSize: 10, cursor: 'pointer', borderRadius: 2
                  }}
                  title="Assistant Mode"
                >Ast</button>
              </div>
              <button
                onClick={() => setShowModeSettings(!showModeSettings)}
                style={{
                  background: showModeSettings ? '#333' : 'transparent',
                  border: '1px solid #444',
                  color: '#888',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontSize: 10,
                  padding: '2px 5px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
                title="Mode Settings"
              >
                <IconSettings />
              </button>
            </div>
          </div>
          <div style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={() => setIsRightPanelOpen(false)}>×</div>
        </div>

        {showModeSettings && (
          <AgentModeConfigPanel
            activeMode={activeMode}
            onClose={() => setShowModeSettings(false)}
          />
        )}

        <div className="chat-container" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div className="chat-messages">
            {messages.map((m, i) => (
              <div key={i} className={`message-row ${m.role}`} style={{ display: 'flex', gap: 10 }}>
                <div className="avatar" style={{ flexShrink: 0 }}>
                  {m.role === 'assistant' ? (
                    <img src="./assets/tala_identity.jpg" style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }} />
                  ) : (
                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#007acc', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: 'white' }}>{userName[0]}</div>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span className="message-author">{m.role === 'user' ? userName : 'TALA'}</span>
                    <div className="message-controls" style={{ marginLeft: 'auto', display: 'flex', gap: 8, opacity: 0, transition: 'opacity 0.2s' }}>
                      {m.role === 'user' && editingIndex !== i && (
                        <span
                          onClick={() => handleEdit(i)}
                          style={{ cursor: 'pointer', opacity: 0.5, fontSize: '0.9em' }}
                          title="Edit & Regenerate"
                        >✎</span>
                      )}
                      <span
                        onClick={() => handleBranch(i)}
                        style={{ cursor: 'pointer', opacity: 0.5, fontSize: '0.9em' }}
                        title="Fork (Branch) from here"
                      >⑂</span>
                      <span
                        onClick={() => handleRewind(i)}
                        style={{ cursor: 'pointer', opacity: 0.5, fontSize: '0.9em' }}
                        title="Rewind (Truncate) here"
                      >↺</span>
                    </div>
                  </div>
                  {m.images && m.images.length > 0 && (
                    <div style={{ display: 'flex', gap: 5, marginBottom: 5, flexWrap: 'wrap' }}>
                      {m.images.map((img, idx) => (
                        <img key={idx} src={img} alt="attachment" style={{ maxHeight: 150, maxWidth: '100%', borderRadius: 4, border: '1px solid #444' }} />
                      ))}
                    </div>
                  )}
                  {editingIndex === i ? (
                    <div style={{ marginTop: 5 }}>
                      <textarea
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        style={{ width: '100%', background: '#333', color: '#fff', border: '1px solid #555', padding: 5, minHeight: 60 }}
                      />
                      <div style={{ marginTop: 5, display: 'flex', gap: 5 }}>
                        <button onClick={handleSaveEdit} style={{ cursor: 'pointer', padding: '2px 8px' }}>Save & Restart</button>
                        <button onClick={() => setEditingIndex(null)} style={{ cursor: 'pointer', padding: '2px 8px' }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                  )}
                  {m.metadata?.usage && (
                    <div style={{ fontSize: '0.75em', opacity: 0.5, marginTop: 4 }}>
                      {m.metadata.usage.total_tokens} tokens ({m.metadata.usage.prompt_tokens} in / {m.metadata.usage.completion_tokens} out)
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <div className="chat-input-area">
            {pendingImages.length > 0 && (
              <div style={{ display: 'flex', gap: 5, padding: '5px 10px', background: '#252526' }}>
                {pendingImages.map((img, idx) => (
                  <div key={idx} style={{ position: 'relative' }}>
                    <img src={img} style={{ height: 40, borderRadius: 4 }} />
                    <div
                      onClick={() => setPendingImages(prev => prev.filter((_, i) => i !== idx))}
                      style={{ position: 'absolute', top: -5, right: -5, background: 'red', color: 'white', borderRadius: '50%', width: 14, height: 14, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                    >×</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5 }}>
              <button title="Attach Image" onClick={handleSelectImage} style={{ background: 'transparent', border: 'none', color: '#ccc', cursor: 'pointer', padding: '10px 5px' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
              </button>
              <textarea
                style={{ flex: 1 }}
                ref={chatInputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="Ask Tala... (Paste images supported)"
              />
              {activeMode === 'hybrid' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 5px', fontSize: 10, color: '#aaa', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    id="allow-writes-check"
                    checked={allowWrites}
                    onChange={e => setAllowWrites(e.target.checked)}
                    style={{ cursor: 'pointer' }}
                  />
                  <label htmlFor="allow-writes-check" style={{ cursor: 'pointer' }}>Allow writes</label>
                </div>
              )}
              {isStreaming && (
                <button
                  title="Force Stop"
                  onClick={() => api?.cancelChat && api.cancelChat()}
                  style={{
                    background: '#a12323',
                    border: 'none',
                    color: 'white',
                    cursor: 'pointer',
                    padding: '8px',
                    borderRadius: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: '4px'
                  }}
                >
                  <IconStop />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* STATUS BAR */}
      <div className="app-status-bar">
        <div className="status-item" onClick={() => setIsBottomPanelOpen(!isBottomPanelOpen)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <IconPanel /> <span>Toggle Terminal</span>
        </div>
        <div className="status-item" onClick={() => setIsRightPanelOpen(!isRightPanelOpen)}>Toggle Chat</div>

        <div
          className="status-item"
          onClick={handleIgniteEngine}
          style={{
            background: localEngineRunning ? '#1e3a1e' : (isStartingEngine ? '#333' : '#3a1e1e'),
            color: '#fff',
            fontWeight: 'bold',
            cursor: isStartingEngine ? 'wait' : 'pointer',
            padding: '0 12px',
            borderRadius: '2px',
            transition: 'all 0.3s ease',
            marginLeft: 5,
            display: 'flex',
            alignItems: 'center',
            gap: 6
          }}
        >
          {isStartingEngine ? (
            <>⏳ Starting...</>
          ) : (
            localEngineRunning ? (
              <>🔥 ENGINE ACTIVE</>
            ) : (
              <>❄️ IGNITE ENGINE</>
            )
          )}
        </div>

        {modelStatus?.isLowFidelity && (
          <div className="status-item" style={{ color: '#ffaa00', display: 'flex', alignItems: 'center', gap: 6, cursor: 'help' }} title={modelStatus.warning || "Performance may be degraded"}>
            <span>⚠️</span> <span>Low Fidelity</span>
          </div>
        )}

        <div className="spacer" />
        <div className="status-item">{statusText}</div>
        <div className="status-item" onClick={toggleTheme} title="Toggle Theme" style={{ cursor: 'pointer', padding: '0 8px' }}>
          {theme === 'dark' ? <IconMoon /> : <IconSun />}
        </div>
      </div>
      {/* First Run Wizard */}
      {showWizard && <FirstRunWizard onComplete={handleWizardComplete} />}
    </div >
  );
}

function AppWithProviders() {
  return (
    <ToastProvider>
      <App />
    </ToastProvider>
  );
}

export default AppWithProviders;
