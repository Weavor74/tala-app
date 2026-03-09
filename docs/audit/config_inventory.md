# Tala — Configuration Inventory
**Audit Mode**: Government-Grade Baseline
**Generated**: 2026-03-09

## 📋 Inventory Summary
This document provides a comprehensive inventory of all configuration files, manifests, and specifications that define the runtime behavior, security posture, and build pipeline of the Tala application.

---

## ⚙️ Configuration & Manifest Inventory

| Config Path | Subsystem | Purpose | Consumed By | Risk Level |
| :--- | :--- | :--- | :--- | :--- |
| `package.json` | Infrastructure | Root npm manifest; defines dependencies. | Npm, Vite | **CRITICAL** |
| `package-lock.json` | Infrastructure | Dependency lockfile for build integrity. | Npm | **HIGH** |
| `tsconfig.json` | Infrastructure | Root TypeScript project configuration. | tsc, IDE | **MEDIUM** |
| `vite.config.ts` | Frontend | Vite build and HMR configuration. | Vite | **HIGH** |
| `vitest.config.ts` | Tests | Unit/Integration testing configuration. | Vitest | **MEDIUM** |
| `agent_profiles.json` | Security/Data | Persona and system prompt definitions. | AgentService | **HIGH** |
| `MASTER_PYTHON_REQUIREMENTS.txt` | Python/MCP | Consolidated Python dependency list. | pip | **MEDIUM** |
| `eslint.config.js` | Quality | Linting and static analysis rules. | ESLint | **LOW** |
| `code_roots.json` | Audit | Metadata defining project source roots. | Audit Tools | **LOW** |
| `subsystem_mapping.json` | Architecture | Mapping of directories to subsystems. | Audit Tools | **LOW** |

---

## 🛡 Risk Level Definitions
- **CRITICAL**: Controls application lifecycle, core dependencies, or entrypoints. Failure can lead to total system compromise or build failure.
- **HIGH**: Controls core logic execution, UI routing, or persistent security settings (e.g., prompts).
- **MEDIUM**: Controls build-time optimizations, test environments, or non-security configurations.
- **LOW**: Non-functional configs like linting or diagnostic metadata.
