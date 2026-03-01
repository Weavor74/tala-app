const fs = require('fs');
const path = require('path');
const appData = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Preferences' : process.env.HOME + "/.local/share");
const memoryPath = 'd:/src/client1/tala-app/data/tala_memory.json';

if (fs.existsSync(memoryPath)) {
    try {
        const raw = fs.readFileSync(memoryPath, 'utf-8');
        const memories = JSON.parse(raw);
        console.log(`Loaded ${memories.length} memories.`);
        const cleaned = memories.filter(m => {
            if (!m.text || typeof m.text !== 'string' || m.text.trim() === '') {
                console.log(`Removing corrupt entry: ${m.id}`);
                return false;
            }
            return true;
        });
        console.log(`Cleaned ${memories.length - cleaned.length} corrupt entries.`);
        fs.writeFileSync(memoryPath, JSON.stringify(cleaned, null, 2));
        console.log('Saved cleaned memories.');
    } catch (e) {
        console.error('Failed to clean memories:', e);
    }
} else {
    console.error('Memory file not found:', memoryPath);
}
