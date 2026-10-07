// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PubSubClient } from '@evtivity/lib';

// Select chains read from a queue; insert chains record their values so the
// tests can inspect what each pull wrote (upserts, CDR inserts, sync-log rows).
let selectResults: unknown[][] = [];
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
  ): Promise<unknown> => Promise.resolve(selectResults.shift() ?? []).then(onF, onR);
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
  ocpiPartners: { id: {}, countryCode: {}, partyId: {}, version: {}, allowPrivateNetwork: {} },
  ocpiPartnerEndpoints: { url: {}, partnerId: {}, module: {}, interfaceRole: {} },
  ocpiExternalLocations: { partnerId: {}, countryCode: {}, partyId: {}, locationId: {} },
  ocpiExternalTariffs: { partnerId: {}, countryCode: {}, partyId: {}, tariffId: {} },
  ocpiCdrs: { partnerId: {}, ocpiCdrId: {} },
  ocpiSyncLog: {},
}));

const { getPaginatedEachMock, getOutboundTokenMock } = vi.hoisted(() => ({
  getPaginatedEachMock: vi.fn(),
  getOutboundTokenMock: vi.fn(),
}));
vi.mock('../lib/ocpi-client.js', () => ({
  OcpiClient: class {
    getPaginatedEach = getPaginatedEachMock;
  },
}));
vi.mock('../lib/outbound-token.js', () => ({ getOutboundToken: getOutboundTokenMock }));

const { pullTariffs, pullCdrs, pullLocations, OcpiPullListener } =
  await import('../services/pull.service.js');

// The pullable entries of OCPI_MODULES (modules.test.ts checks the registry wiring).
const PULL_MODULES = [
  { identifier: 'locations', pull: pullLocations },
  { identifier: 'tariffs', pull: pullTariffs },
  { identifier: 'cdrs', pull: pullCdrs },
] as const;

type PageHandler = (p: unknown[]) => Promise<void>;
function servePages(...pages: unknown[][]): void {
  getPaginatedEachMock.mockImplementation(async (_url: string, onPage: PageHandler) => {
    for (const p of pages) await onPage(p);
  });
}

const PARTNER = { countryCode: 'DE', partyId: 'ABC', version: '2.2.1', allowPrivateNetwork: false };

function syncLogs(): Array<Record<string, unknown>> {
  return inserts
    .filter((i) => !i.upserted && !Array.isArray(i.value))
    .map((i) => i.value as Record<string, unknown>);
}
function upserted(): Array<Record<string, unknown>> {
  return inserts
    .filter((i) => i.upserted)
    .flatMap((i) => i.value as Array<Record<string, unknown>>);
}
function insertedCdrs(): Array<Record<string, unknown>> {
  return inserts
    .filter((i) => !i.upserted && Array.isArray(i.value))
    .flatMap((i) => i.value as Array<Record<string, unknown>>);
}

beforeEach(() => {
  selectResults = [];
  inserts = [];
  getPaginatedEachMock.mockReset();
  getOutboundTokenMock.mockReset();
  getOutboundTokenMock.mockResolvedValue('outbound-token');
});

describe('pullTariffs', () => {
  function tariff(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, country_code: 'DE', party_id: 'ABC', currency: 'EUR', elements: [], ...extra };
  }

  it('upserts valid tariffs, maps their identity columns and skips malformed rows', async () => {
    selectResults = [[{ url: 'https://partner.example/tariffs' }], [PARTNER]];
    servePages([
      tariff('t1'),
      null,
      'not-an-object',
      { id: 't2', country_code: 'DE' },
      tariff('t3'),
    ]);

    const res = await pullTariffs('opr_1');

    expect(res).toEqual({ module: 'tariffs', objectsCount: 2, status: 'completed' });
    expect(getPaginatedEachMock).toHaveBeenCalledWith(
      'https://partner.example/tariffs',
      expect.any(Function),
    );
    const rows = upserted();
    expect(rows.map((r) => r['tariffId'])).toEqual(['t1', 't3']);
    expect(rows[0]).toMatchObject({
      partnerId: 'opr_1',
      countryCode: 'DE',
      partyId: 'ABC',
      currency: 'EUR',
      tariffData: tariff('t1'),
    });
    expect(syncLogs().map((l) => [l['module'], l['status'], l['objectsCount']])).toEqual([
      ['tariffs', 'started', '0'],
      ['tariffs', 'completed', '2'],
    ]);
  });

  it('writes no upsert for a page with only malformed tariffs', async () => {
    selectResults = [[{ url: 'https://partner.example/tariffs' }], [PARTNER]];
    servePages([{ id: 1 }]);

    const res = await pullTariffs('opr_1');

    expect(res.objectsCount).toBe(0);
    expect(upserted()).toHaveLength(0);
  });

  it('fails with a message when the partner has no tariffs endpoint', async () => {
    selectResults = [[], [PARTNER]];

    const res = await pullTariffs('opr_1');

    expect(res).toEqual({
      module: 'tariffs',
      objectsCount: 0,
      status: 'failed',
      errorMessage: 'Partner has no tariffs SENDER endpoint',
    });
    const failed = syncLogs().find((l) => l['status'] === 'failed');
    expect(failed).toMatchObject({
      direction: 'pull',
      action: 'pull_full',
      errorMessage: 'Partner has no tariffs SENDER endpoint',
    });
  });

  it('fails when no outbound token is stored for the partner', async () => {
    selectResults = [[{ url: 'https://partner.example/tariffs' }], [PARTNER]];
    getOutboundTokenMock.mockResolvedValue(null);

    const res = await pullTariffs('opr_1');

    expect(res.errorMessage).toBe('No outbound token for partner');
    expect(getPaginatedEachMock).not.toHaveBeenCalled();
  });

  it('fails when the partner row is missing', async () => {
    selectResults = [[{ url: 'https://partner.example/tariffs' }], []];

    const res = await pullTariffs('opr_1');

    expect(res.errorMessage).toBe('Partner not found');
  });

  it('reports a failed pull when the partner request throws', async () => {
    selectResults = [[{ url: 'https://partner.example/tariffs' }], [PARTNER]];
    getPaginatedEachMock.mockRejectedValue(new Error('HTTP 502'));

    const res = await pullTariffs('opr_1');

    expect(res).toMatchObject({ status: 'failed', errorMessage: 'HTTP 502' });
  });
});

describe('pullLocations error paths', () => {
  it('fails when no outbound token is stored', async () => {
    selectResults = [[{ url: 'https://partner.example/locations' }], [PARTNER]];
    getOutboundTokenMock.mockResolvedValue(null);

    const res = await pullLocations('opr_1');

    expect(res).toMatchObject({ status: 'failed', errorMessage: 'No outbound token for partner' });
  });

  it('fails when the partner row is missing', async () => {
    selectResults = [[{ url: 'https://partner.example/locations' }], []];

    const res = await pullLocations('opr_1');

    expect(res).toMatchObject({ status: 'failed', errorMessage: 'Partner not found' });
  });

  it('uses a generic message when a non-Error value is thrown', async () => {
    selectResults = [[{ url: 'https://partner.example/locations' }], [PARTNER]];
    getPaginatedEachMock.mockRejectedValue('boom');

    const res = await pullLocations('opr_1');

    expect(res).toMatchObject({ status: 'failed', errorMessage: 'Pull failed' });
  });

  it('skips non-object rows, maps name and EVSE count, and defaults a missing name', async () => {
    selectResults = [[{ url: 'https://partner.example/locations' }], [PARTNER]];
    servePages([
      null,
      {
        id: 'L1',
        country_code: 'DE',
        party_id: 'ABC',
        coordinates: { latitude: '1', longitude: '2' },
        evses: [{ uid: 'a' }, { uid: 'b' }],
      },
      {
        id: 'L2',
        country_code: 'DE',
        party_id: 'ABC',
        name: 'Two',
        coordinates: { latitude: '3', longitude: '4' },
      },
    ]);

    const res = await pullLocations('opr_1');

    expect(res.objectsCount).toBe(2);
    expect(upserted()).toEqual([
      expect.objectContaining({ locationId: 'L1', name: null, evseCount: '2', latitude: '1' }),
      expect.objectContaining({ locationId: 'L2', name: 'Two', evseCount: '0', longitude: '4' }),
    ]);
  });
});

describe('pullCdrs', () => {
  function cdr(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      total_energy: 12.5,
      currency: 'EUR',
      total_cost: { excl_vat: 3.5, incl_vat: 4.17 },
      ...extra,
    };
  }

  it('inserts only CDRs not stored yet and maps the credit flag', async () => {
    selectResults = [
      [{ url: 'https://partner.example/cdrs' }],
      [PARTNER],
      [{ ocpiCdrId: 'c1' }], // c1 already stored
    ];
    servePages([cdr('c1'), cdr('c2', { credit: true }), cdr('c3'), null]);

    const res = await pullCdrs('opr_1');

    expect(res).toEqual({ module: 'cdrs', objectsCount: 2, status: 'completed' });
    expect(insertedCdrs()).toEqual([
      expect.objectContaining({
        ocpiCdrId: 'c2',
        totalEnergy: '12.5',
        totalCost: '3.5',
        currency: 'EUR',
        isCredit: true,
        pushStatus: 'confirmed',
      }),
      expect.objectContaining({ ocpiCdrId: 'c3', isCredit: false }),
    ]);
  });

  it('skips the existence lookup for a page with no valid CDRs', async () => {
    selectResults = [[{ url: 'https://partner.example/cdrs' }], [PARTNER]];
    servePages([cdr('x', { total_energy: '12' }), cdr('y', { currency: 5 })]);

    const res = await pullCdrs('opr_1');

    expect(res.objectsCount).toBe(0);
    expect(insertedCdrs()).toHaveLength(0);
  });

  it('fails when the partner has no cdrs endpoint', async () => {
    selectResults = [[], [PARTNER]];

    const res = await pullCdrs('opr_1');

    expect(res).toMatchObject({
      module: 'cdrs',
      status: 'failed',
      errorMessage: 'Partner has no cdrs SENDER endpoint',
    });
  });

  it('fails when no outbound token is stored', async () => {
    selectResults = [[{ url: 'https://partner.example/cdrs' }], [PARTNER]];
    getOutboundTokenMock.mockResolvedValue(null);

    const res = await pullCdrs('opr_1');

    expect(res.errorMessage).toBe('No outbound token for partner');
  });

  it('fails when the partner row is missing', async () => {
    selectResults = [[{ url: 'https://partner.example/cdrs' }], []];

    const res = await pullCdrs('opr_1');

    expect(res.errorMessage).toBe('Partner not found');
  });
});

describe('OcpiPullListener', () => {
  function makePubsub(): {
    pubsub: PubSubClient;
    deliver: (payload: string) => void;
    unsubscribe: ReturnType<typeof vi.fn>;
  } {
    let handler: ((payload: string) => void) | null = null;
    const unsubscribe = vi.fn(() => Promise.resolve());
    const pubsub = {
      publish: vi.fn(),
      subscribe: vi.fn((_channel: string, h: (payload: string) => void) => {
        handler = h;
        return Promise.resolve({ unsubscribe });
      }),
    } as unknown as PubSubClient;
    return {
      pubsub,
      unsubscribe,
      deliver: (payload: string) => {
        if (handler == null) throw new Error('not subscribed');
        handler(payload);
      },
    };
  }

  it('subscribes to ocpi_sync and runs the requested module pull', async () => {
    const { pubsub, deliver, unsubscribe } = makePubsub();
    const listener = new OcpiPullListener(pubsub, PULL_MODULES);
    await listener.start();
    expect(pubsub.subscribe).toHaveBeenCalledWith('ocpi_sync', expect.any(Function));

    selectResults = [[{ url: 'https://partner.example/tariffs' }], [PARTNER]];
    servePages([{ id: 't1', country_code: 'DE', party_id: 'ABC', currency: 'EUR' }]);
    deliver(JSON.stringify({ partnerId: 'opr_9', module: 'tariffs' }));

    // stop() drains in-flight work before returning.
    await listener.stop();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(upserted()).toEqual([expect.objectContaining({ partnerId: 'opr_9', tariffId: 't1' })]);
  });

  it('routes locations and cdrs notifications to their pulls', async () => {
    const { pubsub, deliver } = makePubsub();
    const listener = new OcpiPullListener(pubsub, PULL_MODULES);
    await listener.start();

    selectResults = [[], [PARTNER]];
    deliver(JSON.stringify({ partnerId: 'opr_9', module: 'locations' }));
    await listener.stop();
    expect(syncLogs().find((l) => l['status'] === 'failed')).toMatchObject({
      module: 'locations',
      errorMessage: 'Partner has no locations SENDER endpoint',
    });

    inserts = [];
    await listener.start();
    selectResults = [[], [PARTNER]];
    deliver(JSON.stringify({ partnerId: 'opr_9', module: 'cdrs' }));
    await listener.stop();
    expect(syncLogs().find((l) => l['status'] === 'failed')).toMatchObject({ module: 'cdrs' });
  });

  it('ignores an unparsable payload and an unknown module without writing anything', async () => {
    const { pubsub, deliver } = makePubsub();
    const listener = new OcpiPullListener(pubsub, PULL_MODULES);
    await listener.start();

    deliver('{not json');
    deliver(JSON.stringify({ partnerId: 'opr_9', module: 'sessions' }));
    await listener.stop();

    expect(inserts).toHaveLength(0);
    expect(getPaginatedEachMock).not.toHaveBeenCalled();
  });

  it('stop() without start() is a no-op', async () => {
    const { pubsub, unsubscribe } = makePubsub();
    const listener = new OcpiPullListener(pubsub, PULL_MODULES);
    await listener.stop();
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});
