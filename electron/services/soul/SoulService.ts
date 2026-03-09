import { ipcMain } from 'electron';
import { SoulLogger } from './SoulLogger';
import { IdentityEvolutionEngine } from './IdentityEvolutionEngine';
import { EthicsEngine } from './EthicsEngine';
import { NarrativeEngine } from './NarrativeEngine';
import { HypothesisEngine } from './HypothesisEngine';

/**
 * Soul & Reasoning Service
 * 
 * The `SoulService` orchestrates TALA's high-level cognitive, existential, and
 * ethical reasoning functions. It acts as the container for modules that manage
 * the agent's identity, narrative memory, and ethical boundaries.
 * 
 * **Core Modules:**
 * - **IdentityEvolutionEngine**: Manages the long-term personality and trait development.
 * - **EthicsEngine**: Evaluates proposed actions against system safety and ethical guidelines.
 * - **NarrativeEngine**: Generates human-readable explanations of system reasoning.
 * - **HypothesisEngine**: Manages the resolution of system ambiguities and experiments.
 * - **SoulLogger**: Maintains a high-fidelity record of deep reasoning decisions.
 */
export class SoulService {
    private logger: SoulLogger;
    private identity: IdentityEvolutionEngine;
    private ethics: EthicsEngine;
    private narrative: NarrativeEngine;
    private hypothesis: HypothesisEngine;

    constructor(userDataDir: string) {
        this.logger = new SoulLogger(userDataDir);
        this.identity = new IdentityEvolutionEngine(userDataDir);
        this.ethics = new EthicsEngine();
        this.narrative = new NarrativeEngine(userDataDir);
        this.hypothesis = new HypothesisEngine(userDataDir);

        console.log('[SoulService] Initialized — Tala’s internal reasoning systems are online.');
    }

    public registerIpcHandlers() {
        // --- Core Soul Data ---
        ipcMain.handle('soul:get-identity', async () => {
            return this.identity.loadState();
        });

        ipcMain.handle('soul:update-identity', async (_, changes, context) => {
            return this.identity.update(changes, context);
        });

        // --- Reflection & Reasoning ---
        ipcMain.handle('soul:get-reflections', async (_, count) => {
            return this.logger.getRecent(count);
        });

        ipcMain.handle('soul:log-decision', async (_, decision, context, emotion, confidence, uncertainties) => {
            return this.logger.log({
                decision,
                context,
                emotionalState: emotion,
                confidence,
                uncertainties
            });
        });

        // --- Ethical Evaluation ---
        ipcMain.handle('soul:evaluate-ethics', async (_, ctx) => {
            return this.ethics.evaluate(ctx);
        });

        // --- Narrative & Storytelling ---
        ipcMain.handle('soul:generate-narrative', async (_, ctx) => {
            return this.narrative.generate(ctx);
        });

        // --- Ambiguity & Hypothesis ---
        ipcMain.handle('soul:propose-hypothesis', async (_, ambiguity, hypothesis, test) => {
            return this.hypothesis.propose(ambiguity, hypothesis, test);
        });

        ipcMain.handle('soul:resolve-hypothesis', async (_, id, status) => {
            return this.hypothesis.resolve(id, status);
        });

        // --- Summaries ---
        ipcMain.handle('soul:get-summary', async () => {
            return {
                reflection: this.logger.generateSummary(),
                identity: this.identity.loadState(),
                recentNarratives: [] // Add if needed
            };
        });
    }
}
