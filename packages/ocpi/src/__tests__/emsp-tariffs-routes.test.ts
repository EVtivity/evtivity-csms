// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { OcpiPartnerInfo } from '../middleware/ocpi-auth.js';

// Each awaited select chain resolves to the next queued result. Writes are
// recorded so tests can assert what the route stored.
const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  deletes: 0,
  partner: undefined as OcpiPartnerInfo | undefined,
}));

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(h.selects.shift() ?? []).then(resolve);
  return chain;
}

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        h.updates.push(values);
        return { where: () => Promise.resolve(undefined) };
      },
    })),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        h.inserts.push(values);
        return Promise.resolve(undefined);
      },
    })),
    delete: vi.fn(() => ({
      where: () => {
        h.deletes += 1;
        return Promise.resolve(undefined);
      },
    })),
  },
}));
vi.mock('../middleware/ocpi-auth.js', () => ({
  ocpiAuthenticate: (request: { ocpiPartner?: OcpiPartnerInfo }) => {
    if (h.partner != null) request.ocpiPartner = h.partner;
    return Promise.resolve();
  },
}));

const { emspTariffRoutes } = await import('../routes/emsp/tariffs.js');

const PARTNER: OcpiPartnerInfo = {
  partnerId: 'opr_000000000001',
  partnerName: 'Partner CPO',
  countryCode: 'DE',
  partyId: 'ABC',
  allowPrivateNetwork: false,
  tokenId: 1,
};

const TARIFF = {
  id: 'T1',
  country_code: 'DE',
  party_id: 'ABC',
  currency: 'EUR',
  elements: [{ price_components: [{ type: 'ENERGY', price: 0.3, step_size: 1 }] }],
  last_updated: '2026-09-01T00:00:00Z',
};

type Body = { status_code: number; status_message: string; data: unknown };

const URL_221 = '/ocpi/2.2.1/emsp/tariffs/DE/ABC/T1';
const URL_230 = '/ocpi/2.3.0/emsp/tariffs/DE/ABC/T1';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  emspTariffRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.selects = [];
  h.updates = [];
  h.inserts = [];
  h.deletes = 0;
  h.partner = { ...PARTNER };
});

describe('GET emsp tariff', () => {
  it.each([URL_221, URL_230])('returns the stored tariff data (%s)', async (url) => {
    h.selects = [[{ id: 1, tariffData: TARIFF }]];
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>()).toMatchObject({ status_code: 1000, data: TARIFF });
  });

  it('returns 404 for an unknown tariff', async () => {
    h.selects = [[]];
    const res = await app.inject({ method: 'GET', url: URL_221 });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>()).toMatchObject({
      status_code: 2000,
      status_message: 'Tariff not found',
      data: null,
    });
  });

  it('returns 401 for every method without a registered partner', async () => {
    h.partner = { ...PARTNER, partnerId: null };
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: URL_221, payload: TARIFF });
      expect(res.statusCode).toBe(401);
      expect(res.json<Body>().status_message).toBe('Not authenticated');
    }
  });
});

describe('PUT emsp tariff', () => {
  it('inserts a new tariff', async () => {
    h.selects = [[]];
    const res = await app.inject({ method: 'PUT', url: URL_230, payload: TARIFF });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>()).toMatchObject({ status_code: 1000, data: null });
    expect(h.inserts).toEqual([
      {
        partnerId: PARTNER.partnerId,
        countryCode: 'DE',
        partyId: 'ABC',
        tariffId: 'T1',
        currency: 'EUR',
        tariffData: TARIFF,
      },
    ]);
    expect(h.updates).toHaveLength(0);
  });

  it('updates an existing tariff', async () => {
    h.selects = [[{ id: 9 }]];
    const payload = { ...TARIFF, currency: 'CHF' };
    const res = await app.inject({ method: 'PUT', url: URL_221, payload });
    expect(res.statusCode).toBe(200);
    expect(h.inserts).toHaveLength(0);
    expect(h.updates[0]).toMatchObject({ currency: 'CHF', tariffData: payload });
    expect(h.updates[0]?.['updatedAt']).toBeInstanceOf(Date);
  });

  it('rejects a namespace that does not match the credentials', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/emsp/tariffs/NL/ABC/T1',
      payload: TARIFF,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().status_message).toBe('Cannot PUT tariff for another partner');
  });

  it.each([
    ['missing id', { ...TARIFF, id: undefined }],
    ['numeric currency', { ...TARIFF, currency: 978 }],
    ['elements not an array', { ...TARIFF, elements: {} }],
    ['missing party_id', { ...TARIFF, party_id: undefined }],
  ])('rejects an invalid tariff: %s', async (_name, payload) => {
    const res = await app.inject({ method: 'PUT', url: URL_221, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>()).toMatchObject({
      status_code: 2001,
      status_message: 'Invalid tariff object',
    });
    expect(h.inserts).toHaveLength(0);
  });

  it('rejects a body that is not an object', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: URL_221,
      headers: { 'content-type': 'application/json' },
      payload: 'null',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH emsp tariff', () => {
  it('merges the patch and updates the currency column', async () => {
    h.selects = [[{ id: 9, tariffData: TARIFF }]];
    const res = await app.inject({
      method: 'PATCH',
      url: URL_221,
      payload: { currency: 'CHF', last_updated: '2026-09-02T00:00:00Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.updates[0]).toMatchObject({
      currency: 'CHF',
      tariffData: { ...TARIFF, currency: 'CHF', last_updated: '2026-09-02T00:00:00Z' },
    });
  });

  it('keeps the currency column when the patch has no string currency', async () => {
    h.selects = [[{ id: 9, tariffData: TARIFF }]];
    const res = await app.inject({ method: 'PATCH', url: URL_230, payload: { elements: [] } });
    expect(res.statusCode).toBe(200);
    expect(h.updates[0]).not.toHaveProperty('currency');
    expect(h.updates[0]?.['tariffData']).toMatchObject({ currency: 'EUR', elements: [] });
  });

  it('rejects a foreign namespace, a bad body and an unknown tariff', async () => {
    let res = await app.inject({
      method: 'PATCH',
      url: '/ocpi/2.2.1/emsp/tariffs/DE/XYZ/T1',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().status_message).toBe('Cannot PATCH tariff for another partner');

    res = await app.inject({
      method: 'PATCH',
      url: URL_221,
      headers: { 'content-type': 'application/json' },
      payload: '3',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().status_message).toBe('PATCH body must be a JSON object');

    h.selects = [[]];
    res = await app.inject({ method: 'PATCH', url: URL_221, payload: { currency: 'CHF' } });
    expect(res.statusCode).toBe(404);
    expect(h.updates).toHaveLength(0);
  });
});

describe('DELETE emsp tariff', () => {
  it('deletes an existing tariff', async () => {
    h.selects = [[{ id: 9 }]];
    const res = await app.inject({ method: 'DELETE', url: URL_230 });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>()).toMatchObject({ status_code: 1000, data: null });
    expect(h.deletes).toBe(1);
  });

  it('returns 404 for an unknown tariff and deletes nothing', async () => {
    h.selects = [[]];
    const res = await app.inject({ method: 'DELETE', url: URL_221 });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>().status_message).toBe('Tariff not found');
    expect(h.deletes).toBe(0);
  });

  it('rejects a foreign namespace', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/ocpi/2.2.1/emsp/tariffs/NL/ABC/T1' });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().status_message).toBe('Cannot DELETE tariff for another partner');
    expect(h.deletes).toBe(0);
  });
});
