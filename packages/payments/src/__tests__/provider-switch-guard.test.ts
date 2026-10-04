// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { query } = vi.hoisted(() => ({
  query: vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(),
}));

vi.mock('@evtivity/database', () => ({ client: query }));

import {
  assertProviderSelectable,
  LEGACY_CLEAN_MS,
  legacyProcessCheck,
  PaymentProviderUpgradePendingError,
  PROCESS_VERSION_WATCH_KEY,
  providerUpgradePending,
  recordProcessWatch,
  WATCH_FRESH_MS,
} from '../provider-switch-guard.js';
import type { ProcessWatchStore } from '../provider-switch-guard.js';

const NOW = new Date('2026-10-04T12:00:00.000Z');

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function store(initial: string | null = null): ProcessWatchStore & {
  value: () => string | null;
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
    value: () => value,
    setCalls,
  };
}

function watch(checkedAgoMs: number, legacySeenAgoMs: number | null): string {
  return JSON.stringify({
    checkedAt: ago(checkedAgoMs),
    legacySeenAt: legacySeenAgoMs == null ? null : ago(legacySeenAgoMs),
  });
}

function legacyRows(legacy: number, hosts: string[] = []): void {
  query.mockResolvedValue([{ legacy, hosts }]);
}

beforeEach(() => {
  query.mockReset();
});

describe('legacyProcessCheck', () => {
  it('counts connections named postgres.js on this database and role', async () => {
    legacyRows(2, ['10.0.0.7']);
    await expect(legacyProcessCheck()).resolves.toEqual({ legacy: 2, hosts: ['10.0.0.7'] });
    const [strings, ...values] = query.mock.calls[0] ?? [];
    const text = (strings ?? []).join('?');
    expect(text).toContain('FROM pg_stat_activity');
    expect(text).toContain('datname = current_database()');
    expect(text).toContain('usename = current_user');
    expect(text).toContain("backend_type = 'client backend'");
    expect(text).toContain('pid <> pg_backend_pid()');
    expect(values).toEqual(['postgres.js']);
  });

  it('reads no rows and null hosts as none', async () => {
    query.mockResolvedValue([{ legacy: 0, hosts: null }]);
    await expect(legacyProcessCheck()).resolves.toEqual({ legacy: 0, hosts: [] });
    query.mockResolvedValue([]);
    await expect(legacyProcessCheck()).resolves.toEqual({ legacy: 0, hosts: [] });
  });
});

describe('assertProviderSelectable', () => {
  it('never runs the check for providers that are not guarded', async () => {
    const s = store();
    for (const id of ['stripe', 'simulated', 'none', 'acme']) {
      await expect(assertProviderSelectable(id, s, NOW)).resolves.toBeUndefined();
    }
    expect(query).not.toHaveBeenCalled();
    expect(s.get).not.toHaveBeenCalled();
  });

  it('allows adyen when (a), (b) and (c) all hold', async () => {
    legacyRows(0);
    await expect(
      assertProviderSelectable('adyen', store(watch(30_000, null)), NOW),
    ).resolves.toBeUndefined();
    await expect(
      assertProviderSelectable('adyen', store(watch(30_000, LEGACY_CLEAN_MS)), NOW),
    ).resolves.toBeUndefined();
  });

  it('(a) refuses while an old connection is open, with the details', async () => {
    legacyRows(3, ['10.0.0.7', '10.0.0.8']);
    const err = await assertProviderSelectable('adyen', store(watch(30_000, null)), NOW).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PaymentProviderUpgradePendingError);
    expect((err as PaymentProviderUpgradePendingError).providerId).toBe('adyen');
    expect((err as PaymentProviderUpgradePendingError).details).toEqual({
      legacyConnections: 3,
      hosts: ['10.0.0.7', '10.0.0.8'],
      lastLegacySeenAt: null,
      watchCheckedAt: ago(30_000),
    });
  });

  it('(b) refuses without a watch result or with a stale one', async () => {
    legacyRows(0);
    await expect(assertProviderSelectable('adyen', store(null), NOW)).rejects.toBeInstanceOf(
      PaymentProviderUpgradePendingError,
    );
    await expect(
      assertProviderSelectable('adyen', store(watch(WATCH_FRESH_MS, null)), NOW),
    ).rejects.toBeInstanceOf(PaymentProviderUpgradePendingError);
    await expect(assertProviderSelectable('adyen', store('not json'), NOW)).rejects.toBeInstanceOf(
      PaymentProviderUpgradePendingError,
    );
  });

  it('(c) refuses when the watch saw an old connection within the clean window', async () => {
    legacyRows(0);
    const err = await assertProviderSelectable(
      'adyen',
      store(watch(30_000, LEGACY_CLEAN_MS - 1)),
      NOW,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentProviderUpgradePendingError);
    expect((err as PaymentProviderUpgradePendingError).details).toEqual({
      legacyConnections: 0,
      hosts: [],
      lastLegacySeenAt: ago(LEGACY_CLEAN_MS - 1),
      watchCheckedAt: ago(30_000),
    });
  });

  it('throws a database error instead of allowing the switch', async () => {
    query.mockRejectedValue(new Error('connection refused'));
    await expect(
      assertProviderSelectable('adyen', store(watch(30_000, null)), NOW),
    ).rejects.toThrow('connection refused');
  });
});

describe('providerUpgradePending', () => {
  it('returns null when the switch is allowed', async () => {
    legacyRows(0);
    await expect(
      providerUpgradePending('adyen', store(watch(1_000, null)), NOW),
    ).resolves.toBeNull();
  });
});

describe('recordProcessWatch', () => {
  it('stores checkedAt and legacySeenAt when an old connection is open', async () => {
    legacyRows(1, ['10.0.0.9']);
    const s = store(watch(60_000, null));
    const result = await recordProcessWatch(s, NOW);
    expect(result.check).toEqual({ legacy: 1, hosts: ['10.0.0.9'] });
    expect(result.state).toEqual({ checkedAt: NOW.toISOString(), legacySeenAt: NOW.toISOString() });
    expect(s.setCalls).toEqual([
      [PROCESS_VERSION_WATCH_KEY, JSON.stringify(result.state), 'EX', 3600],
    ]);
  });

  it('keeps the previous legacySeenAt when clean', async () => {
    legacyRows(0);
    const s = store(watch(60_000, 120_000));
    const { state } = await recordProcessWatch(s, NOW);
    expect(state).toEqual({ checkedAt: NOW.toISOString(), legacySeenAt: ago(120_000) });
  });

  it('starts clean without a previous result', async () => {
    legacyRows(0);
    const { state } = await recordProcessWatch(store(null), NOW);
    expect(state).toEqual({ checkedAt: NOW.toISOString(), legacySeenAt: null });
  });
});
