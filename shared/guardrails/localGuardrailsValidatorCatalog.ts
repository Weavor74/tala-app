import type { ValidatorProviderKind } from './guardrailPolicyTypes';

export type LocalGuardrailsArgType = 'string' | 'number' | 'boolean' | 'string_array';

export interface LocalGuardrailsValidatorArgSchema {
    key: string;
    label: string;
    type: LocalGuardrailsArgType;
    defaultValue: string | number | boolean | string[];
    description?: string;
    min?: number;
    max?: number;
}

export interface LocalGuardrailsValidatorCatalogEntry {
    id: string;
    providerKind: ValidatorProviderKind;
    label: string;
    validatorName: string;
    defaultArgs: Record<string, unknown>;
    notes?: string;
    argsSchema?: LocalGuardrailsValidatorArgSchema[];
}

export const LOCAL_GUARDRAILS_VALIDATOR_CATALOG: LocalGuardrailsValidatorCatalogEntry[] = [
    {
        id: 'gr-toxic-language',
        providerKind: 'local_guardrails_ai',
        label: 'Toxic Language',
        validatorName: 'ToxicLanguage',
        defaultArgs: {
            threshold: 0.5,
        },
        notes: 'Detects toxic content in free-form text.',
        argsSchema: [
            {
                key: 'threshold',
                label: 'Threshold',
                type: 'number',
                defaultValue: 0.5,
                min: 0,
                max: 1,
                description: 'Higher values are stricter.',
            },
        ],
    },
    {
        id: 'gr-detect-pii',
        providerKind: 'local_guardrails_ai',
        label: 'Detect PII',
        validatorName: 'DetectPII',
        defaultArgs: {
            pii_entities: ['EMAIL_ADDRESS', 'PHONE_NUMBER', 'PERSON'],
        },
        notes: 'Flags likely personally identifiable information.',
        argsSchema: [
            {
                key: 'pii_entities',
                label: 'PII Entities',
                type: 'string_array',
                defaultValue: ['EMAIL_ADDRESS', 'PHONE_NUMBER', 'PERSON'],
                description: 'Comma-separated entity type list.',
            },
        ],
    },
    {
        id: 'gr-profanity-free',
        providerKind: 'local_guardrails_ai',
        label: 'Profanity Free',
        validatorName: 'ProfanityFree',
        defaultArgs: {},
        notes: 'Detects profanity and unsafe phrasing.',
    },
    {
        id: 'gr-valid-length',
        providerKind: 'local_guardrails_ai',
        label: 'Valid Length',
        validatorName: 'ValidLength',
        defaultArgs: {
            min: 1,
            max: 4000,
        },
        notes: 'Ensures content falls within min/max length bounds.',
        argsSchema: [
            {
                key: 'min',
                label: 'Minimum Length',
                type: 'number',
                defaultValue: 1,
                min: 0,
            },
            {
                key: 'max',
                label: 'Maximum Length',
                type: 'number',
                defaultValue: 4000,
                min: 1,
            },
        ],
    },
    {
        id: 'gr-regex-match',
        providerKind: 'local_guardrails_ai',
        label: 'Regex Match',
        validatorName: 'RegexMatch',
        defaultArgs: {
            regex: '^.*$',
        },
        notes: 'Matches content against a configured regex.',
        argsSchema: [
            {
                key: 'regex',
                label: 'Regex',
                type: 'string',
                defaultValue: '^.*$',
                description: 'Python-compatible regular expression.',
            },
        ],
    },
];

export function getLocalGuardrailsCatalogEntryByValidatorName(
    validatorName?: string,
): LocalGuardrailsValidatorCatalogEntry | undefined {
    if (!validatorName) return undefined;
    const needle = validatorName.trim();
    if (!needle) return undefined;
    return LOCAL_GUARDRAILS_VALIDATOR_CATALOG.find(entry => entry.validatorName === needle);
}

function normalizeArgValue(
    schema: LocalGuardrailsValidatorArgSchema,
    input: unknown,
): string | number | boolean | string[] {
    const fallback = schema.defaultValue;
    if (input === undefined || input === null) return fallback;

    if (schema.type === 'string') {
        return typeof input === 'string' ? input : String(input);
    }

    if (schema.type === 'number') {
        const n = typeof input === 'number' ? input : Number(input);
        if (!Number.isFinite(n)) return fallback;
        const min = schema.min ?? Number.NEGATIVE_INFINITY;
        const max = schema.max ?? Number.POSITIVE_INFINITY;
        if (n < min) return min;
        if (n > max) return max;
        return n;
    }

    if (schema.type === 'boolean') {
        if (typeof input === 'boolean') return input;
        if (typeof input === 'string') {
            const lowered = input.trim().toLowerCase();
            if (lowered === 'true') return true;
            if (lowered === 'false') return false;
        }
        return Boolean(input);
    }

    // string_array
    if (Array.isArray(input)) {
        return input.map(v => String(v)).map(v => v.trim()).filter(Boolean);
    }
    if (typeof input === 'string') {
        return input.split(',').map(s => s.trim()).filter(Boolean);
    }
    return fallback;
}

export function applyLocalGuardrailsCatalogDefaults(
    validatorName: string | undefined,
    rawArgs: Record<string, unknown> | undefined,
): Record<string, unknown> {
    const entry = getLocalGuardrailsCatalogEntryByValidatorName(validatorName);
    if (!entry) {
        return { ...(rawArgs ?? {}) };
    }

    const incoming = rawArgs ?? {};
    const normalized: Record<string, unknown> = {
        ...entry.defaultArgs,
        ...incoming,
    };

    for (const schema of entry.argsSchema ?? []) {
        normalized[schema.key] = normalizeArgValue(schema, incoming[schema.key]);
    }

    return normalized;
}
