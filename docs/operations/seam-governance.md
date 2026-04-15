# Seam Governance Operations

## Why These Seams Are Protected
- `storage_authority`, `diagnostics_truth_contracts`, `runtime_mode_control`, and `workspace_surfaces` are high-churn, high-impact architectural seams.
- These seams govern canonical truth, operator trust, control safety, and deterministic workspace behavior.

## Contributor Workflow
- If your PR touches protected seam paths, update seam contract metadata and/or seam contract docs.
- If no contract update is warranted, include explicit justification through the seam governance gate input.
- Keep seam changes narrow and deterministic; avoid broad refactors in protected zones.

## Bugfix vs Structural Seam Change
- Bugfix: behavior correction that preserves seam contract invariants.
- Structural seam change: modifies authority boundaries, invariants, forbidden behavior rules, diagnostics semantics, or protected seam path coverage.
- Structural seam changes must update contract metadata/docs and associated seam tests.

## Why Contract Updates Are Required
- Contract updates keep seam law and implementation synchronized.
- They make seam changes reviewable as explicit governance decisions instead of implicit drift.

## CI Enforcement
- CI runs seam governance checks on pull requests.
- Protected seam changes fail when they have neither contract updates nor explicit justification.
- Failures return deterministic machine-usable status and findings for fast remediation.
