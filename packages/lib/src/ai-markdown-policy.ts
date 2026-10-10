// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Output policy for AI answers rendered as markdown (plan 2026-10-09, 3.9).
 * Browser-safe: the CSMS imports it via `@evtivity/lib/ai-markdown-policy`.
 *
 * Model output is untrusted. A link is clickable only when it is an https URL
 * on the allowlist: the EVtivity website, the app's own origin, and the
 * configured portal origin. Everything else (javascript:, data:, http:, other
 * hosts, credentials in the URL) renders as plain text. Images never load:
 * the renderer shows them as a chip, so an injected image cannot carry data
 * out in its URL.
 */

/** Hosts that are always allowed (the documentation website). */
export const AI_LINK_ALWAYS_ALLOWED_HOSTS: readonly string[] = ['evtivity.com', 'www.evtivity.com'];

/**
 * The origin (`https://host[:port]`) of an https URL, or null for anything
 * else, including relative URLs and URLs with credentials.
 */
function httpsOrigin(value: string): string | null {
  const url = URL.parse(value);
  if (url == null || url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.origin;
}

/**
 * Builds the allowed origins from the deployment's own URLs. Values that are
 * not https URLs are skipped, so a plain-http dev origin never becomes a
 * clickable target.
 */
export function buildAiLinkAllowlist(origins: readonly (string | null | undefined)[]): string[] {
  const out = new Set(AI_LINK_ALWAYS_ALLOWED_HOSTS.map((h) => `https://${h}`));
  for (const value of origins) {
    if (value == null || value === '') continue;
    const origin = httpsOrigin(value);
    if (origin != null) out.add(origin);
  }
  return [...out];
}

/**
 * The normalized URL when `href` is an https link on the allowlist, else null.
 * The caller renders a null result as text.
 */
export function allowedAiLink(
  href: string | null | undefined,
  allowlist: readonly string[],
): string | null {
  if (href == null) return null;
  const trimmed = href.trim();
  if (trimmed === '') return null;
  const origin = httpsOrigin(trimmed);
  if (origin == null || !allowlist.includes(origin)) return null;
  return new URL(trimmed).href;
}
