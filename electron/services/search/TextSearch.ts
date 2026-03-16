import { FileMetadata, SearchMatch, SearchQuery } from './SearchTypes';

export class TextSearch {
    
    /**
     * Executes a fast, literal or chunked text search against file content.
     */
    public search(content: string, metadata: FileMetadata, query: SearchQuery, isBoolean: boolean): SearchMatch[] {
        const matches: SearchMatch[] = [];
        
        let targetTerms = query.variants;
        if (isBoolean) {
            // "exact phrase" means only search the raw phrase without variants
            targetTerms = [query.rawQuery.replace(/^"|"$/g, '')];
        }

        const lowerContent = content.toLowerCase();
        
        for (const term of targetTerms) {
            const lowerTerm = term.toLowerCase();
            const index = lowerContent.indexOf(lowerTerm);
            
            if (index !== -1) {
                // Determine line number by counting newlines up to the match index
                // This is much faster than splitting the entire file
                const upToMatch = content.substring(0, index);
                let lineNum = 1;
                for (let i = 0; i < upToMatch.length; i++) {
                    if (upToMatch[i] === '\n') lineNum++;
                }

                // Get a preview snippet - only split the relevant portion if needed
                const startOfLine = upToMatch.lastIndexOf('\n') + 1;
                let endOfLine = content.indexOf('\n', index);
                if (endOfLine === -1) endOfLine = content.length;
                
                const snippet = content.substring(startOfLine, endOfLine).trim().substring(0, 150);
                
                // Boost if matching the exact case of the term
                const actualMatch = content.substring(index, index + term.length);
                const isExactCase = actualMatch === term;

                matches.push({
                    filePath: metadata.path,
                    line: lineNum,
                    preview: snippet,
                    matchType: 'content_exact',
                    matchedTerm: term,
                    score: 50 + (isExactCase ? 10 : 0),
                    scope: metadata.scope,
                    confidence: isExactCase ? 'medium' : 'low'
                });
                
                break; // Stop checking other variants if we got a solid content hit
            }
        }

        return matches;
    }
}
