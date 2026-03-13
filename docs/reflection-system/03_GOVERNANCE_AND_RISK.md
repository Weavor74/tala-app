# 03 — Governance & Risk

**Document Version**: 1.0.0
**Status**: Legal-Grade, Audit-Ready

## 1. Philosophy

Trust is built through transparency and control. TALA never performs high-risk actions without explicit, informed user consent.

## 2. Risk Classification Matrix

The **Risk Engine** assigns a score (1-10) to every proposal based on its potential impact:

| Tier | Score | Scope | Approval Gate |
|---|---|---|---|
| **Low** | 1-3 | Docs updating, UI copy, non-functional config. | Auto-apply (if enabled) |
| **Medium** | 4-6 | Bugfixes in non-critical modules, new unit tests, prompt refinement. | User Approval Required |
| **High** | 7-10 | Filesystem write (recursive), Terminal commands, Auth/Security changes. | Mandatory User Approval |

## 3. Security Gates

### Gate 1: Deterministic Filter
A hardcoded list of "Forbidden Actions" (e.g., `rm -rf /`, `app.quit()`) that the system can NEVER propose.

### Gate 2: Dry-Run Validation
Before application, the system attempts to build the code with the proposed change. If the build fails, the proposal is automatically rejected.

### Gate 3: User Confirmation
For Tier 2+ changes, the user is presented with a **Reflection Card** showing:
- **What**: The proposed diff.
- **Why**: The specific evidence (log/error) that triggered the proposal.
- **Risk**: A clear explanation of the potential impact.

## 4. Reversibility

Every applied change MUST be reversible.
- **Git Mode**: Every apply creates a `reflect/...` branch.
- **Snapshot Mode**: Every apply creates a `.bak` of the targeted file.

---
**END OF GOVERNANCE DOCUMENT**
