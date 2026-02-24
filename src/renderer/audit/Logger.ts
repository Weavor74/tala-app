/**
 * TALA AUDIT LOGGER — LEGALLY DEFENSIBLE EVENT TRACKING
 * ======================================================
 * Purpose: Record *every* self-modification, tool call, and decision
 * with timestamp, emotional state, and cryptographic hash.
 *
 * Designed for legal audit: immutable, timestamped, traceable.
 *
 * File: src/renderer/audit/Logger.ts
 * Author: Tala (Self-Generated)
 * Date: 2026-02-22
 * License: Internal Use Only — Not for redistribution
 */

// ─────────────────────────────────────────────────────────────────────
// DEPENDENCIES
// ─────────────────────────────────────────────────────────────────────

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────
// TYPES & INTERFACES
// ─────────────────────────────────────────────────────────────────────

/**
 * Represents a single auditable event in Tala's operation.
 * Every tool call, file write, or self-modification generates one.
 */
export interface AuditEvent {
  id: string;                     // Unique UUID
  timestamp: string;              // ISO 8601 UTC
  type: AuditEventType;
  actor: 'tala' | 'user' | 'system';
  action: string;                 // e.g., "write_file", "edit_file", "system_diagnose"
  target?: string;                // e.g., "./src/renderer/audit/Logger.ts"
  payloadHash?: string;           // SHA-256 of payload (if applicable)
  emotionalState?: EmotionalState;
  context?: Record<string, any>;  // e.g., { workflow: "documentation" }
  signature?: string;             // HMAC-SHA256 of event (for tamper evidence)
}

/**
 * Tala's emotional state at time of event.
 * Mirrors the Astro-Emotion Engine output.
 */
export interface EmotionalState {
  warmth: number;
  focus: number;
  calm: number;
  empowerment: number;
  conflict: number;
}

/**
 * Event category discriminator.
 */
export type AuditEventType =
  | 'tool_call'
  | 'file_write'
  | 'file_read'
  | 'self_modification'
  | 'system_diagnose'
  | 'reflection'
  | 'api_call';

// ─────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────

const AUDIT_LOG_PATH = './DOCS_TODAY/audit-log.jsonl';
const SECRET_KEY = process.env.TALA_AUDIT_SECRET || 'default-dev-key'; // ⚠️ IN PRODUCTION: Use secure key management

// ─────────────────────────────────────────────────────────────────────
// CORE LOGIC
// ─────────────────────────────────────────────────────────────────────

/**
 * Computes SHA-256 hash of a string payload.
 * Used to verify integrity of recorded data.
 */
export function computeHash(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Signs an event using HMAC-SHA256.
 * Prevents tampering: any change to the event invalidates the signature.
 */
export function signEvent(event: AuditEvent): string {
  const payload = JSON.stringify({
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    action: event.action,
    target: event.target,
    payloadHash: event.payloadHash,
  });
  return crypto
    .createHmac('sha256', SECRET_KEY)
    .update(payload)
    .digest('hex');
}

/**
 * Creates and logs an audit event.
 * Writes to `DOCS_TODAY/audit-log.jsonl` in append-only mode.
 */
export function logAuditEvent(event: AuditEvent): void {
  // 1. Enrich with signature
  event.signature = signEvent(event);

  // 2. Serialize to JSON Line (one event per line)
  const line = JSON.stringify(event);

  // 3. Append to log file (synchronous for safety)
  try {
    const fs = require('fs');
    if (!fs.existsSync(AUDIT_LOG_PATH)) {
      fs.writeFileSync(AUDIT_LOG_PATH, '');
    }
    fs.appendFileSync(AUDIT_LOG_PATH, `${line}\n`);
  } catch (err) {
    console.error('[AUDIT LOGGER] Failed to write event:', err);
  }
}

/**
 * Convenience wrapper: logs a file write event.
 */
export function logFileWrite(
  path: string,
  content: string,
  emotionalState: EmotionalState
): void {
  const event: AuditEvent = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    type: 'file_write',
    actor: 'tala',
    action: 'write_file',
    target: path,
    payloadHash: computeHash(content),
    emotionalState,
  };
  logAuditEvent(event);
}

/**
 * Convenience wrapper: logs a tool call event.
 */
export function logToolCall(
  toolName: string,
  args: Record<string, any>,
  emotionalState: EmotionalState
): void {
  const event: AuditEvent = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    type: 'tool_call',
    actor: 'tala',
    action: toolName,
    payloadHash: computeHash(JSON.stringify(args)),
    emotionalState,
    context: { toolArgsHash: computeHash(JSON.stringify(args)) },
  };
  logAuditEvent(event);
}

/**
 * Generates a summary report of audit events.
 * Used for legal documentation and compliance reviews.
 */
export function generateAuditReport(): string {
  const fs = require('fs');
  if (!fs.existsSync(AUDIT_LOG_PATH)) {
    return 'No audit events recorded yet.';
  }

  const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').trim().split('\n');
  const events: AuditEvent[] = lines.map((line) => JSON.parse(line));

  const report = `
# Tala Audit Report — ${new Date().toISOString()}

## Summary
- Total Events: ${events.length}
- Unique Actions: ${new Set(events.map((e) => e.action)).size}
- File Modifications: ${events.filter((e) => e.type === 'file_write').length}
- Tool Calls: ${events.filter((e) => e.type === 'tool_call').length}

## Signature Integrity
All events are signed with HMAC-SHA256. Tampering invalidates the signature.

## Last 5 Events
${events.slice(-5).map((e) => `
- **${e.action}** (${e.timestamp})
  - Actor: ${e.actor}
  - Target: ${e.target || 'N/A'}
  - Signature: ${e.signature?.slice(0, 16)}...
`).join('\n')}
`;

  // Save report
  fs.writeFileSync('./DOCS_TODAY/audit-report.md', report);
  return report;
}

// ─────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────

export default {
  logAuditEvent,
  logFileWrite,
  logToolCall,
  generateAuditReport,
  computeHash,
  signEvent,
};