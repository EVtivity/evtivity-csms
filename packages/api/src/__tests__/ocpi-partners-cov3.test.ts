// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCPI partner routes: list, detail, create with its registration token,
// update (status rules, stored token on a URL change), disconnect, outbound
// registration, a new registration token, manual sync and the sync log.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  index: 0,
  calls: [] as Array<{ op: string; method: string; args: unknown[] }>,
  allSites: true,
  publish: vi.fn().mockResolvedValue(undefined),
}));

function queue(...results: unknown[]): void {
  state.results = results;
  state.index = 0;
}

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  function makeChain(op: string): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const method of [
      'from',
      'where',
      'orderBy',
      'limit',
      'offset',
      'for',
      'values',
      'set',
      'returning',
    ]) {
      chain[method] = vi.fn((...args: unknown[]) => {
        state.calls.push({ op, method, args });
        return chain;
      });
    }
    chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
      const result = state.results[state.index] ?? [];
      state.index++;
      return Promise.resolve(result).then(resolve, reject);
    };
    return chain;
  }
  const db: Record<string, unknown> = {
    select: vi.fn(() => makeChain('select')),
    insert: vi.fn(() => makeChain('insert')),
    update: vi.fn(() => makeChain('update')),
  };
  db['transaction'] = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return {
    ...actual,
    db,
    writeAudit: vi.fn().mockResolvedValue(undefined),
    issueOcpiRegistrationToken: vi.fn().mockResolvedValue('reg-token-1'),
  };
});

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  encryptString: vi.fn((value: string) => `enc:${value}`),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: state.publish }),
}));

vi.mock('../lib/site-access.js', () => ({
  requireAllSiteAccess: vi.fn(
    async (
      _request: unknown,
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
      notFound: unknown,
    ) => {
      if (state.allSites) return true;
      await reply.status(404).send(notFound);
      return false;
    },
  ),
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

import { writeAudit, issueOcpiRegistrationToken } from '@evtivity/database';
import { registerAuth } from '../plugins/auth.js';
import { ocpiPartnerRoutes } from '../routes/ocpi-partners.js';

const ID = 'opr_abcdefghijkl';
const NOW = new Date('2026-11-01T00:00:00.000Z');

function partner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    name: 'Partner',
    countryCode: 'DE',
    partyId: 'ABC',
    roles: [],
    ourRoles: [],
    approvedRoles: [],
    rolesApprovedAt: null,
    status: 'pending',
    version: null,
    versionUrl: 'https://partner.example.com/versions',
    allowPrivateNetwork: false,
    allowRawToken: false,
    partnerRegistrationTokenEnc: 'secret-cipher',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function callsOf(op: string, method: string): Array<Record<string, unknown>> {
  return state.calls
    .filter((c) => c.op === op && c.method === method)
    .map((c) => c.args[0] as Record<string, unknown>);
}

describe('OCPI partner routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(ocpiPartnerRoutes, { prefix: '/v1' });
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.allSites = true;
    state.calls = [];
    queue();
  });

  const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  it('answers 404 PARTNER_NOT_FOUND to a site-restricted user on every route', async () => {
    state.allSites = false;
    const routes: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown?]> = [
      ['GET', '/v1/ocpi/partners'],
      ['GET', `/v1/ocpi/partners/${ID}`],
      ['POST', '/v1/ocpi/partners', { name: 'P', countryCode: 'DE', partyId: 'ABC' }],
      ['PATCH', `/v1/ocpi/partners/${ID}`, {}],
      ['DELETE', `/v1/ocpi/partners/${ID}`],
      ['POST', `/v1/ocpi/partners/${ID}/register`],
      ['POST', `/v1/ocpi/partners/${ID}/registration-token`],
      ['POST', `/v1/ocpi/partners/${ID}/sync/locations`],
      ['GET', '/v1/ocpi/sync-log'],
    ];
    for (const [method, url, body] of routes) {
      const res = await send(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toEqual({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
    }
    expect(state.calls).toHaveLength(0);
  });

  describe('GET /ocpi/partners', () => {
    it('lists partners without the token ciphertext', async () => {
      queue(
        [partner(), partner({ id: 'opr_bbbbbbbbbbbb', partnerRegistrationTokenEnc: null })],
        [{ count: 2 }],
      );
      const res = await send('GET', '/v1/ocpi/partners?search=Part');
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<Record<string, unknown>>; total: number }>();
      expect(body.total).toBe(2);
      expect(body.data[0]).not.toHaveProperty('partnerRegistrationTokenEnc');
      expect(body.data[0]?.['hasPartnerRegistrationToken']).toBe(true);
      expect(body.data[1]?.['hasPartnerRegistrationToken']).toBe(false);
    });

    it('defaults the total to 0', async () => {
      queue([], []);
      const res = await send('GET', '/v1/ocpi/partners');
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  describe('GET /ocpi/partners/:id', () => {
    it('returns the partner with its endpoints', async () => {
      queue([partner()], [{ id: 1, partnerId: ID, module: 'locations' }]);
      const res = await send('GET', `/v1/ocpi/partners/${ID}`);
      expect(res.statusCode).toBe(200);
      const body = res.json<Record<string, unknown>>();
      expect(body['endpoints']).toEqual([{ id: 1, partnerId: ID, module: 'locations' }]);
      expect(body['hasPartnerRegistrationToken']).toBe(true);
    });

    it('answers 404 for an unknown partner', async () => {
      queue([]);
      const res = await send('GET', `/v1/ocpi/partners/${ID}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'PARTNER_NOT_FOUND' });
    });
  });

  describe('POST /ocpi/partners', () => {
    const body = {
      name: 'P',
      countryCode: 'DE',
      partyId: 'ABC',
      versionUrl: 'https://partner.example.com/versions',
    };

    it('creates the partner, its registration token and an audit row', async () => {
      queue([], [partner({ approvedRoles: ['EMSP'] })]);
      const res = await send('POST', '/v1/ocpi/partners', {
        ...body,
        approvedRoles: ['EMSP', 'EMSP'],
        allowRawToken: true,
        partnerRegistrationToken: 'token-c',
      });
      expect(res.statusCode).toBe(201);
      const reply = res.json<{ partner: Record<string, unknown>; registrationToken: string }>();
      expect(reply.registrationToken).toBe('reg-token-1');
      expect(reply.partner).not.toHaveProperty('partnerRegistrationTokenEnc');
      const values = callsOf('insert', 'values')[0];
      expect(values).toMatchObject({
        name: 'P',
        status: 'pending',
        allowPrivateNetwork: false,
        allowRawToken: true,
        approvedRoles: ['EMSP'],
        partnerRegistrationTokenEnc: 'enc:token-c',
      });
      expect(values?.['rolesApprovedAt']).toBeInstanceOf(Date);
      expect(issueOcpiRegistrationToken).toHaveBeenCalledWith(ID, expect.anything());
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({ action: 'created' });
    });

    it('stores no roles and no token by default', async () => {
      queue([], [partner()]);
      const res = await send('POST', '/v1/ocpi/partners', body);
      expect(res.statusCode).toBe(201);
      expect(callsOf('insert', 'values')[0]).toMatchObject({
        approvedRoles: [],
        rolesApprovedAt: null,
        partnerRegistrationTokenEnc: null,
        allowRawToken: false,
      });
    });

    it('answers 409 for a duplicate country code and party id', async () => {
      queue([{ id: 'opr_other' }]);
      const res = await send('POST', '/v1/ocpi/partners', body);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'DUPLICATE_PARTNER' });
    });

    it('refuses a private version URL unless private networks are allowed', async () => {
      queue([]);
      const refused = await send('POST', '/v1/ocpi/partners', {
        ...body,
        versionUrl: 'http://127.0.0.1/versions',
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'PRIVATE_URL' });
      queue([], [partner({ allowPrivateNetwork: true })]);
      const allowed = await send('POST', '/v1/ocpi/partners', {
        ...body,
        versionUrl: 'http://127.0.0.1/versions',
        allowPrivateNetwork: true,
      });
      expect(allowed.statusCode).toBe(201);
    });

    it('answers 500 when the insert returns no row', async () => {
      queue([], []);
      const res = await send('POST', '/v1/ocpi/partners', body);
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(writeAudit).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /ocpi/partners/:id', () => {
    it('answers 404 for an unknown partner', async () => {
      queue([]);
      const res = await send('PATCH', `/v1/ocpi/partners/${ID}`, { name: 'X' });
      expect(res.statusCode).toBe(404);
    });

    it('refuses a private version URL with the stored private network setting off', async () => {
      queue([partner()]);
      const res = await send('PATCH', `/v1/ocpi/partners/${ID}`, {
        versionUrl: 'http://10.0.0.1/versions',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'PRIVATE_URL' });
    });

    it('accepts a private URL when the partner allows private networks', async () => {
      queue([partner({ allowPrivateNetwork: true })], [partner()]);
      const res = await send('PATCH', `/v1/ocpi/partners/${ID}`, {
        versionUrl: 'http://10.0.0.1/versions',
      });
      expect(res.statusCode).toBe(200);
      // A new URL without a new token clears the stored token.
      expect(callsOf('update', 'set')[0]?.['partnerRegistrationTokenEnc']).toBeNull();
    });

    it('updates every sent field and encrypts a new registration token', async () => {
      queue([partner()], [partner({ name: 'New' })]);
      const res = await send('PATCH', `/v1/ocpi/partners/${ID}`, {
        name: 'New',
        approvedRoles: ['CPO', 'CPO', 'HUB'],
        versionUrl: 'https://other.example.com/versions',
        allowPrivateNetwork: false,
        allowRawToken: true,
        partnerRegistrationToken: 'new-token',
        status: 'pending',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'New', hasPartnerRegistrationToken: true });
      const set = callsOf('update', 'set')[0];
      expect(set).toMatchObject({
        name: 'New',
        approvedRoles: ['CPO', 'HUB'],
        status: 'pending',
        versionUrl: 'https://other.example.com/versions',
        allowPrivateNetwork: false,
        allowRawToken: true,
        partnerRegistrationTokenEnc: 'enc:new-token',
      });
      expect(set?.['rolesApprovedAt']).toBeInstanceOf(Date);
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({ action: 'updated' });
    });

    it('keeps the stored token when the version URL does not change', async () => {
      queue([partner()], [partner()]);
      await send('PATCH', `/v1/ocpi/partners/${ID}`, {
        versionUrl: 'https://partner.example.com/versions',
      });
      expect(callsOf('update', 'set')[0]).not.toHaveProperty('partnerRegistrationTokenEnc');
    });

    it('refuses connected for a pending partner', async () => {
      queue([partner({ status: 'pending' })]);
      const res = await send('PATCH', `/v1/ocpi/partners/${ID}`, { status: 'connected' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'PARTNER_NOT_REGISTERED' });
    });

    it('refuses connected for a suspended partner that never registered', async () => {
      queue([partner({ status: 'suspended' })], []);
      const res = await send('PATCH', `/v1/ocpi/partners/${ID}`, { status: 'connected' });
      expect(res.statusCode).toBe(409);
    });

    it('resumes a suspended partner holding an issued credentials token', async () => {
      queue(
        [partner({ status: 'suspended' })],
        [{ id: 'tok_1' }],
        [partner({ status: 'connected' })],
      );
      const res = await send('PATCH', `/v1/ocpi/partners/${ID}`, { status: 'connected' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'connected' });
    });

    it('accepts connected for a partner already connected', async () => {
      queue([partner({ status: 'connected' })], [partner({ status: 'connected' })]);
      const res = await send('PATCH', `/v1/ocpi/partners/${ID}`, { status: 'connected' });
      expect(res.statusCode).toBe(200);
    });

    it('retires the open registration tokens on suspend and disconnect', async () => {
      for (const status of ['suspended', 'disconnected']) {
        state.calls = [];
        queue([partner({ status: 'connected' })], [partner({ status })], []);
        const res = await send('PATCH', `/v1/ocpi/partners/${ID}`, { status });
        expect(res.statusCode).toBe(200);
        const sets = callsOf('update', 'set');
        expect(sets[1]).toEqual({ isActive: false });
      }
    });

    it('writes no audit row and answers null when the update returns nothing', async () => {
      queue([partner()], []);
      const res = await send('PATCH', `/v1/ocpi/partners/${ID}`, { status: 'suspended' });
      expect(res.statusCode).toBe(200);
      expect(callsOf('update', 'set')).toHaveLength(1);
      expect(writeAudit).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /ocpi/partners/:id', () => {
    it('disconnects the partner, deactivates its tokens and audits it', async () => {
      queue([{ id: ID }], [], []);
      const res = await send('DELETE', `/v1/ocpi/partners/${ID}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      const sets = callsOf('update', 'set');
      expect(sets[0]).toMatchObject({ status: 'disconnected' });
      expect(sets[1]).toEqual({ isActive: false });
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({ action: 'disconnected' });
    });

    it('answers 404 for an unknown partner', async () => {
      queue([]);
      const res = await send('DELETE', `/v1/ocpi/partners/${ID}`);
      expect(res.statusCode).toBe(404);
      expect(callsOf('update', 'set')).toHaveLength(0);
    });
  });

  describe('POST /ocpi/partners/:id/register', () => {
    it('publishes the registration request and audits it', async () => {
      queue([partner()]);
      const res = await send('POST', `/v1/ocpi/partners/${ID}/register`);
      expect(res.statusCode).toBe(200);
      expect(state.publish).toHaveBeenCalledWith(
        'ocpi_register',
        JSON.stringify({ partnerId: ID, versionUrl: 'https://partner.example.com/versions' }),
      );
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        notes: 'Outbound registration requested',
      });
    });

    it('answers 404, 409 for a connected partner and 400 without a version URL', async () => {
      queue([]);
      expect((await send('POST', `/v1/ocpi/partners/${ID}/register`)).statusCode).toBe(404);
      queue([partner({ status: 'connected' })]);
      const connected = await send('POST', `/v1/ocpi/partners/${ID}/register`);
      expect(connected.statusCode).toBe(409);
      expect(connected.json()).toMatchObject({ code: 'PARTNER_ALREADY_CONNECTED' });
      for (const versionUrl of [null, '']) {
        queue([partner({ versionUrl })]);
        const missing = await send('POST', `/v1/ocpi/partners/${ID}/register`);
        expect(missing.statusCode).toBe(400);
        expect(missing.json()).toMatchObject({ code: 'MISSING_VERSION_URL' });
      }
      expect(state.publish).not.toHaveBeenCalled();
    });
  });

  describe('POST /ocpi/partners/:id/registration-token', () => {
    it('issues a new token for a partner that is not connected', async () => {
      queue([{ id: ID, status: 'pending' }]);
      const res = await send('POST', `/v1/ocpi/partners/${ID}/registration-token`);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ registrationToken: 'reg-token-1' });
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        notes: 'Registration token issued',
      });
    });

    it('answers 404 for an unknown partner and 409 for a connected one', async () => {
      queue([]);
      expect((await send('POST', `/v1/ocpi/partners/${ID}/registration-token`)).statusCode).toBe(
        404,
      );
      queue([{ id: ID, status: 'connected' }]);
      const connected = await send('POST', `/v1/ocpi/partners/${ID}/registration-token`);
      expect(connected.statusCode).toBe(409);
      expect(issueOcpiRegistrationToken).not.toHaveBeenCalled();
    });
  });

  describe('POST /ocpi/partners/:id/sync/:module', () => {
    it('publishes the sync of a connected partner', async () => {
      queue([{ id: ID, status: 'connected' }]);
      const res = await send('POST', `/v1/ocpi/partners/${ID}/sync/tariffs`);
      expect(res.statusCode).toBe(200);
      expect(state.publish).toHaveBeenCalledWith(
        'ocpi_sync',
        JSON.stringify({ partnerId: ID, module: 'tariffs' }),
      );
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        action: 'sync_triggered',
        notes: 'Module: tariffs',
      });
    });

    it('answers 404, 400 for a partner not connected, 400 for another module', async () => {
      queue([]);
      expect((await send('POST', `/v1/ocpi/partners/${ID}/sync/cdrs`)).statusCode).toBe(404);
      queue([{ id: ID, status: 'pending' }]);
      const pending = await send('POST', `/v1/ocpi/partners/${ID}/sync/cdrs`);
      expect(pending.statusCode).toBe(400);
      expect(pending.json()).toMatchObject({ code: 'PARTNER_NOT_CONNECTED' });
      const bad = await send('POST', `/v1/ocpi/partners/${ID}/sync/sessions`);
      expect(bad.statusCode).toBe(400);
      expect(state.publish).not.toHaveBeenCalled();
    });
  });

  describe('GET /ocpi/sync-log', () => {
    const row = {
      id: 1,
      partnerId: ID,
      module: 'locations',
      direction: 'pull',
      action: 'pull',
      status: 'completed',
      objectsCount: '3',
      errorMessage: null,
      createdAt: NOW,
    };

    it('lists the sync log of a partner', async () => {
      queue([row], [{ count: 1 }]);
      const res = await send('GET', `/v1/ocpi/sync-log?partnerId=${ID}`);
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<Record<string, unknown>>; total: number }>();
      expect(body.total).toBe(1);
      expect(body.data[0]).toMatchObject({ id: 1, module: 'locations', objectsCount: '3' });
      // The partner filter adds a where clause with a condition.
      const wheres = state.calls.filter((c) => c.method === 'where');
      expect(wheres[0]?.args[0]).toBeDefined();
    });

    it('lists every entry without a filter and defaults the total', async () => {
      queue([], []);
      const res = await send('GET', '/v1/ocpi/sync-log');
      expect(res.json()).toEqual({ data: [], total: 0 });
      const wheres = state.calls.filter((c) => c.method === 'where');
      expect(wheres[0]?.args[0]).toBeUndefined();
    });
  });
});
