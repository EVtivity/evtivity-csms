// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

// Conditions are evaluated in memory, so the same cases run through the
// Authorize condition and the Started link query.
type Row = Record<string, unknown>;
type Cond =
  | { op: 'eq'; col: string; val: unknown }
  | { op: 'in'; col: string; vals: unknown[] }
  | { op: 'and' | 'or'; conds: Cond[] };

function matches(row: Row, cond: Cond): boolean {
  switch (cond.op) {
    case 'and':
      return cond.conds.every((c) => matches(row, c));
    case 'or':
      return cond.conds.some((c) => matches(row, c));
    case 'eq':
      return row[cond.col] === cond.val;
    case 'in':
      return cond.vals.includes(row[cond.col]);
  }
}

const h = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock('drizzle-orm', () => ({
  eq: (a: { col: string }, val: unknown) => ({ op: 'eq', col: a.col, val }),
  inArray: (a: { col: string }, vals: unknown[]) => ({ op: 'in', col: a.col, vals }),
  and: (...conds: unknown[]) => ({ op: 'and', conds: conds.filter((c) => c != null) }),
  or: (...conds: unknown[]) => ({ op: 'or', conds: conds.filter((c) => c != null) }),
  // The exact-spelling-first order: `idToken = <value>`, descending.
  sql: (_s: TemplateStringsArray, col: { col: string }, value: unknown) => ({
    exactFirst: { col: col.col, value },
  }),
  desc: (expr: unknown) => ({ desc: expr }),
  asc: (col: { col: string }) => ({ asc: col.col }),
}));

vi.mock('@evtivity/database', () => {
  const col = (c: string) => ({ col: c });
  return {
    driverTokens: {
      id: col('id'),
      driverId: col('driverId'),
      idToken: col('idToken'),
      tokenType: col('tokenType'),
      isActive: col('isActive'),
      prepaidBalanceCents: col('prepaidBalanceCents'),
    },
    db: {
      select: (columns: Record<string, { col: string }>) => ({
        from: () => ({
          where: (cond: Cond) => ({
            orderBy: (first: { desc: { exactFirst: { col: string; value: unknown } } }) => {
              const { col: exactCol, value } = first.desc.exactFirst;
              const found = h.rows
                .filter((r) => matches(r, cond))
                .sort(
                  (a, b) =>
                    Number(b[exactCol] === value) - Number(a[exactCol] === value) ||
                    String(a['id']).localeCompare(String(b['id'])),
                );
              return Promise.resolve(
                found.map((r) =>
                  Object.fromEntries(Object.entries(columns).map(([k, c]) => [k, r[c.col]])),
                ),
              );
            },
          }),
        }),
      }),
    },
  };
});

const { stationTokenCondition, findLinkableStationTokens } =
  await import('../../authorization/station-token-match.js');

const CARDS: Row[] = [
  { id: 't1', driverId: 'd1', idToken: 'AABBCCDDEEFF', tokenType: 'MacAddress', isActive: true },
  { id: 't2', driverId: 'd2', idToken: 'AABBCCDDEEFF', tokenType: 'ISO14443', isActive: true },
  { id: 't3', driverId: 'd3', idToken: 'VID:AABBCCDDEEFF', tokenType: 'ISO14443', isActive: true },
  { id: 't4', driverId: 'd4', idToken: '1HGCM82633A004352', tokenType: 'VIN', isActive: false },
  { id: 't5', driverId: 'd5', idToken: 'CARD-01', tokenType: 'ISO14443', isActive: true },
  { id: 't6', driverId: 'd6', idToken: 'CARD-01', tokenType: 'Local', isActive: true },
].map((r) => ({ ...r, prepaidBalanceCents: null }));

const CASES: { value: string; type: string | null; expected: string[] }[] = [
  // A 1.6 VID: idTag: a vehicle id card in canonical form, and a card spelled
  // exactly as sent. A plain card with the bare MAC never matches it.
  { value: 'VID:AABBCCDDEEFF', type: null, expected: ['t1', 't3'] },
  { value: 'vid:aa:bb:cc:dd:ee:ff', type: null, expected: ['t1'] },
  { value: 'AABBCCDDEEFF', type: null, expected: ['t1', 't2'] },
  { value: 'AABBCCDDEEFF', type: 'MacAddress', expected: ['t1'] },
  { value: 'AABBCCDDEEFF', type: 'ISO14443', expected: ['t2'] },
  { value: '1hgcm82633a004352', type: 'VIN', expected: ['t4'] },
  { value: 'CARD-01', type: null, expected: ['t5', 't6'] },
  { value: 'CARD-01', type: 'Local', expected: ['t6'] },
  { value: 'card-01', type: null, expected: [] },
];

describe('station token match', () => {
  it.each(CASES)('Authorize matches $value ($type)', ({ value, type, expected }) => {
    const cond = stationTokenCondition(value, type) as unknown as Cond;
    expect(CARDS.filter((r) => matches(r, cond)).map((r) => r['id'])).toEqual(expected);
  });

  it.each(CASES)(
    'the Started link takes the same cards, active only, for $value ($type)',
    async ({ value, type, expected }) => {
      h.rows = CARDS;
      const linked = (await findLinkableStationTokens(value, type)).map((r) => r.id);
      const active = expected.filter((id) => CARDS.find((r) => r['id'] === id)?.['isActive']);
      expect([...linked].sort()).toEqual([...active].sort());
    },
  );

  it('links the exact spelling before a canonical match', async () => {
    h.rows = CARDS;
    const linked = await findLinkableStationTokens('VID:AABBCCDDEEFF', null);
    expect(linked.map((r) => r.id)).toEqual(['t3', 't1']);
  });
});
