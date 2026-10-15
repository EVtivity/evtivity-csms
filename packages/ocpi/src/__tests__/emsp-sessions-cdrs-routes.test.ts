// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { OcpiPartnerInfo } from '../middleware/ocpi-auth.js';

// Each awaited select chain resolves to the next queued result. Writes are
// recorded so tests can assert what the route stored.
const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  returning: [] as unknown[][],
  wheres: [] as unknown[],
  partner: undefined as OcpiPartnerInfo | undefined,
  sessionChanged: vi.fn(),
  cdrChanged: vi.fn(),
}));

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'limit', 'for']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['where'] = vi.fn((condition: unknown) => {
    h.wheres.push(condition);
    return chain;
  });
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(h.selects.shift() ?? []).then(resolve);
  return chain;
}

vi.mock('@evtivity/database', async (importOriginal) => {
  const db: Record<string, unknown> = {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        h.updates.push(values);
        return {
          where: (condition: unknown) => {
            h.wheres.push(condition);
            return Promise.resolve(undefined);
          },
        };
      },
    })),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        h.inserts.push(values);
        const chain: Record<string, unknown> = {
          returning: () => Promise.resolve(h.returning.shift() ?? []),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        };
        chain['onConflictDoNothing'] = () => chain;
        return chain;
      },
    })),
  };
  // The transaction callback runs against the same recording mock.
  db['transaction'] = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return { ...(await importOriginal<typeof import('@evtivity/database')>()), db };
});

const dialect = new PgDialect();
function whereSql(condition: unknown): string {
  return dialect.sqlToQuery(condition as SQL).sql;
}
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
  h.wheres = [];
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
    h.returning = [[{ id: 1 }]];
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
    h.selects = [[{ id: 3, sessionData: SESSION_221 }]];
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
    h.returning = [[{ id: 1 }]];
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

  it('reads and writes received sessions only, never a CPO link row (item 5)', async () => {
    h.selects = [[{ id: 3, sessionData: SESSION_221 }]];
    const res = await app.inject({
      method: 'PUT',
      url: SESSION_URL,
      payload: { ...SESSION_221, last_updated: '2026-09-01T10:40:00Z' },
    });
    expect(res.statusCode).toBe(200);
    // The lookup that picks the row to update requires no charging session:
    // a CPO link row with the same OCPI id is never overwritten.
    expect(whereSql(h.wheres[0])).toContain('"charging_session_id" is null');

    h.wheres = [];
    h.selects = [[]];
    await app.inject({ method: 'GET', url: SESSION_URL });
    expect(whereSql(h.wheres[0])).toContain('"charging_session_id" is null');

    h.wheres = [];
    h.selects = [[{ id: 3, sessionData: SESSION_221 }]];
    await app.inject({ method: 'PATCH', url: SESSION_URL, payload: { kwh: 13 } });
    expect(whereSql(h.wheres[0])).toContain('"charging_session_id" is null');
  });

  it('ignores a PUT older than the stored session (last_updated)', async () => {
    h.selects = [[{ id: 3, sessionData: SESSION_221 }]];
    const res = await app.inject({
      method: 'PUT',
      url: SESSION_URL,
      payload: { ...SESSION_221, kwh: 1, last_updated: '2026-09-01T10:00:00Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>().status_code).toBe(1000);
    expect(h.updates).toHaveLength(0);
    expect(h.sessionChanged).not.toHaveBeenCalled();
  });

  it('never moves a completed session back to ACTIVE', async () => {
    h.selects = [[{ id: 3, sessionData: { ...SESSION_221, status: 'COMPLETED' } }]];
    const res = await app.inject({
      method: 'PUT',
      url: SESSION_URL,
      payload: { ...SESSION_221, status: 'ACTIVE', last_updated: '2026-09-01T12:00:00Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.updates).toHaveLength(0);
  });

  it('retries as an update when a concurrent PUT inserted the session first', async () => {
    h.selects = [[], [{ id: 9, sessionData: SESSION_221 }]];
    h.returning = [[]];
    const res = await app.inject({
      method: 'PUT',
      url: SESSION_URL,
      payload: { ...SESSION_221, kwh: 14, last_updated: '2026-09-01T10:45:00Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.inserts).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ kwh: '14' });
  });

  it('refuses a body whose id or party differs from the URL', async () => {
    for (const [field, value] of [
      ['id', 'S2'],
      ['country_code', 'NL'],
      ['party_id', 'XYZ'],
    ] as const) {
      const res = await app.inject({
        method: 'PUT',
        url: SESSION_URL,
        payload: { ...SESSION_221, [field]: value },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<Body>()).toMatchObject({
        status_code: 2001,
        status_message: `Session ${field} does not match the URL`,
      });
    }
    expect(h.inserts).toHaveLength(0);
  });

  it('answers 2001 for an over-long session id or token uid instead of a 500', async () => {
    const id = 'S'.repeat(37);
    let res = await app.inject({
      method: 'PUT',
      url: `/ocpi/2.2.1/emsp/sessions/DE/ABC/${id}`,
      payload: { ...SESSION_221, id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>()).toMatchObject({
      status_code: 2001,
      status_message: 'Invalid session_id',
    });

    res = await app.inject({
      method: 'PUT',
      url: SESSION_URL,
      payload: { ...SESSION_221, cdr_token: { uid: 'T'.repeat(37), type: 'RFID' } },
    });
    expect(res.statusCode).toBe(400);
    expect(h.inserts).toHaveLength(0);
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

  it('ignores a patch older than the stored session and keeps INVALID sticky', async () => {
    h.selects = [[{ id: 3, sessionData: SESSION_221 }]];
    let res = await app.inject({
      method: 'PATCH',
      url: SESSION_URL,
      payload: { kwh: 1, last_updated: '2026-09-01T09:00:00Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.updates).toHaveLength(0);

    h.selects = [[{ id: 3, sessionData: { ...SESSION_221, status: 'INVALID' } }]];
    res = await app.inject({
      method: 'PATCH',
      url: SESSION_URL,
      payload: { status: 'COMPLETED', last_updated: '2026-09-01T12:00:00Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.updates).toHaveLength(0);
    expect(h.sessionChanged).not.toHaveBeenCalled();
  });

  it('refuses a patch that changes the session id or party', async () => {
    for (const patch of [{ id: 'S2' }, { country_code: 'NL' }, { party_id: 'XYZ' }]) {
      const res = await app.inject({ method: 'PATCH', url: SESSION_URL, payload: patch });
      expect(res.statusCode).toBe(400);
      expect(res.json<Body>().status_code).toBe(2001);
    }
    expect(h.updates).toHaveLength(0);
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

  it('returns 409 for a duplicate CDR (the insert skips the stored id)', async () => {
    h.returning = [[]];
    const res = await app.inject({
      method: 'POST',
      url: '/ocpi/2.2.1/emsp/cdrs',
      payload: CDR_221,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<Body>().status_message).toBe('CDR already exists');
    expect(res.headers['location']).toBeUndefined();
    expect(h.cdrChanged).not.toHaveBeenCalled();
  });

  it('serves received CDRs only on GET, not our own CDRs sent to the partner', async () => {
    h.selects = [[]];
    await app.inject({ method: 'GET', url: '/ocpi/2.2.1/emsp/cdrs/CDR1' });
    expect(whereSql(h.wheres[0])).toContain('"charging_session_id" is null');
  });

  it.each([
    ['2.3.0 route with a 2.2.1 Price', '2.3.0', CDR_221],
    ['string total_energy', '2.2.1', { ...CDR_221, total_energy: '20' }],
    ['missing end_date_time', '2.2.1', { ...CDR_221, end_date_time: undefined }],
    ['missing total_cost', '2.2.1', { ...CDR_221, total_cost: undefined }],
    ['over-long id', '2.2.1', { ...CDR_221, id: 'C'.repeat(37) }],
    ['four-letter currency', '2.2.1', { ...CDR_221, currency: 'EURO' }],
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
