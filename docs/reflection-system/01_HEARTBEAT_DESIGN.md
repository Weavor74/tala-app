# 01 — Heartbeat Design

**Document Version**: 1.0.0
**Status**: Legal-Grade, Audit-Ready

## 1. Purpose

The **Heartbeat Engine** serves as the rhythmic trigger for TALA's subconscious processing. It ensures that reflection doesn't interfere with active user sessions while maintaining a steady pulse of self-improvement.

## 2. Timing & Scheduling

- **Default Interval**: 60 Minutes (configurable via `reflection.heartbeatMinutes`).
- **Jitter**: ±15% random variation applied to each interval to prevent cyclic network/CPU spikes across instances.
- **Quiet Hours**: Defined in settings. Heartbeats are queued but not executed during these windows to preserve hardware resources for user-specified tasks (e.g., overnight renders).

## 3. Execution Cycle

1. **Wait**: The scheduler waits for the next tick.
2. **Idle Check**: The engine verifies that the system is not under heavy load (CPU < 70%).
3. **Session Check**: If the user is actively chatting, the heartbeat is deferred by 5 minutes.
4. **Trigger**: Once conditions are met, the `ReflectionPipeline` is invoked.

## 4. Configuration Schema

```ts
interface ReflectionSettings {
    enabled: boolean;
    heartbeatMinutes: number;
    quietHours: {
        start: string; // e.g., "00:00"
        end: string;   // e.g., "06:00"
    };
}
```

---
**END OF HEARTBEAT DESIGN**
