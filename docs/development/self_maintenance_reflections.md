# Self-Maintenance Reflections

Tala features a deterministic system auto-maintenance orchestrator. Instead of burying these autonomous tasks entirely in the background, Tala explicitly journals them into the user's view via **MaintenanceReflectionEvents**.

These reflections fall under the `system-maintenance` category in the Reflection UI.

## Maintenance Domains
Maintenance operations are grouped into three domains representing different cross-sections of the repository architecture:
1. `documentation`: Recompiling indices, verifying subsystem docs against source TypeScript.
2. `code`: Validating repository structure arrays and bounds checking logic schemas.
3. `memory`: Restructuring or validating memory graph associations.

## The Event Schema
The core transport primitive for these records is the `MaintenanceReflectionEvent`:
```typescript
interface MaintenanceReflectionEvent {
  id: string;                 // unique sequence ID
  timestamp: string;          // ISO string for sorting
  domain: MaintenanceDomain;   // E.g., 'documentation'
  severity: MaintenanceSeverity; // info | warning | error | success
  action: MaintenanceAction;   // audit | propose | apply-safe | blocked
  
  title: string;
  summary: string;
  
  details?: string[];
  changedFiles?: string[];
  protectedItems?: string[];
  suggestedNextSteps?: string[];
  
  remediation?: MaintenanceRemediation[];
}
```

## Remediation Flow
When the CLI specifies a rule violation rather than immediately auto-fixing it (e.g., Code Hygeine identifying boundary cross-talk, running in `action: propose` mode), the emitted reflection attaches a `remediation`.

The Reflection Panel renders these as actionable buttons that dispatch safe commands back into the orchestrator.

## Protected Memory Rules
If any workflow triggers a change against restricted data elements (such as Identity configuration, explicitly memorized user facts, or the persistent log), the SelfMaintenanceService intercepts the attempt before making system-level writes.

This triggers an explicit `MaintenanceReflectionEvent` featuring:
- `severity: warning`
- `action: blocked`
- `protectedItems`: Array containing the names of the guarded sectors.

This ensures both AI autonomy and safe immutable limits are fully transparent in the history panel.
