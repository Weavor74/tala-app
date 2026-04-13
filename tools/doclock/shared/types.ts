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
