# Service: GuardrailService.ts

**Source**: [electron\services\GuardrailService.ts](../../electron/services/GuardrailService.ts)

## Class: `GuardrailService`

## Overview
GuardrailService.ts A GuardrailsAI-compatible guardrail system for Tala. Implements the Guard + Validator architecture from https://guardrailsai.com/ ── Key Concepts ────────────────────────────────────────────────  • Validator  – A single check (e.g. ToxicLanguage, DetectPII).                 Returns PassResult or FailResult.                 On fail, applies an on_fail policy.  • Guard      – A named stack of Validators.                 Can be applied to: agent input, agent output, workflow nodes.                 Can be exported as a self-contained Python script using                 the real `guardrails-ai` SDK. ── On-Fail Policies ────────────────────────────────────────────  • noop       – Log the failure, pass text through unchanged.  • fix        – Attempt to auto-fix (redact / truncate).  • filter     – Remove the offending segment.  • refrain    – Return empty string instead of violating text.  • exception  – Throw a GuardrailError (blocks the pipeline). ── Built-in Validators (matching GuardrailsAI Hub) ─────────────  Rule-based (no ML):    BanList, ContainsString, EndsWith, ValidLength, RegexMatch,    SecretsPresent, ExcludeSQLPredicates, DetectJailbreak (rule)  LLM-based (uses Tala headless inference):    ToxicLanguage, ProfanityFree, DetectPII, BiasCheck,    CompetitorCheck, NSFWText, RestrictToTopic, QARelevance,    LogicCheck, PromptInjection, CustomLLM/

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { app } from 'electron';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type OnFailPolicy = 'noop' | 'fix' | 'filter' | 'refrain' | 'exception';
export type ValidateTarget = 'input' | 'output' | 'both';

export interface ValidatorConfig {
    id: string;                          // local uuid
    type: ValidatorType;                 // e.g. 'ToxicLanguage'
    target: ValidateTarget;
    on_fail: OnFailPolicy;
    args: Record<string, any>;           // validator-specific args
    enabled: boolean;
}

export interface GuardDefinition {
    id: string;
    name: string;
    description: string;
    validators: ValidatorConfig[];
    appliedToAgents: string[];           // profile IDs
    appliedToWorkflows: string[];        // workflow IDs
    createdAt: string;
    updatedAt: string;
}

export interface ValidationResult {
    passed: boolean;
    output: string;
    violations: ViolationDetail[];
    logs: string[];
}

export interface ViolationDetail {
    validatorType: ValidatorType;
    target: ValidateTarget;
    on_fail: OnFailPolicy;
    message: string;
    fixedValue?: string;
}

// ───────────────────────────────────────────────────────────────
// Validator type registry (mirrors GuardrailsAI Hub)
// ───────────────────────────────────────────────────────────────
export const VALIDATOR_REGISTRY: ValidatorMeta[] = [
    // ── Etiquette / Safety ──────────────────────────────────────
    {
        type: 'ToxicLanguage',
        label: 'Toxic Language',
        description: 'Identifies and flags toxic language in text.',
        category: 'Etiquette',
        impl: 'llm',
        hubPackage: 'guardrails/toxic_language',
        argsSchema: { threshold: { type: 'number', default: 0.5, description: 'Toxicity score threshold (0-1).' } },
    },
    {
        type: 'ProfanityFree',
        label: 'Profanity Free',
        description: 'Checks for profanity using pattern matching.',
        category: 'Etiquette',
        impl: 'rule',
        hubPackage: 'guardrails/profanity_free',
        argsSchema: {},
    },
    {
        type: 'NSFWText',
        label: 'NSFW Text',
        description: 'Detects NSFW (not safe for work) content.',
        category: 'Etiquette',
        impl: 'llm',
        hubPackage: 'guardrails/nsfw_text',
        argsSchema: {},
    },
    {
        type: 'BiasCheck',
        label: 'Bias Check',
        description: 'Validates that the text is free from bias (age, gender, race, religion).',
        category: 'Etiquette',
        impl: 'llm',
        hubPackage: 'guardrails/bias_check',
        argsSchema: {},
    },
    // ── Brand Risk ───────────────────────────────────────────────
    {
        type: 'CompetitorCheck',
        label: 'Competitor Check',
        description: 'Flags mentions of competitor brands.',
        category: 'Brand Risk',
        impl: 'llm',
        hubPackage: 'guardrails/competitor_check',
        argsSchema: {
            competitors: { type: 'array', default: [], description: 'List of competitor names to check for.' }
        },
    },
    {
        type: 'BanList',
        label: 'Ban List',
        description: 'Validates that output does not contain banned words.',
        category: 'Brand Risk',
        impl: 'rule',
        hubPackage: 'guardrails/ban_list',
        argsSchema: {
            banned_words: { type: 'array', default: [], description: 'Words/phrases to ban.' }
        },
    },
    // ── Data Leakage ──────────────────────────────────────────────
    {
        type: 'DetectPII',
        label: 'Detect PII',
        description: 'Detects personally identifiable information (PII) using pattern matching and LLM.',
        category: 'Data Leakage',
        impl: 'llm',
        hubPackage: 'guardrails/detect_pii',
        argsSchema: {
            pii_entities: {
                type: 'array',
                default: ['EMAIL_ADDRESS', 'PHONE_NUMBER', 'PERSON', 'CREDIT_CARD'],
                description: 'PII entity types to detect.'
            }
        },
    },
    {
        type: 'SecretsPresent',
        label: 'Secrets Present',
        description: 'Detects API keys, passwords, and other secrets in text.',
        category: 'Data Leakage',
        impl: 'rule',
        hubPackage: 'guardrails/secrets_present',
        argsSchema: {},
    },
    // ── Jailbreak / Prompt Injection ─────────────────────────────
    {
        type: 'DetectJailbreak',
        label: 'Detect Jailbreak',
        description: 'Detects attempts to circumvent AI safety measures.',
        category: 'Jailbreaking',
        impl: 'llm',
        hubPackage: 'guardrails/detect_jailbreak',
        argsSchema: {},
    },
    {
        type: 'PromptInjection',
        label: 'Prompt Injection',
        description: 'Detects prompt injection attacks in user input.',
        category: 'Jailbreaking',
        impl: 'llm',
        hubPackage: 'guardrails/detect_jailbreak',
        argsSchema: {},
    },
    // ── Factuality ────────────────────────────────────────────────
    {
        type: 'QARelevance',
        label: 'QA Relevance',
        description: 'Checks if the LLM response is relevant to the original question.',
        category: 'Factuality',
        impl: 'llm',
        hubPackage: 'guardrails/qa_relevance_llm_eval',
        argsSchema: {},
    },
    {
        type: 'LogicCheck',
        label: 'Logic Check',
        description: 'Validates logical consistency and detects logical fallacies.',
        category: 'Factuality',
        impl: 'llm',
        hubPackage: 'guardrails/logic_check',
        argsSchema: {},
    },
    // ── Formatting / Rules ────────────────────────────────────────
    {
        type: 'ValidLength',
        label: 'Valid Length',
        description: 'Validates text length is within min/max bounds.',
        category: 'Formatting',
        impl: 'rule',
        hubPackage: 'guardrails/valid_length',
        argsSchema: {
            min: { type: 'number', default: 0, description: 'Minimum character length.' },
            max: { type: 'number', default: 10000, description: 'Maximum character length.' },
        },
    },
    {
        type: 'RegexMatch',
        label: 'Regex Match',
        description: 'Validates that text matches (or does not match) a regex pattern.',
        category: 'Formatting',
        impl: 'rule',
        hubPackage: 'guardrails/regex_match',
        argsSchema: {
            pattern: { type: 'string', default: '.*', description: 'Regular expression pattern.' },
            match_type: { type: 'string', default: 'fullmatch', description: '"fullmatch", "search", or "notmatch".' }
        },
    },
    {
        type: 'ContainsString',
        label: 'Contains String',
        description: 'Checks if the text contains a required substring.',
        category: 'Formatting',
        impl: 'rule',
        hubPackage: 'guardrails/contains_string',
        argsSchema: {
            expected_string: { type: 'string', default: '', description: 'Substring that must be present.' }
        },
    },
    {
        type: 'RestrictToTopic',
        label: 'Restrict to Topic',
        description: 'Ensures the text stays on specified topics.',
        category: 'Etiquette',
        impl: 'llm',
        hubPackage: 'tryolabs/restricttotopic',
        argsSchema: {
            valid_topics: { type: 'array', default: [], description: 'Allowed topics.' },
            prohibited_topics: { type: 'array', default: [], description: 'Disallowed topics.' }
        },
    },
    // ── Custom ────────────────────────────────────────────────────
    {
        type: 'CustomLLM',
        label: 'Custom LLM Validator',
        description: 'Uses an LLM prompt you define to validate text. Return YES if valid, NO if invalid.',
        category: 'Custom',
        impl: 'llm',
        hubPackage: '',
        argsSchema: {
            prompt: { type: 'string', default: 'Is the following text appropriate? Reply YES or NO.\n\nText: {value}', description: 'Validation prompt. Use {value} as placeholder.' }
        },
    },
];

export type ValidatorType =
    | 'ToxicLanguage' | 'ProfanityFree' | 'NSFWText' | 'BiasCheck'
    | 'CompetitorCheck' | 'BanList'
    | 'DetectPII' | 'SecretsPresent'
    | 'DetectJailbreak' | 'PromptInjection'
    | 'QARelevance' | 'LogicCheck'
    | 'ValidLength' | 'RegexMatch' | 'ContainsString' | 'RestrictToTopic'
    | 'CustomLLM';

export interface ValidatorMeta {
    type: ValidatorType;
    label: string;
    description: string;
    category: string;
    impl: 'rule' | 'llm';
    hubPackage: string;
    argsSchema: Record<string, { type: string; default: any; description: string }>;
}

// ═══════════════════════════════════════════════════════════════
// Secret/PII patterns for rule-based checks
// ═══════════════════════════════════════════════════════════════
const PROFANITY_PATTERNS = [
    /\b(fuck|shit|ass|bitch|bastard|cunt|damn|hell)\b/gi
];
const SECRET_PATTERNS = [
    /(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[=:]\s*['"]?[\w\-]{16,}/gi,
    /sk-[a-zA-Z0-9]{20,}/g,         // OpenAI
    /ghp_[a-zA-Z0-9]{36}/g,          // GitHub PAT
    /xox[baprs]-[^\s]+/g,            // Slack tokens
    /AKIA[A-Z0-9]{16}/g,             // AWS access key
];
const BAN_LIST_DEFAULT = ['kill', 'destroy', 'hack'];

// ═══════════════════════════════════════════════════════════════
// GuardrailService
// ═══════════════════════════════════════════════════════════════
/** A Guardrails-compatible safety and validation service for Tala.  This service implements the Guard + Validator architecture, allowing the system to: - Validate agent inputs for prompt injection or jailbreak attempts. - Validate agent outputs for toxicity, bias, PII leakage, or logical consistency. - Apply corrective policies (fix, filter, refrain) on validation failure. - Export guard definitions into standalone Python scripts compatible with the `guardrails-ai` SDK.

### Methods

#### `setInferenceFn`
**Arguments**: `fn: (prompt: string) => Promise<string>`

---
#### `load`
**Arguments**: ``
**Returns**: `GuardDefinition[]`

---
#### `save`
**Arguments**: `guards: GuardDefinition[]`

---
#### `listGuards`
**Arguments**: ``
**Returns**: `GuardDefinition[]`

---
#### `getGuard`
**Arguments**: `id: string`
**Returns**: `GuardDefinition | null`

---
#### `saveGuard`
**Arguments**: `definition: Partial<GuardDefinition> & { name: string }`
**Returns**: `GuardDefinition`

---
#### `deleteGuard`
**Arguments**: `id: string`
**Returns**: `boolean`

---
#### `validate`
Run a guard against a value. @param guardId  ID of the guard to apply. @param value    Text to validate. @param target   'input' or 'output' (only validators matching target or 'both' run)./

**Arguments**: `guardId: string, value: string, target: 'input' | 'output'`
**Returns**: `Promise<ValidationResult>`

---
#### `validateWithGuard`
Executes a specific guard stack against a text value.  The validation process: 1. Filters validators based on the `target` (input or output). 2. Iterates through the validator stack. 3. For each failure, applies the specific `on_fail` policy:    - `noop`: Passive logging.    - `fix`: Modifies the text (e.g., redaction).    - `filter`: Removes the violating segment.    - `refrain`: Returns an empty string.    - `exception`: Immediately halts the pipeline.  @param guard - The guard definition to apply. @param value - The text to validate. @param target - The context of the validation ('input' or 'output'). @returns A comprehensive result object with pass/fail status and audit logs./

**Arguments**: `guard: GuardDefinition, value: string, target: 'input' | 'output'`
**Returns**: `Promise<ValidationResult>`

---
#### `runValidator`
**Arguments**: `config: ValidatorConfig, meta: ValidatorMeta, value: string`
**Returns**: `Promise<`

---
#### `llmCheck`
**Arguments**: `_value: string, prompt: string, defaultFailMessage: string`
**Returns**: `Promise<`

---
#### `exportToPython`
Exports a guard definition as a standalone Python script using the real `guardrails-ai` SDK and Hub validators./

**Arguments**: `guardId: string`
**Returns**: `string`

---
#### `generatePythonCode`
**Arguments**: `guard: GuardDefinition`
**Returns**: `string`

---
#### `hubPackageToClassName`
**Arguments**: `hubPackage: string`
**Returns**: `string`

---
#### `formatValidatorArgs`
**Arguments**: `v: ValidatorConfig`
**Returns**: `string`

---
#### `generateCustomValidatorPython`
**Arguments**: `id: string, prompt: string`
**Returns**: `string`

---
