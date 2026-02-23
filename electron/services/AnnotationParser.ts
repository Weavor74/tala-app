import fs from 'fs';
import path from 'path';

/**
 * AnnotationParser
 * 
 * Scans source files for inline Tala annotations — special comments that
 * provide instructions, context, or directives to Tala when she reads the file.
 * 
 * ## Supported Formats
 * 
 * The annotation prefix is `@tala:` (case-insensitive) and can appear in any
 * comment style:
 * 
 * ```
 * // @tala: This function is performance-critical, avoid adding allocations
 * # @tala: Keep this config stable, it's shared across 12 services
 * /* @tala: This module is deprecated, prefer utils/v2.ts instead *​/
 * <!-- @tala: Do not modify the header section -->
 * ```
 * 
 * ## Annotation Tags (Optional)
 * 
 * Tags refine the intent of an annotation:
 * 
 * | Tag | Purpose | Example |
 * |---|---|---|
 * | `@tala:` | General instruction | `@tala: Prefer async/await over .then()` |
 * | `@tala:context` | Background knowledge | `@tala:context This uses a custom ORM` |
 * | `@tala:warn` | Safety/caution | `@tala:warn Do not remove the null check` |
 * | `@tala:todo` | Actionable task | `@tala:todo Refactor this into a class` |
 * | `@tala:reflect` | Reflection system hint | `@tala:reflect Error rate is high here` |
 * | `@tala:ignore` | Skip this file/section | `@tala:ignore Don't analyze this block` |
 * | `@tala:pin` | Always include in context | `@tala:pin Critical business rule` |
 * 
 * @capability [CAPABILITY 6.1] Inline Annotations
 */

/** Represents a single parsed annotation from a source file. */
export interface TalaAnnotation {
    /** 1-indexed line number where the annotation appears. */
    line: number;
    /** The raw annotation text (after the @tala: prefix). */
    text: string;
    /** Optional tag (e.g., 'context', 'warn', 'todo', 'reflect', 'ignore', 'pin'). */
    tag: string;
    /** The full original line from the source file. */
    sourceLine: string;
}

/** Summary of all annotations found in a file. */
export interface AnnotationResult {
    /** Absolute path to the file. */
    filePath: string;
    /** All annotations found. */
    annotations: TalaAnnotation[];
    /** Whether the file contains an @tala:ignore directive. */
    hasIgnore: boolean;
    /** Pinned annotations (always included in context). */
    pinned: TalaAnnotation[];
    /** Warning annotations. */
    warnings: TalaAnnotation[];
    /** Todo/task annotations. */
    todos: TalaAnnotation[];
    /** Reflection hints. */
    reflectionHints: TalaAnnotation[];
}

/**
 * Regex to match @tala: annotations in any comment style.
 * 
 * Captures:
 * - Group 1: optional tag (context, warn, todo, reflect, ignore, pin)
 * - Group 2: the annotation text
 * 
 * Supports: //, #, /*, *​/, <!--, -->, and bare line prefixes
 */
const ANNOTATION_REGEX = /(?:\/\/|#|\/\*|\*|<!--)\s*@tala(?::(\w+))?\s*[:\-]?\s*(.+?)(?:\s*\*\/|\s*-->)?$/i;

export class AnnotationParser {
    /**
     * Parses a file for @tala: annotations.
     */
    static parseFile(filePath: string): AnnotationResult {
        const result: AnnotationResult = {
            filePath,
            annotations: [],
            hasIgnore: false,
            pinned: [],
            warnings: [],
            todos: [],
            reflectionHints: []
        };

        if (!fs.existsSync(filePath)) return result;

        // Skip binary files and large files (> 500KB)
        const stats = fs.statSync(filePath);
        if (stats.size > 512 * 1024) {
            console.debug(`[AnnotationParser] Skipping large file: ${filePath} (${Math.round(stats.size / 1024)}KB)`);
            return result;
        }

        const ext = path.extname(filePath).toLowerCase();
        const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib'];
        if (binaryExts.includes(ext)) return result;

        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const match = line.match(ANNOTATION_REGEX);
                if (!match) continue;

                const tag = (match[1] || '').toLowerCase();
                const text = match[2].trim();

                const annotation: TalaAnnotation = {
                    line: i + 1,
                    text,
                    tag: tag || 'general',
                    sourceLine: line.trim()
                };

                result.annotations.push(annotation);

                // Categorize
                switch (tag) {
                    case 'ignore':
                        result.hasIgnore = true;
                        break;
                    case 'pin':
                        result.pinned.push(annotation);
                        break;
                    case 'warn':
                        result.warnings.push(annotation);
                        break;
                    case 'todo':
                        result.todos.push(annotation);
                        break;
                    case 'reflect':
                        result.reflectionHints.push(annotation);
                        break;
                }
            }
        } catch (e: any) {
            // Silently skip unreadable files
            console.debug(`[AnnotationParser] Skipped ${filePath}: ${e.message}`);
        }

        return result;
    }

    /**
     * Parses a string of file content (when you already have the content in memory).
     */
    static parseContent(content: string, filePath: string = '<buffer>'): AnnotationResult {
        const result: AnnotationResult = {
            filePath,
            annotations: [],
            hasIgnore: false,
            pinned: [],
            warnings: [],
            todos: [],
            reflectionHints: []
        };

        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(ANNOTATION_REGEX);
            if (!match) continue;

            const tag = (match[1] || '').toLowerCase();
            const text = match[2].trim();

            const annotation: TalaAnnotation = {
                line: i + 1,
                text,
                tag: tag || 'general',
                sourceLine: line.trim()
            };

            result.annotations.push(annotation);

            switch (tag) {
                case 'ignore':
                    result.hasIgnore = true;
                    break;
                case 'pin':
                    result.pinned.push(annotation);
                    break;
                case 'warn':
                    result.warnings.push(annotation);
                    break;
                case 'todo':
                    result.todos.push(annotation);
                    break;
                case 'reflect':
                    result.reflectionHints.push(annotation);
                    break;
            }
        }

        return result;
    }

    /**
     * Formats annotations into a context block for LLM injection.
     * Returns empty string if no annotations found.
     */
    static formatForContext(result: AnnotationResult): string {
        if (result.annotations.length === 0) return '';
        if (result.hasIgnore) return ''; // File wants to be ignored

        const lines: string[] = [];
        lines.push(`[INLINE ANNOTATIONS — ${path.basename(result.filePath)}]`);

        for (const ann of result.annotations) {
            if (ann.tag === 'ignore') continue;
            const prefix = ann.tag !== 'general' ? `[${ann.tag.toUpperCase()}] ` : '';
            lines.push(`  L${ann.line}: ${prefix}${ann.text}`);
        }

        return lines.join('\n');
    }

    /**
     * Scans an entire directory tree for files with @tala annotations.
     * Useful for building a project-wide annotation summary.
     */
    static scanDirectory(dirPath: string, maxDepth: number = 2): AnnotationResult[] {
        const results: AnnotationResult[] = [];
        const skipDirs = new Set(['node_modules', '.git', 'dist', 'dist-electron', '__pycache__', '.next', 'coverage', 'data', 'bin', '.gemini', 'tmp', 'venv', 'env', 'build']);

        const walk = (dir: string, depth: number) => {
            if (depth > maxDepth) return;

            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const lowName = entry.name.toLowerCase();
                    if (skipDirs.has(lowName)) continue;
                    if (entry.name.startsWith('.')) continue; // Skip hidden dirs (except .tala if we add it)

                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        walk(fullPath, depth + 1);
                    } else if (entry.isFile()) {
                        const parsed = AnnotationParser.parseFile(fullPath);
                        if (parsed.annotations.length > 0) {
                            results.push(parsed);
                        }
                    }
                }
            } catch { /* skip unreadable dirs */ }
        };

        walk(dirPath, 0);
        return results;
    }

    /**
     * Generates a project-wide annotation summary for context injection.
     */
    static generateProjectSummary(dirPath: string): string {
        const results = AnnotationParser.scanDirectory(dirPath);
        if (results.length === 0) return '';

        const lines: string[] = ['[PROJECT ANNOTATIONS]'];
        let totalAnnotations = 0;
        let totalWarnings = 0;
        let totalTodos = 0;

        for (const result of results) {
            totalAnnotations += result.annotations.length;
            totalWarnings += result.warnings.length;
            totalTodos += result.todos.length;

            // Only show pinned and warnings in project summary (to save tokens)
            const important = [...result.pinned, ...result.warnings];
            if (important.length > 0) {
                const relPath = path.relative(dirPath, result.filePath).replace(/\\/g, '/');
                lines.push(`  ${relPath}:`);
                for (const ann of important) {
                    const prefix = ann.tag !== 'general' ? `[${ann.tag.toUpperCase()}] ` : '';
                    lines.push(`    L${ann.line}: ${prefix}${ann.text}`);
                }
            }
        }

        lines.push(`  — ${totalAnnotations} annotation(s) across ${results.length} file(s), ${totalWarnings} warning(s), ${totalTodos} todo(s)`);
        return lines.join('\n');
    }
}
