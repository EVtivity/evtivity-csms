// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Login return-to: a signed-out user who opens a protected deep link (such
 * as an insight link from an email) lands back on it after
 * signing in, by password, MFA or SSO. The path travels as `/login?returnTo=`
 * and is kept in sessionStorage for the SSO round trip, which leaves the
 * page. Only same-origin relative paths are accepted, so it is never an open
 * redirect.
 */

const RETURN_TO_KEY = 'csms_return_to';
const PARAM = 'returnTo';
/** The origin relative paths are resolved against; never used as a destination. */
const PROBE_ORIGIN = 'https://csms.invalid';

/** Pages a user is never sent back to: the sign-in flow itself. */
const AUTH_PATHS = ['/login', '/forgot-password', '/reset-password', '/set-password'];

/**
 * The path to return to, or null. Accepts `/path?query#hash` only: no scheme,
 * no host, no protocol-relative `//` or `/\`, no control characters, and not
 * a sign-in page.
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (value == null || value === '' || value.length > 2048) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const url = URL.parse(value, PROBE_ORIGIN);
  if (url == null || url.origin !== PROBE_ORIGIN) return null;
  if (AUTH_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  return path === '/' ? null : path;
}

/** The sign-in URL that comes back to `current` (a path with query and hash). */
export function loginPathFor(current: string): string {
  const target = safeReturnTo(current);
  return target == null ? '/login' : `/login?${PARAM}=${encodeURIComponent(target)}`;
}

/** Keeps the `returnTo` of the sign-in URL for after the login (password, MFA or SSO). */
export function rememberReturnTo(search: URLSearchParams): void {
  rememberReturnPath(search.get(PARAM));
}

/** Keeps a page to open after the next sign-in (an SSO round trip from a signed-in page). */
export function rememberReturnPath(path: string | null): void {
  const target = safeReturnTo(path);
  if (target == null) return;
  try {
    sessionStorage.setItem(RETURN_TO_KEY, target);
  } catch (err) {
    console.warn('Keep the page to return to after login failed', err);
  }
}

/** The remembered page, once: it is cleared as it is read. Checked again on the way out. */
export function takeReturnTo(): string | null {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(RETURN_TO_KEY);
    sessionStorage.removeItem(RETURN_TO_KEY);
  } catch (err) {
    console.warn('Read the page to return to after login failed', err);
  }
  return safeReturnTo(stored);
}
