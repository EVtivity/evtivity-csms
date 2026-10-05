// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { connect as tlsConnect } from 'node:tls';

/**
 * Whether a TLS server answers at a wss:// URL: a TLS handshake completes
 * within timeoutMs. It checks reachability only and never verifies the server
 * certificate. Certificate policy belongs to OcppClient
 * (resolveVerifyServerCertificate, TLS_REJECT_UNAUTHORIZED): a station that
 * refuses the certificate must still try to connect, so it reports
 * InvalidCentralSystemCertificate and keeps retrying, as a real station does.
 * The probe sends no data: it closes the socket right after the handshake.
 */
export function isTlsReachable(url: string, timeoutMs = 3000): Promise<boolean> {
  let host: string;
  let port: number;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = Number(parsed.port) || 443;
  } catch {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const socket = tlsConnect({ host, port, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}
