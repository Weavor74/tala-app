import { FileMetadata, SearchMatch, SearchQuery } from './SearchTypes';

export class FuzzySearch {
    
    /**
     * Executes heuristic matching against file paths and names.
     * Often used as a fallback if no exact content matches are found, or as secondary scoring.
     */
    public search(metadata: FileMetadata, query: SearchQuery): SearchMatch[] {
        const matches: SearchMatch[] = [];
        const lowerPath = metadata.path.toLowerCase();
        const lowerName = metadata.filename.toLowerCase();
        
        let bestVariant = '';
        let bestScore = 0;
        let matchType: 'filename_exact' | 'path_exact' | 'fuzzy_related' = 'fuzzy_related';

        // 1. Direct Filename Match (Strongest fuzzy signal)
        for (const term of query.variants) {
            const lowerTerm = term.toLowerCase();
            
            if (lowerName === lowerTerm || lowerName === `${lowerTerm}${metadata.extension}`) {
                bestScore = 80;
                matchType = 'filename_exact';
                bestVariant = term;
                break;
            }
            
            if (lowerName.includes(lowerTerm)) {
                if (bestScore < 60) {
                    bestScore = 60;
                    matchType = 'fuzzy_related';
                    bestVariant = term;
                }
            }
        }

        // 2. Path Match (Secondary signal)
        if (bestScore === 0) {
            for (const term of query.variants) {
                const lowerTerm = term.toLowerCase();
                
                if (lowerPath.includes(`/${lowerTerm}/`) || lowerPath.includes(`\\${lowerTerm}\\`)) {
                    bestScore = 40;
                    matchType = 'path_exact';
                    bestVariant = term;
                    break;
                }
                
                if (lowerPath.includes(lowerTerm)) {
                    if (bestScore < 30) {
                        bestScore = 30;
                        matchType = 'fuzzy_related';
                        bestVariant = term;
                    }
                }
            }
        }

        if (bestScore > 0) {
            matches.push({
                filePath: metadata.path,
                preview: `[Matched in path/filename] ${metadata.path}`,
                matchType: matchType,
                matchedTerm: bestVariant,
                score: bestScore,
                scope: metadata.scope,
                confidence: 'low'
            });
        }

        return matches;
    }
}
