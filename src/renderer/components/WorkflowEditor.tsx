/**
 * Workflow Editor (Visual Node Graph)
 *
 * A drag-and-drop visual workflow editor built on React Flow. Users can
 * design automation workflows by dragging node types from a palette,
 * connecting them with edges, and configuring each node's properties.
 *
 * **Supported node types** (from PALETTE_ITEMS):
 * - `manual` — Manual trigger (entry point).
 * - `scheduled` — Cron/time-based trigger.
 * - `webhook` — HTTP trigger from external service.
 * - `llm` — AI inference step (model, prompt, temperature).
 * - `code` — Custom JavaScript/Python code block.
 * - `http` — HTTP request to an external API.
 * - `if` — Conditional branch (true/false paths).
 * - `loop` — Iterative loop.
 * - `delay` — Timed pause between steps.
 * - `tool_call` — Invoke a registered tool/function.
 * - `memory_read` / `memory_write` — RAG memory operations.
 * - `guardrail` — Safety check with pass/fail outputs.
 * - `subworkflow` — Embed another workflow.
 *
 * **Saving:** Serializes nodes + edges + metadata and calls
 * `tala.saveWorkflow(workflow)` via IPC.
 *
 * **Execution:** Calls `tala.runWorkflow(id)` which delegates to
 * `WorkflowEngine` in the main process.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactFlow, {
    Handle,
    Position,
    addEdge,
    MiniMap,
    Controls,
    Background,
    useNodesState,
    useEdgesState,
    BackgroundVariant,
    ReactFlowProvider,
    useReactFlow
} from 'reactflow';
import 'reactflow/dist/style.css';

// Custom Node Components
const IfNode = ({ data }: any) => {
    return (
        <div style={{ background: '#d65d0e', padding: '10px', borderRadius: '5px', color: '#fff', border: '1px solid #fabd2f', minWidth: '150px' }}>
            <Handle type="target" position={Position.Top} style={{ background: '#fff' }} />
            <div style={{ fontWeight: 'bold', fontSize: '12px', marginBottom: '5px' }}>IF CONDITION</div>
            <div style={{ fontSize: '11px', fontFamily: 'monospace' }}>{data.expression || 'Condition'}</div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '10px' }}>
                <div style={{ position: 'relative' }}>
                    <span style={{ fontSize: '10px' }}>True</span>
                    <Handle type="source" position={Position.Bottom} id="true" style={{ left: '10px', background: '#b8bb26' }} />
                </div>
                <div style={{ position: 'relative' }}>
                    <span style={{ fontSize: '10px' }}>False</span>
                    <Handle type="source" position={Position.Bottom} id="false" style={{ left: 'auto', right: '10px', background: '#cc241d' }} />
                </div>
            </div>
        </div>
    );
};

const nodeTypes = {
    if: IfNode,
    guardrail: IfNode, // Reuse IfNode logic (Handles: True/False -> Pass/Fail)
};

const PALETTE_ITEMS = [
    { type: 'manual', label: 'Trigger', color: '#d3869b' },
    { type: 'agent', label: 'Agent Inference', color: '#83a598' },
    { type: 'tool', label: 'Execute Tool', color: '#fabd2f' },
    { type: 'function', label: 'Function Script', color: '#b8bb26' },
    { type: 'credential', label: 'Credential Source', color: '#cc241d' },
    { type: 'http', label: 'HTTP Request', color: '#458588' },
    { type: 'if', label: 'Logic: If', color: '#d65d0e' },
    { type: 'wait', label: 'Logic: Wait', color: '#689d6a' },
    { type: 'edit_fields', label: 'Edit Fields (Set)', color: '#83a598' },
    { type: 'merge', label: 'Merge', color: '#b16286' },
    { type: 'email_read', label: 'Email Read (IMAP)', color: '#b8bb26' },
    { type: 'ai_model', label: 'AI Model Config', color: '#458588' },
    { type: 'split', label: 'Loop / Split', color: '#b16286' },
    { type: 'memory_read', label: 'Read Memories', color: '#458588' },
    { type: 'memory_write', label: 'Write Memory', color: '#98971a' },
    { type: 'guardrail', label: 'Safety Guardrail', color: '#cc241d' },
    { type: 'subworkflow', label: 'Sub-workflow', color: '#d79921' },
];
const SidebarItem = ({ type, label, color }: { type: string, label: string, color: string }) => {
    const onDragStart = (event: React.DragEvent, nodeType: string) => {
        event.dataTransfer.setData('application/reactflow', nodeType);
        event.dataTransfer.effectAllowed = 'move';
    };

    return (
        <div
            onDragStart={(event) => onDragStart(event, type)}
            draggable
            style={{
                padding: '8px',
                marginBottom: '8px',
                background: color,
                color: '#fff',
                borderRadius: '4px',
                cursor: 'grab',
                fontSize: '12px',
                fontWeight: 'bold',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
            }}
        >
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgba(255,255,255,0.5)' }} />
            {label}
        </div>
    );
};

const EditorContent = ({ workflow, onSave }: { workflow: any, onSave: (wf: any) => void }) => {
    const reactFlowWrapper = useRef<HTMLDivElement>(null);
    const [nodes, setNodes, onNodesChange] = useNodesState(workflow.nodes || []);
    const [edges, setEdges, onEdgesChange] = useEdgesState(workflow.edges || []);
    const [name, setName] = useState(workflow.name);
    const { project } = useReactFlow();
    const [logs, setLogs] = useState<string[]>([]);
    const [availableTools, setAvailableTools] = useState<any[]>([]);
    const [historyRuns, setHistoryRuns] = useState<any[]>([]);
    const [activeTab, setActiveTab] = useState<'logs' | 'history'>('logs');
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);

    // SELECTION & PROPERTY EDITING
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [isFullScreen, setIsFullScreen] = useState(false);
    const [availableKeys, setAvailableKeys] = useState<string[]>([]);
    const [paletteSearch, setPaletteSearch] = useState('');

    // Fetch settings to get available keys & tools
    useEffect(() => {
        // @ts-ignore
        if (window.tala && window.tala.getSettings) {
            // @ts-ignore
            window.tala.getSettings().then((s: any) => {
                const keys: string[] = [];
                if (s.auth && s.auth.keys) {
                    Object.keys(s.auth.keys).forEach(k => {
                        if (s.auth.keys[k]) keys.push(k);
                    });
                }
                if (s.auth?.cloudToken) keys.push('cloudToken');
                setAvailableKeys(keys);
            });
        }
        // @ts-ignore
        if (window.tala && window.tala.getAllTools) {
            // @ts-ignore
            window.tala.getAllTools().then((tools: any[]) => {
                setAvailableTools(tools);
            });
        }
    }, []);

    // Fetch history when workflow changes or tab switches
    useEffect(() => {
        if (activeTab === 'history' && workflow?.id) {
            refreshHistory();
        }
    }, [activeTab, workflow?.id]);

    const refreshHistory = async () => {
        if (!workflow?.id) return;
        setIsLoadingHistory(true);
        try {
            // @ts-ignore
            const runs = await window.tala.getWorkflowRuns(workflow.id);
            setHistoryRuns(runs);
        } catch (e) {
            console.error('Failed to fetch runs:', e);
        } finally {
            setIsLoadingHistory(false);
        }
    };

    // Sync when workflow prop changes
    useEffect(() => {
        setNodes(workflow.nodes || []);
        setEdges(workflow.edges || []);
        setName(workflow.name);
    }, [workflow]);

    const [isDebug, setIsDebug] = useState(false);
    const [debugState, setDebugState] = useState<{ activeNodeId: string | null, logs: string[], context: any }>({ activeNodeId: null, logs: [], context: {} });

    // Listen for debug updates
    useEffect(() => {
        const handleDebugUpdate = (_event: any, { workflowId, type, data }: any) => {
            if (workflowId !== workflow.id) return;

            if (type === 'started') {
                setDebugState(prev => ({ ...prev, logs: [...prev.logs, `Debug Session Started. Queue: ${data.queueLength}`] }));
            } else if (type === 'next-node') {
                setDebugState(prev => ({ ...prev, activeNodeId: data.nodeId }));
                // Determine which node needs styling
                setNodes(nds => nds.map(n => ({
                    ...n,
                    style: { ...n.style, border: n.id === data.nodeId ? '2px solid #fabd2f' : '1px solid #777' }
                })));
            } else if (type === 'step-completed') {
                setDebugState(prev => ({ ...prev, logs: [...prev.logs, ...data.logs] }));
            } else if (type === 'completed') {
                setDebugState(prev => ({ ...prev, activeNodeId: null, context: data.context, logs: [...prev.logs, 'Debug Session Completed.'] }));
                setNodes(nds => nds.map(n => ({ ...n, style: { ...n.style, border: '1px solid #777' } })));
            } else if (type === 'error') {
                setDebugState(prev => ({ ...prev, logs: [...prev.logs, `Error: ${data.error}`] }));
            }
        };

        // @ts-ignore
        if (window.tala && window.tala.on) {
            // @ts-ignore
            window.tala.on('debug-update', handleDebugUpdate);
        }

        return () => {
            // cleanup if we had an 'off' method, but we rely on brute force
        };
    }, [workflow.id]);

    const handleDebugStart = async () => {
        setIsDebug(true);
        setDebugState({ activeNodeId: null, logs: ['Starting Debug...'], context: {} });
        // @ts-ignore
        await window.tala.debugWorkflowStart(workflow, { manualTrigger: true });
    };

    const handleDebugStep = async () => {
        // @ts-ignore
        await window.tala.debugWorkflowStep(workflow.id);
    };

    const handleDebugStop = async () => {
        // @ts-ignore
        await window.tala.debugWorkflowStop(workflow.id);
        setIsDebug(false);
        setNodes(nds => nds.map(n => ({ ...n, style: { ...n.style, border: '1px solid #777' } })));
    };

    const onNodeClick = useCallback((_event: React.MouseEvent, node: any) => {
        setSelectedNodeId(node.id);
    }, []);

    const onPaneClick = useCallback(() => {
        setSelectedNodeId(null);
    }, []);

    const updateNodeData = (key: string, value: any) => {
        setNodes((nds) =>
            nds.map((node) => {
                if (node.id === selectedNodeId) {
                    node.data = { ...node.data, [key]: value };
                }
                return node;
            })
        );
    };

    const selectedNode = nodes.find(n => n.id === selectedNodeId);

    const onConnect = useCallback((params: any) => setEdges((eds) => addEdge(params, eds)), [setEdges]);

    const onDragOver = useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }, []);

    const onDrop = useCallback(
        (event: React.DragEvent) => {
            event.preventDefault();

            const type = event.dataTransfer.getData('application/reactflow');
            if (typeof type === 'undefined' || !type) return;

            const position = reactFlowWrapper.current?.getBoundingClientRect();
            if (!position) return;

            const p = project({
                x: event.clientX - position.left,
                y: event.clientY - position.top,
            });

            const newNode: any = {
                id: `${type}-${Date.now()}`,
                type: 'default', // Using default for now, can perform custom rendering later
                position: p,
                data: { label: `${type.toUpperCase()} Node` },
                style: {
                    border: '1px solid #777',
                    padding: 10,
                    borderRadius: 5,
                    background: type === 'agent' ? '#252526' : '#1e1e1e',
                    color: '#fff',
                    minWidth: 150
                }
            };

            // Custom Node Data
            if (type === 'agent') {
                // @ts-ignore
                newNode.data = { label: 'AGENT: Ask Question', prompt: 'What is the capital of France?' };
            } else if (type === 'function') {
                // @ts-ignore
                newNode.data = { label: 'FUNCTION: Run Script', functionName: '' };
            } else if (type === 'tool') {
                // @ts-ignore
                newNode.data = { label: 'TOOL: Execute MCP', toolName: '', args: '{}' };
            } else if (type === 'credential') {
                // @ts-ignore
                newNode.data = { label: 'AUTH: Get Key', credentialKey: '' };
            } else if (type === 'manual') {
                // @ts-ignore
                newNode.data = { label: 'TRIGGER: Manual', triggerType: 'manual', webhookPath: '/webhook', cron: '0 0 * * *' };
                newNode.type = 'input'; // Special input node
            } else if (type === 'http') {
                // @ts-ignore
                newNode.data = { label: 'HTTP Request', method: 'GET', url: 'https://api.example.com', headers: '{}', body: '{}' };
            } else if (type === 'if') {
                // @ts-ignore
                newNode.data = { label: 'IF Condition', expression: 'input.value > 10' };
            } else if (type === 'wait') {
                // @ts-ignore
                newNode.data = { label: 'Wait', duration: 1000 };
            } else if (type === 'edit_fields') {
                // @ts-ignore
                newNode.data = { label: 'Edit Fields', fields: '{\n  "myVar": "value"\n}' };
            } else if (type === 'merge') {
                // @ts-ignore
                newNode.data = { label: 'Merge', mode: 'pass-through' };
            } else if (type === 'email_read') {
                // @ts-ignore
                newNode.data = {
                    label: 'Read Email',
                    host: 'imap.gmail.com',
                    port: 993,
                    secure: true,
                    mailbox: 'INBOX',
                    limit: 5,
                    credentialKey: ''
                };
            } else if (type === 'ai_model') {
                // @ts-ignore
                newNode.data = { label: 'AI Model', provider: 'openai', model: 'gpt-4o' };
            } else if (type === 'split') {
                // @ts-ignore
                newNode.data = { label: 'Loop Array', arrayPath: 'input.items' };
            } else if (type === 'memory_read') {
                // @ts-ignore
                newNode.data = { label: 'Read Memories', query: '', limit: 5 };
            } else if (type === 'memory_write') {
                // @ts-ignore
                newNode.data = { label: 'Write Memory', content: '' };
            } else if (type === 'guardrail') {
                // @ts-ignore
                newNode.data = { label: 'Guardrail', rules: 'Content must be safe.', content: 'input.text' };
            }

            setNodes((nds) => nds.concat(newNode));
        },
        [project]
    );

    const handleSave = () => {
        onSave({ ...workflow, name, nodes, edges });
    };

    const handleRun = async () => {
        setLogs(['Starting Execution...']);
        try {
            // autosave before run
            const currentWf = { ...workflow, name, nodes, edges };
            onSave(currentWf);

            // @ts-ignore
            const result = await window.tala.executeWorkflow(workflow.id);
            if (result.logs) setLogs(prev => [...prev, ...result.logs]);
            if (result.success) setLogs(prev => [...prev, 'Done.']);
            else setLogs(prev => [...prev, `Failed: ${result.error}`]);
        } catch (e: any) {
            setLogs(prev => [...prev, `Error: ${e.message}`]);
        }
    };

    const containerStyle: React.CSSProperties = isFullScreen ? {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        background: '#1a1a1a', // Ensure background covers everything
        display: 'flex',
        flexDirection: 'column'
    } : { height: '100%', display: 'flex', flexDirection: 'column' };

    return (
        <div style={containerStyle}>
            {/* TOOLBAR */}
            <div style={{ padding: '10px', background: '#2d2d2d', borderBottom: '1px solid #3e3e42', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                    <input
                        value={name}
                        onChange={e => setName(e.target.value)}
                        style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: 14, fontWeight: 'bold' }}
                    />
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                    <button onClick={() => setIsFullScreen(!isFullScreen)} style={{ background: '#3c3c3c', color: '#ccc', border: 'none', padding: '6px 12px', borderRadius: 2, cursor: 'pointer' }}>
                        {isFullScreen ? 'EXIT FULL SCREEN' : 'FULL SCREEN'}
                    </button>
                    {!isDebug ? (
                        <button onClick={handleDebugStart} style={{ background: '#d79921', color: '#fff', border: 'none', padding: '6px 16px', borderRadius: 2, cursor: 'pointer', fontWeight: 'bold' }}>
                            🐞 DEBUG
                        </button>
                    ) : (
                        <>
                            <button onClick={handleDebugStep} style={{ background: '#d79921', color: '#fff', border: 'none', padding: '6px 16px', borderRadius: 2, cursor: 'pointer', fontWeight: 'bold' }}>
                                ↷ STEP
                            </button>
                            <button onClick={handleDebugStop} style={{ background: '#cc241d', color: '#fff', border: 'none', padding: '6px 16px', borderRadius: 2, cursor: 'pointer', fontWeight: 'bold' }}>
                                ⏹ STOP
                            </button>
                        </>
                    )}
                    <button onClick={handleRun} style={{ background: '#2da042', color: '#fff', border: 'none', padding: '6px 16px', borderRadius: 2, cursor: 'pointer', fontWeight: 'bold' }}>
                        ▶ RUN
                    </button>
                    <button onClick={handleSave} style={{ background: '#0e639c', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 2, cursor: 'pointer' }}>
                        SAVE
                    </button>
                </div>
            </div>

            {/* MAIN CONTENT AREA */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                {/* PALETTE */}
                <div style={{ width: 170, background: '#252526', borderRight: '1px solid #3e3e42', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ padding: 10, borderBottom: '1px solid #3e3e42' }}>
                        <div style={{ fontSize: 11, fontWeight: 'bold', color: '#888', marginBottom: 10 }}>NODE PALETTE</div>
                        <input
                            type="text"
                            placeholder="Filter nodes..."
                            value={paletteSearch}
                            onChange={(e) => setPaletteSearch(e.target.value)}
                            style={{
                                width: '100%',
                                background: '#1e1e1e',
                                border: '1px solid #3e3e42',
                                color: '#fff',
                                padding: '4px 8px',
                                fontSize: '11px',
                                borderRadius: '4px',
                                outline: 'none'
                            }}
                        />
                    </div>
                    <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
                        {PALETTE_ITEMS.filter((item: any) =>
                            item.label.toLowerCase().includes(paletteSearch.toLowerCase()) ||
                            item.type.toLowerCase().includes(paletteSearch.toLowerCase())
                        ).map((item: any) => (
                            <SidebarItem key={item.type} type={item.type} label={item.label} color={item.color} />
                        ))}
                    </div>
                </div>

                {/* CANVAS */}
                <div style={{ flex: 1, position: 'relative' }} ref={reactFlowWrapper}>
                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        nodeTypes={nodeTypes}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        onDragOver={onDragOver}
                        onDrop={onDrop}
                        onNodeClick={onNodeClick}
                        onPaneClick={onPaneClick}
                        fitView
                        minZoom={0.1}
                        maxZoom={1}
                        style={{ background: '#1e1e1e' }}
                    >
                        <Controls style={{ fill: '#fff' }} />
                        <MiniMap style={{ height: 120, background: '#252526' }} zoomable pannable />
                        <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
                    </ReactFlow>
                </div>

                {/* DEBUG OR PROPERTY INSPECTOR */}
                {isDebug ? (
                    <div style={{ width: 300, background: '#252526', borderLeft: '1px solid #3e3e42', padding: 15, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ fontSize: 12, fontWeight: 'bold', color: '#fabd2f', marginBottom: 15, borderBottom: '1px solid #3e3e42', paddingBottom: 5 }}>
                            DEBUG CONTEXT
                        </div>

                        <div style={{ marginBottom: 15 }}>
                            <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Active Node</label>
                            <div style={{ fontSize: 13, color: '#fff', fontWeight: 'bold' }}>{debugState.activeNodeId || 'None'}</div>
                        </div>

                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                            <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Logs</label>
                            <div style={{ flex: 1, background: '#1e1e1e', padding: 5, borderRadius: 4, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace', color: '#ccc' }}>
                                {debugState.logs.map((L, i) => <div key={i}>{L}</div>)}
                            </div>
                        </div>
                    </div>
                ) : selectedNode && (
                    <div style={{ width: 250, background: '#252526', borderLeft: '1px solid #3e3e42', padding: 15, overflowY: 'auto' }}>
                        <div style={{ fontSize: 12, fontWeight: 'bold', color: '#ccc', marginBottom: 15, borderBottom: '1px solid #3e3e42', paddingBottom: 5 }}>
                            NODE PROPERTIES
                        </div>

                        <div style={{ marginBottom: 15 }}>
                            <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Type</label>
                            <div style={{ fontSize: 13, color: '#fff', textTransform: 'uppercase' }}>{selectedNode.id.split('-')[0]}</div>
                        </div>

                        <div style={{ marginBottom: 15 }}>
                            <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Label</label>
                            <input
                                value={selectedNode.data.label}
                                onChange={e => updateNodeData('label', e.target.value)}
                                style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12 }}
                            />
                        </div>

                        {/* TRIGGER SPECIFIC */}
                        {(selectedNode.type === 'input' || selectedNode.id.startsWith('manual')) && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Trigger Type</label>
                                <select
                                    value={selectedNode.data.triggerType || 'manual'}
                                    onChange={e => {
                                        const type = e.target.value;
                                        updateNodeData('triggerType', type);
                                        updateNodeData('label', `TRIGGER: ${type.charAt(0).toUpperCase() + type.slice(1)}`);
                                    }}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, marginBottom: 10, cursor: 'pointer' }}
                                >
                                    <option value="manual">Manual (Button)</option>
                                    <option value="webhook">WebHook</option>
                                    <option value="app_event">App Event</option>
                                    <option value="schedule">Schedule (Cron)</option>
                                </select>

                                {/* WEBHOOK */}
                                {selectedNode.data.triggerType === 'webhook' && (
                                    <div style={{ paddingLeft: 10, borderLeft: '2px solid #d3869b' }}>
                                        <label style={{ display: 'block', fontSize: 10, color: '#aaa', marginBottom: 3 }}>Method</label>
                                        <select
                                            value={selectedNode.data.method || 'POST'}
                                            onChange={e => updateNodeData('method', e.target.value)}
                                            style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 4, fontSize: 11, marginBottom: 5 }}
                                        >
                                            <option value="POST">POST</option>
                                            <option value="GET">GET</option>
                                        </select>
                                        <label style={{ display: 'block', fontSize: 10, color: '#aaa', marginBottom: 3 }}>Path</label>
                                        <input
                                            value={selectedNode.data.webhookPath || ''}
                                            onChange={e => updateNodeData('webhookPath', e.target.value)}
                                            placeholder="/hooks/my-workflow"
                                            style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 4, fontSize: 11 }}
                                        />
                                    </div>
                                )}

                                {/* APP EVENT */}
                                {selectedNode.data.triggerType === 'app_event' && (
                                    <div style={{ paddingLeft: 10, borderLeft: '2px solid #d3869b' }}>
                                        <label style={{ display: 'block', fontSize: 10, color: '#aaa', marginBottom: 3 }}>Event</label>
                                        <select
                                            value={selectedNode.data.event || 'onBoot'}
                                            onChange={e => updateNodeData('event', e.target.value)}
                                            style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 4, fontSize: 11 }}
                                        >
                                            <option value="onBoot">Application Boot</option>
                                            <option value="onSave">File Saved</option>
                                        </select>
                                    </div>
                                )}

                                {/* SCHEDULE */}
                                {selectedNode.data.triggerType === 'schedule' && (
                                    <div style={{ paddingLeft: 10, borderLeft: '2px solid #d3869b' }}>
                                        <label style={{ display: 'block', fontSize: 10, color: '#aaa', marginBottom: 3 }}>Cron Expression</label>
                                        <input
                                            value={selectedNode.data.cron || ''}
                                            onChange={e => updateNodeData('cron', e.target.value)}
                                            placeholder="0 9 * * *"
                                            style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 4, fontSize: 11, fontFamily: 'monospace' }}
                                        />
                                        <div style={{ fontSize: 9, color: '#666', marginTop: 3 }}>Examples: "0 0 * * *" (Daily), "*/5 * * * *" (5 mins)</div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* AGENT SPECIFIC */}
                        {selectedNode.id.startsWith('agent') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Prompt</label>
                                <textarea
                                    value={selectedNode.data.prompt || ''}
                                    onChange={e => updateNodeData('prompt', e.target.value)}
                                    rows={5}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, resize: 'vertical' }}
                                />
                            </div>
                        )}

                        {/* HTTP SPECIFIC */}
                        {selectedNode.id.startsWith('http') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Method</label>
                                <select
                                    value={selectedNode.data.method || 'GET'}
                                    onChange={e => updateNodeData('method', e.target.value)}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, marginBottom: 10 }}
                                >
                                    <option value="GET">GET</option>
                                    <option value="POST">POST</option>
                                    <option value="PUT">PUT</option>
                                    <option value="DELETE">DELETE</option>
                                </select>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>URL</label>
                                <input
                                    value={selectedNode.data.url || ''}
                                    onChange={e => updateNodeData('url', e.target.value)}
                                    placeholder="https://api.example.com"
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, marginBottom: 10 }}
                                />
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Headers (JSON)</label>
                                <textarea
                                    value={selectedNode.data.headers || '{}'}
                                    onChange={e => updateNodeData('headers', e.target.value)}
                                    rows={2}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, resize: 'vertical', fontFamily: 'monospace', marginBottom: 10 }}
                                />
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Body (JSON)</label>
                                <textarea
                                    value={selectedNode.data.body || '{}'}
                                    onChange={e => updateNodeData('body', e.target.value)}
                                    rows={4}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, resize: 'vertical', fontFamily: 'monospace' }}
                                />
                            </div>
                        )}

                        {/* IF SPECIFIC */}
                        {selectedNode.id.startsWith('if') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Condition (JS)</label>
                                <input
                                    value={selectedNode.data.expression || ''}
                                    onChange={e => updateNodeData('expression', e.target.value)}
                                    placeholder="input.value > 100"
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, fontFamily: 'monospace' }}
                                />
                                <div style={{ fontSize: 10, color: '#666', marginTop: 5 }}>
                                    Evaluate boolean expression. Use 'input' variable.
                                </div>
                            </div>
                        )}

                        {/* WAIT SPECIFIC */}
                        {selectedNode.id.startsWith('wait') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Duration (ms)</label>
                                <input
                                    type="number"
                                    value={selectedNode.data.duration || 1000}
                                    onChange={e => updateNodeData('duration', parseInt(e.target.value) || 0)}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12 }}
                                />
                            </div>
                        )}

                        {/* EDIT FIELDS SPECIFIC */}
                        {selectedNode.id.startsWith('edit_fields') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Fields (JSON)</label>
                                <textarea
                                    value={selectedNode.data.fields || '{}'}
                                    onChange={e => updateNodeData('fields', e.target.value)}
                                    rows={5}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, resize: 'vertical', fontFamily: 'monospace' }}
                                />
                                <div style={{ fontSize: 10, color: '#666', marginTop: 5 }}>
                                    These values will be merged into the input object.
                                </div>
                            </div>
                        )}

                        {/* EMAIL READ SPECIFIC */}
                        {selectedNode.id.startsWith('email_read') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>IMAP Host</label>
                                <input
                                    value={selectedNode.data.host || ''}
                                    onChange={e => updateNodeData('host', e.target.value)}
                                    placeholder="imap.gmail.com"
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, marginBottom: 10 }}
                                />

                                <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                                    <div style={{ flex: 1 }}>
                                        <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Port</label>
                                        <input
                                            type="number"
                                            value={selectedNode.data.port || 993}
                                            onChange={e => updateNodeData('port', parseInt(e.target.value))}
                                            style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12 }}
                                        />
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>TLS</label>
                                        <input
                                            type="checkbox"
                                            checked={selectedNode.data.secure !== false}
                                            onChange={e => updateNodeData('secure', e.target.checked)}
                                            style={{ marginTop: 5 }}
                                        />
                                    </div>
                                </div>

                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Credential (User/Pass)</label>
                                <select
                                    value={selectedNode.data.credentialKey || ''}
                                    onChange={e => updateNodeData('credentialKey', e.target.value)}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, marginBottom: 10 }}
                                >
                                    <option value="">-- Select Credential --</option>
                                    {availableKeys.map(k => (
                                        <option key={k} value={k}>{k}</option>
                                    ))}
                                </select>
                                <div style={{ fontSize: 10, color: '#666', marginBottom: 10 }}>
                                    Key should contain JSON: <code>{`{"user": "...", "pass": "..."}`}</code>
                                </div>

                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Mailbox</label>
                                <input
                                    value={selectedNode.data.mailbox || 'INBOX'}
                                    onChange={e => updateNodeData('mailbox', e.target.value)}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, marginBottom: 10 }}
                                />

                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Limit</label>
                                <input
                                    type="number"
                                    value={selectedNode.data.limit || 5}
                                    onChange={e => updateNodeData('limit', parseInt(e.target.value))}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12 }}
                                />
                            </div>
                        )}

                        {/* AI MODEL SPECIFIC */}
                        {selectedNode.id.startsWith('ai_model') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Provider</label>
                                <select
                                    value={selectedNode.data.provider || 'openai'}
                                    onChange={e => updateNodeData('provider', e.target.value)}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, marginBottom: 10 }}
                                >
                                    <option value="openai">OpenAI</option>
                                    <option value="anthropic">Anthropic</option>
                                    <option value="google">Google Gemini</option>
                                    <option value="local">Local (OpenAI Compatible)</option>
                                </select>

                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Credential (API Key)</label>
                                <select
                                    value={selectedNode.data.credentialKey || ''}
                                    onChange={e => updateNodeData('credentialKey', e.target.value)}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, marginBottom: 10 }}
                                >
                                    <option value="">-- Optional (Use Provider Default) --</option>
                                    {availableKeys.map(k => (
                                        <option key={k} value={k}>{k}</option>
                                    ))}
                                </select>

                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Model Name</label>
                                <input
                                    value={selectedNode.data.model || ''}
                                    onChange={e => updateNodeData('model', e.target.value)}
                                    placeholder="gpt-4o"
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, marginBottom: 10 }}
                                />

                                {selectedNode.data.provider === 'local' && (
                                    <>
                                        <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Base URL</label>
                                        <input
                                            value={selectedNode.data.baseUrl || 'http://localhost:1234/v1'}
                                            onChange={e => updateNodeData('baseUrl', e.target.value)}
                                            placeholder="http://localhost:1234/v1"
                                            style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12 }}
                                        />
                                    </>
                                )}
                            </div>
                        )}

                        {/* FUNCTION SPECIFIC */}
                        {selectedNode.id.startsWith('function') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Function Utility Name</label>
                                <input
                                    value={selectedNode.data.functionName || ''}
                                    onChange={e => updateNodeData('functionName', e.target.value)}
                                    placeholder="e.g. scrape_url"
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12 }}
                                />
                                <div style={{ fontSize: 10, color: '#666', marginTop: 5 }}>Must match a file in your Functions library.</div>
                            </div>
                        )}

                        {/* TOOL SPECIFIC */}
                        {selectedNode.id.startsWith('tool') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Tool Name</label>
                                {availableTools.length > 0 ? (
                                    <select
                                        value={selectedNode.data.toolName || ''}
                                        onChange={e => updateNodeData('toolName', e.target.value)}
                                        style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, marginBottom: 10 }}
                                    >
                                        <option value="">-- Select Tool --</option>
                                        {availableTools.sort((a: any, b: any) => a.name.localeCompare(b.name)).map((t: any) => (
                                            <option key={t.name} value={t.name}>{t.name} ({t.source})</option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        value={selectedNode.data.toolName || ''}
                                        onChange={e => updateNodeData('toolName', e.target.value)}
                                        placeholder="e.g. github_list_repos"
                                        style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, marginBottom: 10 }}
                                    />
                                )}
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Arguments (JSON)</label>
                                <textarea
                                    value={selectedNode.data.args || '{}'}
                                    onChange={e => updateNodeData('args', e.target.value)}
                                    rows={5}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, resize: 'vertical', fontFamily: 'monospace' }}
                                />
                                <div style={{ fontSize: 10, color: '#666', marginTop: 5 }}>Enter arguments as valid JSON object.</div>
                            </div>
                        )}

                        {/* CREDENTIAL SPECIFIC */}
                        {selectedNode.id.startsWith('credential') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Select Credential</label>
                                <select
                                    value={selectedNode.data.credentialKey || ''}
                                    onChange={e => updateNodeData('credentialKey', e.target.value)}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, cursor: 'pointer' }}
                                >
                                    <option value="">-- Choose Key --</option>
                                    {availableKeys.map(k => (
                                        <option key={k} value={k}>{k}</option>
                                    ))}
                                </select>
                                <div style={{ fontSize: 10, color: '#666', marginTop: 5 }}>
                                    Will inject the value of this key at runtime.
                                </div>
                            </div>
                        )}

                        {/* SPLIT SPECIFIC */}
                        {selectedNode.id.startsWith('split') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Array Path (JSON Path)</label>
                                <input
                                    value={selectedNode.data.arrayPath || ''}
                                    onChange={e => updateNodeData('arrayPath', e.target.value)}
                                    placeholder="input.items"
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, fontFamily: 'monospace' }}
                                />
                                <div style={{ fontSize: 10, color: '#666', marginTop: 5 }}>
                                    Path to the array in the input payload to iterate over.
                                </div>
                            </div>
                        )}

                        {/* MEMORY READ SPECIFIC */}
                        {selectedNode.id.startsWith('memory_read') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Search Query</label>
                                <input
                                    value={selectedNode.data.query || ''}
                                    onChange={e => updateNodeData('query', e.target.value)}
                                    placeholder="e.g. user preferences"
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, marginBottom: 10 }}
                                />
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Limit</label>
                                <input
                                    type="number"
                                    value={selectedNode.data.limit || 5}
                                    onChange={e => updateNodeData('limit', parseInt(e.target.value))}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12 }}
                                />
                            </div>
                        )}

                        {/* MEMORY WRITE SPECIFIC */}
                        {selectedNode.id.startsWith('memory_write') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Memory Content</label>
                                <textarea
                                    value={selectedNode.data.content || ''}
                                    onChange={e => updateNodeData('content', e.target.value)}
                                    rows={4}
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, resize: 'vertical' }}
                                />
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5, marginTop: 10 }}>User ID (Optional)</label>
                                <input
                                    value={selectedNode.data.userId || ''}
                                    onChange={e => updateNodeData('userId', e.target.value)}
                                    placeholder="default-user"
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12 }}
                                />
                            </div>
                        )}

                        {/* GUARDRAIL SPECIFIC */}
                        {selectedNode.id.startsWith('guardrail') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Rules</label>
                                <textarea
                                    value={selectedNode.data.rules || ''}
                                    onChange={e => updateNodeData('rules', e.target.value)}
                                    rows={5}
                                    placeholder="Content must not include..."
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, resize: 'vertical', marginBottom: 10 }}
                                />
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Content to Check</label>
                                <textarea
                                    value={selectedNode.data.content || ''}
                                    onChange={e => updateNodeData('content', e.target.value)}
                                    rows={3}
                                    placeholder="input.text"
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, resize: 'vertical' }}
                                />
                            </div>
                        )}

                        {/* SUBWORKFLOW SPECIFIC */}
                        {selectedNode.id.startsWith('subworkflow') && (
                            <div style={{ marginBottom: 15 }}>
                                <label style={{ display: 'block', fontSize: 11, color: '#888', marginBottom: 5 }}>Workflow File Path</label>
                                <input
                                    value={selectedNode.data.workflowPath || ''}
                                    onChange={e => updateNodeData('workflowPath', e.target.value)}
                                    placeholder="my-workflow.json"
                                    style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 5, fontSize: 12, fontFamily: 'monospace' }}
                                />
                                <div style={{ fontSize: 10, color: '#666', marginTop: 5 }}>
                                    Filename of workflow in your workflows folder. The sub-workflow will receive this node's input and return its final output.
                                </div>
                            </div>
                        )}

                        <div style={{ fontSize: 10, color: '#555', marginTop: 20 }}>
                            ID: {selectedNode.id}
                        </div>
                    </div>
                )}
            </div>

            {/* BOTTOM PANEL: LOGS & HISTORY */}
            <div style={{ height: 250, background: '#1e1e1e', borderTop: '1px solid #3e3e42', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', background: '#2d2d2d', borderBottom: '1px solid #3e3e42' }}>
                    <button
                        onClick={() => setActiveTab('logs')}
                        style={{
                            padding: '8px 20px',
                            background: activeTab === 'logs' ? '#1e1e1e' : 'transparent',
                            color: activeTab === 'logs' ? '#fff' : '#888',
                            border: 'none',
                            borderRight: '1px solid #3e3e42',
                            fontSize: 11,
                            fontWeight: 'bold',
                            cursor: 'pointer'
                        }}
                    >
                        EXECUTION LOGS
                    </button>
                    <button
                        onClick={() => setActiveTab('history')}
                        style={{
                            padding: '8px 20px',
                            background: activeTab === 'history' ? '#1e1e1e' : 'transparent',
                            color: activeTab === 'history' ? '#fff' : '#888',
                            border: 'none',
                            borderRight: '1px solid #3e3e42',
                            fontSize: 11,
                            fontWeight: 'bold',
                            cursor: 'pointer'
                        }}
                    >
                        HISTORY
                    </button>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: 10, fontFamily: 'Consolas', fontSize: 12, color: '#aaa' }}>
                    {activeTab === 'logs' && (
                        <>
                            {logs.map((log, i) => (
                                <div key={i}>{log}</div>
                            ))}
                            {logs.length === 0 && <span style={{ opacity: 0.5 }}>Ready to execute.</span>}
                        </>
                    )}

                    {activeTab === 'history' && (
                        <div style={{ height: '100%' }}>
                            {isLoadingHistory ? (
                                <div style={{ opacity: 0.5 }}>Loading runs...</div>
                            ) : historyRuns.length === 0 ? (
                                <div style={{ opacity: 0.5 }}>No previous runs found.</div>
                            ) : (
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ textAlign: 'left', borderBottom: '1px solid #333', color: '#666', fontSize: 10 }}>
                                            <th style={{ padding: 5 }}>Date</th>
                                            <th style={{ padding: 5 }}>Status</th>
                                            <th style={{ padding: 5 }}>Duration</th>
                                            <th style={{ padding: 5 }}>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {historyRuns.map((run: any) => (
                                            <tr key={run.runId} style={{ borderBottom: '1px solid #252525' }}>
                                                <td style={{ padding: 5 }}>{new Date(run.timestamp).toLocaleString()}</td>
                                                <td style={{ padding: 5, color: run.success ? '#98971a' : '#cc241d' }}>
                                                    {run.success ? 'Success' : 'Failed'}
                                                </td>
                                                <td style={{ padding: 5 }}>{run.duration ? `${run.duration}ms` : '-'}</td>
                                                <td style={{ padding: 5 }}>
                                                    <button
                                                        onClick={() => setLogs(run.logs || [])}
                                                        style={{ background: '#333', color: '#eee', border: 'none', padding: '2px 8px', fontSize: 10, cursor: 'pointer', borderRadius: 2, marginRight: 5 }}
                                                    >
                                                        View Logs
                                                    </button>
                                                    <button
                                                        onClick={async () => {
                                                            if (confirm('Delete this run log?')) {
                                                                await (window as any).tala.deleteWorkflowRun({ workflowId: workflow.id, runId: run.runId });
                                                                refreshHistory();
                                                            }
                                                        }}
                                                        style={{ background: '#442222', color: '#eee', border: 'none', padding: '2px 8px', fontSize: 10, cursor: 'pointer', borderRadius: 2 }}
                                                    >
                                                        Delete
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export const WorkflowEditor = (props: any) => (
    <ReactFlowProvider>
        <EditorContent {...props} />
    </ReactFlowProvider>
);
