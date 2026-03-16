import { FileMetadata, SearchMatch } from './SearchTypes';

export class SearchRanker {
    
    /**
     * Ranks a collection of matches. Higher score = better match.
     * Takes into account the MatchType, file metadata (location, scope), and explicit priorities.
     */
    public rank(matches: SearchMatch[], metadataMap: Map<string, FileMetadata>): SearchMatch[] {
        for (const match of matches) {
            const meta = metadataMap.get(match.filePath);
            if (!meta) continue;

            // Base score is already assigned by the search engine (e.g. 100 for export decl, 90 for decl, 50 for content)
            
            // Boost: In active authored files rather than huge generated blobs
            if (!meta.isGenerated && !meta.isBinary && meta.size > 0 && meta.size < 100 * 1024) {
                match.score += 5;
            }

            // Boost: In core directories
            const p = meta.path.toLowerCase();
            if (p.startsWith('src/') || p.startsWith('electron/') || p.startsWith('main/') || p.startsWith('renderer/')) {
                match.score += 10;
            }
            if (p.includes('services/') || p.includes('lib/')) {
                match.score += 5;
            }

            // Penalty: Docs in active code search (handled partly by scope filtering, but just in case)
            if (meta.scope === 'docs') {
                match.score -= 20;
            }
            
            // Penalty: Archive
            if (meta.scope === 'archive') {
                match.score -= 50;
            }

            // Penalty: Huge files (>1MB) get deranked unless it's a very strong hit
            if (meta.size > 1024 * 1024 && match.matchType !== 'export_declaration' && match.matchType !== 'symbol_declaration') {
                match.score -= 15;
            }
            
            // Penalty: Fuzzy fallback only
            if (match.matchType === 'fuzzy_related') {
                match.score -= 30; // Push fuzzy hits below almost all exact content hits
            }

            // Final confidence assignment based on final boosted scores
            if (match.score >= 100) {
                match.confidence = 'high';
            } else if (match.score >= 70) {
                match.confidence = 'medium';
            } else {
                match.confidence = 'low';
            }
        }

        // Sort descending
        return matches.sort((a, b) => {
            // Priority 1: Score
            if (b.score !== a.score) return b.score - a.score;
            
            // Priority 2: Exact Filename Match (alphabetical tiebreaker)
            if (a.matchType === 'filename_exact' && b.matchType !== 'filename_exact') return -1;
            if (a.matchType !== 'filename_exact' && b.matchType === 'filename_exact') return 1;

            // Priority 3: Alphabetical by path
            return a.filePath.localeCompare(b.filePath);
        });
    }

    /**
     * Groups multiple matches per file by taking the highest scoring match as the primary, 
     * but boosting its score if the file has multiple independent signals.
     */
    public deduplicateAndBoost(matches: SearchMatch[]): SearchMatch[] {
        const fileMap = new Map<string, SearchMatch[]>();
        
        for (const m of matches) {
            if (!fileMap.has(m.filePath)) fileMap.set(m.filePath, []);
            fileMap.get(m.filePath)!.push(m);
        }

        const consolidated: SearchMatch[] = [];

        for (const [path, fileMatches] of fileMap.entries()) {
            // Sort to find best match in the file
            fileMatches.sort((a, b) => b.score - a.score);
            const primary = fileMatches[0];
            
            // If there's multiple hits in the file, modestly boost the primary score
            // e.g., if a file has the declaration AND 5 uses, it's slightly better than just a declaration
            if (fileMatches.length > 1) {
                primary.score += Math.min(10, fileMatches.length); // Max +10 boost for frequency
            }

            consolidated.push(primary);
        }

        // Re-sort the consolidated list
        return consolidated.sort((a, b) => b.score - a.score);
    }
}
