/**
 * Canonical provider identity constants shared between SettingsManager and
 * ExternalApiSearchProvider.
 *
 * Keeping these in one place prevents the two normalization paths from
 * diverging:
 *   - SettingsManager applies LEGACY_PROVIDER_ID_MAP at settings-load time
 *     (normalizeProviderEntry).
 *   - ExternalApiSearchProvider.canonicalizeProviderId() applies the same map
 *     at provider-resolution time.
 *
 * If a new legacy alias needs to be supported, add it here once.
 */

/**
 * Maps legacy provider IDs (stored in older settings) to canonical IDs.
 * e.g. "default-brave" → "brave"
 */
export const LEGACY_PROVIDER_ID_MAP: Record<string, string> = {
    'default-brave': 'brave',
    'default-google': 'google',
    'default-serper': 'serper',
    'default-tavily': 'tavily',
};

/**
 * Maps each known canonical provider ID to its required type field.
 * Used to detect and correct id/type mismatches (e.g. {id:'google', type:'brave'})
 * that would otherwise silently route requests to the wrong endpoint.
 */
export const CANONICAL_PROVIDER_TYPE_MAP: Record<string, string> = {
    'brave': 'brave',
    'google': 'google',
    'serper': 'serper',
    'tavily': 'tavily',
};
