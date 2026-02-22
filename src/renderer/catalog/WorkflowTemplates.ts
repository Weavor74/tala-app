/**
 * Workflow Templates Catalog
 * 
 * Pre-defined JSON structures for common automation workflows.
 * Used by Settings.tsx to bootstrap new workflows for users.
 */

export interface WorkflowTemplate {
    id: string;
    name: string;
    description: string;
    nodes: any[];
    edges: any[];
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
    {
        id: 'tpl-summarize-url',
        name: 'Summarize URL',
        description: 'Fetch a web page, extract its content, summarize with AI, and save the result.',
        nodes: [
            {
                id: 'trigger-1',
                type: 'input',
                position: { x: 50, y: 100 },
                data: { label: 'TRIGGER: Manual', triggerType: 'manual' },
                style: { border: '1px solid #777', padding: 10, borderRadius: 5, background: '#d3869b', color: '#fff', minWidth: 150 }
            },
            {
                id: 'http-1',
                type: 'default',
                position: { x: 250, y: 100 },
                data: { label: 'HTTP: Fetch Content', method: 'GET', url: 'https://example.com' },
                style: { border: '1px solid #777', padding: 10, borderRadius: 5, background: '#1e1e1e', color: '#fff', minWidth: 150 }
            },
            {
                id: 'agent-1',
                type: 'default',
                position: { x: 450, y: 100 },
                data: { label: 'AGENT: Summarize', prompt: 'Please summarize the following web content in 3 bullet points:\n\n{{input.body}}' },
                style: { border: '1px solid #777', padding: 10, borderRadius: 5, background: '#252526', color: '#fff', minWidth: 150 }
            },
            {
                id: 'tool-1',
                type: 'default',
                position: { x: 650, y: 100 },
                data: { label: 'TOOL: Save to File', toolName: 'write_file', args: '{\n  "path": "summary.txt",\n  "content": "{{input.content}}"\n}' },
                style: { border: '1px solid #777', padding: 10, borderRadius: 5, background: '#1e1e1e', color: '#fff', minWidth: 150 }
            }
        ],
        edges: [
            { id: 'e1-2', source: 'trigger-1', target: 'http-1' },
            { id: 'e2-3', source: 'http-1', target: 'agent-1' },
            { id: 'e3-4', source: 'agent-1', target: 'tool-1' }
        ]
    },
    {
        id: 'tpl-git-commit',
        name: 'Smart Git Commit',
        description: 'Analyze staged git changes with AI and generate a meaningful commit message.',
        nodes: [
            {
                id: 'trigger-1',
                type: 'input',
                position: { x: 50, y: 100 },
                data: { label: 'TRIGGER: Manual', triggerType: 'manual' },
                style: { border: '1px solid #777', padding: 10, borderRadius: 5, background: '#d3869b', color: '#fff', minWidth: 150 }
            },
            {
                id: 'tool-1',
                type: 'default',
                position: { x: 250, y: 100 },
                data: { label: 'TOOL: Git Diff', toolName: 'execute_command', args: '{"command": "git diff --cached"}' },
                style: { border: '1px solid #777', padding: 10, borderRadius: 5, background: '#1e1e1e', color: '#fff', minWidth: 150 }
            },
            {
                id: 'agent-1',
                type: 'default',
                position: { x: 450, y: 100 },
                data: { label: 'AGENT: Generate Message', prompt: 'Based on these git changes, write a concise semantic commit message (e.g. feat: add login logic):\n\n{{input}}' },
                style: { border: '1px solid #777', padding: 10, borderRadius: 5, background: '#252526', color: '#fff', minWidth: 150 }
            },
            {
                id: 'tool-2',
                type: 'default',
                position: { x: 650, y: 100 },
                data: { label: 'TOOL: Git Commit', toolName: 'execute_command', args: '{"command": "git commit -m \"{{input.content}}\""}' },
                style: { border: '1px solid #777', padding: 10, borderRadius: 5, background: '#1e1e1e', color: '#fff', minWidth: 150 }
            }
        ],
        edges: [
            { id: 'e1-2', source: 'trigger-1', target: 'tool-1' },
            { id: 'e2-3', source: 'tool-1', target: 'agent-1' },
            { id: 'e3-4', source: 'agent-1', target: 'tool-2' }
        ]
    },
    {
        id: 'tpl-research',
        name: 'Deep Research',
        description: 'Research a topic by searching the web and compiling a final report.',
        nodes: [
            {
                id: 'trigger-1',
                type: 'input',
                position: { x: 50, y: 150 },
                data: { label: 'TRIGGER: Manual', triggerType: 'manual' },
                style: { border: '1px solid #777', padding: 10, borderRadius: 5, background: '#d3869b', color: '#fff', minWidth: 150 }
            },
            {
                id: 'tool-1',
                type: 'default',
                position: { x: 250, y: 150 },
                data: { label: 'TOOL: Search Web', toolName: 'search_web', args: '{"query": "Future of AI Agents"}' },
                style: { border: '1px solid #777', padding: 10, borderRadius: 5, background: '#1e1e1e', color: '#fff', minWidth: 150 }
            },
            {
                id: 'agent-1',
                type: 'default',
                position: { x: 450, y: 150 },
                data: { label: 'AGENT: Synthesize', prompt: 'Write a detailed report on the following search results:\n\n{{input}}' },
                style: { border: '1px solid #777', padding: 10, borderRadius: 5, background: '#252526', color: '#fff', minWidth: 150 }
            },
            {
                id: 'tool-2',
                type: 'default',
                position: { x: 650, y: 150 },
                data: { label: 'TOOL: Save Report', toolName: 'write_file', args: '{\n  "path": "research_report.md",\n  "content": "{{input.content}}"\n}' },
                style: { border: '1px solid #777', padding: 10, borderRadius: 5, background: '#1e1e1e', color: '#fff', minWidth: 150 }
            }
        ],
        edges: [
            { id: 'e1-2', source: 'trigger-1', target: 'tool-1' },
            { id: 'e2-3', source: 'tool-1', target: 'agent-1' },
            { id: 'e3-4', source: 'agent-1', target: 'tool-2' }
        ]
    }
];
