import path from 'path';
import type { ToolExecutionCoordinator, ToolInvocationContext } from '../tools/ToolExecutionCoordinator';
import {
    detectSelfInspectionRequest,
    type SelfInspectionDecision,
    type SelfInspectionOperation,
} from '../../../shared/agent/SelfInspectionIntent';

export type SelfInspectionExecutionResult = {
    executed: boolean;
    operation: SelfInspectionOperation;
    toolCalls: Array<{ toolId: string; args: Record<string, unknown> }>;
    summary: string;
    artifacts?: Array<{ path: string; kind: 'read' | 'modified' | 'created' }>;
    blockedReason?: string;
};

interface ToolAuthorityLike {
    executeTool(
        name: string,
        args: Record<string, unknown>,
        allowedNames?: ReadonlySet<string>,
        ctx?: ToolInvocationContext,
    ): Promise<unknown>;
}

const SELF_INSPECTION_TOOL_ALLOWLIST = new Set<string>(['fs_read_text', 'fs_list', 'fs_write_text']);

function unwrapToolData(result: unknown): string {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && 'data' in result) {
        const data = (result as { data?: unknown }).data;
        if (typeof data === 'string') return data;
        return JSON.stringify(data ?? '');
    }
    return JSON.stringify(result ?? '');
}

function isToolError(result: string): boolean {
    return /^error:/i.test(result.trim());
}

function normalizeRelativePath(rawPath: string): string | null {
    const normalized = rawPath.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!normalized) return null;
    if (path.posix.isAbsolute(normalized)) return null;
    const segments = normalized.split('/');
    if (segments.some((segment) => segment === '..')) return null;
    return normalized;
}

function parseListedFiles(output: string): string[] {
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('[FILE] '))
        .map((line) => line.replace(/^\[FILE\]\s+/, '').trim())
        .filter(Boolean);
}

function pickBestPathMatch(filePaths: string[], targetName: string): string | null {
    const target = targetName.toLowerCase();
    const matches = filePaths.filter((value) => value.split('/').pop()?.toLowerCase() === target);
    if (matches.length === 0) return null;
    const rank = (candidate: string): number => {
        const normalized = candidate.toLowerCase();
        if (normalized === target) return 0;
        if (normalized === `docs/${target}`) return 1;
        return 2 + normalized.split('/').length;
    };
    return matches.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}

async function executeAllowedTool(
    authority: ToolAuthorityLike,
    toolCalls: Array<{ toolId: string; args: Record<string, unknown> }>,
    toolId: string,
    args: Record<string, unknown>,
): Promise<string> {
    toolCalls.push({ toolId, args });
    const result = await authority.executeTool(toolId, args, SELF_INSPECTION_TOOL_ALLOWLIST, {
        executionType: 'chat_turn',
        executionOrigin: 'ipc',
        executionMode: 'assistant',
    });
    return unwrapToolData(result);
}

async function readWithFallback(
    authority: ToolAuthorityLike,
    toolCalls: Array<{ toolId: string; args: Record<string, unknown> }>,
    requestedPath: string,
): Promise<{ path: string; content: string } | null> {
    const directRead = await executeAllowedTool(authority, toolCalls, 'fs_read_text', { path: requestedPath });
    if (!isToolError(directRead)) {
        return { path: requestedPath, content: directRead };
    }

    const recursiveList = await executeAllowedTool(authority, toolCalls, 'fs_list', { path: '', recursive: true });
    if (isToolError(recursiveList)) return null;

    const files = parseListedFiles(recursiveList);
    const basename = requestedPath.split('/').pop() ?? requestedPath;
    const fallbackPath = pickBestPathMatch(files, basename);
    if (!fallbackPath || fallbackPath === requestedPath) return null;

    const fallbackRead = await executeAllowedTool(authority, toolCalls, 'fs_read_text', { path: fallbackPath });
    if (isToolError(fallbackRead)) return null;
    return { path: fallbackPath, content: fallbackRead };
}

function resolveRequestedPaths(decision: SelfInspectionDecision): string[] {
    const requested = (decision.requestedPaths ?? [])
        .map(normalizeRelativePath)
        .filter((value): value is string => Boolean(value));
    if (requested.length > 0) return requested;
    if (decision.targetScope === 'readme') return ['README.md'];
    if (decision.targetScope === 'docs') return ['docs/'];
    return ['README.md'];
}

export class SelfInspectionExecutionService {
    async executeSelfInspectionTurn(input: {
        text: string;
        allowWritesThisTurn: boolean;
        allowedRoot?: string;
        toolExecutionCoordinator: ToolExecutionCoordinator | ToolAuthorityLike;
    }): Promise<SelfInspectionExecutionResult> {
        const decision = detectSelfInspectionRequest({ text: input.text });
        if (!decision.isSelfInspectionRequest) {
            return {
                executed: false,
                operation: decision.requestedOperation,
                toolCalls: [],
                summary: 'No self-inspection operation detected.',
            };
        }

        const authority = input.toolExecutionCoordinator as ToolAuthorityLike;
        const toolCalls: Array<{ toolId: string; args: Record<string, unknown> }> = [];
        const artifacts: Array<{ path: string; kind: 'read' | 'modified' | 'created' }> = [];
        const operation = decision.requestedOperation === 'unknown' ? 'read' : decision.requestedOperation;

        if (operation === 'edit') {
            const targetPath = resolveRequestedPaths(decision)[0];
            if (!targetPath) {
                return {
                    executed: true,
                    operation,
                    toolCalls,
                    summary: 'Edit request detected, but no target path could be determined.',
                    blockedReason: 'no_target_path',
                };
            }
            if (!input.allowWritesThisTurn) {
                return {
                    executed: true,
                    operation,
                    toolCalls,
                    summary: 'Write request detected. Inspection is allowed, but writes are blocked for this turn.',
                    blockedReason: 'write_not_allowed_this_turn',
                };
            }
            const appendMatch = /\bappend\b\s+["'`]([\s\S]+?)["'`]/i.exec(input.text);
            const replaceMatch = /\breplace\b\s+["'`]([\s\S]+?)["'`]\s+\bwith\b\s+["'`]([\s\S]+?)["'`]/i.exec(input.text);
            const current = await executeAllowedTool(authority, toolCalls, 'fs_read_text', { path: targetPath });
            if (isToolError(current)) {
                return {
                    executed: true,
                    operation,
                    toolCalls,
                    summary: `Write was allowed, but ${targetPath} could not be read before edit: ${current}`,
                    blockedReason: 'edit_pre_read_failed',
                };
            }
            let nextContent = current;
            if (replaceMatch) {
                nextContent = nextContent.split(replaceMatch[1]).join(replaceMatch[2]);
            } else if (appendMatch) {
                nextContent = `${nextContent}${nextContent.endsWith('\n') ? '' : '\n'}${appendMatch[1]}\n`;
            } else {
                return {
                    executed: true,
                    operation,
                    toolCalls,
                    summary: 'Write request detected, but deterministic edit instruction was missing (use replace/append form).',
                    blockedReason: 'edit_instruction_not_deterministic',
                };
            }
            const writeResult = await executeAllowedTool(authority, toolCalls, 'fs_write_text', {
                path: targetPath,
                content: nextContent,
            });
            if (isToolError(writeResult)) {
                return {
                    executed: true,
                    operation,
                    toolCalls,
                    summary: `Write attempt failed for ${targetPath}: ${writeResult}`,
                    blockedReason: 'write_failed',
                };
            }
            artifacts.push({ path: targetPath, kind: 'modified' });
            return {
                executed: true,
                operation,
                toolCalls,
                artifacts,
                summary: `Updated ${targetPath} deterministically within the allowed root.`,
            };
        }

        if (operation === 'list') {
            const listing = await executeAllowedTool(authority, toolCalls, 'fs_list', { path: '' });
            if (isToolError(listing)) {
                return {
                    executed: true,
                    operation,
                    toolCalls,
                    summary: `Failed to list the workspace root: ${listing}`,
                    blockedReason: 'list_failed',
                };
            }
            artifacts.push({ path: '.', kind: 'read' });
            return {
                executed: true,
                operation,
                toolCalls,
                artifacts,
                summary: `Listed workspace root entries.\n${listing.split('\n').slice(0, 20).join('\n')}`,
            };
        }

        if (operation === 'search') {
            const listing = await executeAllowedTool(authority, toolCalls, 'fs_list', { path: '', recursive: true });
            if (isToolError(listing)) {
                return {
                    executed: true,
                    operation,
                    toolCalls,
                    summary: `Recursive search failed: ${listing}`,
                    blockedReason: 'search_failed',
                };
            }
            const files = parseListedFiles(listing);
            const hints = resolveRequestedPaths(decision).map((value) => value.toLowerCase());
            const matched = files.filter((file) => hints.some((hint) => file.toLowerCase().includes(hint)));
            return {
                executed: true,
                operation,
                toolCalls,
                artifacts: matched.slice(0, 10).map((pathValue) => ({ path: pathValue, kind: 'read' })),
                summary: matched.length > 0
                    ? `Matched files:\n${matched.slice(0, 20).join('\n')}`
                    : 'No matching files found in workspace search.',
            };
        }

        const requestedPaths = resolveRequestedPaths(decision);
        for (const requestedPath of requestedPaths) {
            const normalizedPath = normalizeRelativePath(requestedPath);
            if (!normalizedPath) {
                return {
                    executed: true,
                    operation,
                    toolCalls,
                    summary: `Blocked path outside allowed root: ${requestedPath}`,
                    blockedReason: 'outside_allowed_root',
                };
            }
            if (normalizedPath.endsWith('/')) {
                const listResult = await executeAllowedTool(authority, toolCalls, 'fs_list', { path: normalizedPath });
                if (!isToolError(listResult)) {
                    artifacts.push({ path: normalizedPath, kind: 'read' });
                    return {
                        executed: true,
                        operation,
                        toolCalls,
                        artifacts,
                        summary: `Listed ${normalizedPath}\n${listResult.split('\n').slice(0, 20).join('\n')}`,
                    };
                }
                continue;
            }

            const readResult = await readWithFallback(authority, toolCalls, normalizedPath);
            if (readResult) {
                artifacts.push({ path: readResult.path, kind: 'read' });
                return {
                    executed: true,
                    operation,
                    toolCalls,
                    artifacts,
                    summary: `Read ${readResult.path}\n${readResult.content.slice(0, 3000)}`,
                };
            }
        }

        return {
            executed: true,
            operation,
            toolCalls,
            summary: 'Self-inspection request detected, but no matching file could be found after deterministic lookup.',
            blockedReason: 'file_not_found',
        };
    }
}

