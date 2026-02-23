# 02 — Reflection Pipeline

**Document Version**: 1.0.0
**Status**: Legal-Grade, Audit-Ready

## 1. Overview

The **Reflection Pipeline** is a multi-stage data processing sequence that converts raw logs into actionable system improvements.

## 2. Pipeline Stages

### Stage 1: Capture (Evidence Collection)
The pipeline gathers data since the last successful heartbeat:
- **Interaction Logs**: Recent user/assistant turns.
- **Tool Outcomes**: Success/failure/latency of every tool call.
- **Trace Logs**: Internal errors and stack traces.
- **Feedback Signals**: User corrections ("No, do it this way") or retries.

### Stage 2: Analyze (Reflection)
The LLM reviews the evidence to identify:
- **Patterns**: Repeated errors or inefficient tool use.
- **Gaps**: Missing documentation, incomplete memory, or prompt ambiguity.
- **Wins**: Successful complex task completions that should be templatized.

### Stage 3: Propose (Innovation)
The system generates `ChangeProposals`. Categories include:
- **Prompting**: Refining system instructions.
- **Workflows**: Creating new `.md` workflows for repeated tasks.
- **Bugfixes**: Surgical code edits to resolve identified patterns.
- **Docs**: Updating internal documentation to reflect new learnings.

### Stage 4: Validate (Gating)
Every proposal is passed to the **Risk Engine** for classification and approval routing.

## 3. Failure Handling

If any stage fails (e.g., LLM timeout), the entire pipeline instance is aborted. The evidence remains in the "Unprocessed" queue for the next heartbeat.

---
**END OF PIPELINE SPECIFICATION**
