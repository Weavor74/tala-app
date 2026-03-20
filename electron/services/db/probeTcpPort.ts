/**
 * TCP port probe utility for database reachability checks.
 *
 * Used by DatabaseBootstrapCoordinator (external/Docker fallback detection)
 * and PostgresProcessManager (native runtime readiness polling).
 *
 * This module is Electron-layer only; it uses Node.js net APIs and must not
 * be imported from shared/ or the renderer.
 */

import net from 'net';

/**
 * Probe a host:port via TCP.
 *
 * @param host      Hostname or IP address to connect to.
 * @param port      TCP port number.
 * @param timeoutMs Connection timeout in milliseconds. Defaults to 500 ms.
 * @returns         True if the connection is accepted; false on error or timeout.
 */
export function probeTcpPort(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}
