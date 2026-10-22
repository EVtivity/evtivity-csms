// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The only NODE_ENV values under which a SIM provider test base URL is accepted. */
const TEST_NODE_ENVS: ReadonlySet<string> = new Set(['development', 'test']);

export interface SimProviderTestBaseUrlEnv {
  NODE_ENV?: string | undefined;
  SIM_PROVIDER_TEST_BASE_URL?: string | undefined;
}

/**
 * The base URL of a SIM provider mock (no trailing slash), or null when unset.
 * Each adapter appends its own prefix (Hologram: `/hologram/api/1`). It is an
 * environment variable, not a setting, so an operator cannot send provider
 * credentials elsewhere. Throws when it is set and `NODE_ENV` is not
 * `development` or `test` (unset and `production` included), or when it is
 * not an http or https URL.
 */
export function resolveSimProviderTestBaseUrl(env: SimProviderTestBaseUrlEnv): string | null {
  const url = (env.SIM_PROVIDER_TEST_BASE_URL ?? '').trim();
  if (url === '') return null;
  if (!TEST_NODE_ENVS.has(env.NODE_ENV ?? '')) {
    throw new Error(
      'SIM_PROVIDER_TEST_BASE_URL needs NODE_ENV development or test: the SIM provider mock is for local development only',
    );
  }
  const parsed = URL.parse(url);
  if (parsed == null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error('SIM_PROVIDER_TEST_BASE_URL must be an http or https URL');
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('SIM_PROVIDER_TEST_BASE_URL must have no credentials, query or fragment');
  }
  return trimTrailingSlashes(url);
}

// A backwards scan, linear in the length (a regex would be quadratic on many slashes).
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

let cached: { url: string | null } | undefined;

/** The test base URL of this process, read once from `process.env`. */
export function getSimProviderTestBaseUrl(): string | null {
  cached ??= { url: resolveSimProviderTestBaseUrl(process.env) };
  return cached.url;
}

/** Drops the cached value so the next read sees `process.env` again (tests). */
export function clearSimProviderTestBaseUrlCache(): void {
  cached = undefined;
}
