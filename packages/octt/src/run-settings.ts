// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type pino from 'pino';
import { db, OCPP_SETTINGS_CACHE_TTL_MS, PNC_SETTINGS_CACHE_TTL_MS } from '@evtivity/database';
import { OCTT_PENDING_RESTORE_SETTING_KEY } from '@evtivity/lib';
import { sql } from 'drizzle-orm';

/** A setting the run changed: its key and the value before the run (undefined when unset). */
export interface SettingChange {
  key: string;
  previous: unknown;
}

/** How often a run refreshes its pending restore row, so the worker sweep sees it is alive. */
export const PENDING_RESTORE_HEARTBEAT_MS = 5 * 60_000;

/** The CSMS settings cache that reads each key prefix, by its time to live. */
const SETTINGS_CACHE_TTLS: readonly (readonly [string, number])[] = [
  ['pnc.', PNC_SETTINGS_CACHE_TTL_MS],
  ['smartCharging.', OCPP_SETTINGS_CACHE_TTL_MS],
  ['ocpp.', OCPP_SETTINGS_CACHE_TTL_MS],
];
const LONGEST_SETTINGS_CACHE_TTL_MS = Math.max(...SETTINGS_CACHE_TTLS.map(([, ttl]) => ttl));

/**
 * How long a CSMS process can keep serving the old value of these settings:
 * the longest TTL of the caches that read them. A key no listed cache reads
 * gets the longest TTL of all.
 */
export function settingsCacheTtlMs(keys: readonly string[]): number {
  let ttl = 0;
  for (const key of keys) {
    const cache = SETTINGS_CACHE_TTLS.find(([prefix]) => key.startsWith(prefix));
    ttl = Math.max(ttl, cache?.[1] ?? LONGEST_SETTINGS_CACHE_TTL_MS);
  }
  return ttl;
}

/**
 * Writes the wanted values that differ from the current ones. Each change is
 * recorded before its write, so a write that throws still leaves every
 * earlier change, and this one, to be restored.
 */
export async function writeSettings(
  wanted: Map<string, unknown>,
  current: Map<string, unknown>,
  record: (change: SettingChange) => Promise<void>,
): Promise<SettingChange[]> {
  const changes: SettingChange[] = [];
  for (const [key, value] of wanted) {
    if (JSON.stringify(current.get(key)) === JSON.stringify(value)) continue;
    const change = { key, previous: current.get(key) };
    await record(change);
    changes.push(change);
    const json = JSON.stringify(value);
    await db.execute(sql`
      INSERT INTO settings (key, value) VALUES (${key}, ${json}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = ${json}::jsonb, updated_at = now()
    `);
  }
  return changes;
}

/** Puts back the previous values, in order; a setting that did not exist is deleted. */
export async function restoreSettings(changes: readonly SettingChange[]): Promise<void> {
  for (const { key, previous } of changes) {
    if (previous === undefined) {
      await db.execute(sql`DELETE FROM settings WHERE key = ${key}`);
    } else {
      const json = JSON.stringify(previous);
      await db.execute(
        sql`UPDATE settings SET value = ${json}::jsonb, updated_at = now() WHERE key = ${key}`,
      );
    }
  }
}

type StoredChange = { key: string; previous: unknown } | { key: string; unset: true };

function encode(changes: readonly SettingChange[]): string {
  const stored: StoredChange[] = changes.map(({ key, previous }) =>
    previous === undefined ? { key, unset: true } : { key, previous },
  );
  return JSON.stringify({ changes: stored });
}

function decode(value: unknown): SettingChange[] {
  if (typeof value !== 'object' || value == null) return [];
  const stored = (value as { changes?: unknown }).changes;
  if (!Array.isArray(stored)) return [];
  const changes: SettingChange[] = [];
  for (const entry of stored as unknown[]) {
    if (typeof entry !== 'object' || entry == null) continue;
    const { key } = entry as { key?: unknown };
    if (typeof key !== 'string') continue;
    changes.push(
      'previous' in entry ? { key, previous: entry.previous } : { key, previous: undefined },
    );
  }
  return changes;
}

/**
 * The settings a run changed, kept in memory and in the pending restore
 * settings row, which is written before each change. A run killed before it
 * restored them leaves the row; `restoreLeftoverRunSettings` puts them back.
 */
export class PendingSettingsRestore {
  private readonly runList: SettingChange[] = [];
  private readonly caseList: SettingChange[] = [];
  private saved = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly logger: Pick<pino.Logger, 'warn'>) {}

  /** Changes of the current per-case settings. */
  get caseChanges(): readonly SettingChange[] {
    return this.caseList;
  }

  /** Records a change before it is written: run-level, or for the current case. */
  async record(scope: 'run' | 'case', change: SettingChange): Promise<void> {
    (scope === 'run' ? this.runList : this.caseList).push(change);
    await this.save();
  }

  /** Forgets a recorded change the run did not make after all. */
  async discard(change: SettingChange): Promise<void> {
    for (const list of [this.runList, this.caseList]) {
      const idx = list.indexOf(change);
      if (idx !== -1) list.splice(idx, 1);
    }
    await this.save();
  }

  /** Restores the current case's settings back to the run's values. */
  async restoreCase(): Promise<void> {
    await restoreSettings(this.caseList);
    this.caseList.length = 0;
    await this.save();
  }

  /**
   * Restores the case settings, then the run settings, and removes the row.
   * When a restore fails the row keeps every change, in the same order, so a
   * later restore ends at the values before the run.
   */
  async restoreAll(): Promise<void> {
    this.stopHeartbeat();
    let failure: unknown;
    for (const list of [this.caseList, this.runList]) {
      try {
        await restoreSettings(list);
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure !== undefined)
      throw new Error('Restoring the run settings failed', { cause: failure });
    this.caseList.length = 0;
    this.runList.length = 0;
    await this.save();
  }

  stopHeartbeat(): void {
    if (this.heartbeat != null) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private async save(): Promise<void> {
    // Case changes first: they were made on top of the run's values.
    const changes = [...this.caseList, ...this.runList];
    if (changes.length === 0) {
      if (!this.saved) return;
      await db.execute(sql`DELETE FROM settings WHERE key = ${OCTT_PENDING_RESTORE_SETTING_KEY}`);
      this.saved = false;
      this.stopHeartbeat();
      return;
    }
    const json = encode(changes);
    await db.execute(sql`
      INSERT INTO settings (key, value) VALUES (${OCTT_PENDING_RESTORE_SETTING_KEY}, ${json}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = ${json}::jsonb, updated_at = now()
    `);
    this.saved = true;
    this.heartbeat ??= setInterval(() => {
      void db
        .execute(
          sql`UPDATE settings SET updated_at = now() WHERE key = ${OCTT_PENDING_RESTORE_SETTING_KEY}`,
        )
        .catch((err: unknown) => {
          this.logger.warn({ err }, 'Refreshing the pending settings restore row failed');
        });
    }, PENDING_RESTORE_HEARTBEAT_MS);
    this.heartbeat.unref();
  }
}

/**
 * Puts back the settings a killed run left in the pending restore row and
 * removes the row. With `staleBefore`, only a row its run stopped refreshing
 * before then. Returns the settings it restored and logs them at warn.
 */
export async function restoreLeftoverRunSettings(
  logger: Pick<pino.Logger, 'warn'>,
  options: { staleBefore?: Date } = {},
): Promise<SettingChange[]> {
  const stale =
    options.staleBefore == null
      ? sql``
      : sql` AND updated_at < ${options.staleBefore.toISOString()}::timestamptz`;
  const rows = (await db.execute(sql`
    SELECT value FROM settings WHERE key = ${OCTT_PENDING_RESTORE_SETTING_KEY}${stale}
  `)) as unknown as { value: unknown }[];
  const row = rows[0];
  if (row == null) return [];
  const changes = decode(row.value);
  await restoreSettings(changes);
  // Only the row read: a run that started since wrote its own.
  await db.execute(sql`
    DELETE FROM settings
    WHERE key = ${OCTT_PENDING_RESTORE_SETTING_KEY} AND value = ${JSON.stringify(row.value)}::jsonb
  `);
  logger.warn(
    { restored: changes.map((c) => c.key) },
    'Restored the settings an earlier conformance run left changed',
  );
  return changes;
}
