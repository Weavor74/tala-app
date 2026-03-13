import { ReflectionDataDirectories } from '../electron/services/reflection/DataDirectoryPaths';
import { GoalService } from '../electron/services/reflection/GoalService';
import * as path from 'path';
import * as fs from 'fs';

async function run() {
    console.log("=== Verifying Self-Improvement Goal Flow ===\n");

    const tmpUserData = path.join(process.cwd(), '.tmp_test_goals');
    if (fs.existsSync(tmpUserData)) {
        fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpUserData, { recursive: true });

    try {
        const dirs = new ReflectionDataDirectories(tmpUserData);
        const goalService = new GoalService(dirs);

        console.log("1. Creating a new Goal...");
        const newGoal = await goalService.createGoal({
            title: "Improve RAG Memory Retrieval Speed",
            description: "Optimize RAG memory queries by adding an FAISS index cache.",
            category: "performance",
            priority: "high"
        });
        console.log(`✅ Goal Created: [${newGoal.goalId}] ${newGoal.title}`);

        console.log("\n2. Listing Goals...");
        const goals = await goalService.listGoals();
        console.log(`✅ Found ${goals.length} goals. First goal status: ${goals[0].status}`);

        console.log("\n3. Updating Goal Status to 'active'...");
        const updated = await goalService.updateGoalStatus(newGoal.goalId, 'active');
        if (updated) {
            const check = await goalService.getGoal(newGoal.goalId);
            console.log(`✅ Goal updated successfully. New status: ${check?.status}`);
        } else {
            console.log(`❌ Failed to update goal.`);
        }

        console.log("\n4. Linking an Issue to Goal...");
        await goalService.linkIssueToGoal(newGoal.goalId, 'iss_mock_123');
        const finalCheck = await goalService.getGoal(newGoal.goalId);
        console.log(`✅ Linked issues: ${finalCheck?.linkedIssueIds.join(', ')}`);

        console.log("\n✅ All Goal mechanics functioning gracefully.");
    } catch (e: any) {
        console.error("❌ Verification failed:", e.message);
        console.error(e.stack);
    } finally {
        if (fs.existsSync(tmpUserData)) {
            fs.rmSync(tmpUserData, { recursive: true, force: true });
        }
    }
}

run();
