# Tala Portable USB Guide

This guide explains how to bundle Tala into a portable version that can be run directly from a USB drive without copying thousands of small library files.

## 1. Prerequisites
- Ensure you have downloaded the **Local Engine Binary** and at least one **GGUF Model** in the **Settings > Inference** menu.
- **Zero-Dependency**: Download the **Portable Python** runtime in the same menu. This ensures all AI features (Memory, RAG, MCP) work on host machines without Python installed.
- Ensure your `bin/` and `models/` folders are populated.

## 2. Portable Configuration
To make Tala handle all data locally on the USB (including chat history and memory):
1. Create an empty file named `portable.flag` in the root of your application folder (next to `Tala.exe`).
2. When this file is present, Tala will:
   - Save all settings to `data/app_settings.json`.
   - Store all memories/profiles in the `data/` folder.
   - Prioritize bundled Python in `bin/python` over system Python.

## 3. Building the Self-Modifying Version
Run the following command in your terminal:
... (rest of the file)

```bash
npm run dist
```

This command will:
1. Compile the TypeScript and React code.
2. Bundle all `node_modules` into optimized files.
3. Package the native `llama-server` and your models.
4. **Important**: It does NOT use ASAR packing, ensuring the source code remains directly editable in the `resources/app` folder.

## 3. Deployment to USB
1. Go to the `dist/win-unpacked` (or similar for your OS) folder in your project.
2. Copy the entire contents of this folder to your USB drive.

## 4. Running from USB
- Run `Tala.exe` (or the main binary) from the USB drive.
- No installation is required.
- **Self-Modification**: The agent can now read and write to its own source code within the `resources/app` directory of your USB drive.

> [!TIP]
> If you want to keep your chat history on the USB, ensure the application is configured to look for its data directory relative to the executable (Portable Mode).
