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
  returning: [] as unknown[][],
  partner: undefined as OcpiPartnerInfo | undefined,
  sessionChanged: vi.fn(),
  cdrChanged: vi.fn(),
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
        return {
          returning: () => Promise.resolve(h.returning.shift() ?? []),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        };
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
vi.mock('../lib/pubsub.js', () => ({
  notifyRoamingSessionChanged: h.sessionChanged,
  notifyRoamingCdrChanged: h.cdrChanged,
}));

const { emspSessionRoutes } = await import('../routes/emsp/sessions.js');
const { emspCdrRoutes } = await import('../routes/emsp/cdrs.js');

const PARTNER: OcpiPartnerInfo = {
  partnerId: 'opr_000000000001',
  partnerName: 'Partner CPO',
  countryCode: 'DE',
  partyId: 'ABC',
  allowPrivateNetwork: false,
  tokenId: 1,
};

const SESSION_221 = {
  id: 'S1',
  country_code: 'DE',
  party_id: 'ABC',
  start_date_time: '2026-09-01T10:00:00Z',
  kwh: 12.5,
  cdr_token: { uid: 'TOKEN1', type: 'RFID', contract_id: 'C1' },
  status: 'ACTIVE',
  currency: 'EUR',
  total_cost: { excl_vat: 4.2, incl_vat: 5 },
  last_updated: '2026-09-01T10:30:00Z',
};

const CDR_221 = {
  id: 'CDR1',
  country_code: 'DE',
  party_id: 'ABC',
  start_date_time: '2026-09-01T10:00:00Z',
  end_date_time: '2026-09-01T11:00:00Z',
  currency: 'EUR',
  total_energy: 20,
  total_cost: { excl_vat: 6, incl_vat: 7.14 },
};

type Body = { status_code: number; status_message: string; data: unknown };

const SESSION_URL = '/ocpi/2.2.1/emsp/sessions/DE/ABC/S1';
const SESSION_URL_230 = '/ocpi/2.3.0/emsp/sessions/DE/ABC/S1';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  emspSessionRoutes(app);
  emspCdrRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.selects = [];
  h.updates = [];
  h.inserts = [];
  h.returning = [];
  h.partner = { ...PARTNER };
});

describe('GET emsp session', () => {
  it('returns the stored session data', async () => {
    h.selects = [[{ id: 1, sessionData: SESSION_221 }]];
    const res = await app.inject({ method: 'GET', url: SESSION_URL });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>()).toMatchObject({ status_code: 1000, data: SESSION_221 });
  });

  it('returns 404 for an unknown session', async () => {
    h.selects = [[]];
    const res = await app.inject({ method: 'GET', url: SESSION_URL });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>()).toMatchObject({
      status_code: 2000,
      status_message: 'Session not found',
    });
  });

  it('returns 401 for every method without a registered partner', async () => {
    h.partner = undefined;
    for (const method of ['GET', 'PUT', 'PATCH'] as const) {
      const res = await app.inject({ method, url: SESSION_URL, payload: SESSION_221 });
      expect(res.statusCode).toBe(401);
    }
    expect(h.sessionChanged).not.toHaveBeenCalled();
  });
});

describe('PUT emsp session', () => {
  it('inserts a new 2.2.1 session with the excl_vat cost', async () => {
    h.selects = [[]];
    const res = await app.inject({ method: 'PUT', url: SESSION_URL, payload: SESSION_221 });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>()).toMatchObject({ status_code: 1000, data: null });
    expect(h.inserts).toEqual([
      {
        partnerId: PARTNER.partnerId,
        ocpiSessionId: 'S1',
        tokenUid: 'TOKEN1',
        status: 'ACTIVE',
        kwh: '12.5',
        totalCost: '4.2',
        currency: 'EUR',
        sessionData: SESSION_221,
      },
    ]);
    expect(h.sessionChanged).toHaveBeenCalledTimes(1);
  });

  it('updates an existing 2.3.0 session with the before_taxes cost', async () => {
    h.selects = [[{ id: 3 }]];
    const payload = {
      ...SESSION_221,
      status: 'COMPLETED',
      total_cost: { before_taxes: 8.4, taxes: [{ name: 'VAT', percentage: 19, amount: 1.6 }] },
    };
    const res = await app.inject({ method: 'PUT', url: SESSION_URL_230, payload });
    expect(res.statusCode).toBe(200);
    expect(h.inserts).toHaveLength(0);
    expect(h.updates[0]).toMatchObject({
      status: 'COMPLETED',
      kwh: '12.5',
      totalCost: '8.4',
      currency: 'EUR',
      sessionData: payload,
    });
  });

  it('stores a null cost when the session has no total_cost', async () => {
    h.selects = [[]];
    const payload: Record<string, unknown> = { ...SESSION_221 };
    delete payload['total_cost'];
    const res = await app.inject({ method: 'PUT', url: SESSION_URL, payload });
    expect(res.statusCode).toBe(200);
    expect(h.inserts[0]?.['totalCost']).toBeNull();
  });

  it('rejects a 2.2.1 Price on the 2.3.0 route', async () => {
    const res = await app.inject({ method: 'PUT', url: SESSION_URL_230, payload: SESSION_221 });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>()).toMatchObject({
      status_code: 2001,
      status_message: 'Invalid session object',
    });
  });

  it.each([
    ['missing cdr_token', { ...SESSION_221, cdr_token: undefined }],
    ['cdr_token without uid', { ...SESSION_221, cdr_token: { type: 'RFID' } }],
    ['missing status', { ...SESSION_221, status: undefined }],
    ['numeric id', { ...SESSION_221, id: 1 }],
  ])('rejects an invalid session: %s', async (_name, payload) => {
    const res = await app.inject({ method: 'PUT', url: SESSION_URL, payload });
    expect(res.statusCode).toBe(400);
    expect(h.inserts).toHaveLength(0);
    expect(h.sessionChanged).not.toHaveBeenCalled();
  });

  it('rejects a namespace that does not match the credentials', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/emsp/sessions/NL/ABC/S1',
      payload: SESSION_221,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().status_message).toBe('Cannot PUT session for another partner');
  });
});

describe('PATCH emsp session', () => {
  it('merges the patch and updates status, kwh, cost and currency', async () => {
    h.selects = [[{ id: 3, sessionData: SESSION_221 }]];
    const res = await app.inject({
      method: 'PATCH',
      url: SESSION_URL,
      payload: { status: 'COMPLETED', kwh: 20, total_cost: { excl_vat: 7 }, currency: 'CHF' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.updates[0]).toMatchObject({
      status: 'COMPLETED',
      kwh: '20',
      totalCost: '7',
      currency: 'CHF',
      sessionData: { id: 'S1', status: 'COMPLETED', kwh: 20, currency: 'CHF' },
    });
    expect(h.sessionChanged).toHaveBeenCalledTimes(1);
  });

  it('only updates the merged data for a patch without known columns', async () => {
    h.selects = [[{ id: 3, sessionData: SESSION_221 }]];
    const res = await app.inject({
      method: 'PATCH',
      url: SESSION_URL_230,
      payload: { last_updated: '2026-09-01T11:00:00Z', kwh: '20' },
    });
    expect(res.statusCode).toBe(200);
    const update = h.updates[0] ?? {};
    expect(Object.keys(update).sort()).toEqual(['sessionData', 'updatedAt']);
  });

  it('rejects a total_cost that is not a Price of the route version', async () => {
    h.selects = [[{ id: 3, sessionData: SESSION_221 }]];
    const res = await app.inject({
      method: 'PATCH',
      url: SESSION_URL_230,
      payload: { total_cost: { excl_vat: 7 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>()).toMatchObject({
      status_code: 2001,
      status_message: 'Invalid total_cost',
    });
    expect(h.updates).toHaveLength(0);
    expect(h.sessionChanged).not.toHaveBeenCalled();
  });

  it('rejects a foreign namespace, a bad body and an unknown session', async () => {
    let res = await app.inject({
      method: 'PATCH',
      url: '/ocpi/2.2.1/emsp/sessions/DE/XYZ/S1',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().status_message).toBe('Cannot PATCH session for another partner');

    res = await app.inject({
      method: 'PATCH',
      url: SESSION_URL,
      headers: { 'content-type': 'application/json' },
      payload: '"x"',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().status_message).toBe('PATCH body must be a JSON object');

    h.selects = [[]];
    res = await app.inject({ method: 'PATCH', url: SESSION_URL, payload: { status: 'X' } });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>().status_message).toBe('Session not found');
  });
});

describe('GET emsp CDR', () => {
  it('returns the stored CDR data', async () => {
    h.selects = [[{ id: 1, cdrData: CDR_221 }]];
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/emsp/cdrs/CDR1' });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>()).toMatchObject({ status_code: 1000, data: CDR_221 });
  });

  it('returns 404 for an unknown CDR and 401 without a partner', async () => {
    h.selects = [[]];
    let res = await app.inject({ method: 'GET', url: '/ocpi/2.3.0/emsp/cdrs/NOPE' });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>().status_message).toBe('CDR not found');

    h.partner = { ...PARTNER, partnerId: null };
    res = await app.inject({ method: 'GET', url: '/ocpi/2.3.0/emsp/cdrs/CDR1' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST emsp CDR', () => {
  it('stores a new 2.2.1 CDR and returns its Location', async () => {
    h.selects = [[]];
    h.returning = [[{ id: 11 }]];
    const res = await app.inject({
      method: 'POST',
      url: '/ocpi/2.2.1/emsp/cdrs',
      payload: CDR_221,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>()).toMatchObject({ status_code: 1000, data: null });
    expect(res.headers['location']).toBe('http://localhost:7104/ocpi/2.2.1/emsp/cdrs/CDR1');
    expect(h.inserts).toEqual([
      {
        partnerId: PARTNER.partnerId,
        ocpiCdrId: 'CDR1',
        totalEnergy: '20',
        totalCost: '6',
        currency: 'EUR',
        cdrData: CDR_221,
        isCredit: false,
        pushStatus: 'confirmed',
      },
    ]);
    expect(h.cdrChanged).toHaveBeenCalledTimes(1);
  });

  it('stores a 2.3.0 credit CDR with the before_taxes cost', async () => {
    h.selects = [[]];
    h.returning = [[{ id: 12 }]];
    const payload = { ...CDR_221, credit: true, total_cost: { before_taxes: -6 } };
    const res = await app.inject({ method: 'POST', url: '/ocpi/2.3.0/emsp/cdrs', payload });
    expect(res.statusCode).toBe(200);
    expect(h.inserts[0]).toMatchObject({ totalCost: '-6', isCredit: true });
  });

  it('returns 409 for a duplicate CDR', async () => {
    h.selects = [[{ id: 11 }]];
    const res = await app.inject({
      method: 'POST',
      url: '/ocpi/2.2.1/emsp/cdrs',
      payload: CDR_221,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<Body>().status_message).toBe('CDR already exists');
    expect(h.inserts).toHaveLength(0);
    expect(h.cdrChanged).not.toHaveBeenCalled();
  });

  it('returns 500 when the insert returns no row', async () => {
    h.selects = [[]];
    h.returning = [[]];
    const res = await app.inject({
      method: 'POST',
      url: '/ocpi/2.2.1/emsp/cdrs',
      payload: CDR_221,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json<Body>()).toMatchObject({
      status_code: 3000,
      status_message: 'Failed to store CDR',
    });
    expect(h.cdrChanged).not.toHaveBeenCalled();
  });

  it.each([
    ['2.3.0 route with a 2.2.1 Price', '2.3.0', CDR_221],
    ['string total_energy', '2.2.1', { ...CDR_221, total_energy: '20' }],
    ['missing end_date_time', '2.2.1', { ...CDR_221, end_date_time: undefined }],
    ['missing total_cost', '2.2.1', { ...CDR_221, total_cost: undefined }],
  ])('rejects an invalid CDR: %s', async (_name, version, payload) => {
    const res = await app.inject({
      method: 'POST',
      url: `/ocpi/${version}/emsp/cdrs`,
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>()).toMatchObject({
      status_code: 2001,
      status_message: 'Invalid CDR object',
    });
  });

  it('rejects a CDR whose body namespace does not match the credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ocpi/2.2.1/emsp/cdrs',
      payload: { ...CDR_221, party_id: 'XYZ' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().status_message).toBe(
      'CDR country_code/party_id does not match credentials',
    );
  });

  it('returns 401 without a registered partner', async () => {
    h.partner = undefined;
    const res = await app.inject({
      method: 'POST',
      url: '/ocpi/2.2.1/emsp/cdrs',
      payload: CDR_221,
    });
    expect(res.statusCode).toBe(401);
  });
});
