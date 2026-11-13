// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { Logger } from '@evtivity/lib';
import {
  CONNECTION_FAILURE_MAX_SOURCES,
  CONNECTION_FAILURE_WINDOW_MS,
  flushConnectionFailureLogs,
  logConnectionEvent,
  logConnectionFailure,
} from '../server/middleware/connection-log.js';

interface Query {
  text: string;
  values: unknown[];
}

function fakeSql(options: { failInsert?: boolean; failUpdate?: boolean } = {}) {
  const queries: Query[] = [];
  let nextId = 1;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$');
    queries.push({ text, values });
    if (text.includes('INSERT')) {
      if (options.failInsert === true) return Promise.reject(new Error('insert failed'));
      return Promise.resolve([{ id: nextId++ }]);
    }
    if (options.failUpdate === true) return Promise.reject(new Error('update failed'));
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  Object.assign(sql, { json: (v: unknown) => ({ json: v }) });
  return { sql, queries };
}

function logger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
  };
}

const updates = (queries: Query[]) => queries.filter((q) => q.text.includes('UPDATE'));
const patchOf = (q: Query | undefined) =>
  (q?.values[0] as { json: Record<string, unknown> } | undefined)?.json;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await flushConnectionFailureLogs();
  vi.useRealTimers();
});

describe('logConnectionEvent', () => {
  it('writes one row and never throws on a failed insert', async () => {
    const ok = fakeSql();
    await logConnectionEvent(ok.sql, 'sta_1', 'connected', '10.0.0.1', { a: 1 }, logger());
    expect(ok.queries[0]?.values.slice(0, 3)).toEqual(['sta_1', 'connected', '10.0.0.1']);
    const bad = fakeSql({ failInsert: true });
    const log = logger();
    await expect(
      logConnectionEvent(bad.sql, 'sta_1', 'connected', null, {}, log),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('logConnectionFailure', () => {
  it('writes one row per window and the window end updates its count and sources once', async () => {
    const { sql, queries } = fakeSql();
    const log = logger();
    await logConnectionFailure(sql, 'sta_a', 'auth_failed', '10.0.0.1', { reason: 'bad' }, log);
    await logConnectionFailure(sql, 'sta_a', 'auth_failed', '10.0.0.2', { reason: 'bad' }, log);
    await logConnectionFailure(sql, 'sta_a', 'auth_failed', '10.0.0.1', { reason: 'bad' }, log);
    expect(queries.filter((q) => q.text.includes('INSERT'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CONNECTION_FAILURE_WINDOW_MS);
    const [update] = updates(queries);
    expect(patchOf(update)).toEqual({
      count: 3,
      remoteAddresses: ['10.0.0.1', '10.0.0.2'],
      remoteAddressesDropped: 0,
    });
    expect(update?.values[1]).toBe(1);
  });

  it('keeps reasons and stations apart and records certificate serials', async () => {
    const { sql, queries } = fakeSql();
    const log = logger();
    await logConnectionFailure(
      sql,
      'sta_b',
      'auth_failed',
      null,
      { reason: 'x', certSerial: 'S1' },
      log,
    );
    await logConnectionFailure(
      sql,
      'sta_b',
      'auth_failed',
      null,
      { reason: 'x', certSerial: 'S2' },
      log,
    );
    await logConnectionFailure(sql, 'sta_b', 'auth_failed', null, { reason: 'y' }, log);
    await logConnectionFailure(sql, 'sta_c', 'auth_failed', null, {}, log);
    expect(queries.filter((q) => q.text.includes('INSERT'))).toHaveLength(3);
    await flushConnectionFailureLogs();
    const patches = updates(queries).map(patchOf);
    expect(patches).toEqual([
      {
        count: 2,
        remoteAddresses: [],
        remoteAddressesDropped: 0,
        certSerials: ['S1', 'S2'],
        certSerialsDropped: 0,
      },
    ]);
  });

  it('bounds the kept addresses and counts the ones dropped', async () => {
    const { sql, queries } = fakeSql();
    const log = logger();
    for (let i = 0; i < CONNECTION_FAILURE_MAX_SOURCES + 3; i++) {
      await logConnectionFailure(sql, 'sta_d', 'auth_failed', `10.0.1.${String(i)}`, {}, log);
    }
    await flushConnectionFailureLogs();
    const patch = patchOf(updates(queries)[0]);
    expect((patch?.['remoteAddresses'] as string[]).length).toBe(CONNECTION_FAILURE_MAX_SOURCES);
    expect(patch?.['remoteAddressesDropped']).toBe(3);
  });

  it('starts a new row after the window, flushing the old one first', async () => {
    const { sql, queries } = fakeSql();
    const log = logger();
    await logConnectionFailure(sql, 'sta_e', 'auth_failed', null, {}, log);
    await logConnectionFailure(sql, 'sta_e', 'auth_failed', null, {}, log);
    vi.setSystemTime(Date.now() + CONNECTION_FAILURE_WINDOW_MS);
    await logConnectionFailure(sql, 'sta_e', 'auth_failed', null, {}, log);
    const kinds = queries.map((q) => (q.text.includes('INSERT') ? 'insert' : 'update'));
    expect(kinds).toEqual(['insert', 'update', 'insert']);
    expect(patchOf(updates(queries)[0])?.['count']).toBe(2);
  });

  it('writes nothing more when the first insert failed, and logs a failed update', async () => {
    const noRow = fakeSql({ failInsert: true });
    const log = logger();
    await logConnectionFailure(noRow.sql, 'sta_f', 'auth_failed', null, {}, log);
    await logConnectionFailure(noRow.sql, 'sta_f', 'auth_failed', null, {}, log);
    await flushConnectionFailureLogs();
    expect(updates(noRow.queries)).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledTimes(1);

    const badUpdate = fakeSql({ failUpdate: true });
    const log2 = logger();
    await logConnectionFailure(badUpdate.sql, 'sta_g', 'auth_failed', null, {}, log2);
    await logConnectionFailure(badUpdate.sql, 'sta_g', 'auth_failed', null, {}, log2);
    await flushConnectionFailureLogs();
    expect(log2.warn).toHaveBeenCalledWith(
      expect.objectContaining({ rowId: 1 }),
      'Failed to update the connection_logs failure count',
    );
  });

  it('writes no update for a window that saw only its first failure', async () => {
    const { sql, queries } = fakeSql();
    await logConnectionFailure(sql, 'sta_h', 'auth_failed', null, {}, logger());
    await flushConnectionFailureLogs();
    expect(updates(queries)).toHaveLength(0);
  });
});
