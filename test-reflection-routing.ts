import { MaintenanceReflectionEvent } from './shared/maintenance/maintenanceEvents';

const mockEvent: MaintenanceReflectionEvent = {
    id: 'test_1',
    timestamp: new Date().toISOString(),
    domain: 'code',
    severity: 'warning',
    action: 'propose',
    title: 'Test Event',
    summary: 'A test event validating the schema',
    remediation: [
        { label: 'Fix Code', command: 'npm run code:heal' }
    ]
};

console.log('Schema validation passed. Event structure:', JSON.stringify(mockEvent, null, 2));
