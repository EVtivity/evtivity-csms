// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The CSMS update check: the worker reads the latest stable release from the
 * EVtivity website at most once a day, so the browsers of CSMS users never
 * contact the website (security review case 385). The operator turns it off
 * with the `system.updateCheckEnabled` setting.
 */

/** Plain text file naming the latest stable CSMS release, such as `v0.1.50`. */
export const CSMS_VERSION_URL = 'https://evtivity.com/csms-version.txt';

/** The setting that turns the update check on (default) or off. */
export const UPDATE_CHECK_SETTING_KEY = 'system.updateCheckEnabled';

/** At most one read a day, also when the cron is run by hand. */
export const UPDATE_CHECK_MIN_INTERVAL_MS = 23 * 60 * 60 * 1000;

/** The version file is a few bytes; a longer reply is refused unread. */
export const UPDATE_CHECK_MAX_BYTES = 256;

/** The whole read, redirects included, ends after this time. */
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;

// A stable release only (csms-version.txt never names a prerelease): an
// optional v, then major.minor.patch without leading zeros.
const STABLE_VERSION_RE = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

/**
 * The stable version the version file names, without the leading `v`, or
 * null when the text is anything else (so a broken or hostile reply never
 * reaches the CSMS).
 */
export function parseReleasedCsmsVersion(text: string): string | null {
  const match = STABLE_VERSION_RE.exec(text.trim());
  if (match == null) return null;
  return `${match[1] ?? ''}.${match[2] ?? ''}.${match[3] ?? ''}`;
}
