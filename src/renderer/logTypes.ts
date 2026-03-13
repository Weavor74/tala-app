/**
 * Log System Type Definitions
 * 
 * Provides structural schemas for TALA's distributed logging architecture,
 * covering standard logs, performance metrics, and subsystem health snapshots.
 * 
 * **Schema Categories:**
 * - **Telemetry**: Low-level event distribution (`LogViewerEntry`, `LogSeverity`).
 * - **Diagnostics**: Aggregated health and performance snapshots (`LogHealthSnapshot`, `PerformanceSummary`).
 * - **Management**: Metadata for log sources and read operations (`LogSourceInfo`, `LogReadResult`).
 */
export type { 
    LogSeverity,
    LogViewerEntry,
    SystemHealth,
    LogHealthSnapshot,
    LogDiagnosticsSummary,
    RuntimeErrorRecord,
    PerformanceMetricRecord,
    TimelineEvent,
    PerformanceSummary,
    LogSourceInfo,
    LogReadResult
} from '../../shared/logs';
