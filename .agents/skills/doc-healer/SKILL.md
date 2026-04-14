---
name: doc-healer
description: Deterministic documentation self-healing and validation workflow for code-to-doc drift.
---

# Doc Healer Skill

## Trigger Guidance
Use this skill whenever changed code can affect behavior, architecture, contracts, workflows, telemetry, setup, policies, runtime guardrails, reflection, tools, memory, inference, MCP services, or operator instructions.

## Required Workflow
1. Inspect changed files (`git diff --name-only` and staged/unstaged state).
2. Map changed files to owned docs and generated sections (`npm run docs:scan-impact`).
3. Refresh deterministic generated sections (`npm run docs:heal`).
4. Run validation (`npm run docs:validate`).
5. Repair any remaining drift or unresolved `REVIEW_REQUIRED` items with narrow doc edits.
6. Summarize what changed and why, including unresolved risks if any.

## Completion Guard
- Do not conclude the task while doc/code drift remains.
- Do not conclude while any `REVIEW_REQUIRED` checklist item remains unchecked.
- Prefer deterministic generators and bounded blocks over speculative prose.
