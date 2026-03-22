# Service: VoiceService.ts

**Source**: [electron/services/VoiceService.ts](../../electron/services/VoiceService.ts)

## Class: `VoiceService`

## Overview
VoiceService — Handles speech-to-text (Whisper) and text-to-speech (ElevenLabs).
 
 **STT (Speech-to-Text)**:
   - Uses OpenAI-compatible Whisper API for transcription
   - Supports local whisper.cpp or remote OpenAI Whisper endpoint
 
 **TTS (Text-to-Speech)**:
   - Uses ElevenLabs API for high-quality voice synthesis
   - Falls back to system TTS if no API key is configured
 
 @capability [CAPABILITY 6.1] Voice Input/Output

### Methods

#### `transcribe`
Transcribes an audio file using Whisper API.
 
 @param audioPath - Path to audio file (wav, mp3, ogg, webm, etc.)
 @param language - Optional language hint (e.g., 'en')
 @returns Transcribed text
/

**Arguments**: `audioPath: string, language?: string`
**Returns**: `Promise<string>`

---
#### `synthesize`
Converts text to speech using ElevenLabs API.
 
 @param text - Text to synthesize
 @param outputFileName - Optional output file name (defaults to timestamp)
 @returns Path to the generated audio file
/

**Arguments**: `text: string, outputFileName?: string`
**Returns**: `Promise<string>`

---
#### `transcribeBuffer`
Transcribes an audio buffer (e.g., from a microphone recording).
 
 Temporarily persists the buffer to a file in the voice output directory, 
 calls `transcribe()`, and ensures the temp file is cleaned up afterward.
 
 @param audioBuffer - The raw audio data.
 @param format - The audio format/extension (default: `'webm'`).
 @returns Transcribed text.
/

**Arguments**: `audioBuffer: Buffer, format: string = 'webm'`
**Returns**: `Promise<string>`

---
