// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { OcpiPartnerInfo } from '../middleware/ocpi-auth.js';

// Each awaited select chain resolves to the next queued result.
let selectResults: unknown[][] = [];
const updateSets: Array<Record<string, unknown>> = [];
const insertValues: Array<Record<string, unknown>> = [];

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'orderBy']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(selectResults.shift() ?? []).then(resolve);
  return chain;
}

function makeUpdateChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['set'] = vi.fn((values: Record<string, unknown>) => {
    updateSets.push(values);
    return chain;
  });
  chain['where'] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return chain;
}

function makeInsertChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['values'] = vi.fn((values: Record<string, unknown>) => {
    insertValues.push(values);
    return chain;
  });
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return chain;
}

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => makeUpdateChain()),
    insert: vi.fn(() => makeInsertChain()),
  },
}));

let partner: OcpiPartnerInfo | undefined;
vi.mock('../middleware/ocpi-auth.js', () => ({
  ocpiAuthenticate: async (request: { ocpiPartner?: OcpiPartnerInfo }) => {
    if (partner != null) request.ocpiPartner = partner;
  },
}));

const { cpoTokenRoutes } = await import('../routes/cpo/tokens.js');

const PARTNER: OcpiPartnerInfo = {
  partnerId: 'opr_000000000001',
  partnerName: 'Partner One',
  countryCode: 'NL',
  partyId: 'EMS',
  allowPrivateNetwork: false,
  tokenId: 1,
};

const TOKEN = {
  country_code: 'NL',
  party_id: 'EMS',
  uid: 'TOK001',
  type: 'RFID',
  contract_id: 'NL-EMS-C00001-X',
  issuer: 'eMSP One',
  valid: true,
  whitelist: 'ALLOWED',
  last_updated: '2026-09-01T00:00:00Z',
};

const BASE = '/ocpi/2.2.1/cpo/tokens';
const TOKEN_URL = `${BASE}/NL/EMS/TOK001`;

function without(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  cpoTokenRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  selectResults = [];
  updateSets.length = 0;
  insertValues.length = 0;
  partner = { ...PARTNER };
});

describe('GET /cpo/tokens/:country_code/:party_id/:token_uid', () => {
  it('returns the stored token data in the OCPI envelope', async () => {
    selectResults = [[{ id: 7, tokenData: TOKEN }]];
    const res = await app.inject({ method: 'GET', url: TOKEN_URL });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status_code: number; data: unknown; timestamp: string }>();
    expect(body.status_code).toBe(1000);
    expect(body.data).toEqual(TOKEN);
    expect(typeof body.timestamp).toBe('string');
  });

  it('serves the 2.3.0 path too', async () => {
    selectResults = [[{ id: 7, tokenData: TOKEN }]];
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.3.0/cpo/tokens/NL/EMS/TOK001' });
    expect(res.json<{ data: unknown }>().data).toEqual(TOKEN);
  });

  it('returns 404 with 2004 when the partner has no such token', async () => {
    selectResults = [[]];
    const res = await app.inject({ method: 'GET', url: TOKEN_URL });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status_code: 2004, data: null });
  });

  it('returns 401 with 2000 when no partner is registered on the token', async () => {
    partner = { ...PARTNER, partnerId: null };
    const res = await app.inject({ method: 'GET', url: TOKEN_URL });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ status_code: 2000, status_message: 'Not authenticated' });
  });
});

describe('PUT /cpo/tokens/:country_code/:party_id/:token_uid', () => {
  it('rejects a body missing a required field with 400 and 2001', async () => {
    const missing = without(TOKEN, 'contract_id');
    const res = await app.inject({ method: 'PUT', url: TOKEN_URL, payload: missing });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status_code: 2001, status_message: 'Invalid token object' });
    expect(insertValues).toHaveLength(0);
  });

  it('rejects a body whose valid field is not a boolean', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: TOKEN_URL,
      payload: { ...TOKEN, valid: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status_code: 2001 });
  });

  it('rejects a non-object body', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: TOKEN_URL,
      headers: { 'content-type': 'application/json' },
      payload: 'null',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status_code: 2001 });
  });

  it('returns 401 when the token has no registered partner', async () => {
    partner = { ...PARTNER, partnerId: null };
    const res = await app.inject({ method: 'PUT', url: TOKEN_URL, payload: TOKEN });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ status_code: 2000 });
  });

  it('refuses a PUT into another party namespace with 403', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${BASE}/DE/OTH/TOK001`,
      payload: TOKEN,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      status_code: 2000,
      status_message: 'Cannot PUT tokens for another partner',
    });
    expect(insertValues).toHaveLength(0);
    expect(updateSets).toHaveLength(0);
  });

  it('refuses a PUT when only the party id differs', async () => {
    const res = await app.inject({ method: 'PUT', url: `${BASE}/NL/OTH/TOK001`, payload: TOKEN });
    expect(res.statusCode).toBe(403);
  });

  it('inserts a new token scoped to the partner', async () => {
    selectResults = [[]];
    const res = await app.inject({ method: 'PUT', url: TOKEN_URL, payload: TOKEN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status_code: 1000, data: null });
    expect(insertValues).toEqual([
      {
        partnerId: PARTNER.partnerId,
        countryCode: 'NL',
        partyId: 'EMS',
        uid: 'TOK001',
        tokenType: 'RFID',
        isValid: true,
        whitelist: 'ALLOWED',
        tokenData: TOKEN,
      },
    ]);
    expect(updateSets).toHaveLength(0);
  });

  it('updates the existing token row instead of inserting', async () => {
    selectResults = [[{ id: 42 }]];
    const body = { ...TOKEN, valid: false, type: 'APP_USER', whitelist: 'NEVER' };
    const res = await app.inject({ method: 'PUT', url: TOKEN_URL, payload: body });
    expect(res.statusCode).toBe(200);
    expect(insertValues).toHaveLength(0);
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toMatchObject({
      tokenType: 'APP_USER',
      isValid: false,
      whitelist: 'NEVER',
      tokenData: body,
    });
    expect(updateSets[0]?.['updatedAt']).toBeInstanceOf(Date);
  });
});

describe('PATCH /cpo/tokens/:country_code/:party_id/:token_uid', () => {
  it('returns 401 without a registered partner', async () => {
    partner = { ...PARTNER, partnerId: null };
    const res = await app.inject({ method: 'PATCH', url: TOKEN_URL, payload: { valid: false } });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a PATCH into another party namespace with 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/DE/EMS/TOK001`,
      payload: { valid: false },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      status_message: 'Cannot PATCH tokens for another partner',
    });
  });

  it('returns 404 with 2004 for an unknown token', async () => {
    selectResults = [[]];
    const res = await app.inject({ method: 'PATCH', url: TOKEN_URL, payload: { valid: false } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status_code: 2004 });
    expect(updateSets).toHaveLength(0);
  });

  it('rejects a non-object body with 400', async () => {
    selectResults = [[{ id: 3, tokenData: TOKEN }]];
    const res = await app.inject({
      method: 'PATCH',
      url: TOKEN_URL,
      headers: { 'content-type': 'application/json' },
      payload: '"text"',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      status_code: 2001,
      status_message: 'PATCH body must be a JSON object',
    });
    expect(updateSets).toHaveLength(0);
  });

  it('merges the patch into the stored data and updates the typed columns', async () => {
    selectResults = [[{ id: 3, tokenData: TOKEN }]];
    const patch = { valid: false, whitelist: 'NEVER', type: 'APP_USER', last_updated: 'x' };
    const res = await app.inject({ method: 'PATCH', url: TOKEN_URL, payload: patch });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status_code: 1000, data: null });
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toMatchObject({
      tokenData: { ...TOKEN, ...patch },
      isValid: false,
      whitelist: 'NEVER',
      tokenType: 'APP_USER',
    });
  });

  it('only touches tokenData when no typed field is in the patch', async () => {
    selectResults = [[{ id: 3, tokenData: TOKEN }]];
    const res = await app.inject({
      method: 'PATCH',
      url: TOKEN_URL,
      payload: { issuer: 'New issuer', valid: 'no' },
    });
    expect(res.statusCode).toBe(200);
    const set = updateSets[0] ?? {};
    expect(set['tokenData']).toEqual({ ...TOKEN, issuer: 'New issuer', valid: 'no' });
    expect(set).not.toHaveProperty('isValid');
    expect(set).not.toHaveProperty('whitelist');
    expect(set).not.toHaveProperty('tokenType');
  });
});

describe('POST /cpo/tokens/:token_uid/authorize', () => {
  const AUTH_URL = `${BASE}/TOK001/authorize`;

  it('returns 401 without a registered partner', async () => {
    partner = { ...PARTNER, partnerId: null };
    const res = await app.inject({ method: 'POST', url: AUTH_URL, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('answers NOT_ALLOWED with a placeholder token for an unknown uid', async () => {
    selectResults = [[]];
    const res = await app.inject({ method: 'POST', url: AUTH_URL, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      status_code: number;
      data: { allowed: string; token: Record<string, unknown> };
    }>();
    expect(body.status_code).toBe(1000);
    expect(body.data.allowed).toBe('NOT_ALLOWED');
    expect(body.data.token).toMatchObject({
      uid: 'TOK001',
      contract_id: 'TOK001',
      valid: false,
      whitelist: 'NEVER',
      type: 'RFID',
    });
  });

  it('answers ALLOWED for a valid token and echoes the location reference', async () => {
    selectResults = [[{ id: 1, isValid: true, tokenData: TOKEN }]];
    const res = await app.inject({
      method: 'POST',
      url: AUTH_URL,
      payload: { location_id: 'LOC1', evse_uids: ['E1', 'E2'] },
    });
    const body = res.json<{ data: Record<string, unknown> }>();
    expect(body.data).toEqual({
      allowed: 'ALLOWED',
      token: TOKEN,
      location: { location_id: 'LOC1', evse_uids: ['E1', 'E2'] },
    });
  });

  it('answers BLOCKED for an invalid token and omits evse_uids when not an array', async () => {
    selectResults = [[{ id: 1, isValid: false, tokenData: TOKEN }]];
    const res = await app.inject({
      method: 'POST',
      url: AUTH_URL,
      payload: { location_id: 'LOC1', evse_uids: 'E1' },
    });
    const body = res.json<{ data: Record<string, unknown> }>();
    expect(body.data).toEqual({
      allowed: 'BLOCKED',
      token: TOKEN,
      location: { location_id: 'LOC1' },
    });
  });

  it('omits the location when the body has no location_id', async () => {
    selectResults = [[{ id: 1, isValid: true, tokenData: TOKEN }]];
    const res = await app.inject({ method: 'POST', url: AUTH_URL });
    const body = res.json<{ data: Record<string, unknown> }>();
    expect(body.data).toEqual({ allowed: 'ALLOWED', token: TOKEN });
  });
});
