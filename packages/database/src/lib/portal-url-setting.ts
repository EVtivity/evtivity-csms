// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { createLogger } from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const logger = createLogger('portal-url-setting');

/** The public driver portal URL the operator enters in Settings > Company. */
export const COMPANY_PORTAL_URL_KEY = 'company.portalUrl';

const TTL_MS = 60_000;
let cachedValue: string | null | undefined;
let cachedAt = 0;

export function clearCompanyPortalUrlCache(): void {
  cachedValue = undefined;
  cachedAt = 0;
}

/**
 * The driver portal URL without a trailing slash, for links in notifications
 * sent from processes that have no PORTAL_URL (the OCPP server). Null when
 * unset, not an http(s) URL, or on error. Cached 60 s.
 */
export async function getCompanyPortalUrl(): Promise<string | null> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) return cachedValue;
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, COMPANY_PORTAL_URL_KEY));
    const raw = typeof row?.value === 'string' ? row.value.trim() : '';
    const url = raw !== '' ? URL.parse(raw) : null;
    cachedValue =
      url != null && (url.protocol === 'http:' || url.protocol === 'https:')
        ? url.href.replace(/\/+$/, '')
        : null;
    cachedAt = now;
    return cachedValue;
  } catch (err) {
    logger.warn(
      { err, key: COMPANY_PORTAL_URL_KEY },
      'getCompanyPortalUrl failed, using the cached value or none',
    );
    return cachedValue ?? null;
  }
}
