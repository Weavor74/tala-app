/**
 * Main Process Entry Point
 * 
 * This file is the "Central Nervous System" of the Electron application.
 * It coordinates the application lifecycle (ready, window-all-closed),
 * window management, and service orchestration.
 * 
 * **Initialization Flow:**
 * 1. Calls `bootstrap()` to setup local data paths.
 * 2. Instantiates all core services (Agent, Git, Rag, Memory, etc.).
 * 3. Initializes the IPC router to bridge renderer calls to services.
 * 4. Spawns the main UI window.
 * 5. Starts background schedulers (Workflows, Backups).
 */
import 'dotenv/config'
import './bootstrap';
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { APP_ROOT, localStorageRootPath, resolveStoragePath } from './services/PathResolver';
import { AgentService } from './services/AgentService';
import { FileService } from './services/FileService';
import { TerminalService } from './services/TerminalService';
import { SystemService } from './services/SystemService';
import { McpService } from './services/McpService';
import { FunctionService } from './services/FunctionService';
import { WorkflowService } from './services/WorkflowService';
import { WorkflowEngine } from './services/WorkflowEngine';
import { GuardrailService } from './services/GuardrailService';
import { GitService } from './services/GitService';
import { BackupService } from './services/BackupService';
import { InferenceService } from './services/InferenceService';
import { loadSettings, saveSettings, getActiveMode } from './services/SettingsManager';
import { IpcRouter } from './services/IpcRouter';
import { ReflectionService } from './services/reflection/ReflectionService';
import { ReflectionAppService } from './services/reflection/ReflectionAppService';
import { SafeChangePlanner } from './services/reflection/SafeChangePlanner';
import { ExecutionOrchestrator } from './services/execution/ExecutionOrchestrator';
import { ExecutionAppService } from './services/execution/ExecutionAppService';
import { GovernanceAppService } from './services/governance/GovernanceAppService';
import { InvariantRegistry } from './services/selfModel/InvariantRegistry';
import { CapabilityRegistry } from './services/selfModel/CapabilityRegistry';
import { OwnershipMapper } from './services/selfModel/OwnershipMapper';
import { SelfModelScanner } from './services/selfModel/SelfModelScanner';
import { SelfModelBuilder } from './services/selfModel/SelfModelBuilder';
import { SelfModelQueryService } from './services/selfModel/SelfModelQueryService';
import { SelfModelRefreshService } from './services/selfModel/SelfModelRefreshService';
import { SelfModelAppService } from './services/selfModel/SelfModelAppService';
import { VoiceService } from './services/VoiceService';
import { SoulService } from './services/soul/SoulService';
import { UserProfileService } from './services/UserProfileService';
import { CodeAccessPolicy } from './services/CodeAccessPolicy';
import { CodeControlService } from './services/CodeControlService';
import { LogViewerService } from './services/LogViewerService';
import { McpLifecycleManager } from './services/McpLifecycleManager';
import { RuntimeDiagnosticsAggregator } from './services/RuntimeDiagnosticsAggregator';
import { RuntimeControlService } from './services/RuntimeControlService';
import { McpAuthorityService } from './services/mcp/McpAuthorityService';
import { OperatorActionService } from './services/OperatorActionService';
import { SystemModeManager } from './services/SystemModeManager';
import { inferenceDiagnostics } from './services/InferenceDiagnosticsService';
import { WorldModelAssembler } from './services/world/WorldModelAssembler';
import { initCanonicalMemory, shutdownCanonicalMemory, getResearchRepository, getEmbeddingsRepository } from './services/db/initMemoryStore';
import { initRetrievalOrchestrator } from './services/retrieval/RetrievalOrchestratorRegistry';
import { AutonomousRunOrchestrator } from './services/autonomy/AutonomousRunOrchestrator';
import { AutonomyAppService } from './services/autonomy/AutonomyAppService';
import { DEFAULT_AUTONOMY_POLICY } from './services/autonomy/defaults/defaultAutonomyPolicy';
// ── Phase 4.3: Recovery Pack services ─────────────────────────────────────────
import { RecoveryPackRegistry } from './services/autonomy/recovery/RecoveryPackRegistry';
import { RecoveryPackMatcher } from './services/autonomy/recovery/RecoveryPackMatcher';
import { RecoveryPackPlannerAdapter } from './services/autonomy/recovery/RecoveryPackPlannerAdapter';
import { RecoveryPackOutcomeTracker } from './services/autonomy/recovery/RecoveryPackOutcomeTracker';
// ── Phase 5: Adaptive Intelligence Layer ──────────────────────────────────────
import { SubsystemProfileRegistry } from './services/autonomy/adaptive/SubsystemProfileRegistry';
import { GoalValueScoringEngine } from './services/autonomy/adaptive/GoalValueScoringEngine';
import { StrategySelectionEngine } from './services/autonomy/adaptive/StrategySelectionEngine';
import { AdaptivePolicyGate } from './services/autonomy/adaptive/AdaptivePolicyGate';
// ── Phase 5.1: Model Escalation & Bounded Decomposition ───────────────────────
import { ModelCapabilityEvaluator } from './services/autonomy/escalation/ModelCapabilityEvaluator';
import { EscalationPolicyEngine } from './services/autonomy/escalation/EscalationPolicyEngine';
import { DecompositionEngine } from './services/autonomy/escalation/DecompositionEngine';
import { ExecutionStrategySelector } from './services/autonomy/escalation/ExecutionStrategySelector';
import { EscalationAuditTracker } from './services/autonomy/escalation/EscalationAuditTracker';
import { DecompositionOutcomeTracker } from './services/autonomy/escalation/DecompositionOutcomeTracker';
// ── Phase 5.5: Multi-Step Repair Campaigns ────────────────────────────────────
import { RepairCampaignRegistry } from './services/autonomy/campaigns/RepairCampaignRegistry';
import { RepairCampaignPlanner } from './services/autonomy/campaigns/RepairCampaignPlanner';
import { CampaignOutcomeTracker } from './services/autonomy/campaigns/CampaignOutcomeTracker';
import { CampaignSafetyGuard } from './services/autonomy/campaigns/CampaignSafetyGuard';
import { CampaignDashboardBridge } from './services/autonomy/campaigns/CampaignDashboardBridge';
import { RepairCampaignCoordinator } from './services/autonomy/campaigns/RepairCampaignCoordinator';
import { CampaignAppService } from './services/autonomy/CampaignAppService';
// ── Phase 5.6: Code Harmonization Campaigns ───────────────────────────────────
import { HarmonizationCanonRegistry } from './services/autonomy/harmonization/HarmonizationCanonRegistry';
import { HarmonizationDriftDetector } from './services/autonomy/harmonization/HarmonizationDriftDetector';
import { HarmonizationMatcher } from './services/autonomy/harmonization/HarmonizationMatcher';
import { HarmonizationCampaignPlanner } from './services/autonomy/harmonization/HarmonizationCampaignPlanner';
import { HarmonizationOutcomeTracker } from './services/autonomy/harmonization/HarmonizationOutcomeTracker';
import { HarmonizationDashboardBridge } from './services/autonomy/harmonization/HarmonizationDashboardBridge';
import { HarmonizationCoordinator } from './services/autonomy/harmonization/HarmonizationCoordinator';
import { HarmonizationAppService } from './services/autonomy/HarmonizationAppService';
import type { HarmonizationCampaignInput } from '../shared/harmonizationTypes';
// ── Phase 6: Cross-System Intelligence ───────────────────────────────────────
import { CrossSystemSignalAggregator } from './services/autonomy/crossSystem/CrossSystemSignalAggregator';
import { IncidentClusteringEngine } from './services/autonomy/crossSystem/IncidentClusteringEngine';
import { RootCauseAnalyzer } from './services/autonomy/crossSystem/RootCauseAnalyzer';
import { CrossSystemStrategySelector } from './services/autonomy/crossSystem/CrossSystemStrategySelector';
import { CrossSystemOutcomeTracker } from './services/autonomy/crossSystem/CrossSystemOutcomeTracker';
import { CrossSystemDashboardBridge } from './services/autonomy/crossSystem/CrossSystemDashboardBridge';
import { CrossSystemCoordinator } from './services/autonomy/crossSystem/CrossSystemCoordinator';
import { CrossSystemSignalCollector } from './services/autonomy/crossSystem/CrossSystemSignalCollector';
import { CrossSystemAppService } from './services/autonomy/CrossSystemAppService';
// ── Phase 6.1: Strategy Routing ───────────────────────────────────────────────
import { StrategyRoutingEngine } from './services/autonomy/crossSystem/StrategyRoutingEngine';
import { StrategyRoutingOutcomeTracker } from './services/autonomy/crossSystem/StrategyRoutingOutcomeTracker';
import { StrategyRoutingDashboardBridge } from './services/autonomy/crossSystem/StrategyRoutingDashboardBridge';
import { StrategyRoutingAppService } from './services/autonomy/StrategyRoutingAppService';
import { RuntimeErrorLogger } from './services/logging/RuntimeErrorLogger';

// ═══════════════════════════════════════════════════════════════════════
// PATH CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

// Paths derived after bootstrap redirection
const USER_DATA_DIR = localStorageRootPath;
const SYSTEM_SETTINGS_PATH = resolveStoragePath('app_settings.json');

// Deployment Mode: Force local tracking for maximum autonomy
let deploymentMode: 'usb' | 'local' | 'remote' = 'local';
let SETTINGS_PATH = SYSTEM_SETTINGS_PATH;

if (fs.existsSync(SETTINGS_PATH)) {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    deploymentMode = s.deploymentMode || deploymentMode;
  } catch (e) { }
}

const USER_DATA_PATH = resolveStoragePath('user_profile.json');
// Determine effective workspace: defaults to local /workspace if not in dev
const EFFECTIVE_WORKSPACE_ROOT = (process.env.VITE_DEV_SERVER_URL || !app.isPackaged)
  ? APP_ROOT
  : path.join(localStorageRootPath, 'workspace');

// Ensure workspace exists
if (!fs.existsSync(EFFECTIVE_WORKSPACE_ROOT)) {
  fs.mkdirSync(EFFECTIVE_WORKSPACE_ROOT, { recursive: true });
}

const terminalService = new TerminalService();
terminalService.setSettingsPath(SYSTEM_SETTINGS_PATH);
const mcpService = new McpService();
const systemService = new SystemService();
const fileService = new FileService(EFFECTIVE_WORKSPACE_ROOT);
const functionService = new FunctionService(systemService, fileService.getRoot());

const userProfileService = new UserProfileService(USER_DATA_DIR);
const inferenceService = new InferenceService();
const workflowService = new WorkflowService(fileService.getRoot());
const agent = new AgentService(terminalService, functionService, mcpService, inferenceService, userProfileService);
const reflectionService = new ReflectionService(USER_DATA_DIR, SYSTEM_SETTINGS_PATH);

const invariantRegistry = new InvariantRegistry();
const capabilityRegistry = new CapabilityRegistry();
const ownershipMapper = new OwnershipMapper();
const selfModelScanner = new SelfModelScanner();
const selfModelBuilder = new SelfModelBuilder();
const selfModelQueryService = new SelfModelQueryService(invariantRegistry, capabilityRegistry, ownershipMapper, selfModelScanner, selfModelBuilder);
const selfModelRefreshService = new SelfModelRefreshService(invariantRegistry, capabilityRegistry, selfModelQueryService, USER_DATA_DIR);
const selfModelAppService = new SelfModelAppService(selfModelRefreshService, selfModelQueryService);

// SafeChangePlanner requires selfModelQueryService — must come after it
const safePlanner = new SafeChangePlanner(selfModelQueryService, USER_DATA_DIR);

// ─── Governance Layer (Phase 3.5) — must come before ReflectionAppService and ExecutionOrchestrator ────
// Instantiated here so the evaluateForProposal callback can be passed to ReflectionAppService.
const governanceAppService = new GovernanceAppService(
    USER_DATA_DIR,
    (proposalId: string) => safePlanner.listProposals().find(p => p.proposalId === proposalId) ?? null,
);

// Pass the governance evaluation callback so planning:promoteProposal auto-creates a GovernanceDecision.
const reflectionAppService = new ReflectionAppService(
    reflectionService,
    safePlanner,
    (proposal) => governanceAppService.evaluateForProposal(proposal),
);

// ─── Controlled Execution Layer (Phase 3) ─────────────────────────────────────
const executionOrchestrator = new ExecutionOrchestrator(
    USER_DATA_DIR,
    EFFECTIVE_WORKSPACE_ROOT,
    () => invariantRegistry.getAll().map(i => i.id),
    (proposalId: string) => safePlanner.listProposals().find(p => p.proposalId === proposalId) ?? null,
    governanceAppService.getAuthorizationGate(),
);
new ExecutionAppService(executionOrchestrator);

// ─── Phase 4: Autonomous Self-Improvement ─────────────────────────────────────
// Instantiated after governance + execution to provide correct service references.
// globalAutonomyEnabled defaults to false in DEFAULT_AUTONOMY_POLICY (operator must enable).
const autonomousRunOrchestrator = new AutonomousRunOrchestrator(
    USER_DATA_DIR,
    safePlanner,
    governanceAppService,
    executionOrchestrator,
    DEFAULT_AUTONOMY_POLICY,
);

// ─── Phase 4.3: Recovery Pack services ────────────────────────────────────────
// Injected as optional services — orchestrator falls back to standard planning when absent.
const recoveryPackRegistry = new RecoveryPackRegistry(USER_DATA_DIR);
const recoveryPackMatcher = new RecoveryPackMatcher(recoveryPackRegistry);
const recoveryPackPlannerAdapter = new RecoveryPackPlannerAdapter();
const recoveryPackOutcomeTracker = new RecoveryPackOutcomeTracker(USER_DATA_DIR, recoveryPackRegistry);
autonomousRunOrchestrator.setRecoveryPackServices(
    recoveryPackRegistry,
    recoveryPackMatcher,
    recoveryPackPlannerAdapter,
    recoveryPackOutcomeTracker,
);

// ─── Phase 6: Signal Collector — created early, sources registered lazily ─────
// CrossSystemSignalCollector is created here so each phase can register its
// source tracker as it becomes available. The collector is passed to the
// CrossSystemCoordinator in the Phase 6 block below.
const crossSystemSignalCollector = new CrossSystemSignalCollector();
// Register execution run source immediately — AutonomousRunOrchestrator.listRuns(windowMs?) is always available
// (defined at electron/services/autonomy/AutonomousRunOrchestrator.ts:821, delegating to AutonomyAuditService.listRuns)
crossSystemSignalCollector.setExecutionSource(autonomousRunOrchestrator);

// ─── Phase 5: Adaptive Intelligence Layer ─────────────────────────────────────
// Injected as optional services — orchestrator falls back to Phase 4 behavior when absent.
// Must be wired after setRecoveryPackServices() so GoalValueScoringEngine can reference
// the already-instantiated recoveryPackRegistry for pack confidence scoring.
try {
    const subsystemProfileRegistry = new SubsystemProfileRegistry(USER_DATA_DIR);
    const goalValueScoringEngine = new GoalValueScoringEngine(
        autonomousRunOrchestrator.learningRegistry,
        recoveryPackRegistry,
    );
    const strategySelectionEngine = new StrategySelectionEngine();
    const adaptivePolicyGate = new AdaptivePolicyGate();
    autonomousRunOrchestrator.setAdaptiveServices(
        subsystemProfileRegistry,
        goalValueScoringEngine,
        strategySelectionEngine,
        adaptivePolicyGate,
    );
} catch (err) {
    console.warn('[Main] Phase 5 adaptive services failed to initialize — autonomy falls back to Phase 4 behavior:', err);
}

// ─── Phase 5.1: Model Escalation & Bounded Decomposition ──────────────────────
// Injected as optional services — orchestrator skips capability evaluation when absent.
// Must be wired after setAdaptiveServices() (Phase 5) per initialization order.
// Conservative defaults (local_preferred_with_request, requireHumanApprovalForRemote=true)
// are preserved via DEFAULT_ESCALATION_POLICY already set in AutonomousRunOrchestrator.
try {
    const modelCapabilityEvaluator = new ModelCapabilityEvaluator();
    const escalationPolicyEngine = new EscalationPolicyEngine();
    const decompositionEngine = new DecompositionEngine();
    const executionStrategySelector = new ExecutionStrategySelector();
    const escalationAuditTracker = new EscalationAuditTracker();
    const decompositionOutcomeTracker = new DecompositionOutcomeTracker();
    autonomousRunOrchestrator.setEscalationServices(
        modelCapabilityEvaluator,
        escalationPolicyEngine,
        decompositionEngine,
        executionStrategySelector,
        escalationAuditTracker,
        decompositionOutcomeTracker,
    );
    crossSystemSignalCollector.setEscalationSource(escalationAuditTracker);
} catch (err) {
    console.warn('[Main] Phase 5.1 escalation services failed to initialize — autonomy skips capability evaluation:', err);
}

// ─── Phase 5.5: Multi-Step Repair Campaigns ───────────────────────────────────
// Injected as optional services — all campaign steps still flow through Phase 2/3.5/3 gates.
// Must be wired after Phase 5.1 per initialization order.
// Falls back gracefully if any service fails to initialize.
try {
    const campaignRegistry = new RepairCampaignRegistry(USER_DATA_DIR);
    const campaignOutcomeTracker = new CampaignOutcomeTracker(USER_DATA_DIR);
    const campaignSafetyGuard = new CampaignSafetyGuard(campaignRegistry);
    const campaignDashboardBridge = new CampaignDashboardBridge();
    const campaignPlanner = new RepairCampaignPlanner();

    // Recover any stale campaigns from previous sessions before starting
    const staleExpired = campaignSafetyGuard.recoverStaleCampaigns();
    if (staleExpired.length > 0) {
        console.log(`[Main] Phase 5.5: Expired ${staleExpired.length} stale campaign(s) at startup`);
    }

    // The step executor: delegates to the existing autonomous run pipeline.
    // This preserves ALL Phase 2 / 3.5 / 3 safety gates — the coordinator
    // never calls SafeChangePlanner or ExecutionOrchestrator directly.
    const campaignStepExecutor = async (step: any, campaign: any) => {
        return autonomousRunOrchestrator.executeCampaignStep(step, campaign);
    };

    const campaignCoordinator = new RepairCampaignCoordinator(
        campaignRegistry,
        campaignOutcomeTracker,
        campaignSafetyGuard,
        campaignDashboardBridge,
        campaignStepExecutor,
    );

    autonomousRunOrchestrator.setCampaignServices(
        campaignPlanner,
        campaignRegistry,
        campaignCoordinator,
    );

    new CampaignAppService(campaignCoordinator, campaignRegistry, campaignOutcomeTracker);
    crossSystemSignalCollector.setCampaignSource(campaignOutcomeTracker);
} catch (err) {
    console.warn('[Main] Phase 5.5 campaign services failed to initialize — autonomy falls back to single-step execution:', err);
}

// ─── Phase 5.6: Code Harmonization Campaigns ──────────────────────────────────
// Injected as optional services — all harmonization steps still flow through Phase 2/3.5/3 gates.
// Must be wired after Phase 5.5 per initialization order.
// Falls back gracefully if any service fails to initialize.
try {
    const harmonizationCanonRegistry = new HarmonizationCanonRegistry(USER_DATA_DIR);
    const harmonizationDriftDetector = new HarmonizationDriftDetector();
    const harmonizationMatcher = new HarmonizationMatcher();
    const harmonizationPlanner = new HarmonizationCampaignPlanner();
    const harmonizationDashboardBridge = new HarmonizationDashboardBridge();
    const harmonizationOutcomeTracker = new HarmonizationOutcomeTracker(
        USER_DATA_DIR,
        harmonizationCanonRegistry,
    );

    // The step executor: delegates to the existing autonomous run pipeline.
    // This preserves ALL Phase 2 / 3.5 / 3 safety gates.
    const harmonizationStepExecutor = async (filePath: any, campaign: any, metadata: any) => {
        return autonomousRunOrchestrator.executeHarmonizationStep(filePath, campaign, metadata);
    };

    const harmonizationCoordinator = new HarmonizationCoordinator(
        USER_DATA_DIR,
        harmonizationOutcomeTracker,
        harmonizationDashboardBridge,
        harmonizationPlanner,
        harmonizationCanonRegistry,
        harmonizationStepExecutor,
    );

    // Recover any stale campaigns from previous sessions before starting
    const staleHarmonization = harmonizationCoordinator.recoverStaleCampaigns();
    if (staleHarmonization.length > 0) {
        console.log(`[Main] Phase 5.6: Expired ${staleHarmonization.length} stale harmonization campaign(s) at startup`);
    }

    autonomousRunOrchestrator.setHarmonizationServices(harmonizationCoordinator);

    new HarmonizationAppService(harmonizationCoordinator, harmonizationCanonRegistry, harmonizationOutcomeTracker);
    crossSystemSignalCollector.setHarmonizationSource(harmonizationOutcomeTracker);

    // ── Phase 5.6.1: Harmonization Activation ─────────────────────────────────
    // Wire the bounded drift-scan loop and the campaign-advancement loop so that
    // the already-complete harmonization backend runs in the real runtime.
    //
    // Safety constraints:
    //   - Low-frequency intervals (scan: 8 min, advance: 3 min).
    //   - Re-entrancy guards prevent overlapping ticks.
    //   - File gathering is capped to MAX_HARMONIZATION_SCAN_FILES files.
    //   - Skips node_modules, dist, .git, and other non-source directories.
    //   - All errors are caught and logged; neither loop crashes the app.
    try {
        const HARMONIZATION_SCAN_INTERVAL_MS = 8 * 60 * 1000;   // 8 minutes
        const HARMONIZATION_ADVANCE_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
        const MAX_HARMONIZATION_SCAN_FILES = 200;
        const HARMONIZATION_SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.json']);
        const HARMONIZATION_SKIP_DIRS = new Set([
            'node_modules', 'dist', 'out', 'build', '.git', '.vite',
            'coverage', 'tmp', 'data', 'cache', '.cache',
        ]);

        // Re-entrancy guards
        let harmonizationScanInProgress = false;
        let harmonizationAdvanceInProgress = false;

        /**
         * Gathers relevant source-file contents from the workspace root into a
         * Map<filePath, content> for the DriftDetector.  Bounded to at most
         * MAX_HARMONIZATION_SCAN_FILES entries; unreadable files are skipped.
         */
        function gatherHarmonizationFiles(): Map<string, string> {
            const contentMap = new Map<string, string>();

            function walk(dir: string): void {
                if (contentMap.size >= MAX_HARMONIZATION_SCAN_FILES) return;
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    return;
                }
                for (const entry of entries) {
                    if (contentMap.size >= MAX_HARMONIZATION_SCAN_FILES) return;
                    if (entry.isDirectory()) {
                        if (HARMONIZATION_SKIP_DIRS.has(entry.name)) continue;
                        walk(path.join(dir, entry.name));
                    } else if (entry.isFile()) {
                        if (!HARMONIZATION_SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
                        const fullPath = path.join(dir, entry.name);
                        try {
                            contentMap.set(fullPath, fs.readFileSync(fullPath, 'utf-8'));
                        } catch {
                            // skip unreadable files gracefully
                        }
                    }
                }
            }

            walk(EFFECTIVE_WORKSPACE_ROOT);
            return contentMap;
        }

        // ── Scan loop ──────────────────────────────────────────────────────────
        // Every HARMONIZATION_SCAN_INTERVAL_MS:
        //   1. Gather file contents
        //   2. Run DriftDetector
        //   3. Store drift records for the dashboard
        //   4. For each strong_match: build campaign input, plan campaign, register it
        setInterval(async () => {
            if (harmonizationScanInProgress) return;
            harmonizationScanInProgress = true;
            try {
                const rules = harmonizationCanonRegistry.getAll();
                if (rules.length === 0) return;

                const contentMap = gatherHarmonizationFiles();
                console.log(`[Harmonization] Scan started: ${contentMap.size} file(s) gathered`);

                const driftRecords = harmonizationDriftDetector.scan(rules, contentMap);
                harmonizationCoordinator.storeDriftRecords(driftRecords);
                console.log(`[Harmonization] Scan complete: ${driftRecords.length} drift record(s) produced`);

                if (driftRecords.length === 0) return;

                // Match new drift records to canon rules and create campaigns
                const activeSubsystems = harmonizationCoordinator.getActiveSubsystems();
                for (const drift of driftRecords) {
                    try {
                        const match = harmonizationMatcher.match(drift, rules, activeSubsystems);
                        if (!match || match.strength !== 'strong_match' || !match.safetyApproved) continue;

                        const rule = rules.find(r => r.ruleId === drift.ruleId);
                        if (!rule) continue;

                        const verificationRequirements =
                            rule.riskLevel === 'high'   ? ['no_regression', 'governance_approved', 'human_review'] :
                            rule.riskLevel === 'medium' ? ['no_regression', 'governance_approved'] :
                                                          ['no_regression'];

                        const input: HarmonizationCampaignInput = {
                            matchId: match.matchId,
                            driftId: match.driftId,
                            ruleId: match.ruleId,
                            scope: match.proposedScope,
                            riskLevel: rule.riskLevel,
                            verificationRequirements,
                            rollbackExpected: rule.riskLevel !== 'low',
                            skipIfLowConfidence: true,
                        };

                        const campaign = harmonizationPlanner.plan(input, rule);
                        if (campaign) {
                            harmonizationCoordinator.registerCampaign(campaign);
                        }
                    } catch (matchErr: any) {
                        console.warn(`[Harmonization] Match/plan error for drift ${drift.driftId}:`, matchErr?.message ?? matchErr);
                    }
                }
            } catch (err: any) {
                console.error('[Harmonization] Scan loop error:', err?.message ?? err);
            } finally {
                harmonizationScanInProgress = false;
            }
        }, HARMONIZATION_SCAN_INTERVAL_MS);

        // ── Advancement loop ───────────────────────────────────────────────────
        // Every HARMONIZATION_ADVANCE_INTERVAL_MS:
        //   1. Fetch active (non-terminal, non-deferred) campaigns
        //   2. Call advanceCampaign() once per campaign — no inner looping
        //   3. Rely on the coordinator's own state machine for stop/continue/defer
        setInterval(async () => {
            if (harmonizationAdvanceInProgress) return;
            harmonizationAdvanceInProgress = true;
            try {
                const active = harmonizationCoordinator.getActiveCampaigns();
                if (active.length > 0) {
                    console.log(`[Harmonization] Advance tick: ${active.length} campaign(s) considered`);
                }
                for (const campaign of active) {
                    try {
                        await harmonizationCoordinator.advanceCampaign(campaign.campaignId);
                    } catch (advErr: any) {
                        console.warn(`[Harmonization] Campaign ${campaign.campaignId} advance error:`, advErr?.message ?? advErr);
                    }
                }
            } catch (err: any) {
                console.error('[Harmonization] Advance loop error:', err?.message ?? err);
            } finally {
                harmonizationAdvanceInProgress = false;
            }
        }, HARMONIZATION_ADVANCE_INTERVAL_MS);

        console.log('[Main] Phase 5.6.1: Harmonization activation loops started (scan=8min, advance=3min)');
    } catch (activationErr) {
        console.warn('[Main] Phase 5.6.1 harmonization activation failed — harmonization remains in latent mode:', activationErr);
    }
} catch (err) {
    console.warn('[Main] Phase 5.6 harmonization services failed to initialize — harmonization is inactive:', err);
}

// ─── Phase 6: Cross-System Intelligence ───────────────────────────────────────
// Injected as optional services — all strategy decisions still route through Phase 2/3.5/3 gates.
// Must be wired after Phase 5.6 per initialization order.
// Falls back gracefully if any service fails to initialize.
try {
    const crossSystemAggregator = new CrossSystemSignalAggregator();
    const crossSystemClusteringEngine = new IncidentClusteringEngine();
    const crossSystemRootCauseAnalyzer = new RootCauseAnalyzer();
    const crossSystemStrategySelector = new CrossSystemStrategySelector();
    const crossSystemOutcomeTracker = new CrossSystemOutcomeTracker(USER_DATA_DIR);
    const crossSystemDashboardBridge = new CrossSystemDashboardBridge();

    const crossSystemCoordinator = new CrossSystemCoordinator(
        USER_DATA_DIR,
        crossSystemAggregator,
        crossSystemClusteringEngine,
        crossSystemRootCauseAnalyzer,
        crossSystemStrategySelector,
        crossSystemOutcomeTracker,
        crossSystemDashboardBridge,
    );

    autonomousRunOrchestrator.setCrossSystemServices(crossSystemCoordinator);

    // Register signal collector for pull-based ingestion from all source registries
    crossSystemCoordinator.setSignalCollector(crossSystemSignalCollector);

    new CrossSystemAppService(crossSystemCoordinator);

    // ── Phase 6 analysis loop (10 min) ────────────────────────────────────────
    // Low-frequency bounded loop: runs the full clustering → root-cause → strategy pipeline.
    // Re-entrancy is guarded inside CrossSystemCoordinator.runAnalysis().
    try {
        const CROSS_SYSTEM_ANALYSIS_INTERVAL_MS = 10 * 60 * 1000; // 10 min
        setInterval(() => {
            try {
                crossSystemCoordinator.runAnalysis();
            } catch (tickErr) {
                console.warn('[Main] Phase 6 analysis tick error (non-fatal):', tickErr);
            }
        }, CROSS_SYSTEM_ANALYSIS_INTERVAL_MS);
        console.log('[Main] Phase 6: Cross-system intelligence loop started (interval=10min)');
    } catch (activationErr) {
        console.warn('[Main] Phase 6 analysis loop failed to start — intelligence remains in latent mode:', activationErr);
    }
} catch (err) {
    console.warn('[Main] Phase 6 cross-system intelligence services failed to initialize — intelligence is inactive:', err);
}

// ─── Phase 6.1: Strategy Routing ──────────────────────────────────────────────
// Instantiates the strategy routing layer and wires it into the cross-system
// coordinator and autonomous run orchestrator.
// All routing decisions still pass through planning/governance/execution pipelines.
// Falls back gracefully if any service fails to initialize.
try {
    const strategyRoutingOutcomeTracker = new StrategyRoutingOutcomeTracker(USER_DATA_DIR);
    const strategyRoutingDashboardBridge = new StrategyRoutingDashboardBridge();

    const strategyRoutingEngine = new StrategyRoutingEngine(
        USER_DATA_DIR,
        strategyRoutingOutcomeTracker,
        strategyRoutingDashboardBridge,
    );

    // Inject routing engine into the orchestrator
    autonomousRunOrchestrator.setStrategyRoutingServices(
        strategyRoutingEngine,
        strategyRoutingOutcomeTracker,
    );

    // Inject routing engine into the cross-system coordinator so it is called
    // automatically when runAnalysis() produces a new strategy decision.
    // Protected subsystems and active campaign counts are resolved lazily via callbacks.
    const crossSystemCoordinatorForRouting = (autonomousRunOrchestrator as any)._crossSystemCoordinator;
    if (crossSystemCoordinatorForRouting && typeof crossSystemCoordinatorForRouting.setStrategyRoutingEngine === 'function') {
        crossSystemCoordinatorForRouting.setStrategyRoutingEngine(
            strategyRoutingEngine,
            () => {
                // Returns count of active (non-terminal) repair campaigns
                try {
                    const registry = (autonomousRunOrchestrator as any)._campaignRegistry;
                    return registry ? registry.getAll(['active', 'paused']).length : 0;
                } catch { return 0; }
            },
            () => {
                // Returns hard-blocked subsystem IDs from the active autonomy policy
                try {
                    const policy = autonomousRunOrchestrator.getPolicy();
                    return policy?.hardBlockedSubsystems ?? [];
                } catch { return []; }
            },
        );
    }

    new StrategyRoutingAppService(strategyRoutingEngine, strategyRoutingOutcomeTracker);

    console.log('[Main] Phase 6.1: Strategy routing services wired.');
} catch (err) {
    console.warn('[Main] Phase 6.1 strategy routing services failed to initialize — routing is inactive:', err);
}

new AutonomyAppService(autonomousRunOrchestrator);
// Start periodic goal detection (5 min cycle, will run if/when autonomy is enabled)
autonomousRunOrchestrator.start();

const soulService = new SoulService(USER_DATA_DIR);
const voiceService = new VoiceService();
const workflowEngine = new WorkflowEngine(functionService, agent);
const guardrailService = new GuardrailService();
const gitService = new GitService(fileService.getRoot());
const backupService = new BackupService();
const logViewerService = new LogViewerService();

// ─── Runtime Diagnostics (Priority 2A) ───────────────────────────────────────
const mcpLifecycleManager = new McpLifecycleManager(mcpService);
const mcpAuthority = new McpAuthorityService(mcpService, mcpLifecycleManager);
const runtimeControl = new RuntimeControlService(inferenceService, mcpLifecycleManager, mcpService, mcpAuthority);
const diagnosticsAggregator = new RuntimeDiagnosticsAggregator(
  inferenceDiagnostics,
  mcpAuthority as any,
  runtimeControl,
  {
    getStartupStatus: () => agent.getStartupStatus(),
    getCurrentMode: () => getActiveMode(SYSTEM_SETTINGS_PATH, 'RuntimeDiagnosticsAggregator'),
    getAutonomyState: () => autonomousRunOrchestrator.getDashboardState(),
    getReflectionSummary: () => agent.getReflectionSummary(),
  },
);
// Phase D: central mode manager delegates to the canonical diagnostics provider.
SystemModeManager.configureDiagnosticsProvider(() => diagnosticsAggregator);
const operatorActionService = new OperatorActionService({
  diagnosticsAggregator,
  runtimeControl,
  getSettingsPath: () => SETTINGS_PATH,
  autonomyOrchestrator: autonomousRunOrchestrator,
  reflectionService,
  logViewerService,
});

// ─── World Model Assembler (Phase 4A) ─────────────────────────────────────────
const worldModelAssembler = new WorldModelAssembler({ includeRepoState: true });

// Initialize Code Access Policy and Control Service
const codePolicy = new CodeAccessPolicy({
  workspaceRoot: EFFECTIVE_WORKSPACE_ROOT,
  mode: 'auto' // Default to auto, can be updated via settings later
});
const codeControlService = new CodeControlService(fileService, terminalService, codePolicy);

// Register Handlers
soulService.registerIpcHandlers();
reflectionService.start();
selfModelRefreshService.init().catch(e => console.error('[SelfModel] init failed:', e));

// ═══════════════════════════════════════════════════════════════════════
// GLOBAL ERROR LOGGING
// ═══════════════════════════════════════════════════════════════════════

process.on('uncaughtException', (error) => {
  RuntimeErrorLogger.log({
    source: 'process',
    component: 'main',
    event: 'uncaughtException',
    code: 'PROCESS_UNCAUGHT_EXCEPTION',
    message: error?.message || String(error),
    stack: error?.stack,
  });
  console.error('[Main] Uncaught Exception:', error);
  logViewerService.logRuntimeError(error, {
    source: 'runtime_error_main',
    subsystem: 'app',
    eventType: 'uncaughtException',
    processType: 'main'
  });
});

process.on('unhandledRejection', (reason, promise) => {
  const rejectionError = reason instanceof Error ? reason : new Error(String(reason));
  RuntimeErrorLogger.log({
    source: 'process',
    component: 'main',
    event: 'unhandledRejection',
    code: 'PROCESS_UNHANDLED_REJECTION',
    message: rejectionError.message,
    stack: rejectionError.stack,
    metadata: { reason: String(reason) }
  });
  console.error('[Main] Unhandled Rejection at:', promise, 'reason:', reason);
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logViewerService.logRuntimeError(error, {
    source: 'runtime_error_main',
    subsystem: 'app',
    eventType: 'unhandledRejection',
    processType: 'main',
    metadata: { reason: String(reason) }
  });
});

ipcMain.handle('voice:transcribe', async (_e, audioPath: string) => voiceService.transcribe(audioPath));
ipcMain.handle('voice:synthesize', async (_e, text: string) => voiceService.synthesize(text));
ipcMain.handle('voice:transcribe-buffer', async (_e, audioBuffer: Buffer, format: string) => voiceService.transcribeBuffer(audioBuffer, format));
ipcMain.handle('voice:status', async () => voiceService.getStatus());

// Wire Dependencies
agent.setLogViewerService(logViewerService);
agent.setMcpService(mcpService);
agent.setMcpAuthority(mcpAuthority);
agent.setGitService(gitService);
agent.setReflectionService(reflectionService);
agent.setCodeControl(codeControlService);

// Initialize MCP Status (inferred as online if service exists)
logViewerService.setSubsystemStatus('mcp', 'online');

guardrailService.setInferenceFn((prompt: string) => agent.headlessInference(prompt));

// Initialize Workflow Scheduler
workflowService.initScheduler(async (workflowId) => {
  try {
    const workflows = workflowService.listWorkflows();
    const wf = workflows.find((w: any) => w.id === workflowId);
    if (!wf) return;
    const result = await workflowEngine.executeWorkflow(wf, undefined, undefined, 'system');
    const runId = Date.now().toString();
    workflowService.saveRun(workflowId, runId, {
      id: runId,
      workflowId,
      timestamp: parseInt(runId),
      success: result.success,
      error: result.error,
      logs: result.logs,
      context: result.context
    });
  } catch (e) {
    console.error(`[Scheduler] Failed to execute workflow ${workflowId}:`, e);
  }
});

const TEMP_SYSTEM_PATH = resolveStoragePath('temp_system_info.json');

// Detect environment on launch
systemService.detectEnv(fileService.getRoot()).then(info => {
  agent.setSystemInfo(info);
  agent.setWorkspaceRoot(fileService.getRoot());
  gitService.setRoot(fileService.getRoot());
  fs.writeFileSync(TEMP_SYSTEM_PATH, JSON.stringify(info, null, 2));
});

if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let isQuitting = false;

/**
 * createWindow
 * 
 * Orchestrates the creation of the application windows (Splash and Main).
 * It configures the main window with the context bridge preload script
 * and enables essential features like webviewTag for external tool integration.
 */
const createWindow = () => {
  // 1. Create and show Splash Screen
  splashWindow = new BrowserWindow({
    width: 520, height: 380, transparent: true, frame: false, alwaysOnTop: true, resizable: false, center: true, skipTaskbar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    splashWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}splash.html`);
  } else {
    splashWindow.loadFile(path.join(__dirname, '../dist/splash.html'));
  }

  // 2. Create and configure Main Window
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, webviewTag: true, backgroundThrottling: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow?.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow?.webContents.openDevTools();
  } else {
    mainWindow?.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Auto-close splash after a delay
  const closeSplash = () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
  };
  setTimeout(closeSplash, 3000);

  // Link services to the main window for UI updates
  terminalService.setWindow(mainWindow);
  agent.setMainWindow(mainWindow);
};

app.on('ready', async () => {
  createWindow();

  // ─── Canonical Memory Store (Phase A) ───────────────────────────────────────
  // Initialize PostgreSQL-backed canonical memory. Failures are non-fatal;
  // the app continues without canonical memory until the DB is available.
  try {
    await initCanonicalMemory();
  } catch (err) {
    console.warn('[Main] Canonical memory store unavailable — continuing without it:', err);
  }

  // ─── Retrieval Orchestrator ──────────────────────────────────────────────────
  // Wire LocalSearchProvider and ExternalApiSearchProvider (from Settings).
  // Non-fatal: if settings are unavailable the local provider still works.
  try {
    initRetrievalOrchestrator({
      fileService,
      researchRepo: getResearchRepository() ?? undefined,
      embeddingsRepo: getEmbeddingsRepository() ?? undefined,
      settingsPath: SETTINGS_PATH,
    });
  } catch (err) {
    console.warn('[Main] RetrievalOrchestrator init failed — retrieval degraded:', err);
  }

  const info = await systemService.detectEnv(fileService.getRoot());
  const agentPythonPath = info.pythonEnvPath || info.pythonPath;
  agent.setSystemInfo(info);
  agent.igniteSoul(agentPythonPath);
  mcpService.setPythonPath(info.pythonPath); // Use canonical bundled python for MCP servers
  mcpService.startHealthLoop();
  try {
    const settings = loadSettings(SETTINGS_PATH, 'main.mcpAuthority.startup');
    mcpAuthority.syncConfiguredServers(settings.mcpServers ?? []);
    await mcpAuthority.activateAllConfiguredServers();
    await agent.refreshMcpTools();
  } catch (err) {
    console.warn('[Main] MCP authority startup activation failed:', err);
  }
  if (mainWindow) fileService.watchWorkspace(mainWindow);
  backupService.init();

  ipcMain.handle('get-startup-status', async () => agent.getStartupStatus());

  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      if (settings.system?.env) terminalService.setCustomEnv(settings.system.env);
    } catch (e) { }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event: any) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  try {
    await agent.shutdown();
    await mcpService.shutdown();
    await shutdownCanonicalMemory();
  } catch (e) {
  } finally {
    app.exit(0);
  }
});

const ipcRouter = new IpcRouter({
  app,
  getMainWindow: () => mainWindow,
  agent,
  fileService,
  terminalService,
  systemService,
  mcpService,
  mcpAuthority,
  functionService,
  workflowService,
  workflowEngine,
  guardrailService,
  gitService,
  backupService,
  inferenceService,
  userProfileService,
  diagnosticsAggregator,
  runtimeControl,
  operatorActionService,
  getSettingsPath: () => SETTINGS_PATH,
  setSettingsPath: (p) => { SETTINGS_PATH = p; },
  USER_DATA_DIR,
  USER_DATA_PATH,
  APP_DIR: app.getAppPath(),
  PORTABLE_SETTINGS_PATH: path.join(app.getAppPath(), 'app_settings.json'),
  SYSTEM_SETTINGS_PATH,
  TEMP_SYSTEM_PATH,
  codeControlService,
  logViewerService,
  worldModelAssembler,
});
ipcRouter.registerAll();

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

