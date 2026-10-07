// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { connect as tlsConnect } from 'node:tls';

/**
 * Error codes Node reports when the TLS handshake completed but the server
 * certificate failed verification: OpenSSL's X509 verify errors
 * (https://nodejs.org/api/tls.html#x509-certificate-error-codes) and the
 * host name check.
 */
const CERTIFICATE_VERIFY_ERRORS = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Whether a TLS server answers at a wss:// URL: a TLS handshake completes
 * within timeoutMs. It checks reachability only. The probe verifies the
 * server certificate as usual, and a certificate that fails verification
 * still counts as reachable, because the handshake that delivered it
 * completed. Certificate policy belongs to OcppClient
 * (resolveVerifyServerCertificate, TLS_REJECT_UNAUTHORIZED): a station that
 * refuses the certificate must still try to connect, so it reports
 * InvalidCentralSystemCertificate and keeps retrying, as a real station does.
 * The probe sends no data: it closes the socket right after the handshake.
 */
export function isTlsReachable(url: string, timeoutMs = 3000): Promise<boolean> {
  const parsed = URL.parse(url);
  if (parsed == null) return Promise.resolve(false);
  const host = parsed.hostname;
  const port = Number(parsed.port) || 443;
  return new Promise<boolean>((resolve) => {
    const socket = tlsConnect({ host, port, timeout: timeoutMs }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(err.code != null && CERTIFICATE_VERIFY_ERRORS.has(err.code));
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}
