export type MaintenanceMode = 'audit' | 'propose' | 'apply-safe';

export type MaintenanceLaneName = 'documentation' | 'code' | 'memory';

export interface MaintenanceReport {
  lane: MaintenanceLaneName;
  status: 'success' | 'warning' | 'error';
  mode: MaintenanceMode;
  messages: string[];
  changedFiles?: string[];
  proposedFixes?: string[];
}

export interface MaintenanceLane {
  name: MaintenanceLaneName;
  description: string;
  allowedModes: MaintenanceMode[];
  
  /**
   * Run the lane's specific maintenance logic based on the mode.
   */
  run(mode: MaintenanceMode): Promise<MaintenanceReport>;
}

export const ProtectedMemoryArtifacts = [
  'long_term_memory',
  'explicit_user_facts',
  'identity_rules',
  'canonical_preferences'
];

export const FORBIDDEN_AUTOFIXES = [
  'rewrite runtime orchestration logic',
  'alter core agent behavior',
  'alter memory policy logic',
  'modify prompts unrelated to maintenance'
];
