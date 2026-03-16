import { FileMetadata, SearchDiagnostics, SearchMatch, SearchMode, SearchQuery, SearchResult, SearchScope } from './SearchTypes';
import { SearchIndexService } from './SearchIndexService';
import { SearchQueryExpander } from './SearchQueryExpander';
import { SymbolSearch } from './SymbolSearch';
import { TextSearch } from './TextSearch';
import { FuzzySearch } from './FuzzySearch';
import { SearchRanker } from './SearchRanker';
import * as fs from 'fs';

export class UniversalSearchService {
    private indexService: SearchIndexService;
    private expander: SearchQueryExpander;
    private symbolSearch: SymbolSearch;
    private textSearch: TextSearch;
    private fuzzySearch: FuzzySearch;
    private ranker: SearchRanker;

    constructor(workspaceDir: string) {
        this.indexService = new SearchIndexService(workspaceDir);
        this.expander = new SearchQueryExpander();
        this.symbolSearch = new SymbolSearch();
        this.textSearch = new TextSearch();
        this.fuzzySearch = new FuzzySearch();
        this.ranker = new SearchRanker();
    }

    /**
     * Executes the staged, mathematically budgeted search over the workspace.
     */
    public async search(rawQuery: string, maxTimeMs: number = 10000): Promise<SearchResult> {
        const globalStartTime = Date.now();
        
        // Stage 1: Discovery & Expansion (Budgets ~15%)
        const query = this.expander.expand(rawQuery);
        let budgetIndexMs = maxTimeMs * 0.15;
        await this.indexService.refreshIndex(budgetIndexMs);

        let filesDiscovered = this.indexService.getCacheSize();
        let filesSearched = 0;
        let filesSkippedIgnored = 0;
        let filesSkippedTooLarge = 0;
        let filesPartiallyScanned = 0;
        let timedOut = false;
        
        const allMetadata = this.indexService.getAllMetadata();
        
        // Filter eligible files based on scope (default Active Code)
        let eligibleFiles = allMetadata.filter(m => {
            if (m.isBinary || m.isGenerated || m.isHidden) return false;
            
            // If explicit scope mapping was implemented in expander, use it. Else default to active code/config
            if (query.scope === 'active_code' && m.scope !== 'active_code' && m.scope !== 'config') return false;
            if (query.scope === 'docs' && m.scope !== 'docs') return false;
            
            return true;
        });

        // Stage 2: High-Confidence Active Scan (Budget ~45%)
        // Prioritize actual TS/JS code files for symbol searches
        const primaryCandidates = eligibleFiles
            .filter(m => m.extension === '.ts' || m.extension === '.tsx' || m.extension === '.js' || m.extension === '.jsx')
            .sort((a, b) => b.mtime - a.mtime); // Prioritize recently modified files

        const secondaryCandidates = eligibleFiles
            .filter(m => !primaryCandidates.includes(m))
            .sort((a, b) => b.mtime - a.mtime);

        let matches: SearchMatch[] = [];
        let relatedFiles: SearchMatch[] = [];
        
        const executeSearchPassAsync = async (candidates: FileMetadata[], budgetMs: number, allowText: boolean, allowSymbol: boolean) => {
            const passStartTime = Date.now();
            let passSearched = 0;
            const BATCH_SIZE = 100;

            for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
                if (Date.now() - passStartTime > budgetMs || Date.now() - globalStartTime > maxTimeMs * 0.9) {
                    timedOut = true;
                    break;
                }

                const batch = candidates.slice(i, i + BATCH_SIZE);
                const batchResults = await Promise.all(batch.map(async (meta) => {
                    if (meta.size > 1024 * 1024) { // over 1MB
                        return { type: 'skip_size' };
                    }

                    try {
                        const content = await fs.promises.readFile(meta.path, 'utf8');
                        let fileMatches: SearchMatch[] = [];

                        // 1. Symbol Search (structural logic)
                        if (allowSymbol && (query.mode === 'symbol' || query.mode === 'auto')) {
                            fileMatches = fileMatches.concat(this.symbolSearch.search(content, meta, query));
                        }

                        // 2. Fallback to literal Text Search if symbol structural parse yielded nothing strong
                        if (allowText && fileMatches.length === 0) {
                            fileMatches = fileMatches.concat(this.textSearch.search(content, meta, query, query.isBoolean || false));
                        }

                        return { type: 'match', matches: fileMatches };
                    } catch (e: any) {
                        return { type: 'skip_error' };
                    }
                }));

                for (const res of batchResults) {
                    if (res.type === 'match' && res.matches) {
                        matches.push(...res.matches);
                        passSearched++;
                    } else if (res.type === 'skip_size') {
                        filesSkippedTooLarge++;
                    } else if (res.type === 'skip_error') {
                        filesSkippedIgnored++;
                    }
                }

                if (timedOut) break;
            }
            filesSearched += passSearched;
        };

        // Execute Primary Pass (45% budget)
        const primaryBudget = maxTimeMs * 0.45;
        await executeSearchPassAsync(primaryCandidates, primaryBudget, true, true);

        // Stage 3: Secondary Candidates Scan (25% budget)
        if (!timedOut) {
            const secondaryBudget = maxTimeMs * 0.25;
            await executeSearchPassAsync(secondaryCandidates, secondaryBudget, true, false); // Mostly just text search for config/markdown
        }

        // Stage 4: Fuzzy / Related Fallback (15% budget)
        // If we found ZERO exact matches, or explicitly requested fuzzy, generate heuristic relations
        if (matches.length === 0) {
            for (const meta of eligibleFiles) {
                if (Date.now() - globalStartTime > maxTimeMs * 0.95) {
                    timedOut = true;
                    break;
                }
                const related = this.fuzzySearch.search(meta, query);
                if (related.length > 0) {
                    relatedFiles.push(...related);
                }
            }
        }

        // Rank and Deduplicate
        const metadataMap = new Map<string, FileMetadata>();
        allMetadata.forEach(m => metadataMap.set(m.path, m));
        
        // Stage 6: Final Ranking and Result Assembly
        const rankedAll = this.ranker.rank(matches, this.indexService.getAllMetadata().reduce((map, obj) => {
            map.set(obj.path, obj);
            return map;
        }, new Map<string, FileMetadata>()));

        // Deduplicate per-file (keep best match in each file)
        const consolidated = this.ranker.deduplicateAndBoost(rankedAll);

        // Result Hygiene Pass:
        // 1. Primary matches: High/Medium confidence (top 5)
        // 2. Weak matches: Low confidence or excess hits
        // 3. Suppression: Filter out truly weak noise (score < 45)
        
        const primaryMatches = consolidated
            .filter(m => m.confidence === 'high' || m.confidence === 'medium')
            .filter(m => m.score >= 45)
            .slice(0, 5);

        const weakMatches = consolidated
            .filter(m => !primaryMatches.includes(m))
            .filter(m => m.score >= 40) // Still keep some low confidence ones for diagnostics
            .slice(0, 10);

        // Re-rank related files if any
        if (relatedFiles.length > 0) {
            relatedFiles = this.ranker.rank(relatedFiles, metadataMap);
            relatedFiles = this.ranker.deduplicateAndBoost(relatedFiles).slice(0, 5); // Max out at top 5 fuzzy related
        }

        const interpretation = this.interpretResults(primaryMatches, timedOut, query);

        return {
            matches: primaryMatches,
            weakMatches: weakMatches,
            relatedFiles: relatedFiles,
            diagnostics: {
                filesDiscovered,
                filesEligible: eligibleFiles.length,
                filesRanked: consolidated.length,
                filesSearched,
                filesSkippedIgnored,
                filesSkippedTooLarge,
                filesPartiallyScanned: 0,
                timedOut,
                completeCoverage: !timedOut,
                elapsedMs: Date.now() - globalStartTime,
                scope: query.scope,
                mode: query.mode
            },
            interpretation
        };
    }

    private interpretResults(primaryMatches: SearchMatch[], timedOut: boolean, query: SearchQuery): string {
        let interpretation = '';
        const completeCoverage = !timedOut;

        if (primaryMatches.length > 0) {
            if (primaryMatches[0].matchType === 'symbol_declaration' || primaryMatches[0].matchType === 'export_declaration') {
                interpretation = `Exact declaration found in ${primaryMatches[0].filePath}.`;
            } else {
                interpretation = `References or text matches found.`;
                if (!completeCoverage) interpretation += ` (Note: The search timed out before scanning all eligible files, there may be exact declarations elsewhere.)`;
            }
        } else {
            interpretation = `No exact matches found for "${query.rawQuery}" in scanned files.`;
            if (!completeCoverage) {
                interpretation += ` Search did not complete total coverage.`;
            } else {
                interpretation += ` The symbol or text does not exist in the active codebase. It may have been renamed, moved, or deleted.`;
            }
        }

        return interpretation;
    }
}
