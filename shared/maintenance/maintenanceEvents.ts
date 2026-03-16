export type MaintenanceDomain = 'documentation' | 'code' | 'memory' | 'system';

export type MaintenanceSeverity = 'info' | 'warning' | 'error' | 'success';

export type MaintenanceAction = 'audit' | 'propose' | 'apply-safe' | 'blocked';

export interface MaintenanceRemediation {
  label: string;
  command: string;
}

export interface MaintenanceReflectionEvent {
  id: string;
  timestamp: string;
  domain: MaintenanceDomain;
  severity: MaintenanceSeverity;
  action: MaintenanceAction;

  title: string;
  summary: string;

  details?: string[];
  changedFiles?: string[];
  protectedItems?: string[];
  suggestedNextSteps?: string[];

  remediation?: MaintenanceRemediation[];
}
