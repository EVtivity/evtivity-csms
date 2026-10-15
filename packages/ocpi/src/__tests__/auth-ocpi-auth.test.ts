// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as argon2 from 'argon2';

// Each awaited query chain resolves to the next queued result.
let dbResults: unknown[][] = [];
let selectCount = 0;
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve);
  return chain;
}

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: {
    select: vi.fn(() => {
      selectCount++;
      return makeChain();
    }),
  },
}));

const {
  ocpiAuthenticate,
  ocpiAuthenticateRegistration,
  resetOcpiAuthFailures,
  OCPI_AUTH_FAILURE_LIMIT,
} = await import('../middleware/ocpi-auth.js');

const TOKEN = 'abcdef0123456789-partner-token';
const OTHER = 'abcdef01-different-token-same-prefix';
let tokenHash = '';
let otherHash = '';

let app: FastifyInstance;

beforeAll(async () => {
  tokenHash = await argon2.hash(TOKEN);
  otherHash = await argon2.hash(OTHER);
  app = Fastify();
  app.get('/full', { onRequest: [ocpiAuthenticate] }, (request) => ({
    partner: request.ocpiPartner,
    token: request.ocpiToken,
  }));
  app.get('/reg', { onRequest: [ocpiAuthenticateRegistration] }, (request) => ({
    partner: request.ocpiPartner,
    token: request.ocpiToken,
  }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  dbResults = [];
  selectCount = 0;
  resetOcpiAuthFailures();
});

function auth(token: string): Record<string, string> {
  return { authorization: `Token ${Buffer.from(token).toString('base64')}` };
}

const PARTNER_ROW = {
  name: 'Partner NL',
  countryCode: 'NL',
  partyId: 'ABC',
  status: 'connected',
  roles: [{ role: 'EMSP', country_code: 'NL', party_id: 'ABC' }],
  allowPrivateNetwork: true,
  allowRawToken: false,
};

function tokenRow(
  kind: 'registration' | 'credentials',
  partnerId: string | null = 'opr_000000000001',
): Record<string, unknown> {
  return { tokenId: 8, tokenHash, partnerId, kind };
}

describe.each([
  ['ocpiAuthenticate', '/full'],
  ['ocpiAuthenticateRegistration', '/reg'],
])('%s header handling', (_name, path) => {
  it('rejects a missing Authorization header with 401 and status 2000', async () => {
    const res = await app.inject({ method: 'GET', url: path });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ status_code: number; status_message: string; data: unknown }>();
    expect(body.status_code).toBe(2000);
    expect(body.status_message).toBe('Missing or invalid Authorization header');
    expect(body.data).toBeNull();
    expect(selectCount).toBe(0);
  });

  it('rejects a non-Token scheme', async () => {
    const res = await app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: 'Bearer abc' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ status_message: string }>().status_message).toBe(
      'Missing or invalid Authorization header',
    );
  });

  it('rejects a token with no matching hash', async () => {
    dbResults = [[{ tokenId: 1, tokenHash: otherHash, partnerId: 'opr_000000000001' }]];
    const res = await app.inject({ method: 'GET', url: path, headers: auth(TOKEN) });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ status_code: number; status_message: string }>()).toMatchObject({
      status_code: 2000,
      status_message: 'Invalid token',
    });
  });

  it('resolves a connected partner with a credentials token, checking every candidate', async () => {
    dbResults = [
      [
        { tokenId: 7, tokenHash: otherHash, partnerId: 'opr_000000000009', kind: 'credentials' },
        tokenRow('credentials'),
      ],
      [PARTNER_ROW],
    ];
    const res = await app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: `token ${Buffer.from(TOKEN).toString('base64')}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ partner: unknown; token: unknown }>();
    expect(body.partner).toEqual({
      partnerId: 'opr_000000000001',
      partnerName: 'Partner NL',
      countryCode: 'NL',
      partyId: 'ABC',
      allowPrivateNetwork: true,
      tokenId: 8,
    });
    expect(body.token).toEqual({
      kind: 'credentials',
      partnerStatus: 'connected',
      roleNames: ['EMSP'],
    });
    expect(selectCount).toBe(2);
  });

  it('rejects a token whose partner row no longer exists', async () => {
    dbResults = [[tokenRow('credentials')], []];
    const res = await app.inject({ method: 'GET', url: path, headers: auth(TOKEN) });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ status_message: string }>().status_message).toBe('Invalid token');
  });

  it('rejects a token bound to no partner', async () => {
    dbResults = [[tokenRow('registration', null)]];
    const res = await app.inject({ method: 'GET', url: path, headers: auth(TOKEN) });
    expect(res.statusCode).toBe(401);
    expect(selectCount).toBe(1);
  });
});

describe('registration tokens (OCPI 2.3.0 4.1)', () => {
  it('ocpiAuthenticate rejects a registration token on a module', async () => {
    dbResults = [[tokenRow('registration')], [{ ...PARTNER_ROW, status: 'pending' }]];
    const res = await app.inject({ method: 'GET', url: '/full', headers: auth(TOKEN) });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ status_message: string }>().status_message).toBe('Invalid token');
  });

  it('ocpiAuthenticate rejects a registration token even for a connected partner', async () => {
    dbResults = [[tokenRow('registration')], [PARTNER_ROW]];
    const res = await app.inject({ method: 'GET', url: '/full', headers: auth(TOKEN) });
    expect(res.statusCode).toBe(401);
  });

  it('ocpiAuthenticateRegistration accepts it with its bound partner', async () => {
    dbResults = [[tokenRow('registration')], [{ ...PARTNER_ROW, status: 'pending' }]];
    const res = await app.inject({ method: 'GET', url: '/reg', headers: auth(TOKEN) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ partner: { partnerId: string }; token: { kind: string } }>();
    expect(body.partner.partnerId).toBe('opr_000000000001');
    expect(body.token.kind).toBe('registration');
  });
});

describe('partner status', () => {
  it.each(['pending', 'suspended', 'disconnected'])(
    'ocpiAuthenticate rejects a %s partner',
    async (status) => {
      dbResults = [[tokenRow('credentials')], [{ ...PARTNER_ROW, status }]];
      const res = await app.inject({ method: 'GET', url: '/full', headers: auth(TOKEN) });
      expect(res.statusCode).toBe(401);
    },
  );

  it('ocpiAuthenticateRegistration accepts a suspended partner (credentials module)', async () => {
    dbResults = [[tokenRow('credentials')], [{ ...PARTNER_ROW, status: 'suspended' }]];
    const res = await app.inject({ method: 'GET', url: '/reg', headers: auth(TOKEN) });
    expect(res.statusCode).toBe(200);
  });
});

describe('tokens without Base64 encoding (OCPI 2.1.1 and 2.2 peers)', () => {
  const RAW = 'rawtok0123456789abcdef';
  let rawHash = '';
  beforeAll(async () => {
    rawHash = await argon2.hash(RAW);
  });

  it('accepts a raw token from a partner with the flag on', async () => {
    dbResults = [
      [], // the Base64-decoded value matches nothing
      [{ tokenId: 5, tokenHash: rawHash, partnerId: 'opr_000000000001', kind: 'credentials' }],
      [{ ...PARTNER_ROW, allowRawToken: true }],
    ];
    const res = await app.inject({
      method: 'GET',
      url: '/full',
      headers: { authorization: `Token ${RAW}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a raw token from a partner with the flag off', async () => {
    dbResults = [
      [],
      [{ tokenId: 5, tokenHash: rawHash, partnerId: 'opr_000000000001', kind: 'credentials' }],
      [PARTNER_ROW],
    ];
    const res = await app.inject({
      method: 'GET',
      url: '/full',
      headers: { authorization: `Token ${RAW}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('failed authentication limit', () => {
  it('answers 429 once an IP reached the failure limit, before any lookup', async () => {
    for (let i = 0; i < OCPI_AUTH_FAILURE_LIMIT; i++) {
      const res = await app.inject({ method: 'GET', url: '/full' });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await app.inject({ method: 'GET', url: '/full', headers: auth(TOKEN) });
    expect(blocked.statusCode).toBe(429);
    expect(selectCount).toBe(0);
  });
});
