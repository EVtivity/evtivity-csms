// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** Origin plus path of a URL, or null when it does not parse. */
function endpointKey(raw: string): string | null {
  if (!URL.canParse(raw)) return null;
  const url = new URL(raw);
  return `${url.origin}${url.pathname}`;
}

/**
 * Whether a provider webhook posts to the given webhook URL: the same origin
 * (scheme, host, port) and path. Query and fragment are ignored. A webhook
 * URL that does not parse matches nothing.
 *
 * Several EVtivity deployments can share one provider account (local and a
 * dev stack, two staging stacks). Each one manages only the webhooks at its
 * own URL and never touches another deployment's.
 */
export function isSameWebhookUrl(a: string, b: string): boolean {
  const keyA = endpointKey(a);
  return keyA != null && keyA === endpointKey(b);
}

/**
 * Splits webhook endpoints into the ones at the given URL (this deployment's)
 * and the others (other EVtivity deployments on the same provider account).
 */
export function partitionWebhookEndpoints<T extends { url: string }>(
  endpoints: readonly T[],
  url: string,
): { matching: T[]; other: T[] } {
  const matching: T[] = [];
  const other: T[] = [];
  for (const endpoint of endpoints) {
    (isSameWebhookUrl(endpoint.url, url) ? matching : other).push(endpoint);
  }
  return { matching, other };
}
