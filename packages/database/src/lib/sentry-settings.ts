// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { inArray } from 'drizzle-orm';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import type { SentryConfig } from '@evtivity/lib';

let cached: SentryConfig | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;
const SENTRY_KEYS = ['sentry.enabled', 'sentry.dsn', 'sentry.environment'];

export async function getSentryConfig(): Promise<SentryConfig> {
  const now = Date.now();
  if (cached !== undefined && now - cachedAt < TTL_MS) {
    return cached;
  }

  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, SENTRY_KEYS));
    const map = new Map(rows.map((r) => [r.key, r.value]));

    cached = {
      enabled: map.get('sentry.enabled') === true || map.get('sentry.enabled') === 'true',
      dsn: typeof map.get('sentry.dsn') === 'string' ? (map.get('sentry.dsn') as string) : '',
      environment:
        typeof map.get('sentry.environment') === 'string'
          ? (map.get('sentry.environment') as string)
          : 'production',
    };
    cachedAt = now;
    return cached;
  } catch {
    return cached ?? { enabled: false, dsn: '', environment: 'production' };
  }
}
