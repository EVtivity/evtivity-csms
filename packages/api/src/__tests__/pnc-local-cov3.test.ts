// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Local contract CA routes (read, create once, add the CPO Sub-CAs with a
// compare-and-set) and the driver Plug and Charge contract routes.

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
    for (const method of ['from', 'where', 'values', 'set', 'returning', 'onConflictDoNothing']) {
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
  return {
    ...actual,
    db: {
      select: vi.fn(() => makeChain('select')),
      insert: vi.fn(() => makeChain('insert')),
      update: vi.fn(() => makeChain('update')),
    },
    writeAudit: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  encryptString: vi.fn((value: string) => `enc:${value}`),
  decryptString: vi.fn((value: string) => value.replace(/^enc:/, '')),
}));

const ca = vi.hoisted(() => ({
  createLocalContractCa: vi.fn(),
  addCpoSubCas: vi.fn(),
  hasCpoSubCas: vi.fn((c: { cpo?: boolean }) => c.cpo === true),
  describeLocalContractCa: vi.fn(() => []),
  parseLocalContractCa: vi.fn((text: string) => {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed != null && 'createdAt' in parsed ? parsed : null;
  }),
}));
vi.mock('@evtivity/ocpp', () => ca);

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: state.publish }),
}));

vi.mock('../services/pnc-contract.service.js', () => ({
  listDriverContracts: vi.fn(),
  createContract: vi.fn(),
  revokeContract: vi.fn(),
}));

vi.mock('../services/token.service.js', () => ({
  tokenActorOf: vi.fn(() => ({ actor: 'user', userId: 'usr_1' })),
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

import { writeAudit } from '@evtivity/database';
import * as contractService from '../services/pnc-contract.service.js';
import { config } from '../lib/config.js';
import { registerAuth } from '../plugins/auth.js';
import { pncLocalRoutes } from '../routes/pnc-local.js';

const DRIVER = 'drv_abcdefghijkl';
const CREATED = '2026-11-01T00:00:00.000Z';
const mutableConfig = config as { SETTINGS_ENCRYPTION_KEY: string };

function storedCa(cpo: boolean): string {
  return `enc:${JSON.stringify({ createdAt: CREATED, cpo })}`;
}

const contract = {
  id: 1,
  driverId: DRIVER,
  driverTokenId: 'dtk_1',
  emaid: 'DEABCC12345678',
  pcid: 'PCID-1',
  status: 'active',
  createdAt: CREATED,
  revokedAt: null,
};

describe('PnC local CA routes', () => {
  let app: FastifyInstance;
  let token: string;
  const originalKey = mutableConfig.SETTINGS_ENCRYPTION_KEY;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(pncLocalRoutes, { prefix: '/v1' });
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' });
  });

  afterAll(async () => {
    mutableConfig.SETTINGS_ENCRYPTION_KEY = originalKey;
    await app.close();
  });

  beforeEach(() => {
    state.allSites = true;
    state.calls = [];
    mutableConfig.SETTINGS_ENCRYPTION_KEY = 'test-key';
    queue();
    ca.createLocalContractCa.mockResolvedValue({ createdAt: CREATED, cpo: true });
    ca.addCpoSubCas.mockResolvedValue({ createdAt: CREATED, cpo: true });
  });

  const send = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  describe('GET /pnc/settings/local-ca', () => {
    it('answers not configured without a stored CA, an empty one or an unparsable one', async () => {
      for (const rows of [[], [{ value: '' }], [{ value: 'enc:{}' }]]) {
        queue(rows);
        const res = await send('GET', '/v1/pnc/settings/local-ca');
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          configured: false,
          createdAt: null,
          cpoSubCa: false,
          certificates: [],
        });
      }
    });

    it('describes a stored CA', async () => {
      queue([{ value: storedCa(true) }]);
      const res = await send('GET', '/v1/pnc/settings/local-ca');
      expect(res.json()).toEqual({
        configured: true,
        createdAt: CREATED,
        cpoSubCa: true,
        certificates: [],
      });
    });

    it('answers 500 when the encryption key is empty', async () => {
      mutableConfig.SETTINGS_ENCRYPTION_KEY = '';
      queue([{ value: storedCa(true) }]);
      const res = await send('GET', '/v1/pnc/settings/local-ca');
      expect(res.statusCode).toBe(500);
    });

    it('answers 404 to a site-restricted user on every CA route', async () => {
      state.allSites = false;
      for (const [method, url] of [
        ['GET', '/v1/pnc/settings/local-ca'],
        ['POST', '/v1/pnc/settings/local-ca'],
        ['POST', '/v1/pnc/settings/local-ca/cpo-sub-ca'],
      ] as const) {
        const res = await send(method, url);
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'Setting not found', code: 'SETTING_NOT_FOUND' });
      }
      expect(ca.createLocalContractCa).not.toHaveBeenCalled();
    });
  });

  describe('POST /pnc/settings/local-ca', () => {
    it('stores the encrypted CA once, audits and invalidates the cache', async () => {
      queue([], [{ key: 'pnc.local.caEnc' }]);
      const res = await send('POST', '/v1/pnc/settings/local-ca');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ configured: true, cpoSubCa: true });
      const set = state.calls.find((c) => c.method === 'set')?.args[0] as { value: string };
      expect(set.value).toBe(`enc:${JSON.stringify({ createdAt: CREATED, cpo: true })}`);
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        entityId: 'pnc.local.caEnc',
        after: { key: 'pnc.local.caEnc', configured: true, createdAt: CREATED },
      });
      expect(state.publish).toHaveBeenCalledWith(
        'cache_invalidate',
        JSON.stringify({ cache: 'pkiCaCertificates' }),
      );
    });

    it('answers 409 LOCAL_CA_EXISTS when a CA is already stored', async () => {
      queue([], []);
      const res = await send('POST', '/v1/pnc/settings/local-ca');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'LOCAL_CA_EXISTS' });
      expect(writeAudit).not.toHaveBeenCalled();
      expect(state.publish).not.toHaveBeenCalled();
    });

    it('still answers when the cache invalidation publish fails', async () => {
      state.publish.mockRejectedValueOnce(new Error('redis down'));
      queue([], [{ key: 'pnc.local.caEnc' }]);
      const res = await send('POST', '/v1/pnc/settings/local-ca');
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /pnc/settings/local-ca/cpo-sub-ca', () => {
    it('adds the CPO Sub-CAs with a compare-and-set on the stored value', async () => {
      queue([{ value: storedCa(false) }], [{ key: 'pnc.local.caEnc' }]);
      const res = await send('POST', '/v1/pnc/settings/local-ca/cpo-sub-ca');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ configured: true, cpoSubCa: true });
      expect(ca.addCpoSubCas).toHaveBeenCalledWith({ createdAt: CREATED, cpo: false });
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        before: { key: 'pnc.local.caEnc', cpoSubCa: false },
        after: { key: 'pnc.local.caEnc', cpoSubCa: true },
      });
      expect(state.publish).toHaveBeenCalledTimes(1);
    });

    it('answers 409 without a CA, with the Sub-CAs present, and on a lost race', async () => {
      queue([]);
      const none = await send('POST', '/v1/pnc/settings/local-ca/cpo-sub-ca');
      expect(none.statusCode).toBe(409);
      expect(none.json()).toMatchObject({ code: 'LOCAL_CA_NOT_CONFIGURED' });

      queue([{ value: storedCa(true) }]);
      const present = await send('POST', '/v1/pnc/settings/local-ca/cpo-sub-ca');
      expect(present.json()).toMatchObject({ code: 'LOCAL_CPO_SUB_CA_EXISTS' });
      expect(ca.addCpoSubCas).not.toHaveBeenCalled();

      queue([{ value: storedCa(false) }], []);
      const raced = await send('POST', '/v1/pnc/settings/local-ca/cpo-sub-ca');
      expect(raced.statusCode).toBe(409);
      expect(raced.json()).toMatchObject({ code: 'LOCAL_CPO_SUB_CA_EXISTS' });
      expect(writeAudit).not.toHaveBeenCalled();
    });
  });

  describe('driver contracts', () => {
    it('lists a driver contracts', async () => {
      vi.mocked(contractService.listDriverContracts).mockResolvedValue([contract] as never);
      const res = await send('GET', `/v1/drivers/${DRIVER}/pnc-contracts`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([contract]);
      expect(contractService.listDriverContracts).toHaveBeenCalledWith(DRIVER);
    });

    it('creates a contract for the PCID with the caller as actor', async () => {
      vi.mocked(contractService.createContract).mockResolvedValue(contract as never);
      const res = await send('POST', `/v1/drivers/${DRIVER}/pnc-contracts`, { pcid: 'PCID-1' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(contract);
      expect(contractService.createContract).toHaveBeenCalledWith(
        DRIVER,
        'PCID-1',
        { actor: 'user', userId: 'usr_1' },
        expect.objectContaining({ actor: expect.objectContaining({ actorUserId: 'usr_1' }) }),
      );
    });

    it('refuses a PCID with other characters', async () => {
      const res = await send('POST', `/v1/drivers/${DRIVER}/pnc-contracts`, { pcid: 'a b' });
      expect(res.statusCode).toBe(400);
      expect(contractService.createContract).not.toHaveBeenCalled();
    });

    it('revokes a contract', async () => {
      vi.mocked(contractService.revokeContract).mockResolvedValue({
        ...contract,
        status: 'revoked',
        revokedAt: CREATED,
      } as never);
      const res = await send('POST', `/v1/drivers/${DRIVER}/pnc-contracts/1/revoke`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'revoked' });
      expect(vi.mocked(contractService.revokeContract).mock.calls[0]?.slice(0, 2)).toEqual([
        DRIVER,
        1,
      ]);
    });
  });
});
