// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

// Each awaited query chain resolves to the next queued result.
let dbResults: unknown[][] = [];
const updateSets: unknown[] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['set'] = vi.fn((v: unknown) => {
    updateSets.push(v);
    return chain;
  });
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve);
  return chain;
}

const { mockRegistration, mockUpdate, mockUnregister, updateMock } = vi.hoisted(() => ({
  mockRegistration: vi.fn(),
  mockUpdate: vi.fn(),
  mockUnregister: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: {
    select: vi.fn(() => makeChain()),
    update: updateMock,
  },
}));

// The test sends the authenticated partner as JSON in x-test-partner; a
// missing header means the middleware rejected the request.
async function fakeAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = request.headers['x-test-partner'];
  if (typeof raw !== 'string') {
    await reply.status(401).send({ status_code: 2000, status_message: 'Invalid token' });
    return;
  }
  request.ocpiPartner = JSON.parse(raw) as NonNullable<FastifyRequest['ocpiPartner']>;
}
vi.mock('../middleware/ocpi-auth.js', () => ({
  ocpiAuthenticate: fakeAuth,
  ocpiAuthenticateRegistration: fakeAuth,
}));

vi.mock('../services/credentials.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/credentials.service.js')>()),
  handleRegistration: mockRegistration,
  handleCredentialUpdate: mockUpdate,
  handleUnregister: mockUnregister,
}));

const { credentialRoutes } = await import('../routes/credentials.js');
const { versionRoutes } = await import('../routes/versions.js');
const { hubClientInfoRoutes } = await import('../routes/hubclientinfo.js');

const BASE = 'http://localhost:7104';

const REGISTERED = {
  partnerId: 'opr_000000000001',
  partnerName: 'Partner NL',
  countryCode: 'NL',
  partyId: 'ABC',
  allowPrivateNetwork: false,
  tokenId: 5,
};
const REGISTRATION = { ...REGISTERED, partnerId: null, partnerName: null, tokenId: 9 };

const VALID_BODY = {
  token: 'partner-token-b',
  url: 'https://partner.example.com/ocpi/versions',
  roles: [
    {
      role: 'EMSP',
      party_id: 'ABC',
      country_code: 'NL',
      business_details: { name: 'Partner NL' },
    },
  ],
};

interface Envelope<T = unknown> {
  data: T;
  status_code: number;
  status_message: string;
  timestamp: string;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  credentialRoutes(app);
  versionRoutes(app);
  hubClientInfoRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  dbResults = [];
  updateSets.length = 0;
  mockRegistration.mockReset();
  mockUpdate.mockReset();
  mockUnregister.mockReset();
  updateMock.mockReset();
  updateMock.mockImplementation(() => makeChain());
});

function as(partner: unknown): Record<string, string> {
  return { 'x-test-partner': JSON.stringify(partner) };
}

describe('versions', () => {
  it('GET /ocpi/versions lists 2.2.1 and 2.3.0 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/ocpi/versions' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Envelope>();
    expect(body.status_code).toBe(1000);
    expect(body.status_message).toBe('Success');
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');
    expect(body.data).toEqual([
      { version: '2.2.1', url: `${BASE}/ocpi/2.2.1` },
      { version: '2.3.0', url: `${BASE}/ocpi/2.3.0` },
    ]);
  });

  it.each(['2.2.1', '2.3.0'])('GET /ocpi/%s returns module endpoints', async (version) => {
    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/${version}`,
      headers: as(REGISTRATION),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json<
      Envelope<{
        version: string;
        endpoints: { identifier: string; role: string; url: string }[];
      }>
    >().data;
    expect(data.version).toBe(version);
    expect(data.endpoints).toHaveLength(14);
    const prefix = `${BASE}/ocpi/${version}`;
    expect(data.endpoints).toContainEqual({
      identifier: 'locations',
      role: 'SENDER',
      url: `${prefix}/cpo/locations`,
    });
    expect(data.endpoints).toContainEqual({
      identifier: 'tokens',
      role: 'RECEIVER',
      url: `${prefix}/cpo/tokens`,
    });
    expect(data.endpoints).toContainEqual({
      identifier: 'commands',
      role: 'RECEIVER',
      url: `${prefix}/cpo/commands`,
    });
    expect(data.endpoints.filter((e) => e.identifier === 'commands')).toHaveLength(1);
  });

  it('GET /ocpi/2.2.1 requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1' });
    expect(res.statusCode).toBe(401);
  });
});

describe('credentials', () => {
  it('GET returns our credentials with an empty token and both roles', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.2.1/credentials',
      headers: as(REGISTERED),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json<Envelope>().data;
    expect(data).toEqual({
      token: '',
      url: `${BASE}/ocpi/versions`,
      roles: [
        {
          role: 'CPO',
          business_details: { name: 'EVtivity' },
          party_id: 'EVT',
          country_code: 'US',
        },
        {
          role: 'EMSP',
          business_details: { name: 'EVtivity' },
          party_id: 'EVT',
          country_code: 'US',
        },
      ],
    });
  });

  it.each([
    ['no body', undefined],
    ['missing token', { url: 'https://x', roles: [{}] }],
    ['empty roles', { token: 't', url: 'https://x', roles: [] }],
    ['roles not an array', { token: 't', url: 'https://x', roles: 'CPO' }],
  ])('POST rejects an invalid credentials object (%s) with 2001', async (_label, payload) => {
    const res = await app.inject({
      method: 'POST',
      url: '/ocpi/2.2.1/credentials',
      headers: as(REGISTRATION),
      ...(payload === undefined ? {} : { payload }),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<Envelope>();
    expect(body.status_code).toBe(2001);
    expect(body.data).toBeNull();
    expect(mockRegistration).not.toHaveBeenCalled();
  });

  it('POST rejects an already registered partner with 405', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ocpi/2.2.1/credentials',
      headers: as(REGISTERED),
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(405);
    expect(res.json<Envelope>().status_message).toBe(
      'Already registered. Use PUT to update credentials.',
    );
    expect(mockRegistration).not.toHaveBeenCalled();
  });

  it('POST registers with the posted version and returns 201', async () => {
    const ours = { token: 'token-a', url: `${BASE}/ocpi/versions`, roles: [] };
    mockRegistration.mockResolvedValue(ours);
    const res = await app.inject({
      method: 'POST',
      url: '/ocpi/2.3.0/credentials',
      headers: as(REGISTRATION),
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Envelope>();
    expect(body.status_code).toBe(1000);
    expect(body.data).toEqual(ours);
    expect(mockRegistration).toHaveBeenCalledWith(VALID_BODY, 9, '2.3.0');
  });

  it('POST maps a registration failure to 400 with the error message', async () => {
    mockRegistration.mockRejectedValue(new Error('Registration token already used'));
    const res = await app.inject({
      method: 'POST',
      url: '/ocpi/2.2.1/credentials',
      headers: as(REGISTRATION),
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Envelope>()).toMatchObject({
      status_code: 2000,
      status_message: 'Registration token already used',
      data: null,
    });
  });

  it('POST uses a generic message for a non-Error rejection', async () => {
    mockRegistration.mockRejectedValue('boom');
    const res = await app.inject({
      method: 'POST',
      url: '/ocpi/2.2.1/credentials',
      headers: as(REGISTRATION),
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Envelope>().status_message).toBe('Registration failed');
  });

  it('PUT rejects an invalid body with 2001', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/credentials',
      headers: as(REGISTERED),
      payload: { token: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Envelope>().status_code).toBe(2001);
  });

  it('PUT rejects an unregistered token with 405', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/credentials',
      headers: as(REGISTRATION),
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(405);
    expect(res.json<Envelope>().status_message).toBe('Not registered. Use POST to register.');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('PUT updates credentials for the authenticated partner', async () => {
    const ours = { token: 'token-a2', url: `${BASE}/ocpi/versions`, roles: [] };
    mockUpdate.mockResolvedValue(ours);
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.3.0/credentials',
      headers: as(REGISTERED),
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Envelope>().data).toEqual(ours);
    expect(mockUpdate).toHaveBeenCalledWith(VALID_BODY, 'opr_000000000001', '2.3.0');
  });

  it('PUT maps an update failure to 400', async () => {
    mockUpdate.mockRejectedValue(new Error('No compatible OCPI version found'));
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/credentials',
      headers: as(REGISTERED),
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Envelope>().status_message).toBe('No compatible OCPI version found');
  });

  it('PUT uses a generic message for a non-Error rejection', async () => {
    mockUpdate.mockRejectedValue(42);
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/credentials',
      headers: as(REGISTERED),
      payload: VALID_BODY,
    });
    expect(res.json<Envelope>().status_message).toBe('Credential update failed');
  });

  it('DELETE unregisters the partner', async () => {
    mockUnregister.mockResolvedValue(undefined);
    const res = await app.inject({
      method: 'DELETE',
      url: '/ocpi/2.2.1/credentials',
      headers: as(REGISTERED),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Envelope>()).toMatchObject({ status_code: 1000, data: null });
    expect(mockUnregister).toHaveBeenCalledWith('opr_000000000001');
  });

  it('DELETE rejects an unregistered token with 405', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/ocpi/2.3.0/credentials',
      headers: as(REGISTRATION),
    });
    expect(res.statusCode).toBe(405);
    expect(res.json<Envelope>().status_message).toBe('Not registered');
    expect(mockUnregister).not.toHaveBeenCalled();
  });
});

describe('hubclientinfo', () => {
  const updatedAt = new Date('2026-09-01T12:00:00Z');

  it('GET maps partners to HubClientInfo with role names and statuses', async () => {
    dbResults = [
      [
        {
          countryCode: 'NL',
          partyId: 'ABC',
          roles: [{ role: 'EMSP', party_id: 'ABC' }, { role: 'CPO' }, null, { role: 5 }],
          status: 'connected',
          updatedAt,
        },
        { countryCode: 'DE', partyId: 'DEF', roles: null, status: 'suspended', updatedAt },
        { countryCode: 'FR', partyId: 'GHI', roles: [], status: 'pending', updatedAt },
        { countryCode: 'BE', partyId: 'JKL', roles: [], status: 'disconnected', updatedAt },
        { countryCode: 'IT', partyId: 'MNO', roles: [], status: 'weird', updatedAt },
      ],
    ];
    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.2.1/hubclientinfo',
      headers: as(REGISTERED),
    });
    expect(res.statusCode).toBe(200);
    const last = updatedAt.toISOString();
    expect(res.json<Envelope>().data).toEqual([
      {
        party_id: 'ABC',
        country_code: 'NL',
        role: ['EMSP', 'CPO'],
        status: 'CONNECTED',
        last_updated: last,
      },
      {
        party_id: 'DEF',
        country_code: 'DE',
        role: ['CPO'],
        status: 'SUSPENDED',
        last_updated: last,
      },
      { party_id: 'GHI', country_code: 'FR', role: ['CPO'], status: 'PLANNED', last_updated: last },
      { party_id: 'JKL', country_code: 'BE', role: ['CPO'], status: 'OFFLINE', last_updated: last },
      { party_id: 'MNO', country_code: 'IT', role: ['CPO'], status: 'OFFLINE', last_updated: last },
    ]);
  });

  it('PUT refuses to update another partner with 403', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/hubclientinfo/DE/DEF',
      headers: as(REGISTERED),
      payload: { status: 'SUSPENDED' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Envelope>().status_message).toBe(
      'Cannot update HubClientInfo for another partner',
    );
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('PUT refuses a matching country with a different party', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/hubclientinfo/NL/XYZ',
      headers: as(REGISTERED),
      payload: { status: 'OFFLINE' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PUT rejects a body without a status with 2001', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.3.0/hubclientinfo/NL/ABC',
      headers: as(REGISTERED),
      payload: { party_id: 'ABC' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Envelope>().status_code).toBe(2001);
  });

  it.each([
    ['CONNECTED', 'connected'],
    ['OFFLINE', 'disconnected'],
    ['PLANNED', 'pending'],
    ['SUSPENDED', 'suspended'],
    ['UNKNOWN', 'disconnected'],
  ])('PUT maps hub status %s to partner status %s', async (hubStatus, partnerStatus) => {
    dbResults = [[{ id: 'opr_000000000001' }], []];
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/hubclientinfo/NL/ABC',
      headers: as(REGISTERED),
      payload: { status: hubStatus },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Envelope>()).toMatchObject({ status_code: 1000, data: null });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateSets[0]).toMatchObject({ status: partnerStatus });
  });

  it('PUT succeeds without an update when the partner row is unknown', async () => {
    dbResults = [[]];
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/hubclientinfo/NL/ABC',
      headers: as(REGISTERED),
      payload: { status: 'CONNECTED' },
    });
    expect(res.statusCode).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
