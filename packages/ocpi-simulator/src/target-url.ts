// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The URL the simulator calls for a URL the target platform advertised.
 *
 * A platform advertises its versions and module endpoints under its public
 * base URL (the CSMS `OCPI_BASE_URL`). On the local Docker Compose stack that
 * is `http://localhost:7104`, which a partner on the host or the LAN can use,
 * but which inside the simulator container is the container itself (finding
 * JB-7). `targetOrigin` (`OCPI_SIM_TARGET_ORIGIN`, for example
 * `http://ocpi:7104`) replaces the scheme, host and port of every URL the
 * simulator calls, so the platform keeps advertising its public URL. Unset,
 * URLs are called as given.
 */
export function rewriteTargetUrl(url: string, targetOrigin: string | undefined): string {
  if (targetOrigin == null || targetOrigin === '') return url;
  const origin = new URL(targetOrigin);
  const target = new URL(url);
  target.protocol = origin.protocol;
  target.host = origin.host;
  return target.toString();
}
