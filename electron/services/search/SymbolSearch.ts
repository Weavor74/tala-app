import { FileMetadata, MatchType, SearchMatch, SearchQuery } from './SearchTypes';
import * as fs from 'fs';

export class SymbolSearch {
    
    /**
     * Executes a fast, structural regex-based search for symbols against the file content.
     * Extracts declarations, exports, and imports.
     */
    public search(content: string, metadata: FileMetadata, query: SearchQuery): SearchMatch[] {
        const matches: SearchMatch[] = [];
        
        // Fast Pre-check: Avoid splitting lines if the terms aren't even present in the blob
        const terms = query.variants;
        const lowerContent = content.toLowerCase();
        const relevantTerms = terms.filter(t => lowerContent.includes(t.toLowerCase()));
        
        if (relevantTerms.length === 0) return matches;

        const lines = content.split('\n');

        // Combined Regex for common declarations to reduce iterations
        const declRegexStr = `(?:class|function|interface|type|const|let|var)\\s+(${relevantTerms.map(this.escapeRegExp).join('|')})\\b`;
        const declRegex = new RegExp(declRegexStr, 'i');
        
        const methodRegexStr = `\\b(${relevantTerms.map(this.escapeRegExp).join('|')})\\s*\\(`;
        const methodRegex = new RegExp(methodRegexStr, 'i');

        const importRegexStr = `import\\s+.*\\b(${relevantTerms.map(this.escapeRegExp).join('|')})\\b.*from`;
        const importRegex = new RegExp(importRegexStr, 'i');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.length === 0 || trimmed.startsWith('//')) continue;

            // 1. Declaration check
            const declMatch = trimmed.match(declRegex) || trimmed.match(methodRegex);
            if (declMatch) {
                const term = declMatch[1];
                const isExactCase = trimmed.includes(term);
                const isExport = trimmed.startsWith('export ');
                matches.push({
                    filePath: metadata.path,
                    line: i + 1,
                    preview: trimmed.substring(0, 150),
                    matchType: isExport ? 'export_declaration' : 'symbol_declaration',
                    matchedTerm: term,
                    score: (isExport ? 100 : 90) + (isExactCase ? 10 : 0),
                    scope: metadata.scope,
                    confidence: isExactCase ? 'high' : 'medium'
                });
                continue;
            }

            // 2. Import Reference check
            const importMatch = trimmed.match(importRegex);
            if (importMatch) {
                const term = importMatch[1];
                const isExactCase = trimmed.includes(term);
                matches.push({
                    filePath: metadata.path,
                    line: i + 1,
                    preview: trimmed.substring(0, 150),
                    matchType: 'import_reference',
                    matchedTerm: term,
                    score: 70 + (isExactCase ? 10 : 0),
                    scope: metadata.scope,
                    confidence: 'medium'
                });
                continue;
            }
        }

        return matches;
    }

    private escapeRegExp(string: string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
