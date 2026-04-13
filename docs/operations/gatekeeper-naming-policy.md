# Tala Gatekeeper Naming Policy (Initial Operational Pass)

## 1. Purpose
This policy defines how Gatekeeper uses naming compliance as an operational safety and governance signal.

## 2. Why Naming Is a Governance Signal
In Tala, names encode subsystem boundaries, execution intent, mutability, and exposure. Naming drift increases risk in self-modification, automation, and admin audit workflows. Gatekeeper therefore treats naming as enforceable compliance, not style preference.

## 3. Scope of Gatekeeper Naming Review
Gatekeeper naming review covers:
- Naming contract compliance results
- Exception debt state
- Critical-boundary changed files
- Event, IPC, and API naming in changed critical boundaries
- Baseline growth governance for `docs/contracts/naming.exceptions.json`

## 4. Decision Classes
- `PASS`:
  - no new violations
  - no stale exceptions
  - no escalation conditions
  - no naming debt
- `PASS_WITH_DEBT`:
  - no new violations
  - no stale exceptions
  - existing allowed exceptions remain
- `WARN_ESCALATE`:
  - deterministic checks pass
  - escalation condition requires human review
- `FAIL`:
  - deterministic hard-fail condition triggered

## 5. Deterministic Policy Layer
Gatekeeper evaluates:
- naming validator outcomes (`new`, `allowed`, `stale`)
- banned-term violations
- event/IPC/API naming pattern violations
- stale exceptions (hard fail)
- baseline growth governance (hard fail without approved mechanism)

## 6. Critical-Boundary Strictness
Gatekeeper applies elevated severity in changed files matching critical boundary paths for:
- memory authority
- IPC/API boundaries
- telemetry/events
- tool/workflow execution
- reflection/self-improvement
- inference/provider resolution
- path/storage/portable-root enforcement
- policy gates

In changed critical files, any violation of hard-fail rule IDs fails Gatekeeper, including baseline-covered debt.

## 7. Baseline/Exception Policy
- Exceptions are temporary debt tracking only.
- Stale exceptions fail.
- Baseline expansion requires explicit justification.
- Mass baseline refresh is forbidden.
- Baseline growth must be visible in Gatekeeper output.

## 8. Generated Artifact Policy
- Generated artifacts must be classified before creation.
- Name validation must run before write.
- Gatekeeper rejects generated artifact changes that bypass naming validation and introduce naming contract violations.

## 9. Immediate Hard-Fail Conditions
- One or more new naming violations.
- One or more stale exceptions.
- Hard-fail naming rules violated in changed critical-boundary files.
- Exception baseline growth without explicit justification.
- Exception baseline growth above configured limit.

## 10. Warning/Escalation Conditions
- Gatekeeper cannot resolve changed-file scope reliably.
- Baseline growth is justified but still requires reviewer sign-off.
- A deterministic pass reveals policy ambiguity requiring contract/policy extension review.

## 11. Operational Integration Points
- PR/CI:
  - `npm run docs:gatekeeper:naming`
- Self-modification and reflection:
  - run Gatekeeper naming pass before applying generated or autonomous code updates
- Workflow/tool generation:
  - enforce classify -> name -> validate before write, then Gatekeeper review on produced diff

## Implementation Reference
- Gatekeeper executable mode:
  - `tools/doclock/validate-naming-contract.ts --gatekeeper`
- Gatekeeper config:
  - [naming-gatekeeper.config.json](/D:/src/client1/tala-app/docs/contracts/naming-gatekeeper.config.json)
