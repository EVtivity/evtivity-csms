// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCPI CDR routes: the list with filters and site scope, a credit CDR, the
// reissue of a credited session and the retry of a failed CDR push.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  index: 0,
  calls: [] as Array<{ method: string; args: unknown[] }>,
  siteIds: null as string[] | null,
}));

function queue(...results: unknown[]): void {
  state.results = results;
  state.index = 0;
}

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'leftJoin', 'orderBy', 'limit', 'offset']) {
      chain[method] = vi.fn((...args: unknown[]) => {
        state.calls.push({ method, args });
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
    db: { select: vi.fn(() => makeChain()) },
    writeAudit: vi.fn().mockResolvedValue(undefined),
    createCreditCdr: vi.fn(),
    supersedeCreditedSessionCdrs: vi.fn(),
    claimCdrPushRetry: vi.fn(),
  };
});

vi.mock('../lib/ocpi-cdr-request.js', () => ({
  publishOcpiCdrRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(async () => state.siteIds),
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

import {
  writeAudit,
  createCreditCdr,
  supersedeCreditedSessionCdrs,
  claimCdrPushRetry,
} from '@evtivity/database';
import { publishOcpiCdrRequest } from '../lib/ocpi-cdr-request.js';
import { registerAuth } from '../plugins/auth.js';
import { ocpiCdrRoutes } from '../routes/ocpi-cdrs.js';

const PARTNER = 'opr_abcdefghijkl';
const CDR = '0b5c2a3e-1111-4222-8333-444455556666';

const cdrRow = {
  id: 'cdr_1',
  partnerId: PARTNER,
  ocpiCdrId: CDR,
  chargingSessionId: 'ses_1',
  totalEnergy: '10.0',
  totalCost: '4.50',
  currency: 'EUR',
  isCredit: false,
  hasCredit: false,
  supersededAt: null,
  pushStatus: 'sent',
  createdAt: '2026-11-01T00:00:00.000Z',
  partnerName: 'Partner',
};

describe('OCPI CDR routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(ocpiCdrRoutes, { prefix: '/v1' });
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.siteIds = null;
    state.calls = [];
    queue();
  });

  const send = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  describe('GET /ocpi/cdrs', () => {
    it('lists CDRs with the partner and push status filters', async () => {
      queue([cdrRow], [{ count: 1 }]);
      const res = await send('GET', `/v1/ocpi/cdrs?partnerId=${PARTNER}&pushStatus=sent`);
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<Record<string, unknown>>; total: number }>();
      expect(body.total).toBe(1);
      expect(body.data[0]).toMatchObject({ ocpiCdrId: CDR, partnerName: 'Partner' });
      expect(state.calls.filter((c) => c.method === 'where')[0]?.args[0]).toBeDefined();
    });

    it('answers an empty page for a user without sites and scopes a restricted user', async () => {
      state.siteIds = [];
      const empty = await send('GET', '/v1/ocpi/cdrs');
      expect(empty.json()).toEqual({ data: [], total: 0 });
      expect(state.calls).toHaveLength(0);

      state.siteIds = ['sit_1'];
      queue([], []);
      const scoped = await send('GET', '/v1/ocpi/cdrs');
      expect(scoped.json()).toEqual({ data: [], total: 0 });
      expect(state.calls.filter((c) => c.method === 'where')[0]?.args[0]).toBeDefined();
    });

    it('reads every CDR without filters', async () => {
      queue([], [{ count: 0 }]);
      await send('GET', '/v1/ocpi/cdrs');
      expect(state.calls.filter((c) => c.method === 'where')[0]?.args[0]).toBeUndefined();
    });
  });

  describe('POST /ocpi/cdrs/credit', () => {
    const body = { originalCdrId: CDR, reason: 'Wrong tariff' };

    it('creates a credit CDR and audits it on the session', async () => {
      vi.mocked(createCreditCdr).mockResolvedValue({
        status: 'created',
        cdrId: 'credit-1',
        chargingSessionId: 'ses_1',
        partnerId: PARTNER,
        cdrData: { total_cost: { excl_vat: -4.5 } },
      } as never);
      const res = await send('POST', '/v1/ocpi/cdrs/credit', body);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ cdrId: 'credit-1' });
      expect(createCreditCdr).toHaveBeenCalledWith(CDR, 'Wrong tariff');
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        entityId: 'ses_1',
        action: 'cdr_credited',
        after: {
          originalCdrId: CDR,
          creditCdrId: 'credit-1',
          partnerId: PARTNER,
          totalCost: { excl_vat: -4.5 },
        },
        notes: 'Wrong tariff',
      });
    });

    it('audits a null total cost when the credit CDR has none', async () => {
      vi.mocked(createCreditCdr).mockResolvedValue({
        status: 'created',
        cdrId: 'credit-2',
        chargingSessionId: 'ses_1',
        partnerId: PARTNER,
        cdrData: {},
      } as never);
      await send('POST', '/v1/ocpi/cdrs/credit', body);
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        after: { totalCost: null },
      });
    });

    it('returns the existing credit CDR without a new audit row', async () => {
      vi.mocked(createCreditCdr).mockResolvedValue({
        status: 'existing',
        cdrId: 'credit-1',
      } as never);
      const res = await send('POST', '/v1/ocpi/cdrs/credit', body);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ cdrId: 'credit-1' });
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('maps the refusals', async () => {
      const cases: Array<[string, number, string]> = [
        ['not_found', 404, 'CDR_NOT_FOUND'],
        ['is_credit', 400, 'INVALID_OPERATION'],
        ['invalid_cdr', 400, 'VALIDATION_ERROR'],
      ];
      for (const [status, code, errorCode] of cases) {
        vi.mocked(createCreditCdr).mockResolvedValueOnce({ status } as never);
        const res = await send('POST', '/v1/ocpi/cdrs/credit', body);
        expect(res.statusCode, status).toBe(code);
        expect(res.json()).toMatchObject({ code: errorCode });
      }
    });

    it('answers 404 for a CDR outside the user sites before crediting', async () => {
      state.siteIds = [];
      const none = await send('POST', '/v1/ocpi/cdrs/credit', body);
      expect(none.statusCode).toBe(404);
      state.siteIds = ['sit_1'];
      queue([]);
      const other = await send('POST', '/v1/ocpi/cdrs/credit', body);
      expect(other.statusCode).toBe(404);
      expect(createCreditCdr).not.toHaveBeenCalled();
    });

    it('credits a CDR at the user sites', async () => {
      state.siteIds = ['sit_1'];
      queue([{ id: 'cdr_1' }]);
      vi.mocked(createCreditCdr).mockResolvedValue({ status: 'existing', cdrId: 'c' } as never);
      const res = await send('POST', '/v1/ocpi/cdrs/credit', body);
      expect(res.statusCode).toBe(201);
    });
  });

  describe('POST /ocpi/cdrs/:id/reissue', () => {
    const body = { reason: 'Corrected energy' };

    it('supersedes the credited CDRs, audits and requests a new CDR', async () => {
      vi.mocked(supersedeCreditedSessionCdrs).mockResolvedValue({
        status: 'reissued',
        chargingSessionId: 'ses_1',
        generation: 2,
        supersededCdrIds: [CDR],
        partnerId: PARTNER,
      } as never);
      const res = await send('POST', `/v1/ocpi/cdrs/${CDR}/reissue`, body);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ chargingSessionId: 'ses_1', status: 'reissued' });
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        action: 'cdr_reissued',
        before: { liveCdrIds: [CDR] },
        notes: 'Corrected energy',
      });
      expect(publishOcpiCdrRequest).toHaveBeenCalledWith({ sessionId: 'ses_1', generation: 2 });
    });

    it('requests the CDR again for a pending reissue without an audit row', async () => {
      vi.mocked(supersedeCreditedSessionCdrs).mockResolvedValue({
        status: 'pending',
        chargingSessionId: 'ses_1',
        generation: 3,
      } as never);
      const res = await send('POST', `/v1/ocpi/cdrs/${CDR}/reissue`, body);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ chargingSessionId: 'ses_1', status: 'pending' });
      expect(writeAudit).not.toHaveBeenCalled();
      expect(publishOcpiCdrRequest).toHaveBeenCalledWith({ sessionId: 'ses_1', generation: 3 });
    });

    it('answers 404 and 409 CDR_NOT_CREDITED', async () => {
      vi.mocked(supersedeCreditedSessionCdrs).mockResolvedValueOnce({
        status: 'not_found',
      } as never);
      expect((await send('POST', `/v1/ocpi/cdrs/${CDR}/reissue`, body)).statusCode).toBe(404);
      vi.mocked(supersedeCreditedSessionCdrs).mockResolvedValueOnce({
        status: 'not_credited',
        cdrId: CDR,
      } as never);
      const res = await send('POST', `/v1/ocpi/cdrs/${CDR}/reissue`, body);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'CDR_NOT_CREDITED' });
      expect(publishOcpiCdrRequest).not.toHaveBeenCalled();
    });

    it('answers 404 out of scope for a restricted user', async () => {
      state.siteIds = ['sit_1'];
      queue([]);
      const res = await send('POST', `/v1/ocpi/cdrs/${CDR}/reissue`, body);
      expect(res.statusCode).toBe(404);
      state.siteIds = [];
      expect((await send('POST', `/v1/ocpi/cdrs/${CDR}/reissue`, body)).statusCode).toBe(404);
      expect(supersedeCreditedSessionCdrs).not.toHaveBeenCalled();
    });
  });

  describe('POST /ocpi/cdrs/:id/push', () => {
    it('claims the retry, audits and requests the push', async () => {
      state.siteIds = ['sit_1'];
      queue([{ id: 'cdr_1' }]);
      vi.mocked(claimCdrPushRetry).mockResolvedValue({
        status: 'claimed',
        chargingSessionId: 'ses_1',
        partnerId: PARTNER,
        retry: 4,
      } as never);
      const res = await send('POST', `/v1/ocpi/cdrs/${CDR}/push`);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ cdrId: CDR, pushStatus: 'pending' });
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        action: 'cdr_push_retried',
        before: { cdrId: CDR, pushStatus: 'failed' },
        after: { cdrId: CDR, pushStatus: 'pending', partnerId: PARTNER },
      });
      expect(publishOcpiCdrRequest).toHaveBeenCalledWith({ cdrId: CDR, retry: 4 });
    });

    it('answers 404 and 409 CDR_PUSH_NOT_FAILED', async () => {
      vi.mocked(claimCdrPushRetry).mockResolvedValueOnce({ status: 'not_found' } as never);
      expect((await send('POST', `/v1/ocpi/cdrs/${CDR}/push`)).statusCode).toBe(404);
      vi.mocked(claimCdrPushRetry).mockResolvedValueOnce({
        status: 'not_failed',
        pushStatus: 'sent',
      } as never);
      const res = await send('POST', `/v1/ocpi/cdrs/${CDR}/push`);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'CDR_PUSH_NOT_FAILED' });
      expect(publishOcpiCdrRequest).not.toHaveBeenCalled();
    });

    it('answers 404 out of scope', async () => {
      state.siteIds = [];
      const res = await send('POST', `/v1/ocpi/cdrs/${CDR}/push`);
      expect(res.statusCode).toBe(404);
      expect(claimCdrPushRetry).not.toHaveBeenCalled();
    });
  });
});
