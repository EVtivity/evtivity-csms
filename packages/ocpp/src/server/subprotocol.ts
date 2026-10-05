// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export type OcppSubprotocol = 'ocpp2.1' | 'ocpp1.6';

/**
 * The OCPP subprotocol the server accepts from the ones a station offers:
 * 2.1 when offered, else 1.6, else none. The WebSocket servers' handleProtocols
 * and the connection authentication both use it, so the protocol stored at
 * authentication is the one the upgrade negotiates.
 */
export function selectOcppSubprotocol(offered: ReadonlySet<string>): OcppSubprotocol | null {
  if (offered.has('ocpp2.1')) return 'ocpp2.1';
  if (offered.has('ocpp1.6')) return 'ocpp1.6';
  return null;
}

/** The subprotocols of a `Sec-WebSocket-Protocol` request header (comma-separated). */
export function offeredSubprotocols(header: string | string[] | undefined): Set<string> {
  if (header == null) return new Set();
  const values = Array.isArray(header) ? header : [header];
  return new Set(
    values
      .flatMap((value) => value.split(','))
      .map((token) => token.trim())
      .filter((token) => token !== ''),
  );
}
