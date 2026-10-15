// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { OcpiPartnerInfo } from '../middleware/ocpi-auth.js';

// Each awaited select chain resolves to the next queued result and records
// the limit and offset it was given.
const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  limits: [] as number[],
  offsets: [] as number[],
  partner: undefined as OcpiPartnerInfo | undefined,
}));

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'unionAll']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['limit'] = vi.fn((n: number) => {
    h.limits.push(n);
    return chain;
  });
  chain['offset'] = vi.fn((n: number) => {
    h.offsets.push(n);
    return chain;
  });
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(h.selects.shift() ?? []).then(resolve);
  return chain;
}

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: { select: vi.fn(() => makeSelectChain()) },
}));
vi.mock('../middleware/ocpi-auth.js', () => ({
  ocpiAuthenticate: (request: { ocpiPartner?: OcpiPartnerInfo }) => {
    if (h.partner != null) request.ocpiPartner = h.partner;
    return Promise.resolve();
  },
}));

const { emspTokenRoutes } = await import('../routes/emsp/tokens.js');

const PARTNER: OcpiPartnerInfo = {
  partnerId: 'opr_000000000001',
  partnerName: 'Partner CPO',
  countryCode: 'DE',
  partyId: 'ABC',
  allowPrivateNetwork: false,
  tokenId: 1,
};

const updatedAt = new Date('2026-09-01T00:00:00Z');

function tokenRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idToken: 'RFID0001',
    tokenType: 'ISO14443',
    isActive: true,
    expiresAt: null,
    revokedAt: null,
    updatedAt,
    tombstone: false,
    ...over,
  };
}

type Body = { status_code: number; status_message: string; data: unknown };

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  emspTokenRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.selects = [];
  h.limits = [];
  h.offsets = [];
  h.partner = { ...PARTNER };
});

describe('GET emsp tokens', () => {
  it('maps driver tokens to OCPI tokens of our own party', async () => {
    h.selects = [
      [
        tokenRow(),
        tokenRow({ id: 'tok_2', idToken: 'EMAID01', tokenType: 'eMAID', isActive: false }),
        tokenRow({ id: 'tok_3', idToken: 'OLD', revokedAt: updatedAt }),
        tokenRow({ id: 'tok_4', idToken: 'EXP', expiresAt: new Date('2020-01-01T00:00:00Z') }),
        // A deleted token value: OCPI cannot delete a Token, so it is invalid.
        tokenRow({
          idToken: 'GONE',
          isActive: false,
          revokedAt: updatedAt,
          tombstone: true,
        }),
      ],
      [{ count: 4 }],
      [{ count: 1 }],
    ];
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/emsp/tokens' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Body>();
    expect(body.status_code).toBe(1000);
    expect(body.data).toEqual([
      {
        country_code: 'US',
        party_id: 'EVT',
        uid: 'RFID0001',
        type: 'RFID',
        contract_id: 'RFID0001',
        issuer: 'EVT',
        valid: true,
        whitelist: 'ALLOWED',
        last_updated: '2026-09-01T00:00:00.000Z',
      },
      expect.objectContaining({ uid: 'EMAID01', type: 'APP_USER', valid: false }),
      expect.objectContaining({ uid: 'OLD', valid: false }),
      expect.objectContaining({ uid: 'EXP', valid: false }),
      expect.objectContaining({
        uid: 'GONE',
        valid: false,
        last_updated: '2026-09-01T00:00:00.000Z',
      }),
    ]);
    expect(res.headers['x-total-count']).toBe('5');
    expect(res.headers['x-limit']).toBe('50');
    expect(res.headers['link']).toBeUndefined();
    expect(h.limits).toEqual([50]);
    expect(h.offsets).toEqual([0]);
  });

  it('pages with offset and limit and links the next page with the date filters', async () => {
    h.selects = [[tokenRow()], [{ count: 4 }], [{ count: 1 }]];
    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.3.0/emsp/tokens?offset=2&limit=1&date_from=2026-01-01T00:00:00Z&date_to=2026-12-31T00:00:00Z',
    });
    expect(res.statusCode).toBe(200);
    expect(h.limits).toEqual([1]);
    expect(h.offsets).toEqual([2]);
    expect(res.headers['x-total-count']).toBe('5');
    expect(res.headers['x-limit']).toBe('1');
    const link = String(res.headers['link']);
    expect(link).toMatch(/^<http:\/\/localhost:7104\/ocpi\/2\.3\.0\/emsp\/tokens\?/);
    expect(link).toContain('offset=3');
    expect(link).toContain('limit=1');
    expect(link).toContain('date_from=2026-01-01T00%3A00%3A00Z');
    expect(link).toContain('date_to=2026-12-31T00%3A00%3A00Z');
    expect(link).toMatch(/; rel="next"$/);
  });

  it('clamps the limit and ignores invalid offsets and dates', async () => {
    h.selects = [[], [], []];
    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.2.1/emsp/tokens?offset=-5&limit=5000&date_from=nope&date_to=',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>().data).toEqual([]);
    expect(h.limits).toEqual([1000]);
    expect(h.offsets).toEqual([0]);
    expect(res.headers['x-total-count']).toBe('0');
  });

  it('returns 401 without a registered partner', async () => {
    h.partner = { ...PARTNER, partnerId: null };
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/emsp/tokens' });
    expect(res.statusCode).toBe(401);
    expect(res.json<Body>()).toMatchObject({ status_code: 2000, data: null });
  });
});
