// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { like } from 'drizzle-orm';
import {
  createLogger,
  MOBILE_APP_ANDROID_PACKAGES_KEY,
  MOBILE_APP_URL_SCHEMES_KEY,
  parseMobileAppList,
  type MobileAppConfig,
} from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const logger = createLogger('mobile-app-settings');

// The operator's mobile app builds (`mobile.app.*` settings, see
// `@evtivity/lib` mobile-app.ts). Read on every app card setup, so cached.

const EMPTY: MobileAppConfig = { urlSchemes: [], androidPackageNames: [] };
const TTL_MS = 60_000;
let cache: MobileAppConfig | undefined;
let cachedAt = 0;

function parse(rows: { key: string; value: unknown }[]): MobileAppConfig {
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
    urlSchemes:
      parseMobileAppList(MOBILE_APP_URL_SCHEMES_KEY, map.get(MOBILE_APP_URL_SCHEMES_KEY)) ?? [],
    androidPackageNames:
      parseMobileAppList(
        MOBILE_APP_ANDROID_PACKAGES_KEY,
        map.get(MOBILE_APP_ANDROID_PACKAGES_KEY),
      ) ?? [],
  };
}

/** The configured app builds (60 s cache). An unreadable setting allows no app. */
export async function getMobileAppConfig(): Promise<MobileAppConfig> {
  const now = Date.now();
  if (cache != null && now - cachedAt < TTL_MS) return cache;
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(like(settings.key, 'mobile.app.%'));
    cache = parse(rows);
    cachedAt = now;
    return cache;
  } catch (err) {
    // Fail closed: without the settings no app return URL is accepted, and
    // the next call retries the read.
    logger.warn(
      { err, key: 'mobile.app.*' },
      'getMobileAppConfig failed, using the cached value or no app builds',
    );
    return cache ?? EMPTY;
  }
}

export function clearMobileAppConfigCache(): void {
  cache = undefined;
  cachedAt = 0;
}
