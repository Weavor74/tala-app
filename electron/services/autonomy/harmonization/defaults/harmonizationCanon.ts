/**
 * harmonizationCanon.ts — Phase 5.6 P5.6B
 *
 * Built-in canon rule definitions for Phase 5.6.
 *
 * These are source-controlled TypeScript constants — NEVER written at runtime.
 * They define the compliance shape and detection hints for each harmonization pattern.
 *
 * Runtime fields (confidenceCurrent, status, counts) are stored separately in
 * <dataDir>/autonomy/harmonization/canon_registry.json by HarmonizationCanonRegistry.
 *
 * Initial rule set: 5 conservative, high-specificity rules.
 * Selection criteria:
 * - Each rule governs a well-understood, bounded pattern class.
 * - Detection hints are deterministic (regex / string matching only).
 * - riskLevel reflects actual blast radius conservatively.
 * - minDriftSeverity is set to require ≥2 violations before triggering.
 * - initialConfidence: 0.65 — trust is earned through outcomes.
 */

import type { HarmonizationCanonRule, HarmonizationRuleStatus } from '../../../../../shared/harmonizationTypes';

// ─── Static-only shape (runtime fields set to defaults at load time) ──────────

export type CanonRuleStaticDefinition = Omit<
    HarmonizationCanonRule,
    'status' | 'confidenceCurrent' | 'confidenceFloor' | 'confidenceCeiling'
    | 'successCount' | 'failureCount' | 'regressionCount' | 'lastAdjustedAt'
>;

// ─── Built-in canon rules ─────────────────────────────────────────────────────

export const BUILTIN_HARMONIZATION_RULES: CanonRuleStaticDefinition[] = [

    // ─── Rule 1: Preload Exposure Pattern ─────────────────────────────────────
    // All IPC namespace blocks in preload.ts should follow the
    // `tala.<namespace>: { ... }` object literal pattern and namespace
    // strings should follow the `<namespace>:` prefix convention.
    {
        ruleId: 'canon-preload-exposure-pattern',
        label: 'Preload Bridge Namespace Exposure Pattern',
        description:
            'All preload bridge namespaces exposed via contextBridge should use the ' +
            '`tala.<namespace>: { method: () => ipcRenderer.invoke(\'<namespace>:method\') }` pattern. ' +
            'IPC channel strings must use namespace:verb format.',
        patternClass: 'preload_exposure_pattern',
        riskLevel: 'low',
        scopePathIncludes: ['electron/preload.ts'],
        applicableSubsystems: ['preload', 'ipc'],
        complianceDescription:
            'Each namespace block is an object literal keyed on the namespace name. ' +
            'Each method calls ipcRenderer.invoke() with a channel string in the form `namespace:verb`. ' +
            'Each subscription uses ipcRenderer.on() with matching channel and returns a cleanup function.',
        detectionHints: [
            {
                hintKind: 'ipc_naming_check',
                label: 'IPC invoke channel uses namespace:verb format',
                pattern: "ipcRenderer.invoke('",
                expectMatch: true,
                weight: 0.6,
            },
            {
                hintKind: 'presence_absence',
                label: 'contextBridge.exposeInMainWorld present',
                pattern: "contextBridge.exposeInMainWorld",
                expectMatch: true,
                weight: 0.4,
            },
        ],
        exclusionConditions: [
            'File is not electron/preload.ts',
        ],
        minDriftSeverity: 25,
    },

    // ─── Rule 2: Dashboard Subscription Pattern ───────────────────────────────
    // Dashboard panel React components should subscribe to push-update IPC channels
    // via the `tala.<namespace>.onDashboardUpdate()` pattern and return a cleanup fn.
    {
        ruleId: 'canon-dashboard-subscription-pattern',
        label: 'Dashboard IPC Push-Subscription Pattern',
        description:
            'React dashboard panel components should subscribe to backend push events via ' +
            '`tala.<namespace>.onDashboardUpdate(callback)` and call the returned unsub function ' +
            'in the useEffect cleanup. Polling-only patterns without push subscription are drift.',
        patternClass: 'dashboard_subscription_pattern',
        riskLevel: 'low',
        scopePathIncludes: ['src/renderer/components/', 'DashboardPanel.tsx'],
        applicableSubsystems: ['dashboard', 'renderer'],
        complianceDescription:
            'A dashboard panel must import the tala.* namespace via (window as any).tala, ' +
            'call an onDashboardUpdate(listener) method, and return the cleanup function ' +
            'from the useEffect return. The component must not rely on polling alone.',
        detectionHints: [
            {
                hintKind: 'presence_absence',
                label: 'Component uses onDashboardUpdate subscription',
                pattern: 'onDashboardUpdate',
                expectMatch: true,
                weight: 0.5,
            },
            {
                hintKind: 'presence_absence',
                label: 'Component has useEffect cleanup',
                pattern: 'return () =>',
                expectMatch: true,
                weight: 0.3,
            },
            {
                hintKind: 'presence_absence',
                label: 'Component uses window.tala namespace',
                pattern: 'window as any',
                expectMatch: true,
                weight: 0.2,
            },
        ],
        exclusionConditions: [
            'File is not a *DashboardPanel.tsx component',
            'Component does not have an IPC-backed data source',
        ],
        minDriftSeverity: 30,
    },

    // ─── Rule 3: Registry Persistence Pattern ─────────────────────────────────
    // Registry services that persist state to disk should store files under
    // <dataDir>/autonomy/<subsystem>/<filename>.json and use ensureDir at ctor.
    {
        ruleId: 'canon-registry-persistence-pattern',
        label: 'Registry Persistence Storage Convention',
        description:
            'Registry services that persist to disk must store data under ' +
            '`<dataDir>/autonomy/<subsystem>/` subdirectories and call ' +
            'fs.mkdirSync(..., { recursive: true }) during construction.',
        patternClass: 'registry_persistence_pattern',
        riskLevel: 'medium',
        scopePathIncludes: ['electron/services/autonomy/', 'Registry.ts'],
        applicableSubsystems: ['autonomy', 'campaigns', 'recovery', 'harmonization'],
        complianceDescription:
            'The constructor accepts a `dataDir: string` as first parameter. ' +
            'It constructs a subdirectory path via path.join(dataDir, \'autonomy\', <subsystem>). ' +
            'It calls fs.mkdirSync(dir, { recursive: true }) wrapped in try/catch. ' +
            'All JSON persistence uses fs.writeFileSync / fs.readFileSync.',
        detectionHints: [
            {
                hintKind: 'presence_absence',
                label: 'Constructor uses path.join for storage path',
                pattern: 'path.join(',
                expectMatch: true,
                weight: 0.4,
            },
            {
                hintKind: 'presence_absence',
                label: 'Constructor ensures directory exists',
                pattern: 'mkdirSync',
                expectMatch: true,
                weight: 0.4,
            },
            {
                hintKind: 'presence_absence',
                label: 'Uses fs.writeFileSync for persistence',
                pattern: 'writeFileSync',
                expectMatch: true,
                weight: 0.2,
            },
        ],
        exclusionConditions: [
            'File is not a *Registry.ts service',
            'Service is stateless (no disk persistence)',
        ],
        minDriftSeverity: 30,
    },

    // ─── Rule 4: Telemetry Event Naming Pattern ───────────────────────────────
    // All telemetry.operational() calls must use a consistent
    // subsystem label as the first argument ('autonomy' for autonomy services).
    {
        ruleId: 'canon-telemetry-event-naming',
        label: 'Telemetry Event Subsystem Naming Convention',
        description:
            'All telemetry.operational() calls in autonomy services must use ' +
            '\'autonomy\' as the first argument (subsystem label). ' +
            'telemetry.event() calls must not use ad-hoc string keys.',
        patternClass: 'telemetry_event_naming_pattern',
        riskLevel: 'low',
        scopePathIncludes: ['electron/services/autonomy/'],
        applicableSubsystems: ['autonomy', 'campaigns', 'recovery', 'harmonization', 'escalation'],
        complianceDescription:
            'telemetry.operational() first arg is always \'autonomy\'. ' +
            'The source label (4th arg) is the class name. ' +
            'No telemetry.event() calls with arbitrary keys.',
        detectionHints: [
            {
                hintKind: 'telemetry_key_check',
                label: 'telemetry.operational first arg is autonomy subsystem',
                pattern: "telemetry.operational(",
                expectMatch: true,
                weight: 0.6,
            },
            {
                hintKind: 'presence_absence',
                label: 'No bare telemetry.event() calls',
                pattern: 'telemetry.event(',
                expectMatch: false,
                weight: 0.4,
            },
        ],
        exclusionConditions: [
            'File is not in electron/services/autonomy/',
            'File is TelemetryService.ts itself',
        ],
        minDriftSeverity: 20,
    },

    // ─── Rule 5: Service Wiring Pattern ──────────────────────────────────────
    // AppService classes (IPC gateways) should register all handlers in a
    // single registerIpcHandlers() method called from the constructor.
    {
        ruleId: 'canon-service-wiring-pattern',
        label: 'AppService IPC Handler Registration Pattern',
        description:
            'AppService IPC gateway classes must register all ipcMain.handle() calls ' +
            'inside a private registerIpcHandlers() method invoked from the constructor. ' +
            'No ipcMain.handle() calls should appear outside registerIpcHandlers().',
        patternClass: 'service_wiring_pattern',
        riskLevel: 'low',
        scopePathIncludes: ['electron/services/autonomy/', 'AppService.ts'],
        applicableSubsystems: ['autonomy', 'campaigns', 'governance', 'execution'],
        complianceDescription:
            'The constructor calls `this.registerIpcHandlers()`. ' +
            'All `ipcMain.handle()` calls are inside `registerIpcHandlers()`. ' +
            'The class has a private `executeWithTelemetry<T>()` helper method.',
        detectionHints: [
            {
                hintKind: 'presence_absence',
                label: 'Class has registerIpcHandlers method',
                pattern: 'registerIpcHandlers()',
                expectMatch: true,
                weight: 0.5,
            },
            {
                hintKind: 'presence_absence',
                label: 'Class has executeWithTelemetry helper',
                pattern: 'executeWithTelemetry',
                expectMatch: true,
                weight: 0.3,
            },
            {
                hintKind: 'presence_absence',
                label: 'Uses ipcMain.handle',
                pattern: 'ipcMain.handle(',
                expectMatch: true,
                weight: 0.2,
            },
        ],
        exclusionConditions: [
            'File is not an *AppService.ts class',
        ],
        minDriftSeverity: 30,
    },
];

/** Lookup a built-in static rule definition by ID. Returns null if not found. */
export function getBuiltinRuleById(ruleId: string): CanonRuleStaticDefinition | null {
    return BUILTIN_HARMONIZATION_RULES.find(r => r.ruleId === ruleId) ?? null;
}
