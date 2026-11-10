// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { createLogger, UPDATE_CHECK_SETTING_KEY } from '@evtivity/lib';
import { db } from '../config.js';
import { settings, csmsUpdateChecks } from '../schema/settings.js';

const logger = createLogger('csms-update-check');

let cachedEnabled: boolean | undefined;
let cachedAt = 0;
const TTL_MS = 60_000;

/** Drop the cached switch so the next read sees a just-saved setting. */
export function clearCsmsUpdateCheckSettingCache(): void {
  cachedEnabled = undefined;
  cachedAt = 0;
}

/**
 * True while the CSMS update check runs (the default, also when the row is
 * missing). A stored value other than `false` reads as on.
 *
 * The off switch keeps the server from contacting the EVtivity website, so a
 * read error fails closed: the last cached value, else off.
 */
export async function isCsmsUpdateCheckEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedEnabled !== undefined && now - cachedAt < TTL_MS) return cachedEnabled;
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, UPDATE_CHECK_SETTING_KEY));
    cachedEnabled = row == null || row.value !== false;
    cachedAt = now;
    return cachedEnabled;
  } catch (err) {
    logger.warn(
      { err, key: UPDATE_CHECK_SETTING_KEY },
      'isCsmsUpdateCheckEnabled failed, using the cached value or off',
    );
    return cachedEnabled ?? false;
  }
}

export interface CsmsUpdateCheckState {
  /** The latest stable release, without the leading v, or null before a successful read. */
  latestVersion: string | null;
  /** The last successful read. */
  checkedAt: Date | null;
  /** The last try, successful or not. */
  attemptedAt: Date;
}

/** The stored result of the update check, or null before the first try. */
export async function readCsmsUpdateCheck(): Promise<CsmsUpdateCheckState | null> {
  const [row] = await db
    .select({
      latestVersion: csmsUpdateChecks.latestVersion,
      checkedAt: csmsUpdateChecks.checkedAt,
      attemptedAt: csmsUpdateChecks.attemptedAt,
    })
    .from(csmsUpdateChecks)
    .where(eq(csmsUpdateChecks.id, 1));
  return row ?? null;
}

/**
 * Records one try of the update check, the only writer of
 * `csms_update_checks`. A successful read stores the version and its time; a
 * failed one (`latestVersion` null) moves only `attemptedAt`, so the last
 * known version stays.
 */
export async function recordCsmsUpdateCheck(
  latestVersion: string | null,
  at: Date = new Date(),
): Promise<void> {
  if (latestVersion == null) {
    await db
      .insert(csmsUpdateChecks)
      .values({ id: 1, attemptedAt: at })
      .onConflictDoUpdate({ target: csmsUpdateChecks.id, set: { attemptedAt: at } });
    return;
  }
  await db
    .insert(csmsUpdateChecks)
    .values({ id: 1, latestVersion, checkedAt: at, attemptedAt: at })
    .onConflictDoUpdate({
      target: csmsUpdateChecks.id,
      set: { latestVersion, checkedAt: at, attemptedAt: at },
    });
}
