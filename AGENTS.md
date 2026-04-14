# Tala Agent Constitution

## Purpose
- Tala is a local-first AI companion and agent workstation.
- Core goals: durable identity, canonical memory, retrieval intelligence, tooling orchestration, reflection, and safe self-improvement.
- Preserve existing architecture unless change is clearly required; extend before redesign.

## Memory Authority Invariant (Non-Negotiable)
- PostgreSQL is the only canonical durable memory authority.
- mem0 is a candidate learning, extraction, and evaluation layer only.
- No memory becomes durable truth unless accepted into canonical PostgreSQL storage.
- Vector indexes, graph structures, mem0-side state, summaries, caches, notebook projections, and retrieval artifacts are derived only.
- All authoritative memory surfaced to Tala must resolve to canonical PostgreSQL-backed IDs.
- Derived memory systems must be rebuildable from canonical PostgreSQL state.
- No direct durable memory writes may bypass the memory authority path.

## Engineering Invariants
- Preserve existing IPC and service boundaries unless a change is necessary.
- Do not introduce parallel subsystems when an existing subsystem should be extended.
- Do not break artifact-first UX behavior.
- Respect app-root-relative storage and portable-root enforcement rules.
- Preserve offline/local-first operation.
- Prefer deterministic logic over prompt-dependent behavior for critical functions.
- Do not weaken telemetry, diagnostics, policy gates, or guardrails.

## Codex Change Behavior
- Inspect existing code paths and contracts before editing.
- Make surgical changes; avoid broad churn.
- Reuse existing abstractions, validators, and policy mechanisms.
- Avoid speculative refactors and architecture reshaping.
- Update tests when behavior or contracts change.
- Document any new invariant or boundary rule introduced.
- End each task with changed files, behavior impact, and remaining gaps/risk.

## Documentation Completion Law (Binding)
- Documentation is a hard completion gate for qualifying code changes.
- Qualifying changes include behavior, architecture, contracts, workflows, telemetry, setup, policies, runtime guardrails, reflection, tools, memory, inference, MCP services, and operator instructions.
- REQUIRED COMMAND: run `npm run docs:heal-and-validate` for any qualifying change before task completion.
- A task is not complete while documentation drift remains or `REVIEW_REQUIRED` checklist items are unresolved.
- Keep documentation diffs narrow and directly tied to the changed code paths.
- Prefer deterministic regeneration and bounded generated blocks over freeform prose edits.
- Use manual narrative edits only where generated blocks are not appropriate.
- If a required doc cannot be safely auto-regenerated, use a bounded `REVIEW_REQUIRED` section rather than speculative prose.

## Retrieval and Derived State Rules
- RAG is retrieval support, not durable truth storage.
- mem0, graph, embeddings, and summaries are supportive derived layers, not authorities.
- Retrieval may use derived layers for candidate discovery, but memory truth grounding must resolve to canonical PostgreSQL sources.

## Reflection and Self-Modification Safety
- Self-improvement must run inside explicit guardrails.
- No autonomous change may silently bypass canonical authority paths or policy gates.
- Reflection proposals, repairs, and maintenance actions must be constrained, auditable, and reversible where applicable.
