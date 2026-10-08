// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  connectionName,
  CONNECTION_NAME_PREFIX,
  LEGACY_CONNECTION_NAME,
  tryParseJson,
} from '@evtivity/lib';
import { client } from '../config.js';

/**
 * Release guards: refuse a change that processes of an older release would
 * mishandle while such processes may still run (rolling upgrade). Shared by
 * the payment provider-switch guard (no process before v0.1.38) and the
 * fleet account billing switch (no process before v0.1.41).
 *
 * From v0.1.38 on every process names its Postgres connections
 * `evtivity@<version>` (connectionName() in @evtivity/lib); older ones connect
 * as `postgres.js`. All services share one database role, so
 * pg_stat_activity shows them all. An old process can have no open
 * connection at the instant of a check (pool idle timeout 30 s), so the
 * worker cron `process-version-watch` runs the check every minute and keeps
 * when it last saw each release. A change is allowed only when:
 *   (a) the instant check finds no old connection,
 *   (b) the watch ran less than WATCH_FRESH_MS ago,
 *   (c) the watch saw no old connection for at least LEGACY_CLEAN_MS.
 */

/** Redis key of the watch result (no schema, expires after WATCH_TTL_SECONDS). */
export const PROCESS_VERSION_WATCH_KEY = 'evtivity:payments:process-version-watch';

const WATCH_TTL_SECONDS = 60 * 60;

/** The watch must have run within this window (rule b). */
export const WATCH_FRESH_MS = 3 * 60_000;

/** No old connection may have been seen within this window (rule c). */
export const LEGACY_CLEAN_MS = 10 * 60_000;

/** Versions not seen for this long leave the watch state. */
const VERSION_SEEN_RETENTION_MS = 24 * 3600_000;

/** The Redis calls the guard needs; an ioredis client satisfies it. */
export interface ProcessWatchStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, secondsToken: 'EX', seconds: number): Promise<unknown>;
}

export interface ProcessWatchState {
  /** When the watch cron last ran the check (ISO 8601). */
  checkedAt: string;
  /** When the watch cron last saw a `postgres.js` connection (before v0.1.38), or null. */
  legacySeenAt: string | null;
  /**
   * When the watch last saw each `evtivity@<version>` (ISO 8601). Written from
   * v0.1.41 on; a state without it cannot tell newer releases apart.
   */
  versionsSeenAt?: Record<string, string>;
}

/** Open connections of older processes (this database, this role). */
export interface OldProcessCheck {
  connections: number;
  /** Their client addresses (empty for Unix socket connections). */
  hosts: string[];
}

/** Why a guarded change is refused now (the 409 `details`). */
export interface ReleaseUpgradePending {
  oldConnections: number;
  hosts: string[];
  /** When the watch last saw an old process, or null. */
  lastOldSeenAt: string | null;
  watchCheckedAt: string | null;
}

/** `x.y.z` of a version, prerelease and build dropped; null when it does not parse. */
function baseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match == null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Whether a connection's application name belongs to a release before
 * `minVersion` (`x.y.z`). `postgres.js` (before v0.1.38) always does; an
 * `evtivity@` name compares its base version, so a prerelease of
 * `minVersion` counts as that release; a version that does not parse counts
 * as older (fail closed). Other names (psql, pgAdmin) are not EVtivity
 * processes. `minVersion` null asks only for releases before v0.1.38.
 */
export function isOlderRelease(applicationName: string, minVersion: string | null): boolean {
  if (applicationName === LEGACY_CONNECTION_NAME) return true;
  if (minVersion == null || !applicationName.startsWith(CONNECTION_NAME_PREFIX)) return false;
  const have = baseVersion(applicationName.slice(CONNECTION_NAME_PREFIX.length));
  const want = baseVersion(minVersion);
  if (want == null) throw new Error(`Invalid minimum version ${minVersion}`);
  if (have == null) return true;
  for (let i = 0; i < 3; i++) {
    if ((have[i] as number) !== (want[i] as number))
      return (have[i] as number) < (want[i] as number);
  }
  return false;
}

/**
 * The version a release guard compares with: `minVersion`, or this process's
 * own version when that is lower. A released install runs `minVersion` or
 * later, so it compares with `minVersion`. A checkout whose package version
 * is not bumped (the private development tree, every process the same
 * version) compares with its own version, so its own processes do not count
 * as older. `ownName` is this process's connection name (connectionName()).
 */
export function guardVersion(minVersion: string, ownName: string = connectionName()): string {
  const own = ownName.startsWith(CONNECTION_NAME_PREFIX)
    ? ownName.slice(CONNECTION_NAME_PREFIX.length)
    : '';
  return baseVersion(own) != null && isOlderRelease(ownName, minVersion) ? own : minVersion;
}

interface NamedConnections {
  name: string;
  connections: number;
  hosts: string[];
}

/** EVtivity process connections of this database and role, by application name. */
async function processConnections(): Promise<NamedConnections[]> {
  const rows = await client<{ name: string; connections: number; hosts: string[] | null }[]>`
    SELECT application_name AS name, count(*)::int AS connections,
           array_remove(array_agg(DISTINCT host(client_addr)), NULL) AS hosts
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND usename = current_user
      AND backend_type = 'client backend'
      AND pid <> pg_backend_pid()
      AND (application_name = ${LEGACY_CONNECTION_NAME}
           OR application_name LIKE ${`${CONNECTION_NAME_PREFIX}%`})
    GROUP BY application_name
  `;
  return rows.map((r) => ({ name: r.name, connections: r.connections, hosts: r.hosts ?? [] }));
}

function oldOf(rows: readonly NamedConnections[], minVersion: string | null): OldProcessCheck {
  const old = rows.filter((r) => isOlderRelease(r.name, minVersion));
  return {
    connections: old.reduce((sum, r) => sum + r.connections, 0),
    hosts: [...new Set(old.flatMap((r) => r.hosts))].sort(),
  };
}

/** Counts the open connections of processes before `minVersion` (null: before v0.1.38). */
export async function oldProcessCheck(minVersion: string | null): Promise<OldProcessCheck> {
  return oldOf(await processConnections(), minVersion);
}

export function parseWatchState(raw: string | null): ProcessWatchState | null {
  // A value this code did not write is treated as no watch (the guard refuses).
  const parsed = tryParseJson(raw);
  if (parsed == null || typeof parsed !== 'object') return null;
  const { checkedAt, legacySeenAt, versionsSeenAt } = parsed as Partial<ProcessWatchState>;
  if (typeof checkedAt !== 'string') return null;
  const state: ProcessWatchState = {
    checkedAt,
    legacySeenAt: typeof legacySeenAt === 'string' ? legacySeenAt : null,
  };
  if (versionsSeenAt != null && typeof versionsSeenAt === 'object') {
    state.versionsSeenAt = Object.fromEntries(
      Object.entries(versionsSeenAt).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }
  return state;
}

/**
 * Runs the check and stores the watch result (the `process-version-watch`
 * cron): when a `postgres.js` connection and each `evtivity@<version>` was
 * last seen. Keeps the previous times of what is not connected now and drops
 * versions not seen for a day.
 */
export async function recordProcessWatch(
  store: ProcessWatchStore,
  now: Date = new Date(),
): Promise<{ check: OldProcessCheck; state: ProcessWatchState }> {
  const rows = await processConnections();
  const check = oldOf(rows, null);
  const previous = parseWatchState(await store.get(PROCESS_VERSION_WATCH_KEY));
  const at = now.toISOString();
  const versionsSeenAt: Record<string, string> = {};
  for (const [version, seenAt] of Object.entries(previous?.versionsSeenAt ?? {})) {
    if (now.getTime() - Date.parse(seenAt) < VERSION_SEEN_RETENTION_MS) {
      versionsSeenAt[version] = seenAt;
    }
  }
  for (const row of rows) {
    if (row.name.startsWith(CONNECTION_NAME_PREFIX)) {
      versionsSeenAt[row.name.slice(CONNECTION_NAME_PREFIX.length)] = at;
    }
  }
  const state: ProcessWatchState = {
    checkedAt: at,
    legacySeenAt: check.connections > 0 ? at : (previous?.legacySeenAt ?? null),
    versionsSeenAt,
  };
  await store.set(PROCESS_VERSION_WATCH_KEY, JSON.stringify(state), 'EX', WATCH_TTL_SECONDS);
  return { check, state };
}

/** When the watch last saw a process before `minVersion`, or null. */
function lastOldSeenAt(state: ProcessWatchState, minVersion: string | null): string | null {
  const seen = [state.legacySeenAt];
  if (minVersion != null) {
    for (const [version, at] of Object.entries(state.versionsSeenAt ?? {})) {
      if (isOlderRelease(`${CONNECTION_NAME_PREFIX}${version}`, minVersion)) seen.push(at);
    }
  }
  const times = seen.filter((t): t is string => t != null).sort();
  return times.at(-1) ?? null;
}

/**
 * Why a change that needs every process at `minVersion` or later is refused
 * now, or null when it is allowed (rules a, b and c above). `minVersion` null
 * asks for no process before v0.1.38 (the payment provider-switch guard). A
 * version guard also needs a watch that records versions (written by a
 * v0.1.41 worker or later): without one it refuses (fail closed). A Redis or
 * database error is thrown, so a change never passes unchecked (P9).
 */
export async function releaseUpgradePending(
  minVersion: string | null,
  store: ProcessWatchStore,
  now: Date = new Date(),
): Promise<ReleaseUpgradePending | null> {
  const [check, raw] = await Promise.all([
    oldProcessCheck(minVersion),
    store.get(PROCESS_VERSION_WATCH_KEY),
  ]);
  const watch = parseWatchState(raw);
  const usable = watch != null && (minVersion == null || watch.versionsSeenAt != null);
  const nowMs = now.getTime();
  const lastOld = watch != null ? lastOldSeenAt(watch, minVersion) : null;
  const watchFresh = usable && nowMs - Date.parse(watch.checkedAt) < WATCH_FRESH_MS;
  const oldClean = lastOld == null || nowMs - Date.parse(lastOld) >= LEGACY_CLEAN_MS;
  if (check.connections === 0 && watchFresh && oldClean) return null;
  return {
    oldConnections: check.connections,
    hosts: check.hosts,
    lastOldSeenAt: lastOld,
    watchCheckedAt: watch?.checkedAt ?? null,
  };
}
