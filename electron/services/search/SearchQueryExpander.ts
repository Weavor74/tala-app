import { SearchMode, SearchQuery, SearchScope } from './SearchTypes';

export class SearchQueryExpander {
    
    /**
     * Analyzes the raw query and infers the best SearchMode and SearchScope,
     * while producing a ranked array of query variants to search for.
     */
    public expand(rawQuery: string): SearchQuery {
        const query = rawQuery.trim();
        let mode: SearchMode = 'auto';
        let scope: SearchScope = 'active_code'; // Default
        
        let isBoolean = false;
        
        // 1. Infer Mode
        if (query.startsWith('"') && query.endsWith('"')) {
            mode = 'exact';
            isBoolean = true;
        } else if (query.includes('/') || query.includes('\\')) {
            mode = 'path';
        } else if (query.match(/^[a-z_][a-z0-9_]*\.[a-z0-9]+$/i)) {
            // e.g. "ArtifactRouter.ts" or "utils.js"
            mode = 'filename';
        } else if (query.match(/^[A-Z][A-Za-z0-9]*$/) || query.match(/^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/)) {
            // PascalCase or camelCase => likely symbol
            mode = 'symbol';
        } else if (query.split(/\s+/).length > 2) {
            mode = 'text';
        }

        // 2. Generate Variants
        const variants = new Set<string>();
        
        if (mode === 'exact') {
            variants.add(query.replace(/^"|"$/g, ''));
        } else {
            // Always include the exact raw string first
            variants.add(query);
            
            // Generate casing variants for symbols or mixed queries
            if (mode === 'symbol' || mode === 'auto') {
                // Lowercase
                variants.add(query.toLowerCase());
                
                // If it's PascalCase/camelCase, split into words: "ArtifactRouter" -> "Artifact Router", "artifact_router", "artifact-router"
                const words = query.replace(/([A-Z])/g, ' $1').trim().split(/\s+/).filter(w => w.length > 0);
                if (words.length > 1) {
                    const asWords = words.join(' ').toLowerCase();
                    variants.add(asWords);
                    variants.add(words.join('_').toLowerCase());
                    variants.add(words.join('-').toLowerCase());
                    
                    // Add individual strong tokens
                    for (const w of words) {
                        if (w.length > 3) variants.add(w.toLowerCase());
                    }
                }
            }
            
            // If it's a filename with extension
            if (mode === 'filename') {
                const parts = query.split('.');
                const base = parts.slice(0, -1).join('.');
                if (base.length > 0) {
                    variants.add(base);
                    const words = base.replace(/([A-Z])/g, ' $1').trim().split(/\s+/).filter(w => w.length > 0);
                    if (words.length > 1) {
                        variants.add(words.join(' ').toLowerCase());
                        variants.add(words.join('_').toLowerCase());
                    }
                }
            }
            
            // If it's a full path
            if (mode === 'path') {
                const basename = query.split(/[/\\]/).pop();
                if (basename) variants.add(basename);
            }
        }
        
        // Ensure no empty strings
        const filteredVariants = Array.from(variants).filter(v => v.trim().length > 0);

        return {
            rawQuery: query,
            mode,
            scope,
            variants: filteredVariants,
            isBoolean
        };
    }
}
