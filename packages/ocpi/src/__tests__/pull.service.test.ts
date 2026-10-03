// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

// --- @evtivity/database mock: select chains feed a queue; insert chains record
// the values they were called with so the batched-upsert assertions can inspect
// chunk sizes. @evtivity/lib (withLock) and drizzle-orm (sql/eq/and) stay real.
let selectResults: unknown[][] = [];
let selectIndex = 0;
interface InsertRec {
  value: unknown;
  upserted: boolean;
}
let inserts: InsertRec[] = [];

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  chain['then'] = (
    onF?: (v: unknown) => unknown,
    onR?: (r: unknown) => unknown,
  ): Promise<unknown> => Promise.resolve(selectResults[selectIndex++] ?? []).then(onF, onR);
  return chain;
}

function makeInsertChain(): Record<string, unknown> {
  const rec: InsertRec = { value: undefined, upserted: false };
  const chain: Record<string, unknown> = {
    values: vi.fn((v: unknown) => {
      rec.value = v;
      inserts.push(rec);
      return chain;
    }),
    onConflictDoUpdate: vi.fn(() => {
      rec.upserted = true;
      return chain;
    }),
    then: (onF?: (v: unknown) => unknown, onR?: (r: unknown) => unknown): Promise<unknown> =>
      Promise.resolve(undefined).then(onF, onR),
  };
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => makeInsertChain()),
  },
  ocpiPartners: { id: {}, countryCode: {}, partyId: {}, version: {} },
  ocpiPartnerEndpoints: { url: {}, partnerId: {}, module: {}, interfaceRole: {} },
  ocpiExternalLocations: { partnerId: {}, countryCode: {}, partyId: {}, locationId: {} },
  ocpiExternalTariffs: { partnerId: {}, countryCode: {}, partyId: {}, tariffId: {} },
  ocpiCdrs: { partnerId: {}, ocpiCdrId: {} },
  ocpiSyncLog: {},
}));

const getPaginatedEachMock = vi.fn();
vi.mock('../lib/ocpi-client.js', () => ({
  OcpiClient: class {
    getPaginatedEach = getPaginatedEachMock;
  },
}));

vi.mock('../lib/outbound-token.js', () => ({
  getOutboundToken: vi.fn(() => Promise.resolve('outbound-token')),
}));

import { pullCdrs, pullLocations } from '../services/pull.service.js';

// Endpoint lookup then partner-info lookup (the two SELECTs in pullLocations).
function primePartnerLookups(): void {
  selectResults = [
    [{ url: 'http://127.0.0.1/locations' }],
    [{ countryCode: 'DE', partyId: 'ABC' }],
  ];
  selectIndex = 0;
}

function validLocation(id: string): Record<string, unknown> {
  return {
    id,
    country_code: 'DE',
    party_id: 'ABC',
    name: `Loc ${id}`,
    coordinates: { latitude: '52.5', longitude: '13.4' },
    evses: [],
  };
}

const upsertedRows = (): InsertRec[] => inserts.filter((i) => i.upserted);
const syncLogRows = (): InsertRec[] =>
  inserts.filter((i) => !i.upserted && !Array.isArray(i.value));

describe('pullLocations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];
    selectIndex = 0;
    inserts = [];
    getPaginatedEachMock.mockReset();
  });

  it('upserts valid locations in a batch and skips malformed rows', async () => {
    primePartnerLookups();
    getPaginatedEachMock.mockImplementation(
      async (_url: string, onPage: (p: unknown[]) => Promise<void>) => {
        await onPage([
          validLocation('a'),
          { id: 'bad', country_code: 'DE', party_id: 'ABC' }, // no coordinates
          validLocation('c'),
        ]);
      },
    );

    const res = await pullLocations('opr_1');

    expect(res).toEqual({ module: 'locations', objectsCount: 2, status: 'completed' });
    // one upsert statement carrying both valid rows
    const upserts = upsertedRows();
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.value).toHaveLength(2);
    // started + completed sync-log rows
    expect(syncLogRows()).toHaveLength(2);
  });

  it('chunks large pages into multiple batched upserts of <= 500 rows', async () => {
    primePartnerLookups();
    const page = Array.from({ length: 1001 }, (_v, i) => validLocation(`l${String(i)}`));
    getPaginatedEachMock.mockImplementation(
      async (_url: string, onPage: (p: unknown[]) => Promise<void>) => {
        await onPage(page);
      },
    );

    const res = await pullLocations('opr_1');

    expect(res.objectsCount).toBe(1001);
    const upserts = upsertedRows();
    expect(upserts).toHaveLength(3); // 500 + 500 + 1
    const sizes = upserts.map((u) => (Array.isArray(u.value) ? u.value.length : 0));
    expect(sizes).toEqual([500, 500, 1]);
    expect(sizes.every((s) => s <= 500)).toBe(true);
  });

  it('records a failed sync when the partner has no locations endpoint', async () => {
    selectResults = [[], [{ countryCode: 'DE', partyId: 'ABC' }]]; // no endpoint row
    selectIndex = 0;

    const res = await pullLocations('opr_1');

    expect(res.status).toBe('failed');
    expect(getPaginatedEachMock).not.toHaveBeenCalled();
    expect(upsertedRows()).toHaveLength(0);
  });

  it('skips the pull when the per-partner lock is already held', async () => {
    const heldRedis = {
      set: vi.fn(() => Promise.resolve(null)), // SET NX fails: lock held
      eval: vi.fn(() => Promise.resolve(1)),
    } as unknown as Redis;

    const res = await pullLocations('opr_1', heldRedis);

    expect(res).toEqual({ module: 'locations', objectsCount: 0, status: 'completed' });
    expect(getPaginatedEachMock).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0); // not even a 'started' sync-log row
  });

  it('runs and releases the lock when it is free', async () => {
    let held = false;
    const freeRedis = {
      set: vi.fn(() => {
        if (held) return Promise.resolve(null);
        held = true;
        return Promise.resolve('OK');
      }),
      eval: vi.fn(() => {
        held = false;
        return Promise.resolve(1);
      }),
    } as unknown as Redis;
    primePartnerLookups();
    getPaginatedEachMock.mockImplementation(
      async (_url: string, onPage: (p: unknown[]) => Promise<void>) => {
        await onPage([validLocation('a')]);
      },
    );

    const res = await pullLocations('opr_1', freeRedis);

    expect(res.status).toBe('completed');
    expect(res.objectsCount).toBe(1);
    expect(getPaginatedEachMock).toHaveBeenCalledOnce();
    expect(freeRedis.eval).toHaveBeenCalled(); // lock released
  });
});

describe('pullCdrs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inserts = [];
    getPaginatedEachMock.mockReset();
  });

  function cdr(id: string, totalCost: unknown): Record<string, unknown> {
    return { id, total_energy: 10, currency: 'EUR', total_cost: totalCost };
  }

  function primeCdrLookups(version: string | null): void {
    selectResults = [
      [{ url: 'http://127.0.0.1/cdrs' }],
      [{ countryCode: 'DE', partyId: 'ABC', version }],
      [], // no CDR of the page stored yet
    ];
    selectIndex = 0;
  }

  const insertedCdrs = (): Array<Record<string, unknown>> =>
    inserts
      .filter((i) => !i.upserted && Array.isArray(i.value))
      .flatMap((i) => i.value as Array<Record<string, unknown>>);

  it('stores excl_vat from a 2.2.1 partner and skips CDRs without that Price', async () => {
    primeCdrLookups('2.2.1');
    getPaginatedEachMock.mockImplementation(
      async (_url: string, onPage: (p: unknown[]) => Promise<void>) => {
        await onPage([
          cdr('a', { excl_vat: 4, incl_vat: 4.76 }),
          cdr('b', { before_taxes: 4 }),
          cdr('c', { excl_vat: '4.00' }),
        ]);
      },
    );

    const res = await pullCdrs('opr_1');

    expect(res).toEqual({ module: 'cdrs', objectsCount: 1, status: 'completed' });
    expect(insertedCdrs()).toEqual([expect.objectContaining({ ocpiCdrId: 'a', totalCost: '4' })]);
  });

  it('stores before_taxes from a 2.3.0 partner', async () => {
    primeCdrLookups('2.3.0');
    getPaginatedEachMock.mockImplementation(
      async (_url: string, onPage: (p: unknown[]) => Promise<void>) => {
        await onPage([cdr('a', { before_taxes: 4, taxes: [{ name: 'VAT', amount: 0.76 }] })]);
      },
    );

    const res = await pullCdrs('opr_1');

    expect(res.objectsCount).toBe(1);
    expect(insertedCdrs()).toEqual([expect.objectContaining({ ocpiCdrId: 'a', totalCost: '4' })]);
  });
});
