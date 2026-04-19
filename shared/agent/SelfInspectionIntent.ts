export type SelfInspectionOperation = 'read' | 'edit' | 'search' | 'list' | 'unknown';
export type SelfInspectionTargetScope =
    | 'root'
    | 'docs'
    | 'readme'
    | 'workspace'
    | 'memory'
    | 'unknown';

export type SelfInspectionDecision = {
    isSelfInspectionRequest: boolean;
    confidence: number;
    reasonCodes: string[];
    requestedPaths?: string[];
    requestedOperation: SelfInspectionOperation;
    targetScope: SelfInspectionTargetScope;
};

const GREETING_ONLY_PATTERN = /^(hi|hello|hey|yo|good (morning|afternoon|evening)|how are you|what's up)[!. ]*$/i;
const EDIT_VERBS = /\b(update|modify|edit|rewrite|patch|change|create|write)\b/i;
const SEARCH_VERBS = /\b(search|find|lookup|scan|grep)\b/i;
const LIST_VERBS = /\b(list|show|enumerate|directory|files?)\b/i;
const READ_VERBS = /\b(read|open|inspect|check|review)\b/i;
const SELF_SYSTEM_TERMS =
    /\b(your local|your files?|your docs?|your readme|your config|your systems?|your workspace|your root|local files?|workspace|root directory)\b/i;
const FILE_HINT_PATTERN =
    /(?:^|[\s"'`])(README\.md|readme\.md|package\.json|tsconfig(?:\.[a-z0-9]+)?\.json|docs[\\/][^\s"'`]+|src[\\/][^\s"'`]+|[a-z0-9_.\-\\/]+\.(?:md|txt|json|ya?ml|ts|tsx|js|jsx|mjs|cjs))(?=$|[\s"'`.,;!?])/gi;

function inferOperation(text: string): SelfInspectionOperation {
    if (/\b(local files?|your files?|workspace files?)\b/i.test(text)) return 'list';
    if (EDIT_VERBS.test(text)) return 'edit';
    if (SEARCH_VERBS.test(text)) return 'search';
    if (LIST_VERBS.test(text)) return 'list';
    if (READ_VERBS.test(text)) return 'read';
    return 'unknown';
}

function inferTargetScope(text: string): SelfInspectionTargetScope {
    if (/\breadme(\.md)?\b/i.test(text)) return 'readme';
    if (/\bdocs?\b|documentation/i.test(text)) return 'docs';
    if (/\bmemory\b/i.test(text)) return 'memory';
    if (/\bworkspace\b/i.test(text)) return 'workspace';
    if (/\broot\b/i.test(text)) return 'root';
    return 'unknown';
}

function extractRequestedPaths(text: string): string[] {
    const found = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = FILE_HINT_PATTERN.exec(text)) !== null) {
        const raw = match[1].trim().replace(/\\/g, '/');
        if (!raw) continue;
        if (raw.toLowerCase() === 'readme.md') {
            found.add('README.md');
        } else {
            found.add(raw);
        }
    }
    if (/\breadme\b/i.test(text) && ![...found].some((value) => value.toLowerCase() === 'readme.md')) {
        found.add('README.md');
    }
    if (/\bpackage\.json\b/i.test(text) && !found.has('package.json')) {
        found.add('package.json');
    }
    return [...found];
}

export function resolveSelfInspectionRequest(input: {
    text: string;
    mode?: string;
}): SelfInspectionDecision {
    const text = input.text ?? '';
    const normalized = text.trim();
    if (!normalized) {
        return {
            isSelfInspectionRequest: false,
            confidence: 0,
            reasonCodes: ['self_inspection.empty_text'],
            requestedOperation: 'unknown',
            targetScope: 'unknown',
        };
    }

    const greetingOnly = GREETING_ONLY_PATTERN.test(normalized);
    const hasSelfSystemSemantics = SELF_SYSTEM_TERMS.test(normalized);
    const requestedPaths = extractRequestedPaths(normalized);
    const operation = inferOperation(normalized);
    const targetScope = inferTargetScope(normalized);

    const reasonCodes: string[] = [];
    let score = 0;

    if (hasSelfSystemSemantics) {
        score += 2;
        reasonCodes.push('self_inspection.self_system_terms');
    }
    if (requestedPaths.length > 0) {
        score += 2;
        reasonCodes.push('self_inspection.concrete_path_detected');
    }
    if (operation !== 'unknown') {
        score += 1;
        reasonCodes.push(`self_inspection.operation:${operation}`);
    }
    if (targetScope !== 'unknown') {
        score += 1;
        reasonCodes.push(`self_inspection.scope:${targetScope}`);
    }
    if (/\byour systems?\b|\bcapabilities\b/i.test(normalized)) {
        score += 1;
        reasonCodes.push('self_inspection.system_capability_query');
    }
    if (greetingOnly && !hasSelfSystemSemantics && requestedPaths.length === 0) {
        reasonCodes.push('self_inspection.greeting_only_rejected');
        return {
            isSelfInspectionRequest: false,
            confidence: 0,
            reasonCodes,
            requestedOperation: operation,
            targetScope,
            requestedPaths: requestedPaths.length > 0 ? requestedPaths : undefined,
        };
    }

    const isSelfInspectionRequest = score >= 2 && (hasSelfSystemSemantics || requestedPaths.length > 0 || targetScope !== 'unknown');
    const confidence = Math.max(0, Math.min(1, score / 6));
    if (!isSelfInspectionRequest) {
        reasonCodes.push('self_inspection.threshold_not_met');
    }

    return {
        isSelfInspectionRequest,
        confidence,
        reasonCodes,
        requestedOperation: operation,
        targetScope,
        requestedPaths: requestedPaths.length > 0 ? requestedPaths : undefined,
    };
}

export const detectSelfInspectionRequest = resolveSelfInspectionRequest;
