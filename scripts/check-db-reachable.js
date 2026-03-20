#!/usr/bin/env node
/**
 * check-db-reachable.js
 *
 * Lightweight DB reachability probe for the Tala memory bootstrap flow.
 * Attempts a TCP connection to the configured PostgreSQL endpoint.
 *
 * Resolves configuration (in priority order):
 *   1. TALA_DB_CONNECTION_STRING env var  → parsed for host/port
 *   2. TALA_DB_HOST / TALA_DB_PORT env vars
 *   3. Defaults: localhost:5432
 *
 * Exit codes:
 *   0 — port is reachable (DB is up)
 *   1 — port is not reachable (DB is down or not yet started)
 *
 * Usage:
 *   node scripts/check-db-reachable.js
 */

'use strict';

const net = require('net');

const TIMEOUT_MS = 3000;

function parseConnectionString(connStr) {
  try {
    // Handles postgresql://user:pass@host:port/db
    const url = new URL(connStr);
    return {
      host: url.hostname || 'localhost',
      port: parseInt(url.port || '5432', 10),
    };
  } catch {
    return null;
  }
}

function resolveTarget() {
  const connStr = process.env.TALA_DB_CONNECTION_STRING;
  if (connStr) {
    const parsed = parseConnectionString(connStr);
    if (parsed) return parsed;
  }
  return {
    host: process.env.TALA_DB_HOST || 'localhost',
    port: parseInt(process.env.TALA_DB_PORT || '5432', 10),
  };
}

const { host, port } = resolveTarget();

const socket = new net.Socket();
let resolved = false;

socket.setTimeout(TIMEOUT_MS);

socket.on('connect', () => {
  resolved = true;
  socket.destroy();
  process.exit(0);
});

socket.on('timeout', () => {
  if (!resolved) {
    resolved = true;
    socket.destroy();
    process.exit(1);
  }
});

socket.on('error', () => {
  if (!resolved) {
    resolved = true;
    process.exit(1);
  }
});

socket.connect(port, host);
