// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { query } = vi.hoisted(() => ({
  query: vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(),
}));

vi.mock('../config.js', () => ({ client: query }));

const {
  guardVersion,
  isOlderRelease,
  LEGACY_CLEAN_MS,
  oldProcessCheck,
  PROCESS_VERSION_WATCH_KEY,
  recordProcessWatch,
  releaseUpgradePending,
  WATCH_FRESH_MS,
} = await import('../lib/process-versions.js');
type ProcessWatchStore = import('../lib/process-versions.js').ProcessWatchStore;

const NOW = new Date('2026-10-04T12:00:00.000Z');

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function store(initial: string | null = null): ProcessWatchStore & {
  setCalls: unknown[][];
} {
  let value = initial;
  const setCalls: unknown[][] = [];
  return {
    get: vi.fn((key: string) => Promise.resolve(key === PROCESS_VERSION_WATCH_KEY ? value : null)),
    set: vi.fn((key: string, v: string, token: 'EX', seconds: number) => {
      setCalls.push([key, v, token, seconds]);
      value = v;
      return Promise.resolve('OK');
    }),
    setCalls,
  };
}

function watch(
  checkedAgoMs: number,
  legacySeenAgoMs: number | null,
  versionsSeenAt?: Record<string, number>,
): string {
  return JSON.stringify({
    checkedAt: ago(checkedAgoMs),
    legacySeenAt: legacySeenAgoMs == null ? null : ago(legacySeenAgoMs),
    ...(versionsSeenAt != null
      ? {
          versionsSeenAt: Object.fromEntries(
            Object.entries(versionsSeenAt).map(([v, ms]) => [v, ago(ms)]),
          ),
        }
      : {}),
  });
}

function connections(rows: Array<[string, number, string[]?]>): void {
  query.mockResolvedValue(
    rows.map(([name, count, hosts]) => ({ name, connections: count, hosts: hosts ?? [] })),
  );
}

beforeEach(() => {
  query.mockReset();
});

describe('isOlderRelease', () => {
  it('compares base versions, counts postgres.js and unparseable versions as older', () => {
    expect(isOlderRelease('postgres.js', null)).toBe(true);
    expect(isOlderRelease('evtivity@0.1.40', null)).toBe(false);
    expect(isOlderRelease('evtivity@0.1.40', '0.1.41')).toBe(true);
    expect(isOlderRelease('evtivity@0.1.41', '0.1.41')).toBe(false);
    expect(isOlderRelease('evtivity@0.1.41-alpha.3', '0.1.41')).toBe(false);
    expect(isOlderRelease('evtivity@0.2.0', '0.1.41')).toBe(false);
    expect(isOlderRelease('evtivity@unknown', '0.1.41')).toBe(true);
    expect(isOlderRelease('psql', '0.1.41')).toBe(false);
  });
});

describe('guardVersion', () => {
  it('compares with the minimum, or with an own version below it (development tree)', () => {
    expect(guardVersion('0.1.41', 'evtivity@0.1.41')).toBe('0.1.41');
    expect(guardVersion('0.1.41', 'evtivity@0.1.42')).toBe('0.1.41');
    expect(guardVersion('0.1.41', 'evtivity@0.1.19')).toBe('0.1.19');
    expect(guardVersion('0.1.41', 'evtivity@unknown')).toBe('0.1.41');
  });
});

describe('oldProcessCheck', () => {
  it('reads the EVtivity connections of this database and role', async () => {
    connections([
      ['postgres.js', 1, ['10.0.0.7']],
      ['evtivity@0.1.40', 2, ['10.0.0.8', '10.0.0.7']],
      ['evtivity@0.1.41', 5, ['10.0.0.9']],
    ]);
    await expect(oldProcessCheck('0.1.41')).resolves.toEqual({
      connections: 3,
      hosts: ['10.0.0.7', '10.0.0.8'],
    });
    await expect(oldProcessCheck(null)).resolves.toEqual({ connections: 1, hosts: ['10.0.0.7'] });
    const [strings, ...values] = query.mock.calls[0] ?? [];
    const text = (strings ?? []).join('?');
    expect(text).toContain('FROM pg_stat_activity');
    expect(text).toContain('datname = current_database()');
    expect(text).toContain('usename = current_user');
    expect(text).toContain("backend_type = 'client backend'");
    expect(text).toContain('pid <> pg_backend_pid()');
    expect(values).toEqual(['postgres.js', 'evtivity@%']);
  });

  it('reads no rows as none', async () => {
    query.mockResolvedValue([]);
    await expect(oldProcessCheck(null)).resolves.toEqual({ connections: 0, hosts: [] });
  });
});

describe('releaseUpgradePending', () => {
  it('allows the change when (a), (b) and (c) all hold', async () => {
    connections([['evtivity@0.1.41', 3]]);
    await expect(
      releaseUpgradePending('0.1.41', store(watch(30_000, null, { '0.1.41': 0 })), NOW),
    ).resolves.toBeNull();
    await expect(releaseUpgradePending(null, store(watch(30_000, null)), NOW)).resolves.toBeNull();
  });

  it('(a) refuses while a process of an older release is connected', async () => {
    connections([['evtivity@0.1.40', 2, ['10.0.0.8']]]);
    await expect(
      releaseUpgradePending('0.1.41', store(watch(30_000, null, { '0.1.40': 0 })), NOW),
    ).resolves.toEqual({
      oldConnections: 2,
      hosts: ['10.0.0.8'],
      lastOldSeenAt: NOW.toISOString(),
      watchCheckedAt: ago(30_000),
    });
  });

  it('(b) refuses without a fresh watch, and a version guard without a version watch', async () => {
    connections([]);
    await expect(releaseUpgradePending(null, store(null), NOW)).resolves.not.toBeNull();
    await expect(
      releaseUpgradePending(null, store(watch(WATCH_FRESH_MS, null)), NOW),
    ).resolves.not.toBeNull();
    await expect(releaseUpgradePending(null, store('not json'), NOW)).resolves.not.toBeNull();
    // A watch of a worker before v0.1.41 records no versions.
    await expect(
      releaseUpgradePending('0.1.41', store(watch(30_000, null)), NOW),
    ).resolves.not.toBeNull();
  });

  it('(c) refuses when the watch saw an older release within the clean window', async () => {
    connections([]);
    await expect(
      releaseUpgradePending(
        '0.1.41',
        store(watch(30_000, null, { '0.1.40': LEGACY_CLEAN_MS - 1, '0.1.41': 0 })),
        NOW,
      ),
    ).resolves.toMatchObject({ oldConnections: 0, lastOldSeenAt: ago(LEGACY_CLEAN_MS - 1) });
    await expect(
      releaseUpgradePending(
        '0.1.41',
        store(watch(30_000, null, { '0.1.40': LEGACY_CLEAN_MS, '0.1.41': 0 })),
        NOW,
      ),
    ).resolves.toBeNull();
    await expect(
      releaseUpgradePending(null, store(watch(30_000, LEGACY_CLEAN_MS - 1)), NOW),
    ).resolves.toMatchObject({ lastOldSeenAt: ago(LEGACY_CLEAN_MS - 1) });
  });

  it('throws a database error instead of allowing the change', async () => {
    query.mockRejectedValue(new Error('connection refused'));
    await expect(
      releaseUpgradePending('0.1.41', store(watch(30_000, null, {})), NOW),
    ).rejects.toThrow('connection refused');
  });
});

describe('recordProcessWatch', () => {
  it('stores when postgres.js and each version were last seen', async () => {
    connections([
      ['postgres.js', 1, ['10.0.0.9']],
      ['evtivity@0.1.41', 4],
    ]);
    const s = store(watch(60_000, null, { '0.1.40': 120_000 }));
    const result = await recordProcessWatch(s, NOW);
    expect(result.check).toEqual({ connections: 1, hosts: ['10.0.0.9'] });
    expect(result.state).toEqual({
      checkedAt: NOW.toISOString(),
      legacySeenAt: NOW.toISOString(),
      versionsSeenAt: { '0.1.40': ago(120_000), '0.1.41': NOW.toISOString() },
    });
    expect(s.setCalls).toEqual([
      [PROCESS_VERSION_WATCH_KEY, JSON.stringify(result.state), 'EX', 3600],
    ]);
  });

  it('keeps the previous legacySeenAt when clean and drops versions not seen for a day', async () => {
    connections([]);
    const s = store(watch(60_000, 120_000, { '0.1.39': 24 * 3600_000 }));
    const { state } = await recordProcessWatch(s, NOW);
    expect(state).toEqual({
      checkedAt: NOW.toISOString(),
      legacySeenAt: ago(120_000),
      versionsSeenAt: {},
    });
  });
});
