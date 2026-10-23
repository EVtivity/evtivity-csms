// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { isPrivateUrl } from '@evtivity/lib';

/** The settings keys of the Hubject endpoints (base and OAuth2 token URL). */
export const HUBJECT_URL_SETTING_KEYS: ReadonlySet<string> = new Set([
  'pnc.hubject.baseUrl',
  'pnc.hubject.tokenUrl',
]);

export const PRIVATE_HUBJECT_URL_ERROR = {
  error: 'Hubject URLs must be http(s) URLs that do not point to a private or internal address',
  code: 'PRIVATE_URL',
};

/**
 * A Hubject URL as it may be stored: empty (not configured), or an http(s)
 * URL without credentials whose host is not a private or internal address.
 * The OCPP process posts the client secret to the token URL and the
 * API's test route fetches the base URL, so neither may name an internal host.
 * Null when the value is refused. The send goes through safeFetch as well,
 * which also checks the address the host resolves to.
 */
export function validateHubjectUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const url = URL.parse(trimmed);
  if (url == null) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (isPrivateUrl(trimmed)) return null;
  return trimmed;
}
