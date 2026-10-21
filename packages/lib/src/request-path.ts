// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** Characters a client never needs to percent-encode in a path, plus both slashes. */
const PLAIN_CHARACTER = /^[A-Za-z0-9\-._~/\\]$/;
const PERCENT_ESCAPE = /%([0-9A-Fa-f]{2})/g;

/**
 * Whether the path part of a request URL percent-encodes a character that has
 * no reason to be encoded (a letter, digit, `-._~`) or a slash. The HTTP
 * router decodes these before it matches a route, so a hook that reads the
 * raw path would see another path than the route that runs.
 */
export function hasAmbiguousPathEncoding(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  for (const match of path.matchAll(PERCENT_ESCAPE)) {
    const hex = match[1];
    if (hex != null && PLAIN_CHARACTER.test(String.fromCharCode(parseInt(hex, 16)))) {
      return true;
    }
  }
  return false;
}
