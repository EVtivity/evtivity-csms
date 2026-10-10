// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { URL } from 'node:url';
import { isIP } from 'node:net';
import { isNonPublicAddress } from './safe-fetch.js';

/**
 * Syntactic check of a URL before it is stored or accepted: true for a
 * non-http(s) scheme, an invalid URL, `localhost`, an IP literal that is not
 * a public address (see isNonPublicAddress), or a `.local`, `.internal` or
 * `.localhost` name. It does not resolve the host, so a public-looking name
 * can still point at an internal address: send the request with safeFetch,
 * which checks what the name resolves to at connect time.
 */
export function isPrivateUrl(urlString: string): boolean {
  const parsed = URL.parse(urlString);
  if (parsed == null) return true;
  // Only http(s) is a valid outbound target. file://, gopher://, dict://
  // and the like reach local files or internal services.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  // The URL parser keeps IPv6 hosts in brackets ([::1]), which isIP() does
  // not recognize, and keeps a trailing root dot (localhost.).
  const host = parsed.hostname
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase();
  if (host === '' || host === 'localhost') return true;
  if (isIP(host) !== 0) return isNonPublicAddress(host);
  return host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost');
}

// A DNS hostname (RFC 1123 labels), without scheme or port.
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Most hosts an operator allowlist of private hosts may hold. */
export const MAX_ALLOWED_PRIVATE_HOSTS = 20;

/**
 * An operator allowlist of private hosts (OCSP responders, webhook targets):
 * trimmed, lowercased and de-duplicated hostnames or IP addresses, without
 * scheme or port. Null when the value is not an array of at most
 * MAX_ALLOWED_PRIVATE_HOSTS such strings.
 */
export function parseAllowedPrivateHosts(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ALLOWED_PRIVATE_HOSTS) return null;
  const hosts: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const host = item.trim().toLowerCase();
    if (!HOSTNAME.test(host) && isIP(host) === 0) return null;
    hosts.push(host);
  }
  return [...new Set(hosts)];
}

/**
 * Validates an AI provider base URL setting (`ai.<provider>.baseUrl`) before
 * it is stored. The API key is sent to this URL, so it must be https, carry
 * no credentials, query or fragment, and point at a public host
 * (`isPrivateUrl`). `allowPrivateHosts` (local development only) also accepts
 * a private host and plain http, for a mock provider on localhost. An empty
 * string means the official endpoint. Returns the trimmed URL, or null when
 * invalid. This is a syntactic check: the client that sends the key still
 * checks the address the host resolves to.
 */
export function validateAiBaseUrl(
  value: unknown,
  options: { allowPrivateHosts: boolean },
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const parsed = URL.parse(trimmed);
  if (parsed == null) return null;
  const httpAllowed = options.allowPrivateHosts && parsed.protocol === 'http:';
  if (parsed.protocol !== 'https:' && !httpAllowed) return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  if (!options.allowPrivateHosts && isPrivateUrl(trimmed)) return null;
  return trimmed;
}
