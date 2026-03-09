import { ReflectionQueueService } from './electron/services/reflection/ReflectionQueueService';
import { ReflectionScheduler } from './electron/services/reflection/ReflectionScheduler';
import { GoalService } from './electron/services/reflection/GoalService';
import { ReflectionDataDirectories } from './electron/services/reflection/DataDirectoryPaths';
import { ReflectionJournalService } from './electron/services/reflection/ReflectionJournalService';
import * as path from 'path';

async function verify() {
    const root = path.join(process.cwd(), 'data_mock');
    const dirs = new ReflectionDataDirectories(root);
    const queue = new ReflectionQueueService(dirs);
    const goals = new GoalService(dirs);
    const journal = new ReflectionJournalService(dirs);

    let executions = 0;
    const scheduler = new ReflectionScheduler(queue, goals, journal, async (qcId) => {
        console.log('Faking execution...', qcId);
        executions++;
        return { success: true, message: 'Fake success' };
    });

    const added = await queue.enqueue({
        type: 'manual_scan',
        source: 'user',
        priority: 'critical',
        attemptCount: 0
    });

    console.log('Enqueued:', added);

    await scheduler.tickNow();

    const state = scheduler.getSchedulerState();
    console.log('State after tick:', state);
    console.log('Executions ran:', executions);

    let pipeline = await scheduler.getPipelineActivity();
    console.log('Pipeline Activity:', pipeline);
}

verify().catch(console.error);
