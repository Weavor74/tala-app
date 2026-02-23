# 04 — UI & Workflows

**Document Version**: 1.0.0
**Status**: Legal-Grade, Audit-Ready

## 1. Interaction Model

The Reflection System is a background process with a high-visibility frontend. Users monitor and govern the system through a dedicated **Reflection Dashboard**.

## 2. Dashboard Components

### 2.1 Reflection Panel
- **Status Hub**: Shows Heartbeat status (Next Tick In: MM:SS).
- **Recent Events**: A feed of the last 10 `ReflectionEvents`.
- **Proposal Queue**: Pending changes awaiting approval.
- **Metrics**: Success rate of applied changes and system "learning speed".

### 2.2 Proposal Approval Card (A2UI)
TALA uses the **A2UI Dynamic Rendering** system to present proposals. Each card includes:
- **Title**: (e.g., "Refine Git Commit Message Prompt").
- **Evidence**: Snippet of the failure or inefficiency that triggered the fix.
- **Diff View**: Visual side-by-side comparison of the change.
- **Action Group**: `[Approve]`, `[Reject]`, `[Modify]`.

## 3. Workflow: Governing a Proposal

1. **Notification**: A subtle "New Proposal Available" badge appears in the UI.
2. **Review**: User opens the Reflection Panel and clicks a proposal.
3. **Decision**:
   - **Approve**: TALA applies the change, runs tests, and logs the outcome.
   - **Reject**: TALA mark the proposal as "User-Rejected" and will not suggest this specific fix again.
   - **Modify**: User edits the proposal before approving.

---
**END OF UI SPECIFICATION**
