# Tala Node.js Environment Audit

This document details the Node.js dependencies and environment configuration for the Tala application.

## Core Application (tala-app)

| Property | Value |
| :--- | :--- |
| Name | `tala-app` |
| Private | `true` |
| Main Entry | `dist-electron/electron/main.js` |
| Framework | Vite + React + Electron |

## Dependencies (package.json)

| Dependency | Version | License (Common) |
| :--- | :--- | :--- |
| `@modelcontextprotocol/sdk` | `^1.25.3` | MIT |
| `electron` | `^34.0.0` | MIT |
| `react` | `^19.2.0` | MIT |
| `react-dom` | `^19.2.0` | MIT |
| `reactflow` | `^11.11.4` | MIT |
| `zod` | `^4.3.6` | MIT |
| `uuid` | `^11.1.0` | MIT |
| `xterm` | `^5.3.0` | MIT |
| `chokidar` | `^3.6.0` | MIT |
| `archiver` | `^7.0.1` | MIT |
| `discord.js` | `^14.25.1` | Apache-2.0 |
| `nodemailer` | `^8.0.1` | MIT |
| `imapflow` | `^1.2.9` | MIT |
| `node-pty` | `^1.1.0` | MIT |
| `screenshot-desktop` | `^1.15.3` | MIT |
| `undici` | `^7.22.0` | MIT |

## Dev Dependencies

| Dependency | Version |
| :--- | :--- |
| `vite` | `^7.2.4` |
| `vitest` | `^4.0.18` |
| `typescript` | `~5.9.3` |
| `electron-builder` | `^26.4.0` |
| `eslint` | `^9.39.1` |
| `concurrently` | `^9.2.1` |
| `wait-on` | `^9.0.3` |

## Scripts Summary

- `npm run dev`: Starts Vite, Electron, and Local Inference concurrently.
- `npm run build`: Compiles TypeScript and builds Vite assets.
- `npm run dist`: Packages the application using `electron-builder`.
- `npm run test`: Runs unit tests using `vitest`.
