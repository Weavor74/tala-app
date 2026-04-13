import {
  ArtifactClassification,
  ArtifactClassificationInput,
  ArtifactExposure,
  ArtifactKind,
  ArtifactMutability,
  ArtifactNameValidationIssue,
  ArtifactNameValidationResult,
  NamingContract,
  Severity
} from './types';

const ALLOWED_SUBSYSTEMS = new Set([
  'memory',
  'inference',
  'reflection',
  'telemetry',
  'ipc',
  'tools',
  'workflow',
  'path',
  'autonomy',
  'governance',
  'execution',
  'selfmodel',
  'router',
  'a2ui',
  'runtime'
]);

const ALLOWED_LAYERS = new Set([
  'ui',
  'application',
  'domain',
  'infrastructure',
  'integration',
  'contract',
  'service',
  'repository',
  'provider',
  'resolver',
  'registry',
  'validator',
  'policy',
  'coordinator',
  'orchestrator',
  'scheduler',
  'adapter',
  'gateway',
  'client',
  'router',
  'bus',
  'store',
  'schema',
  'contract'
]);

const ALLOWED_MUTABILITY = new Set<ArtifactMutability>([
  'read',
  'write',
  'transform',
  'validate',
  'execute',
  'schedule',
  'route',
  'register'
]);

const ALLOWED_EXPOSURE = new Set<ArtifactExposure>([
  'internal',
  'ipc',
  'api',
  'external',
  'contract_facing'
]);

const ALLOWED_ARTIFACT_KINDS = new Set<ArtifactKind>([
  'file',
  'class',
  'module',
  'function',
  'variable',
  'event',
  'ipc',
  'api-route',
  'tool',
  'workflow',
  'automation'
]);

function toKebab(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function toPascal(input: string): string {
  return toKebab(input)
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function toCamel(input: string): string {
  const p = toPascal(input);
  return p ? p.charAt(0).toLowerCase() + p.slice(1) : p;
}

function splitTokens(name: string): string[] {
  const ascii = name.replace(/[^A-Za-z0-9]+/g, ' ');
  const withCamel = ascii.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return withCamel
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(token => token.toLowerCase());
}

function pushIssue(
  issues: ArtifactNameValidationIssue[],
  rule: string,
  severity: Severity,
  message: string
): void {
  issues.push({ rule, severity, message });
}

export function resolveRoleSuffixMap(contract: NamingContract): Record<string, string> {
  const map: Record<string, string> = {};
  for (const role of contract.allowedSuffixRoles ?? []) {
    map[role.suffix.toLowerCase()] = role.suffix;
  }
  return map;
}

export function resolveArtifactClassification(
  input: ArtifactClassificationInput,
  contract: NamingContract
): { ok: true; classification: ArtifactClassification } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const subsystem = toKebab(input.subsystem);
  const layer = toKebab(input.layer);
  const role = toKebab(input.role);
  const mutability = toKebab(input.mutability) as ArtifactMutability;
  const exposure = toKebab(input.exposure).replace('-', '_') as ArtifactExposure;
  const artifactKind = toKebab(input.artifactKind) as ArtifactKind;

  if (!subsystem) errors.push('subsystem is required');
  if (!layer) errors.push('layer is required');
  if (!role) errors.push('role is required');
  if (!mutability) errors.push('mutability is required');
  if (!exposure) errors.push('exposure is required');
  if (!artifactKind) errors.push('artifactKind is required');

  if (subsystem && !ALLOWED_SUBSYSTEMS.has(subsystem)) {
    errors.push(`unsupported subsystem: ${subsystem}`);
  }

  if (layer && !ALLOWED_LAYERS.has(layer)) {
    errors.push(`unsupported layer: ${layer}`);
  }

  if (mutability && !ALLOWED_MUTABILITY.has(mutability)) {
    errors.push(`unsupported mutability: ${mutability}`);
  }

  if (exposure && !ALLOWED_EXPOSURE.has(exposure)) {
    errors.push(`unsupported exposure: ${exposure}`);
  }

  if (artifactKind && !ALLOWED_ARTIFACT_KINDS.has(artifactKind)) {
    errors.push(`unsupported artifactKind: ${artifactKind}`);
  }

  const suffixMap = resolveRoleSuffixMap(contract);
  const roleSuffix = suffixMap[layer] ?? suffixMap[role];

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    classification: {
      subsystem,
      layer,
      role,
      mutability,
      exposure,
      artifactKind,
      roleSuffix
    }
  };
}

export function validateArtifactName(
  contract: NamingContract,
  classification: ArtifactClassification,
  proposedName: string
): ArtifactNameValidationResult {
  const name = proposedName.trim();
  const issues: ArtifactNameValidationIssue[] = [];

  if (!name) {
    pushIssue(issues, 'naming/name-required', 'error', 'Artifact name is required.');
    return { valid: false, classification, name, issues };
  }

  const banned = contract.bannedTerms?.artifactNames ?? [];
  const containsTokens = contract.bannedTerms?.containsTokens ?? [];
  const bannedFunctionNames = new Set((contract.bannedTerms?.functionNames ?? []).map(v => v.toLowerCase()));

  const tokens = splitTokens(name);
  for (const term of banned) {
    if (tokens.includes(term.toLowerCase())) {
      pushIssue(
        issues,
        'naming/banned-term',
        contract.bannedTerms?.severity ?? 'error',
        `Name contains banned vague term \"${term}\".`
      );
    }
  }

  const lowerName = name.toLowerCase();
  for (const token of containsTokens) {
    if (lowerName.includes(token.toLowerCase())) {
      pushIssue(
        issues,
        'naming/banned-term',
        contract.bannedTerms?.severity ?? 'error',
        `Name contains discouraged token \"${token}\".`
      );
    }
  }

  if (classification.artifactKind === 'class' || classification.artifactKind === 'module') {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
      pushIssue(issues, 'naming/class-format', 'error', 'Class/module names must be PascalCase.');
    }

    if (classification.roleSuffix && !name.endsWith(classification.roleSuffix)) {
      pushIssue(
        issues,
        'naming/suffix-mismatch',
        'error',
        `Expected suffix \"${classification.roleSuffix}\" for classification layer/role.`
      );
    }
  }

  if (classification.artifactKind === 'function') {
    if (!/^[a-z][A-Za-z0-9]*$/.test(name)) {
      pushIssue(issues, 'naming/function-format', 'error', 'Function names must be camelCase.');
    }

    if (bannedFunctionNames.has(name.toLowerCase())) {
      pushIssue(issues, 'naming/function-banned-name', 'error', `Function name \"${name}\" is banned.`);
    }

    const verbs = Object.values(contract.functionNaming?.verbCategories ?? {}).flat();
    const first = tokens[0];
    if ((contract.functionNaming?.mustBeVerbFirst ?? false) && verbs.length > 0 && first && !verbs.includes(first)) {
      pushIssue(
        issues,
        'naming/function-verb',
        'error',
        `Function name must start with approved verb. Found \"${first}\".`
      );
    }

    const restricted = new Set((contract.functionNaming?.restrictedVerbs ?? []).map(v => v.toLowerCase()));
    if (first && restricted.has(first)) {
      pushIssue(
        issues,
        'naming/function-restricted-verb',
        contract.functionNaming?.restrictedVerbPolicy?.defaultSeverity ?? 'warn',
        `Function name starts with restricted vague verb \"${first}\".`
      );
    }
  }

  if (classification.artifactKind === 'variable') {
    if (!/^[a-z][A-Za-z0-9]*$/.test(name)) {
      pushIssue(issues, 'naming/variable-format', 'error', 'Variable names should be camelCase.');
    }
  }

  if (classification.artifactKind === 'event') {
    const regex = contract.eventNaming?.regex ? new RegExp(contract.eventNaming.regex) : null;
    if (regex && !regex.test(name)) {
      pushIssue(
        issues,
        'naming/event-pattern',
        contract.eventNaming?.severity ?? 'error',
        `Event name must match ${contract.eventNaming?.regex}.`
      );
    }

    const first = name.split('.')[0]?.toLowerCase();
    const forbidden = new Set((contract.eventNaming?.forbiddenImperativePrefixes ?? []).map(v => v.toLowerCase()));
    if (first && forbidden.has(first)) {
      pushIssue(
        issues,
        'naming/event-command-form',
        contract.eventNaming?.severity ?? 'error',
        `Event name starts with forbidden imperative prefix \"${first}\".`
      );
    }
  }

  if (classification.artifactKind === 'ipc') {
    const regex = contract.ipcNaming?.regex ? new RegExp(contract.ipcNaming.regex) : null;
    if (regex && !regex.test(name)) {
      pushIssue(
        issues,
        'naming/ipc-pattern',
        contract.ipcNaming?.severity ?? 'error',
        `IPC channel must match ${contract.ipcNaming?.regex}.`
      );
    }
  }

  if (classification.artifactKind === 'api-route') {
    const regex = contract.apiNaming?.pathRegex ? new RegExp(contract.apiNaming.pathRegex) : null;
    if (regex && !regex.test(name)) {
      pushIssue(
        issues,
        'naming/api-route-pattern',
        contract.apiNaming?.severity ?? 'warn',
        `API route must match ${contract.apiNaming?.pathRegex}.`
      );
    }
  }

  if (classification.artifactKind === 'tool') {
    const regex = contract.toolWorkflowAutomationNaming?.toolNameRegex
      ? new RegExp(contract.toolWorkflowAutomationNaming.toolNameRegex)
      : null;
    if (regex && !regex.test(name)) {
      pushIssue(
        issues,
        'naming/tool-pattern',
        contract.toolWorkflowAutomationNaming?.severity ?? 'error',
        `Tool name must match ${contract.toolWorkflowAutomationNaming?.toolNameRegex}.`
      );
    }
  }

  if (classification.artifactKind === 'workflow') {
    const regex = contract.toolWorkflowAutomationNaming?.workflowNameRegex
      ? new RegExp(contract.toolWorkflowAutomationNaming.workflowNameRegex)
      : null;
    if (regex && !regex.test(name)) {
      pushIssue(
        issues,
        'naming/workflow-pattern',
        contract.toolWorkflowAutomationNaming?.severity ?? 'error',
        `Workflow name must match ${contract.toolWorkflowAutomationNaming?.workflowNameRegex}.`
      );
    }
  }

  if (classification.artifactKind === 'automation') {
    const regex = contract.toolWorkflowAutomationNaming?.automationArtifactRegex
      ? new RegExp(contract.toolWorkflowAutomationNaming.automationArtifactRegex)
      : null;
    if (regex && !regex.test(name)) {
      pushIssue(
        issues,
        'naming/automation-pattern',
        contract.toolWorkflowAutomationNaming?.severity ?? 'error',
        `Automation artifact name must match ${contract.toolWorkflowAutomationNaming?.automationArtifactRegex}.`
      );
    }
  }

  if (classification.artifactKind === 'file') {
    const extension = name.split('.').slice(1).join('.');
    if (!extension) {
      pushIssue(issues, 'naming/file-extension', 'error', 'File name must include extension.');
    }
  }

  return {
    valid: issues.filter(issue => issue.severity === 'error').length === 0,
    classification,
    name,
    issues
  };
}

export function buildArtifactNameSuggestion(contract: NamingContract, classification: ArtifactClassification): string {
  const subsystemPart = toPascal(classification.subsystem);
  const rolePart = toPascal(classification.role);
  const suffix = classification.roleSuffix ?? toPascal(classification.layer);

  const verbByMutability: Record<ArtifactMutability, string> = {
    read: 'get',
    write: 'set',
    transform: 'build',
    validate: 'validate',
    execute: 'execute',
    schedule: 'schedule',
    route: 'route',
    register: 'register'
  };

  if (classification.artifactKind === 'class' || classification.artifactKind === 'module') {
    return `${subsystemPart}${rolePart}${suffix}`;
  }

  if (classification.artifactKind === 'function') {
    return `${verbByMutability[classification.mutability]}${subsystemPart}${rolePart}`;
  }

  if (classification.artifactKind === 'event') {
    const eventTerminalByMutability: Record<ArtifactMutability, string> = {
      read: 'queried',
      write: 'updated',
      transform: 'transformed',
      validate: 'validated',
      execute: 'completed',
      schedule: 'scheduled',
      route: 'routed',
      register: 'registered'
    };
    return `${classification.subsystem}.${classification.role.replace(/-/g, '_')}.${eventTerminalByMutability[classification.mutability]}`;
  }

  if (classification.artifactKind === 'ipc') {
    return `${toCamel(classification.subsystem)}:${verbByMutability[classification.mutability]}${toPascal(classification.role)}`;
  }

  if (classification.artifactKind === 'api-route') {
    return `/api/v1/${toKebab(classification.subsystem)}/${toKebab(classification.role)}`;
  }

  if (classification.artifactKind === 'tool') {
    return `${classification.subsystem}_${verbByMutability[classification.mutability]}_${classification.role.replace(/-/g, '_')}`;
  }

  if (classification.artifactKind === 'workflow') {
    return `${classification.subsystem}_${classification.role.replace(/-/g, '_')}`;
  }

  if (classification.artifactKind === 'automation') {
    return `${classification.subsystem}-daily-${classification.role}`;
  }

  if (classification.artifactKind === 'file') {
    const fileStem = `${classification.subsystem}-${classification.role}`;
    return `${fileStem}.ts`;
  }

  if (classification.artifactKind === 'variable') {
    return `${toCamel(classification.subsystem)}${toPascal(classification.role)}`;
  }

  return `${subsystemPart}${rolePart}`;
}
