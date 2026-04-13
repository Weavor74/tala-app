export type Severity = 'error' | 'warn' | 'info';

export interface NamingContract {
  contractName: string;
  version: string;
  fileNaming?: {
    typescript?: {
      patterns?: Array<{ name: string; regex: string; severity?: Severity }>;
    };
    scripts?: { regex: string; severity?: Severity };
    tests?: { regex: string; severity?: Severity };
    contracts?: { regex: string; severity?: Severity };
    schemas?: { regex: string; severity?: Severity };
    configs?: { regex: string; severity?: Severity };
    docs?: { regex: string; severity?: Severity };
  };
  allowedSuffixRoles?: Array<{ suffix: string }>;
  bannedTerms?: {
    artifactNames?: string[];
    functionNames?: string[];
    containsTokens?: string[];
    severity?: Severity;
  };
  functionNaming?: {
    mustBeVerbFirst?: boolean;
    verbCategories?: Record<string, string[]>;
    restrictedVerbs?: string[];
    restrictedVerbPolicy?: {
      defaultSeverity?: Severity;
    };
  };
  variableSuffixRules?: {
    requiredSuffixes?: Array<{ semanticType: string; suffix: string; severity?: Severity }>;
  };
  eventNaming?: {
    regex?: string;
    forbiddenImperativePrefixes?: string[];
    severity?: Severity;
  };
  ipcNaming?: {
    regex?: string;
    severity?: Severity;
  };
  apiNaming?: {
    pathRegex?: string;
    severity?: Severity;
  };
  toolWorkflowAutomationNaming?: {
    toolNameRegex?: string;
    workflowNameRegex?: string;
    automationArtifactRegex?: string;
    severity?: Severity;
  };
}

export interface Violation {
  file: string;
  rule: string;
  message: string;
  severity: Severity;
  symbol?: string;
  value?: string;
  line?: number;
  column?: number;
}

export interface NamingExceptionEntry {
  file: string;
  rule: string;
  symbol?: string;
  value?: string;
  reason?: string;
  addedAt?: string;
}

export interface NamingExceptionsFile {
  contract: string;
  contractVersion: string;
  generatedAt: string;
  exceptions: NamingExceptionEntry[];
}

export type GatekeeperNamingStatus = 'PASS' | 'PASS_WITH_DEBT' | 'WARN_ESCALATE' | 'FAIL';

export interface GatekeeperNamingFinding {
  file: string;
  rule: string;
  message: string;
  symbol?: string;
  value?: string;
  severity?: Severity;
  line?: number;
  column?: number;
  source: 'new_violation' | 'allowed_exception' | 'stale_exception' | 'policy';
}

export interface GatekeeperNamingResult {
  status: GatekeeperNamingStatus;
  summary: string;
  counts: {
    totalDetectedViolations: number;
    newViolations: number;
    allowedExceptions: number;
    staleExceptions: number;
    criticalBoundaryFindings: number;
    changedCriticalFiles: number;
    baselineExceptionDelta: number;
  };
  findings: {
    newViolations: GatekeeperNamingFinding[];
    staleExceptions: GatekeeperNamingFinding[];
    criticalBoundaryFindings: GatekeeperNamingFinding[];
  };
  debt: {
    hasNamingDebt: boolean;
    allowedExceptionCount: number;
  };
  warnings: string[];
  escalations: string[];
  metadata: {
    changedFilesEvaluated: string[];
    criticalBoundaryFilesEvaluated: string[];
    baselineGrowthJustified: boolean;
    baselineGrowthJustification?: string;
    gatekeeperConfigPath: string;
  };
}

export type ArtifactKind =
  | 'file'
  | 'class'
  | 'module'
  | 'function'
  | 'variable'
  | 'event'
  | 'ipc'
  | 'api-route'
  | 'tool'
  | 'workflow'
  | 'automation';

export type ArtifactMutability =
  | 'read'
  | 'write'
  | 'transform'
  | 'validate'
  | 'execute'
  | 'schedule'
  | 'route'
  | 'register';

export type ArtifactExposure = 'internal' | 'ipc' | 'api' | 'external' | 'contract_facing';

export interface ArtifactClassificationInput {
  subsystem: string;
  layer: string;
  role: string;
  mutability: string;
  exposure: string;
  artifactKind: string;
}

export interface ArtifactClassification {
  subsystem: string;
  layer: string;
  role: string;
  mutability: ArtifactMutability;
  exposure: ArtifactExposure;
  artifactKind: ArtifactKind;
  roleSuffix?: string;
}

export interface ArtifactNameValidationIssue {
  rule: string;
  severity: Severity;
  message: string;
}

export interface ArtifactNameValidationResult {
  valid: boolean;
  classification: ArtifactClassification;
  name: string;
  issues: ArtifactNameValidationIssue[];
}
