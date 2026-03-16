export type SearchScope = 'active_code' | 'docs' | 'config' | 'archive' | 'all';
export type SearchMode = 'auto' | 'exact' | 'symbol' | 'text' | 'filename' | 'path' | 'fuzzy';
export type MatchType = 'symbol_declaration' | 'export_declaration' | 'import_reference' | 'content_exact' | 'filename_exact' | 'path_exact' | 'fuzzy_related';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface SearchQuery {
    rawQuery: string;
    mode: SearchMode;
    scope: SearchScope;
    variants: string[];
    isBoolean?: boolean;
}

export interface FileMetadata {
    path: string;            // Absolute or relative path (we'll standardize on relative to workspace root)
    filename: string;        // Just the basename
    extension: string;       // .ts, .md, etc
    size: number;            // bytes
    mtime: number;           // last modified time
    scope: SearchScope;      // deduced scope (e.g., in docs/ -> 'docs', in archive/ -> 'archive')
    isBinary: boolean;
    isGenerated: boolean;
    isHidden: boolean;
}

export interface SearchMatch {
    filePath: string;
    line?: number;
    column?: number;
    preview: string;
    matchType: MatchType;
    matchedTerm: string;
    score: number;
    scope: SearchScope;
    confidence: ConfidenceLevel;
    partial?: boolean;       // If we only scanned a chunk and found it
}

export interface SearchDiagnostics {
    filesDiscovered: number;
    filesEligible: number;
    filesRanked: number;
    filesSearched: number;
    filesSkippedIgnored: number;
    filesSkippedTooLarge: number;
    filesPartiallyScanned: number;
    timedOut: boolean;
    completeCoverage: boolean;
    elapsedMs: number;
    scope: SearchScope;
    mode: SearchMode;
}

export interface SearchResult {
    matches: SearchMatch[];       // Primary "strong" matches
    weakMatches?: SearchMatch[];  // Suppressed/noisy matches
    relatedFiles?: SearchMatch[]; // Used for fuzzy fallback
    diagnostics: SearchDiagnostics;
    interpretation: string;  // User-facing summary
    suggestedActions?: string[];
}
