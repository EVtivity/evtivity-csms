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

const { ocpiAuthenticate, ocpiAuthenticateRegistration } =
  await import('../middleware/ocpi-auth.js');

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
  }));
  app.get('/reg', { onRequest: [ocpiAuthenticateRegistration] }, (request) => ({
    partner: request.ocpiPartner,
  }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  dbResults = [];
  selectCount = 0;
});

function auth(token: string): Record<string, string> {
  return { authorization: `Token ${Buffer.from(token).toString('base64')}` };
}

const PARTNER_ROW = {
  name: 'Partner NL',
  countryCode: 'NL',
  partyId: 'ABC',
  allowPrivateNetwork: true,
};

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

  it('rejects when no candidate shares the prefix', async () => {
    dbResults = [[]];
    const res = await app.inject({ method: 'GET', url: path, headers: auth(TOKEN) });
    expect(res.statusCode).toBe(401);
  });

  it('resolves a registered partner, checking every candidate', async () => {
    dbResults = [
      [
        { tokenId: 7, tokenHash: otherHash, partnerId: 'opr_000000000009' },
        { tokenId: 8, tokenHash: tokenHash, partnerId: 'opr_000000000001' },
      ],
      [PARTNER_ROW],
    ];
    const res = await app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: `token ${Buffer.from(TOKEN).toString('base64')}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ partner: unknown }>().partner).toEqual({
      partnerId: 'opr_000000000001',
      partnerName: 'Partner NL',
      countryCode: 'NL',
      partyId: 'ABC',
      allowPrivateNetwork: true,
      tokenId: 8,
    });
    expect(selectCount).toBe(2);
  });

  it('rejects a token whose partner row no longer exists', async () => {
    dbResults = [[{ tokenId: 8, tokenHash: tokenHash, partnerId: 'opr_000000000001' }], []];
    const res = await app.inject({ method: 'GET', url: path, headers: auth(TOKEN) });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ status_message: string }>().status_message).toBe('Invalid token');
  });
});

describe('registration tokens (no partner yet)', () => {
  it('ocpiAuthenticate rejects a registration token', async () => {
    dbResults = [[{ tokenId: 3, tokenHash: tokenHash, partnerId: null }]];
    const res = await app.inject({ method: 'GET', url: '/full', headers: auth(TOKEN) });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ status_message: string }>().status_message).toBe('Invalid token');
    expect(selectCount).toBe(1);
  });

  it('ocpiAuthenticateRegistration accepts it with a null partner', async () => {
    dbResults = [[{ tokenId: 3, tokenHash: tokenHash, partnerId: null }]];
    const res = await app.inject({ method: 'GET', url: '/reg', headers: auth(TOKEN) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ partner: unknown }>().partner).toEqual({
      partnerId: null,
      partnerName: null,
      countryCode: null,
      partyId: null,
      allowPrivateNetwork: false,
      tokenId: 3,
    });
    expect(selectCount).toBe(1);
  });
});
