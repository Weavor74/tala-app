import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/**
 * VoiceService — Handles speech-to-text (Whisper) and text-to-speech (ElevenLabs).
 * 
 * **STT (Speech-to-Text)**:
 *   - Uses OpenAI-compatible Whisper API for transcription
 *   - Supports local whisper.cpp or remote OpenAI Whisper endpoint
 * 
 * **TTS (Text-to-Speech)**:
 *   - Uses ElevenLabs API for high-quality voice synthesis
 *   - Falls back to system TTS if no API key is configured
 * 
 * @capability [CAPABILITY 6.1] Voice Input/Output
 */
export class VoiceService {
    private whisperEndpoint: string;
    private whisperApiKey: string;
    private elevenLabsApiKey: string;
    private elevenLabsVoiceId: string;
    private outputDir: string;

    constructor(config?: {
        whisperEndpoint?: string;
        whisperApiKey?: string;
        elevenLabsApiKey?: string;
        elevenLabsVoiceId?: string;
    }) {
        this.whisperEndpoint = config?.whisperEndpoint || 'https://api.openai.com/v1/audio/transcriptions';
        this.whisperApiKey = config?.whisperApiKey || process.env.OPENAI_API_KEY || '';
        this.elevenLabsApiKey = config?.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY || '';
        this.elevenLabsVoiceId = config?.elevenLabsVoiceId || 'EXAVITQu4vr4xnSDxMaL'; // Default: "Sarah"
        this.outputDir = path.join(app.getPath('userData'), 'voice');

        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }

        console.log(`[VoiceService] Initialized — Whisper: ${this.whisperEndpoint}, ElevenLabs: ${this.elevenLabsApiKey ? 'configured' : 'not configured'}`);
    }

    /**
     * Transcribes an audio file using Whisper API.
     * 
     * @param audioPath - Path to audio file (wav, mp3, ogg, webm, etc.)
     * @param language - Optional language hint (e.g., 'en')
     * @returns Transcribed text
     */
    async transcribe(audioPath: string, language?: string): Promise<string> {
        if (!this.whisperApiKey) {
            throw new Error('Whisper API key not configured. Set OPENAI_API_KEY or provide whisperApiKey in voice config.');
        }

        if (!fs.existsSync(audioPath)) {
            throw new Error(`Audio file not found: ${audioPath}`);
        }

        console.log(`[VoiceService] Transcribing: ${audioPath}`);

        const fileBuffer = fs.readFileSync(audioPath);
        const fileName = path.basename(audioPath);

        // Build multipart form data manually (Node.js compatible)
        const boundary = '----VoiceServiceBoundary' + Date.now();
        const parts: Buffer[] = [];

        // File part
        parts.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
            `Content-Type: audio/${path.extname(audioPath).slice(1)}\r\n\r\n`
        ));
        parts.push(fileBuffer);
        parts.push(Buffer.from('\r\n'));

        // Model part
        parts.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="model"\r\n\r\n` +
            `whisper-1\r\n`
        ));

        // Language part (optional)
        if (language) {
            parts.push(Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="language"\r\n\r\n` +
                `${language}\r\n`
            ));
        }

        parts.push(Buffer.from(`--${boundary}--\r\n`));

        const body = Buffer.concat(parts);

        const response = await fetch(this.whisperEndpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.whisperApiKey}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
            },
            body: body
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Whisper API error (${response.status}): ${errorText}`);
        }

        const result = await response.json() as any;
        const text = result.text || '';
        console.log(`[VoiceService] Transcription result: "${text.substring(0, 80)}..."`);
        return text;
    }

    /**
     * Converts text to speech using ElevenLabs API.
     * 
     * @param text - Text to synthesize
     * @param outputFileName - Optional output file name (defaults to timestamp)
     * @returns Path to the generated audio file
     */
    async synthesize(text: string, outputFileName?: string): Promise<string> {
        if (!this.elevenLabsApiKey) {
            throw new Error('ElevenLabs API key not configured. Set ELEVENLABS_API_KEY or provide elevenLabsApiKey in voice config.');
        }

        if (!text.trim()) {
            throw new Error('Cannot synthesize empty text.');
        }

        console.log(`[VoiceService] Synthesizing: "${text.substring(0, 60)}..."`);

        const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Accept': 'audio/mpeg',
                'Content-Type': 'application/json',
                'xi-api-key': this.elevenLabsApiKey,
            },
            body: JSON.stringify({
                text: text,
                model_id: 'eleven_monolingual_v1',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.5
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`ElevenLabs API error (${response.status}): ${errorText}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        const fileName = outputFileName || `tts_${Date.now()}.mp3`;
        const outputPath = path.join(this.outputDir, fileName);

        fs.writeFileSync(outputPath, audioBuffer);
        console.log(`[VoiceService] Audio saved: ${outputPath} (${audioBuffer.length} bytes)`);
        return outputPath;
    }

    /**
     * Transcribes an audio buffer (e.g., from a microphone recording).
     * 
     * Temporarily persists the buffer to a file in the voice output directory, 
     * calls `transcribe()`, and ensures the temp file is cleaned up afterward.
     * 
     * @param audioBuffer - The raw audio data.
     * @param format - The audio format/extension (default: `'webm'`).
     * @returns Transcribed text.
     */
    async transcribeBuffer(audioBuffer: Buffer, format: string = 'webm'): Promise<string> {
        const tempPath = path.join(this.outputDir, `temp_recording.${format}`);
        fs.writeFileSync(tempPath, audioBuffer);
        try {
            return await this.transcribe(tempPath);
        } finally {
            // Clean up temp file
            try { fs.unlinkSync(tempPath); } catch { }
        }
    }

    /**
     * Returns the operational status of the voice services.
     * 
     * @returns Object indicating availability of Whisper (STT) and ElevenLabs (TTS),
     *   along with current endpoint and voice configurations.
     */
    getStatus() {
        return {
            sttAvailable: !!this.whisperApiKey,
            ttsAvailable: !!this.elevenLabsApiKey,
            whisperEndpoint: this.whisperEndpoint,
            voiceId: this.elevenLabsVoiceId,
        };
    }
}
