import { ipcMain, BrowserWindow } from 'electron';
import os from 'os';
import fs from 'fs';
import * as pty from 'node-pty';
import { CodeAccessPolicy } from './CodeAccessPolicy';

/**
 * TerminalService
 * 
 * Manages a pseudo-terminal (PTY) session within the Electron application.
 * Spawns a system shell process (PowerShell on Windows, bash on macOS/Linux)
 * and bridges its stdin/stdout/stderr to the frontend `xterm.js` terminal
 * component via IPC events.
 * 
 * **Tier 3 Update**: Now uses `node-pty` for full PTY support, enabling
 * window resizing and proper TTY behavior (colors, cursor, signaling).
 * 
 * Key responsibilities:
 * - Spawning and managing the lifetime of a shell child process.
 * - Forwarding shell output to the renderer via `window.webContents.send('terminal-data', ...)`.
 * - Accepting user input from the frontend and writing to the PTY.
 * - Maintaining a rolling output buffer for AI context.
 * - Handling terminal resize events.
 */
export class TerminalService {
    /** Map of active PTY shell processes by ID. */
    private shells: Map<string, any> = new Map();
    /** Reference to the Electron BrowserWindow for sending IPC messages to the renderer. */
    private window: BrowserWindow | null = null;
    /** The working directory where the shell process starts. Defaults to the user's home directory. */
    private workspaceRoot: string = os.homedir();
    /** Rolling buffer of the last 1000 characters of terminal output, used by AgentService for context. */
    private outputBuffer: string = "";
    /** Custom environment variables merged into the shell's environment. */
    private customEnv: Record<string, string> = {};
    /** Quantum Firewall: Allowed base commands. */
    private allowedCommands: string[] = [
        'ls', 'dir', 'cd', 'mkdir', 'cat', 'grep', 'find', 'git', 'npm', 'npx',
        'node', 'python', 'type', 'echo', 'rm', 'cp', 'mv', 'tsc', 'vite'
    ];
    /** Path to application settings for checking firewall status */
    private settingsPath: string | null = null;
    private policy: CodeAccessPolicy | null = null;

    /**
     * Creates a new TerminalService instance.
     */
    constructor() {
    }

    /**
     * Sets the Electron BrowserWindow reference used to send terminal output.
     */
    public setWindow(win: BrowserWindow) {
        this.window = win;
    }

    /**
     * Sets the path to the app settings file for firewall checks.
     */
    public setSettingsPath(path: string) {
        this.settingsPath = path;
    }

    /**
     * Sets the working directory for the shell process.
     */
    public setRoot(path: string) {
        this.workspaceRoot = path;
    }

    public setPolicy(policy: CodeAccessPolicy) {
        this.policy = policy;
        this.workspaceRoot = policy.getWorkspaceRoot();
    }

    /**
     * Sets custom environment variables.
     */
    public setCustomEnv(env: Record<string, string>) {
        this.customEnv = env;
    }

    /**
     * Returns the most recent terminal output and clears the internal buffer.
     */
    public getRecentOutput(): string {
        const out = this.outputBuffer;
        this.outputBuffer = ""; // Clear after reading
        return out;
    }

    /**
     * Spawns a new system shell process using node-pty.
     */
    public createTerminal(id?: string): string {
        const terminalId = id || Math.random().toString(36).substring(2, 9);

        if (this.shells.has(terminalId)) return terminalId;

        const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

        try {
            const ptyProcess = pty.spawn(shell, [], {
                name: 'xterm-color',
                cols: 80,
                rows: 30,
                cwd: this.workspaceRoot,
                env: { ...process.env, ...this.customEnv } as any
            });

            ptyProcess.onData((data: string) => {
                this.outputBuffer = (this.outputBuffer + data).slice(-1000);
                if (this.window) {
                    this.window.webContents.send('terminal-data', { id: terminalId, data });
                }
            });

            ptyProcess.onExit(({ exitCode, signal }: any) => {
                const msg = `\r\n[Process exited with code ${exitCode}]`;
                this.outputBuffer += msg;
                if (this.window) {
                    this.window.webContents.send('terminal-data', { id: terminalId, data: msg });
                }
                this.shells.delete(terminalId);
            });

            this.shells.set(terminalId, ptyProcess);
            return terminalId;

        } catch (error) {
            console.error('[TerminalService] Failed to spawn PTY:', error);
            if (this.window) {
                this.window.webContents.send('terminal-data', { id: terminalId, data: `\r\n[Error spawning terminal: ${error}]` });
            }
            return "";
        }
    }

    /**
     * Writes raw data to the shell's standard input (PTY stdin relay).
     *
     * IMPORTANT: This method is a pure pass-through for PTY stdin data.
     * It does NOT validate or policy-check the data — that is the responsibility
     * of CodeControlService.shellRun() when executing agent-initiated commands.
     * ESC sequences, arrow keys, control characters, and empty strings must all
     * pass through without interference.
     */
    public write(id: string, data: string) {
        if (data === undefined || data === null) return;
        const shell = this.shells.get(id);
        if (shell) {
            shell.write(data);
        } else {
            console.warn(`[TerminalService] Write failed: Terminal ${id} not found.`);
        }
    }

    /**
     * Resizes the terminal dimensions.
     */
    public resize(id: string, cols: number, rows: number) {
        const shell = this.shells.get(id);
        if (shell) {
            try {
                shell.resize(cols, rows);
            } catch (err) {
                console.error('[TerminalService] Resize failed:', err);
            }
        }
    }

    /**
     * Forcefully terminates the running shell process.
     */
    public kill(id: string) {
        const shell = this.shells.get(id);
        if (shell) {
            shell.kill();
            this.shells.delete(id);
        }
    }
}
