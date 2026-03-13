# 06 — Test Plan

**Document Version**: 1.0.0
**Status**: Legal-Grade, Audit-Ready

## 1. Verification Strategy

The Reflection System is tested at three levels: Unit, Integration, and Smoke.

## 2. Unit Tests (`src/agent/reflection/__tests__`)

- **Risk Scoring**: Verify that a "Terminal Change" always results in a High Risk score.
- **ID Generation**: Ensure `ProposalID` and `EventID` are unique and traceable.
- **Validation Gates**: Mock a build failure and ensure the `ApplyEngine` aborts.

## 3. Integration Tests

- **Persistence Loop**: Write a `ReflectionEvent`, read it back via the `ArtifactStore`, and verify data integrity.
- **IPC Handshake**: Simulate a `proposal-approve` event and verify the backend response.

## 4. Smoke Test (`smoke-test-reflection.ps1`)

An automated PowerShell script that performs:
1. **App Start**: Verify the `HeartbeatEngine` initializes.
2. **Interval Mock**: Force a heartbeat tick via debug IPC.
3. **Artifact Check**: Confirm `reflection_event.json` is created in `./memory/reflections/`.
4. **Proposal Check**: Verify at least one `proposal.json` is generated for a known "bad" log entry.
5. **Approval Simulation**: Approve a low-risk change and verify file modification.

---
**END OF TEST PLAN**
