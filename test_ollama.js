const { OllamaBrain } = require('./dist-electron/electron/brains/OllamaBrain');
const { fetch } = require('undici');

async function test() {
    const brain = new OllamaBrain('http://localhost:11434', 'huihui_ai/qwen3-abliterated:8b');
    console.log('Pinging Ollama...');
    const ok = await brain.ping();
    console.log('Ping status:', ok);
    if (!ok) return;

    const tools = [
        {
            type: 'function',
            function: {
                name: 'get_weather',
                description: 'Get the current weather in a given location',
                parameters: {
                    type: 'object',
                    properties: {
                        location: { type: 'string', description: 'The city and state, e.g. San Francisco, CA' },
                        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
                    },
                    required: ['location']
                }
            }
        }
    ];

    console.log('Testing generateResponse with tools...');
    try {
        const response = await brain.generateResponse(
            [{ role: 'user', content: 'What is the weather in Tokyo?' }],
            'You are a helpful assistant.',
            tools
        );
        console.log('Response content:', response.content);
        console.log('Tool calls:', response.toolCalls);
    } catch (e) {
        console.error('Error:', e.message);
    }
}

test();
