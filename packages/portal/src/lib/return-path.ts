// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Where sign-in returns a visitor: a guest who signs in from a charger page
// comes back to it. Only a path of this portal is taken (`/...`, never `//`
// or a backslash, which a browser reads as another host), so a link cannot
// send a driver to another site after sign-in.

const STORAGE_KEY = 'portalReturnPath';

/** The path itself when it is a path of this portal, else null. */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return raw;
}

/** The sign-in link that returns to `returnTo`. */
export function loginPathFor(returnTo: string): string {
  const safe = safeReturnPath(returnTo);
  return safe == null ? '/login' : `/login?next=${encodeURIComponent(safe)}`;
}

/** Keeps the return path across the sign-in steps (MFA setup included). */
export function rememberReturnPath(raw: string | null | undefined): void {
  const safe = safeReturnPath(raw);
  if (safe == null) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, safe);
  } catch (err) {
    // fail-open: without storage, sign-in returns to the home page
    console.warn('Keeping the sign-in return path failed', err);
  }
}

/** The remembered return path, removed once read. */
export function takeReturnPath(): string | null {
  try {
    const value = safeReturnPath(sessionStorage.getItem(STORAGE_KEY));
    sessionStorage.removeItem(STORAGE_KEY);
    return value;
  } catch (err) {
    // fail-open: without storage, sign-in returns to the home page
    console.warn('Reading the sign-in return path failed', err);
    return null;
  }
}
