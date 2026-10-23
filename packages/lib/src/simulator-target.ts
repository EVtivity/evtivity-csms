// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Whether a station simulator may connect to `url`: a ws or wss URL on the origin (scheme, host and port) of one of the
 * configured OCPP server URLs and its path (a trailing `/` aside), with no
 * credentials, query or fragment (the simulator appends the station id). Anything else would
 * send the station password, or the profile 3 client certificate, to another
 * host. Unset or empty server URLs allow nothing.
 */
export function isAllowedSimulatorTarget(
  url: string,
  serverUrls: ReadonlyArray<string | null | undefined>,
): boolean {
  const target = URL.parse(url);
  if (target == null) return false;
  if (target.protocol !== 'ws:' && target.protocol !== 'wss:') return false;
  if (target.username !== '' || target.password !== '') return false;
  if (target.search !== '' || target.hash !== '') return false;
  const path = (u: URL): string => u.pathname.replace(/\/+$/, '');
  return serverUrls.some((server) => {
    if (server == null || server === '') return false;
    const allowed = URL.parse(server);
    return allowed != null && allowed.origin === target.origin && path(allowed) === path(target);
  });
}
