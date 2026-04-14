import type { ValidatorProviderKind } from './guardrailPolicyTypes';

export interface LocalGuardrailsValidatorCatalogEntry {
    id: string;
    providerKind: ValidatorProviderKind;
    label: string;
    validatorName: string;
    defaultArgs: Record<string, unknown>;
    notes?: string;
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
    },
];
