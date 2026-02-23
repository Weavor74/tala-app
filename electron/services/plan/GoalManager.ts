import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { GoalGraph, GoalNode, GoalStatus } from './types';

/**
 * GoalManager
 * 
 * Manages the persistence and state transitions of the Goal Graph.
 * Ensures the agent has a structured map of what it is doing and why.
 */
export class GoalManager {
    private activeGraph: GoalGraph | null = null;
    private storageDir: string;

    constructor(userDataDir: string) {
        this.storageDir = path.join(userDataDir, 'memory', 'goals');
        if (!fs.existsSync(this.storageDir)) {
            fs.mkdirSync(this.storageDir, { recursive: true });
        }
    }

    /**
     * Initializes a new graph for a session.
     */
    public createGraph(sessionId: string, rootTitle: string, rootDescription: string): GoalGraph {
        const rootId = uuidv4();
        const rootNode: GoalNode = {
            id: rootId,
            parentId: null,
            title: rootTitle,
            description: rootDescription,
            status: 'active',
            children: [],
            dependencies: [],
            createdIndex: 0
        };

        const graph: GoalGraph = {
            sessionId,
            nodes: { [rootId]: rootNode },
            rootGoalId: rootId,
            activeGoalId: rootId,
            turnCount: 0
        };

        this.activeGraph = graph;
        this.save();
        return graph;
    }

    /**
     * Loads a graph from disk.
     */
    public loadGraph(sessionId: string): GoalGraph | null {
        const filePath = path.join(this.storageDir, `${sessionId}.json`);
        if (fs.existsSync(filePath)) {
            try {
                this.activeGraph = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                return this.activeGraph;
            } catch (e) {
                console.error(`[GoalManager] Error loading graph ${sessionId}:`, e);
            }
        }
        return null;
    }

    /**
     * Adds a sub-goal to a parent.
     */
    public addSubGoal(parentId: string, title: string, description: string, immersion?: string): string {
        if (!this.activeGraph || !this.activeGraph.nodes[parentId]) {
            throw new Error(`Parent goal ${parentId} not found.`);
        }

        const id = uuidv4();
        const newNode: GoalNode = {
            id,
            parentId,
            title,
            description,
            status: 'pending',
            children: [],
            dependencies: [],
            createdIndex: this.activeGraph.turnCount,
            immersion
        };

        this.activeGraph.nodes[id] = newNode;
        this.activeGraph.nodes[parentId].children.push(id);

        this.save();
        return id;
    }

    /**
     * Updates the immersion text for a goal.
     */
    public updateImmersion(id: string, immersion: string) {
        if (!this.activeGraph || !this.activeGraph.nodes[id]) return;
        this.activeGraph.nodes[id].immersion = immersion;
        this.save();
    }

    /**
     * Updates the status of a specific goal.
     */
    public updateGoalStatus(id: string, status: GoalStatus) {
        if (!this.activeGraph || !this.activeGraph.nodes[id]) return;

        const node = this.activeGraph.nodes[id];
        node.status = status;

        if (status === 'completed') {
            node.completedIndex = this.activeGraph.turnCount;
        }

        this.save();
    }

    /**
     * Sets which goal the agent should be focusing on.
     */
    public setActiveGoal(id: string) {
        if (this.activeGraph && this.activeGraph.nodes[id]) {
            this.activeGraph.activeGoalId = id;
            this.save();
        }
    }

    /**
     * Formats the active goals into a summary for the system prompt.
     */
    public generatePromptSummary(): string {
        if (!this.activeGraph) return "";

        const lines: string[] = ["# [SHIP'S LOG: GOAL GRAPH]"];
        const root = this.activeGraph.nodes[this.activeGraph.rootGoalId];

        this.renderGoalTree(root.id, 0, lines);

        const active = this.activeGraph.nodes[this.activeGraph.activeGoalId];
        lines.push(`\n## [CURRENT FOCUS]: ${active.title}`);
        lines.push(`Objective: ${active.description}`);
        if (active.immersion) {
            lines.push(`\n**[IMMERSION LOG]**: ${active.immersion}`);
        }

        return lines.join('\n');
    }

    private renderGoalTree(id: string, level: number, lines: string[]) {
        if (!this.activeGraph) return;
        const node = this.activeGraph.nodes[id];
        const indent = "  ".repeat(level);
        const statusMark = this.getStatusMark(node.status);

        lines.push(`${indent}${statusMark} ${node.title} (${node.id.substring(0, 4)})`);

        for (const childId of node.children) {
            this.renderGoalTree(childId, level + 1, lines);
        }
    }

    private getStatusMark(status: GoalStatus): string {
        switch (status) {
            case 'completed': return '⚓'; // Anchored/Done
            case 'active': return '🚀';    // In flight
            case 'blocked': return '⚠️';   // Hazard
            case 'cancelled': return '☄️'; // Drifted
            default: return '🛰️';          // Orbiting (Pending)
        }
    }

    private save() {
        if (!this.activeGraph) return;
        const filePath = path.join(this.storageDir, `${this.activeGraph.sessionId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(this.activeGraph, null, 2), 'utf-8');
    }

    public incrementTurn() {
        if (this.activeGraph) this.activeGraph.turnCount++;
    }
}
