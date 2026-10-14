// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The simulator's target settings, from the environment. */
export interface TargetEnv {
  /** Origin every call goes to (`http://ocpi:7104`), replacing the advertised one. */
  OCPI_SIM_TARGET_ORIGIN?: string | undefined;
  /** The platform the simulator registers with (`http://localhost:7104`). */
  OCPI_TARGET_URL?: string | undefined;
}

/** The origin of an http(s) URL without credentials, or null when unset. */
function configuredOrigin(value: string | undefined, name: string): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return null;
  const parsed = URL.parse(trimmed);
  if (
    parsed == null ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error(`${name} must be an http or https URL without credentials`);
  }
  return parsed.origin;
}

/**
 * The URL the simulator calls for a URL it was given: a registration target
 * or an endpoint the target platform advertised.
 *
 * The simulator calls only its configured target. `OCPI_SIM_TARGET_ORIGIN`
 * (for example `http://ocpi:7104`) replaces the scheme, host and port of
 * every URL: a platform advertises its versions and module endpoints under
 * its public base URL (the CSMS `OCPI_BASE_URL`), which on the local Docker
 * Compose stack is `http://localhost:7104`, the simulator container itself
 * (finding JB-7). Without it, a URL must be on the origin of
 * `OCPI_TARGET_URL`. Anything else (another host, a scheme other than http or
 * https, credentials in the URL, or no target configured) throws, so a
 * request to the control API or a partner's advertised endpoint cannot make
 * the simulator call an arbitrary host.
 */
export function outboundUrl(url: string, env: TargetEnv): string {
  const targetOrigin = configuredOrigin(env.OCPI_SIM_TARGET_ORIGIN, 'OCPI_SIM_TARGET_ORIGIN');
  const targetUrlOrigin = configuredOrigin(env.OCPI_TARGET_URL, 'OCPI_TARGET_URL');
  const parsed = URL.parse(url);
  if (parsed == null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error('The OCPI simulator calls http or https URLs only');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('The OCPI simulator does not call URLs with credentials');
  }
  const origin = targetOrigin ?? (parsed.origin === targetUrlOrigin ? targetUrlOrigin : null);
  if (origin == null) {
    throw new Error(
      'The OCPI simulator calls only its configured target: set OCPI_SIM_TARGET_ORIGIN or OCPI_TARGET_URL',
    );
  }
  return `${origin}${parsed.pathname}${parsed.search}`;
}
