/**
 * TALA LOG REDACTION UTILITY
 * ==========================
 * Purpose: Scrubs sensitive information (API keys, tokens, auth headers)
 * before they are written to the audit log.
 */

const SENSITIVE_KEYS = [
    'apiKey', 'api_key', 'api-key', 'key',
    'token', 'access_token', 'refresh_token',
    'Authorization', 'auth', 'password', 'secret',
    'private_key', 'client_secret', 'gemini_api_key', 'ollama_key'
];

/**
 * Redacts sensitive values in an object or array recursively.
 * @param data The object to redact.
 * @returns A new object with sensitive values replaced by "***".
 */
export function redact(data: any): any {
    if (data === null || data === undefined) return data;

    if (Array.isArray(data)) {
        return data.map(item => redact(item));
    }

    if (typeof data === 'object') {
        const result: any = {};
        for (const [key, value] of Object.entries(data)) {
            if (SENSITIVE_KEYS.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
                result[key] = '***';
            } else {
                result[key] = redact(value);
            }
        }
        return result;
    }

    // Handle strings that might contain patterns (optional but safer)
    if (typeof data === 'string') {
        // Simple regex for Bearer tokens or common API key formats if needed
        // For now, we rely on key-based redaction as requested.
        return data;
    }

    return data;
}
