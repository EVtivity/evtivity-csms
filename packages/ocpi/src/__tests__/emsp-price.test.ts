// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Select chains resolve to the next queued result; writes are recorded.
let selectResults: unknown[][] = [];
let writes: Record<string, unknown>[] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(selectResults.shift() ?? []).then(resolve);
  return chain;
}
function makeWriteChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const record = (v: Record<string, unknown>): Record<string, unknown> => {
    writes.push(v);
    return chain;
  };
  chain['values'] = vi.fn(record);
  chain['set'] = vi.fn(record);
  chain['where'] = vi.fn(() => chain);
  chain['returning'] = vi.fn(() => Promise.resolve([{ id: 1 }]));
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeWriteChain()),
    update: vi.fn(() => makeWriteChain()),
  },
  ocpiCdrs: { partnerId: {}, ocpiCdrId: {}, id: {} },
  ocpiRoamingSessions: { partnerId: {}, ocpiSessionId: {}, id: {} },
}));
vi.mock('../middleware/ocpi-auth.js', () => ({
  ocpiAuthenticate: async (request: { ocpiPartner?: unknown }) => {
    request.ocpiPartner = { partnerId: 'opr_1', countryCode: 'DE', partyId: 'CPO' };
  },
}));
vi.mock('../lib/pubsub.js', () => ({
  notifyRoamingCdrChanged: vi.fn(),
  notifyRoamingSessionChanged: vi.fn(),
}));

const { emspCdrRoutes } = await import('../routes/emsp/cdrs.js');
const { emspSessionRoutes } = await import('../routes/emsp/sessions.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  emspCdrRoutes(app);
  emspSessionRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  selectResults = [];
  writes = [];
});

function cdr(totalCost: unknown): Record<string, unknown> {
  return {
    id: 'cdr-1',
    country_code: 'DE',
    party_id: 'CPO',
    start_date_time: '2026-09-01T10:00:00Z',
    end_date_time: '2026-09-01T11:00:00Z',
    currency: 'EUR',
    total_energy: 10,
    total_cost: totalCost,
  };
}

function session(totalCost?: unknown): Record<string, unknown> {
  return {
    id: 'ses-1',
    country_code: 'DE',
    party_id: 'CPO',
    start_date_time: '2026-09-01T10:00:00Z',
    status: 'ACTIVE',
    currency: 'EUR',
    kwh: 5,
    cdr_token: { uid: 'TOKEN-1' },
    ...(totalCost !== undefined ? { total_cost: totalCost } : {}),
  };
}

describe('eMSP CDR receiver', () => {
  it('stores excl_vat of a 2.2.1 CDR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ocpi/2.2.1/emsp/cdrs',
      payload: cdr({ excl_vat: 4, incl_vat: 4.76 }),
    });
    expect(res.statusCode).toBe(200);
    expect(writes[0]).toMatchObject({ totalCost: '4' });
  });

  it('stores before_taxes of a 2.3.0 CDR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ocpi/2.3.0/emsp/cdrs',
      payload: cdr({ before_taxes: 4, taxes: [{ name: 'VAT', percentage: 19, amount: 0.76 }] }),
    });
    expect(res.statusCode).toBe(200);
    expect(writes[0]).toMatchObject({ totalCost: '4' });
  });

  it('rejects a total_cost that is not a Price of the version', async () => {
    for (const [version, totalCost] of [
      ['2.3.0', { excl_vat: 4 }],
      ['2.2.1', { before_taxes: 4 }],
      ['2.2.1', { excl_vat: '5.00' }],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/ocpi/${version}/emsp/cdrs`,
        payload: cdr(totalCost),
      });
      expect(res.statusCode).toBe(400);
    }
    expect(writes).toHaveLength(0);
  });
});

describe('eMSP session receiver', () => {
  it('stores before_taxes of a 2.3.0 session', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.3.0/emsp/sessions/DE/CPO/ses-1',
      payload: session({ before_taxes: 0.6, taxes: [{ name: 'VAT', amount: 0.06 }] }),
    });
    expect(res.statusCode).toBe(200);
    expect(writes[0]).toMatchObject({ totalCost: '0.6' });
  });

  it('stores no cost for a session without total_cost', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/emsp/sessions/DE/CPO/ses-1',
      payload: session(),
    });
    expect(res.statusCode).toBe(200);
    expect(writes[0]).toMatchObject({ totalCost: null });
  });

  it('rejects a PUT whose total_cost is not a Price of the version', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/emsp/sessions/DE/CPO/ses-1',
      payload: session({ before_taxes: 0.6 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('patches total_cost with the version amount excluding tax', async () => {
    selectResults = [[{ id: 1, sessionData: session({ excl_vat: 0.5 }) }]];
    const res = await app.inject({
      method: 'PATCH',
      url: '/ocpi/2.2.1/emsp/sessions/DE/CPO/ses-1',
      payload: { total_cost: { excl_vat: 0.8, incl_vat: 0.95 } },
    });
    expect(res.statusCode).toBe(200);
    expect(writes[0]).toMatchObject({ totalCost: '0.8' });
  });

  it('rejects a PATCH whose total_cost is not a Price of the version', async () => {
    selectResults = [[{ id: 1, sessionData: session() }]];
    const res = await app.inject({
      method: 'PATCH',
      url: '/ocpi/2.3.0/emsp/sessions/DE/CPO/ses-1',
      payload: { total_cost: { excl_vat: 0.8 } },
    });
    expect(res.statusCode).toBe(400);
    expect(writes).toHaveLength(0);
  });
});
