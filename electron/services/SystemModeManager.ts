import type {
    SystemCapability,
    SystemDegradationFlag,
    SystemHealthOverallStatus,
    SystemModeContract,
    SystemModeTransition,
    SystemOperatingMode,
} from '../../shared/system-health-types';
import { TelemetryBus } from './telemetry/TelemetryBus';

interface ModeInput {
    timestamp: string;
    overallStatus: SystemHealthOverallStatus;
    degradedCapabilities: string[];
    blockedCapabilities: string[];
    pendingRepairs: string[];
    activeFallbacks: string[];
    operatorAttentionRequired: boolean;
    trustScore: number;
}

export interface SystemModeSnapshot {
    effectiveMode: SystemOperatingMode;
    activeFlags: SystemDegradationFlag[];
    modeContract: SystemModeContract;
    recentTransitions: SystemModeTransition[];
}

const BASE_ALLOWED_CAPABILITIES: SystemCapability[] = [
    'chat_inference',
    'workflow_execute',
    'tool_execute_read',
    'tool_execute_write',
    'tool_execute_diagnostic',
    'memory_canonical_read',
    'memory_canonical_write',
    'memory_promotion',
    'autonomy_execute',
    'repair_execute',
    'repair_promotion',
    'self_modify',
];

const MODE_CONTRACTS: Record<SystemOperatingMode, Omit<SystemModeContract, 'mode'>> = {
    NORMAL: {
        entry_conditions: ['All canonical subsystems healthy with acceptable trust score.'],
        exit_conditions: ['Any deterministic degradation or guardrail maintenance trigger.'],
        allowed_capabilities: [...BASE_ALLOWED_CAPABILITIES],
        blocked_capabilities: [],
        fallback_behavior: ['No fallback required.'],
        user_facing_behavior_changes: ['No restrictions banner shown.'],
        telemetry_expectations: ['mode.active=NORMAL', 'mode.transition when changed'],
        operator_actions_allowed: ['all_standard_runtime_controls'],
        autonomy_allowed: true,
        writes_allowed: true,
        operator_approval_required_for: [],
    },
    DEGRADED_INFERENCE: {
        entry_conditions: ['Inference primary unavailable or fallback routing active.'],
        exit_conditions: ['Primary inference path returns to healthy readiness.'],
        allowed_capabilities: [...BASE_ALLOWED_CAPABILITIES],
        blocked_capabilities: [],
        fallback_behavior: ['Route to fallback providers with explicit operator visibility.'],
        user_facing_behavior_changes: ['Operator sees DEGRADED_INFERENCE banner and fallback list.'],
        telemetry_expectations: ['inference_fallback_active', 'mode.active=DEGRADED_INFERENCE'],
        operator_actions_allowed: ['probe_providers', 'restart_provider', 'force_provider_selection'],
        autonomy_allowed: true,
        writes_allowed: true,
        operator_approval_required_for: [],
    },
    DEGRADED_MEMORY: {
        entry_conditions: ['Canonical memory authority impaired but not fully failed.'],
        exit_conditions: ['Canonical memory validation and DB capabilities restored.'],
        allowed_capabilities: BASE_ALLOWED_CAPABILITIES.filter((c) => c !== 'memory_promotion'),
        blocked_capabilities: ['memory_promotion'],
        fallback_behavior: ['Permit read pathways, pause promotion/supersession, reduce trust score.'],
        user_facing_behavior_changes: ['Operator offered revalidate_authority and enter_read_only actions.'],
        telemetry_expectations: ['memory_authority_degraded', 'mode.active=DEGRADED_MEMORY'],
        operator_actions_allowed: ['revalidate_authority', 'enter_read_only', 'run_memory_repair'],
        autonomy_allowed: true,
        writes_allowed: true,
        operator_approval_required_for: ['repair_promotion'],
    },
    DEGRADED_TOOLS: {
        entry_conditions: ['Tooling surface has unavailable MCP or elevated tool failures.'],
        exit_conditions: ['Tool reliability and MCP inventory return to healthy thresholds.'],
        allowed_capabilities: BASE_ALLOWED_CAPABILITIES.filter((c) => c !== 'tool_execute_write'),
        blocked_capabilities: ['tool_execute_write'],
        fallback_behavior: ['Restrict to diagnostic/read tooling and explicit fallback routes.'],
        user_facing_behavior_changes: ['Write-class tools hidden/blocked in runtime surfaces.'],
        telemetry_expectations: ['tool_execution_error_rate_elevated', 'mode.active=DEGRADED_TOOLS'],
        operator_actions_allowed: ['probe_mcp_services', 'restart_mcp_service', 'review_tool_failures'],
        autonomy_allowed: true,
        writes_allowed: true,
        operator_approval_required_for: ['tool_execute_write'],
    },
    DEGRADED_AUTONOMY: {
        entry_conditions: ['Autonomy disabled, blocked, or heavily backlogged.'],
        exit_conditions: ['Autonomy policy green and backlog below threshold.'],
        allowed_capabilities: BASE_ALLOWED_CAPABILITIES.filter((c) => c !== 'autonomy_execute'),
        blocked_capabilities: ['autonomy_execute'],
        fallback_behavior: ['Route pending work to operator/manual execution.'],
        user_facing_behavior_changes: ['Autonomy dashboard highlights blocked queue and manual controls.'],
        telemetry_expectations: ['autonomy_blocked_goals_present', 'mode.active=DEGRADED_AUTONOMY'],
        operator_actions_allowed: ['review_blocked_goals', 'resume_autonomy', 'drain_queue'],
        autonomy_allowed: false,
        writes_allowed: true,
        operator_approval_required_for: ['autonomy_execute'],
    },
    SAFE_MODE: {
        entry_conditions: ['Critical impairment without full read-only enforcement path.'],
        exit_conditions: ['Critical subsystems recover to degraded/healthy levels.'],
        allowed_capabilities: ['chat_inference', 'tool_execute_read', 'tool_execute_diagnostic', 'memory_canonical_read'],
        blocked_capabilities: [
            'workflow_execute',
            'tool_execute_write',
            'memory_canonical_write',
            'memory_promotion',
            'autonomy_execute',
            'repair_execute',
            'repair_promotion',
            'self_modify',
        ],
        fallback_behavior: ['Run read/diagnostic-only operations until operator resolves incident.'],
        user_facing_behavior_changes: ['Persistent SAFE_MODE banner; risky actions blocked.'],
        telemetry_expectations: ['mode.active=SAFE_MODE', 'execution.blocked for denied actions'],
        operator_actions_allowed: ['inspect_diagnostics', 'run_recovery', 'switch_to_read_only'],
        autonomy_allowed: false,
        writes_allowed: false,
        operator_approval_required_for: ['repair_promotion', 'workflow_execute', 'tool_execute_write'],
    },
    READ_ONLY: {
        entry_conditions: ['Canonical memory truth path failed or integrity not trusted.'],
        exit_conditions: ['Memory authority restored and revalidated.'],
        allowed_capabilities: ['chat_inference', 'tool_execute_read', 'tool_execute_diagnostic', 'memory_canonical_read'],
        blocked_capabilities: [
            'workflow_execute',
            'tool_execute_write',
            'memory_canonical_write',
            'memory_promotion',
            'autonomy_execute',
            'repair_promotion',
            'self_modify',
        ],
        fallback_behavior: ['Canonical writes paused; reads allowed when freshness checks pass.'],
        user_facing_behavior_changes: ['READ_ONLY badge and write disable notices across runtime surfaces.'],
        telemetry_expectations: ['mode.active=READ_ONLY', 'memory_authority_unavailable'],
        operator_actions_allowed: ['revalidate_authority', 'inspect_db_health', 'enter_recovery'],
        autonomy_allowed: false,
        writes_allowed: false,
        operator_approval_required_for: ['memory_canonical_write', 'repair_promotion', 'tool_execute_write'],
    },
    RECOVERY: {
        entry_conditions: ['Active repair flow or pending repair queue detected.'],
        exit_conditions: ['Repairs complete and no pending repair actions remain.'],
        allowed_capabilities: BASE_ALLOWED_CAPABILITIES.filter((c) => c !== 'repair_promotion'),
        blocked_capabilities: ['repair_promotion'],
        fallback_behavior: ['Continue service with guarded repairs and explicit state visibility.'],
        user_facing_behavior_changes: ['Recovery indicator shown with pending repair count.'],
        telemetry_expectations: ['memory_repair_in_progress', 'mode.active=RECOVERY'],
        operator_actions_allowed: ['review_repair_queue', 'approve_repair_promotion', 'pause_repairs'],
        autonomy_allowed: false,
        writes_allowed: true,
        operator_approval_required_for: ['repair_promotion'],
    },
    MAINTENANCE: {
        entry_conditions: ['System intentionally placed in maintenance posture.'],
        exit_conditions: ['Maintenance conditions cleared and policy profile active.'],
        allowed_capabilities: ['tool_execute_diagnostic', 'memory_canonical_read'],
        blocked_capabilities: [
            'chat_inference',
            'workflow_execute',
            'tool_execute_write',
            'memory_canonical_write',
            'memory_promotion',
            'autonomy_execute',
            'repair_promotion',
            'self_modify',
        ],
        fallback_behavior: ['Diagnostics-only operation while maintenance tasks complete.'],
        user_facing_behavior_changes: ['Maintenance banner always visible; interactive paths restricted.'],
        telemetry_expectations: ['mode.active=MAINTENANCE', 'execution.blocked for interactive actions'],
        operator_actions_allowed: ['run_maintenance_checks', 'probe_subsystems', 'exit_maintenance'],
        autonomy_allowed: false,
        writes_allowed: false,
        operator_approval_required_for: ['chat_inference', 'workflow_execute', 'tool_execute_write'],
    },
};

export class SystemModeManager {
    private currentMode: SystemOperatingMode = 'NORMAL';
    private recentTransitions: SystemModeTransition[] = [];

    public evaluate(input: ModeInput): SystemModeSnapshot {
        const activeFlags = this.deriveFlags(input);
        const nextMode = this.resolveEffectiveMode(input, activeFlags);
        const transition = this.recordTransitionIfNeeded(input.timestamp, nextMode, activeFlags);

        if (transition) {
            TelemetryBus.getInstance().emit({
                executionId: `mode-${transition.transitioned_at}`,
                subsystem: 'system',
                event: 'execution.mode_transition',
                phase: 'runtime_mode',
                payload: {
                    fromMode: transition.from_mode,
                    toMode: transition.to_mode,
                    reasonCodes: transition.reason_codes,
                },
            });
        }

        return {
            effectiveMode: this.currentMode,
            activeFlags,
            modeContract: this.getContract(this.currentMode),
            recentTransitions: [...this.recentTransitions],
        };
    }

    public isCapabilityAllowed(capability: SystemCapability, snapshot: SystemModeSnapshot): boolean {
        return snapshot.modeContract.allowed_capabilities.includes(capability)
            && !snapshot.modeContract.blocked_capabilities.includes(capability);
    }

    private deriveFlags(input: ModeInput): SystemDegradationFlag[] {
        const flags = new Set<SystemDegradationFlag>();
        const has = (value: string) => input.degradedCapabilities.includes(value) || input.blockedCapabilities.includes(value);

        if (has('memory_authority_service') || has('db_health_service')) flags.add('DEGRADED_MEMORY');
        if (has('inference_service')) flags.add('DEGRADED_INFERENCE');
        if (has('mcp_tool_availability') || has('tool_execution_coordinator')) flags.add('DEGRADED_TOOLS');
        if (has('autonomy_orchestrator') || has('queue_backlog_pressure')) flags.add('DEGRADED_AUTONOMY');
        if (input.overallStatus === 'recovery') flags.add('RECOVERY');
        if (input.overallStatus === 'maintenance') flags.add('MAINTENANCE');
        if (input.overallStatus === 'failed' || input.operatorAttentionRequired || input.trustScore < 0.6) flags.add('SAFE_MODE');
        if (has('memory_authority_service') && input.overallStatus !== 'healthy') flags.add('READ_ONLY');

        return Array.from(flags.values()).sort();
    }

    private resolveEffectiveMode(input: ModeInput, flags: SystemDegradationFlag[]): SystemOperatingMode {
        const has = (flag: SystemDegradationFlag) => flags.includes(flag);
        const hasMemoryFailure = input.blockedCapabilities.includes('memory_authority_service');

        if (has('MAINTENANCE')) return 'MAINTENANCE';
        if (hasMemoryFailure || (has('READ_ONLY') && (input.overallStatus === 'failed' || input.overallStatus === 'impaired'))) {
            return 'READ_ONLY';
        }
        if (has('SAFE_MODE') && (input.overallStatus === 'failed' || input.overallStatus === 'impaired')) {
            return 'SAFE_MODE';
        }
        if (has('RECOVERY')) return 'RECOVERY';
        if (has('DEGRADED_MEMORY')) return 'DEGRADED_MEMORY';
        if (has('DEGRADED_INFERENCE')) return 'DEGRADED_INFERENCE';
        if (has('DEGRADED_TOOLS')) return 'DEGRADED_TOOLS';
        if (has('DEGRADED_AUTONOMY')) return 'DEGRADED_AUTONOMY';
        return 'NORMAL';
    }

    private getContract(mode: SystemOperatingMode): SystemModeContract {
        return {
            mode,
            ...MODE_CONTRACTS[mode],
        };
    }

    private recordTransitionIfNeeded(
        now: string,
        nextMode: SystemOperatingMode,
        flags: SystemDegradationFlag[],
    ): SystemModeTransition | null {
        if (nextMode === this.currentMode) return null;
        const transition: SystemModeTransition = {
            from_mode: this.currentMode,
            to_mode: nextMode,
            transitioned_at: now,
            reason_codes: flags.length > 0 ? flags : ['deterministic_mode_transition'],
        };
        this.currentMode = nextMode;
        this.recentTransitions.push(transition);
        if (this.recentTransitions.length > 30) {
            this.recentTransitions = this.recentTransitions.slice(-30);
        }
        return transition;
    }
}
