const fs = require('fs');
const path = require('path');

// Mock classes for simple JS testing if needed, or just require compiled versions.
// Since I can't easily require .ts files in pure node without setup, 
// I'll just check if the directory structure for indexing can be created.

const baseDir = process.cwd();
const indexDir = path.join(baseDir, 'data', 'docs_index');

console.log('Testing index directory creation...');
if (!fs.existsSync(indexDir)) {
    console.log('Creating directory:', indexDir);
    fs.mkdirSync(indexDir, { recursive: true });
}

if (fs.existsSync(indexDir)) {
    console.log('SUCCESS: Index directory created/exists.');
    fs.writeFileSync(path.join(indexDir, 'test.txt'), 'test');
    if (fs.existsSync(path.join(indexDir, 'test.txt'))) {
        console.log('SUCCESS: Can write to index directory.');
        fs.unlinkSync(path.join(indexDir, 'test.txt'));
    }
} else {
    console.log('FAILURE: Could not create index directory.');
}
