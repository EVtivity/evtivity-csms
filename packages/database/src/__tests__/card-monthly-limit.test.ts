// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const { getCompanyCurrency, getSystemTimezone } = vi.hoisted(() => ({
  getCompanyCurrency: vi.fn(),
  getSystemTimezone: vi.fn(),
}));
vi.mock('../lib/system-settings.js', () => ({ getCompanyCurrency, getSystemTimezone }));

const { readCardMonthlyLimit, checkCardMonthlyLimit, cardLimitBindsSession, cardsMonthSpend } =
  await import('../lib/card-monthly-limit.js');

interface FakeSession {
  id: string;
  tokenId: string;
  status: 'active' | 'completed';
  ceiling: number | null;
  running: number;
  finalCost: number;
}

interface FakeDb {
  limits: Map<string, number | null>;
  sessions: FakeSession[];
  locks: number;
}

/**
 * The cards and their sessions behind a sql mock that answers the card
 * limit queries from that state, one transaction at a time like the fleet
 * row lock.
 */
function fakeDb(db: FakeDb): postgres.Sql {
  let lock: Promise<unknown> = Promise.resolve();
  const spendOf = (tokenId: string, exclude: string | null): number =>
    db.sessions
      .filter((s) => s.tokenId === tokenId && s.id !== exclude)
      .reduce(
        (sum, s) =>
          sum + (s.status === 'active' ? (s.ceiling ?? Math.max(s.running, 0)) : s.finalCost),
        0,
      );
  const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    if (text.includes('SELECT monthly_limit_cents FROM driver_tokens')) {
      const limit = db.limits.get(values[0] as string);
      return Promise.resolve(limit === undefined ? [] : [{ monthly_limit_cents: limit }]);
    }
    if (text.includes('FOR UPDATE OF f')) {
      db.locks += 1;
      return Promise.resolve([{ id: 'flt_1' }]);
    }
    if (text.includes('GROUP BY cs.token_id')) {
      const ids = values[0] as string[];
      return Promise.resolve(
        ids
          .map((id) => ({
            token_id: id,
            spent: String(
              db.sessions
                .filter((s) => s.tokenId === id)
                .reduce((sum, s) => sum + (s.status === 'active' ? s.running : s.finalCost), 0),
            ),
          }))
          .filter((row) => row.spent !== '0'),
      );
    }
    if (text.includes('SUM(CASE')) {
      const tokenId = values[0] as string;
      const exclude = values[4] as string | null;
      return Promise.resolve([{ spent: String(spendOf(tokenId, exclude)) }]);
    }
    if (text.includes('SET cost_ceiling_cents = LEAST')) {
      const remaining = values[0] as number;
      const session = db.sessions.find((s) => s.id === values[2] && s.tokenId === values[3]);
      if (session == null) return Promise.resolve([]);
      session.ceiling = Math.min(session.ceiling ?? remaining, remaining);
      return Promise.resolve([{ cost_ceiling_cents: session.ceiling }]);
    }
    if (text.includes('SELECT token_id, cost_ceiling_cents FROM charging_sessions')) {
      const session = db.sessions.find((s) => s.id === values[0]);
      return Promise.resolve(
        session == null ? [] : [{ token_id: session.tokenId, cost_ceiling_cents: session.ceiling }],
      );
    }
    return Promise.resolve([]);
  };
  (fn as unknown as { begin: unknown }).begin = (
    work: (tx: unknown) => Promise<unknown>,
  ): Promise<unknown> => {
    const run = lock.then(() => work(fn));
    lock = run.catch(() => undefined);
    return run;
  };
  return fn as unknown as postgres.Sql;
}

function session(over: Partial<FakeSession> & { id: string }): FakeSession {
  return {
    tokenId: 'dtk_1',
    status: 'completed',
    ceiling: null,
    running: 0,
    finalCost: 0,
    ...over,
  };
}

beforeEach(() => {
  getCompanyCurrency.mockReset();
  getCompanyCurrency.mockResolvedValue('EUR');
  getSystemTimezone.mockReset();
  getSystemTimezone.mockResolvedValue('Europe/Berlin');
});

describe('readCardMonthlyLimit', () => {
  it('is null for a card without a limit or an unknown card', async () => {
    const sql = fakeDb({ limits: new Map([['dtk_1', null]]), sessions: [], locks: 0 });
    expect(await readCardMonthlyLimit(sql, 'dtk_1')).toBeNull();
    expect(await readCardMonthlyLimit(sql, 'dtk_missing')).toBeNull();
  });

  it('counts ended sessions at their final cost and running ones at their reservation', async () => {
    const sql = fakeDb({
      limits: new Map([['dtk_1', 10_000]]),
      sessions: [
        session({ id: 's1', finalCost: 3_000 }),
        session({ id: 's2', status: 'active', ceiling: 2_000, running: 500 }),
        session({ id: 's3', status: 'active', running: 700 }),
        session({ id: 'other', tokenId: 'dtk_2', finalCost: 9_000 }),
      ],
      locks: 0,
    });
    expect(await readCardMonthlyLimit(sql, 'dtk_1')).toEqual({
      tokenId: 'dtk_1',
      limitCents: 10_000,
      spentCents: 5_700,
      remainingCents: 4_300,
      ceilingCents: null,
    });
  });

  it('never has less than nothing left', async () => {
    const sql = fakeDb({
      limits: new Map([['dtk_1', 1_000]]),
      sessions: [session({ id: 's1', finalCost: 1_500 })],
      locks: 0,
    });
    expect((await readCardMonthlyLimit(sql, 'dtk_1'))?.remainingCents).toBe(0);
  });
});

describe('checkCardMonthlyLimit', () => {
  it('takes no lock for a card without a limit', async () => {
    const db: FakeDb = { limits: new Map([['dtk_1', null]]), sessions: [], locks: 0 };
    expect(await checkCardMonthlyLimit(fakeDb(db), 'dtk_1')).toBeNull();
    expect(db.locks).toBe(0);
  });

  it('caps the session ceiling at what the card may still spend, never raising it', async () => {
    const db: FakeDb = {
      limits: new Map([['dtk_1', 10_000]]),
      sessions: [
        session({ id: 's1', finalCost: 6_000 }),
        session({ id: 'new', status: 'active', ceiling: 5_000 }),
        session({ id: 'small', status: 'active', ceiling: 1_000 }),
      ],
      locks: 0,
    };
    const sql = fakeDb(db);
    const check = await checkCardMonthlyLimit(sql, 'dtk_1', { reserveForSessionId: 'new' });
    // 10000 - 6000 ended - 1000 reserved by the other running session.
    expect(check?.remainingCents).toBe(3_000);
    expect(check?.ceilingCents).toBe(3_000);
    expect(db.locks).toBe(1);
    // The smaller ceiling a session already has stays.
    const small = await checkCardMonthlyLimit(sql, 'dtk_1', { reserveForSessionId: 'small' });
    expect(small?.ceilingCents).toBe(1_000);
  });

  it('gives a session started past the limit a ceiling of 0', async () => {
    const db: FakeDb = {
      limits: new Map([['dtk_1', 2_000]]),
      sessions: [session({ id: 's1', finalCost: 2_500 }), session({ id: 'new', status: 'active' })],
      locks: 0,
    };
    const check = await checkCardMonthlyLimit(fakeDb(db), 'dtk_1', { reserveForSessionId: 'new' });
    expect(check?.ceilingCents).toBe(0);
  });

  it('keeps two concurrent starts of one card within its limit', async () => {
    const db: FakeDb = {
      limits: new Map([['dtk_1', 5_000]]),
      sessions: [session({ id: 'a', status: 'active' }), session({ id: 'b', status: 'active' })],
      locks: 0,
    };
    const sql = fakeDb(db);
    const [a, b] = await Promise.all([
      checkCardMonthlyLimit(sql, 'dtk_1', { reserveForSessionId: 'a' }),
      checkCardMonthlyLimit(sql, 'dtk_1', { reserveForSessionId: 'b' }),
    ]);
    expect((a?.ceilingCents ?? 0) + (b?.ceilingCents ?? 0)).toBeLessThanOrEqual(5_000);
  });
});

describe('cardLimitBindsSession', () => {
  it('is true when what the card has left is not above the session ceiling', async () => {
    const sql = fakeDb({
      limits: new Map([['dtk_1', 10_000]]),
      sessions: [
        session({ id: 's1', finalCost: 7_000 }),
        session({ id: 'run', status: 'active', ceiling: 3_000 }),
      ],
      locks: 0,
    });
    expect(await cardLimitBindsSession(sql, 'run')).toBe(true);
    // A larger card limit than the ceiling: the ceiling is another one (fleet credit).
    expect(await cardLimitBindsSession(sql, 'run', 2_000)).toBe(false);
  });

  it('is false without a card, a ceiling or a limit', async () => {
    const sql = fakeDb({
      limits: new Map([['dtk_1', null]]),
      sessions: [session({ id: 'run', status: 'active', ceiling: 3_000 })],
      locks: 0,
    });
    expect(await cardLimitBindsSession(sql, 'run')).toBe(false);
    expect(await cardLimitBindsSession(sql, 'missing')).toBe(false);
  });
});

describe('cardsMonthSpend', () => {
  it('reads every card in one query, running sessions at their cost so far', async () => {
    const sql = fakeDb({
      limits: new Map(),
      sessions: [
        session({ id: 's1', finalCost: 1_000 }),
        session({ id: 's2', status: 'active', running: 250, ceiling: 5_000 }),
        session({ id: 's3', tokenId: 'dtk_2', finalCost: 0 }),
      ],
      locks: 0,
    });
    const spent = await cardsMonthSpend(sql, ['dtk_1', 'dtk_2']);
    expect(spent.get('dtk_1')).toBe(1_250);
    expect(spent.has('dtk_2')).toBe(false);
    expect((await cardsMonthSpend(sql, [])).size).toBe(0);
  });
});
