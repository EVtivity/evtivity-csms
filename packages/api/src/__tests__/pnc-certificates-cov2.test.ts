// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

const { isPncEnabledMock, writeAuditMock, publishMock, eqMock } = vi.hoisted(() => ({
  isPncEnabledMock: vi.fn(),
  writeAuditMock: vi.fn(),
  publishMock: vi.fn(),
  eqMock: vi.fn((col: unknown, value: unknown) => ({ eq: [col, value] })),
}));

let dbResults: unknown[][] = [];
const chains: Record<string, ReturnType<typeof vi.fn>>[] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['values', 'returning', 'where', 'from', 'set', 'orderBy', 'limit', 'offset']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve, reject);
  chains.push(chain as Record<string, ReturnType<typeof vi.fn>>);
  return chain;
}

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

vi.mock('@evtivity/database', () => ({
  db: {
    insert: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    select: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  pkiCaCertificates: { id: 'ca.id', certificateType: 'ca.type', status: 'ca.status' },
  pkiCsrRequests: { id: 'csr.id', status: 'csr.status', stationId: 'csr.stationId' },
  stationCertificates: { stationId: 'sc.stationId', status: 'sc.status' },
  certificateAuditLog: {},
  writeAudit: writeAuditMock,
  isPncEnabled: isPncEnabledMock,
}));

vi.mock('drizzle-orm', () => ({
  eq: eqMock,
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  desc: vi.fn(),
  count: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({
    publish: publishMock,
    subscribe: async () => ({ unsubscribe: async () => {} }),
  }),
}));

import { registerAuth } from '../plugins/auth.js';
import { pncCertificateRoutes } from '../routes/pnc-certificates.js';
import { db } from '@evtivity/database';

// Static EC P-256 test CA certificate ("OCTT Test SubCA", self-signed).
const CA_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIBwDCCAWegAwIBAgIUZECvpIEtJpg5M81GyF1tIhfEW0wwCgYIKoZIzj0EAwIw\nNjELMAkGA1UEBhMCVVMxDTALBgNVBAoMBE9DVFQxGDAWBgNVBAMMD09DVFQgVGVz\ndCBTdWJDQTAeFw0yNjEwMDEwNDIwMDlaFw00NjA5MjYwNDIwMDlaMDYxCzAJBgNV\nBAYTAlVTMQ0wCwYDVQQKDARPQ1RUMRgwFgYDVQQDDA9PQ1RUIFRlc3QgU3ViQ0Ew\nWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAT+qQsfHqmJiCAQJkymKj708QyTL0Rn\nP4b77NukVQE05xLIfskSpe2DLXc3lNd29/OKm4fFEDG46Iz4QDZA1JC6o1MwUTAd\nBgNVHQ4EFgQUdHkHYZNbQefOYBAsx1d/dEQsQKMwHwYDVR0jBBgwFoAUdHkHYZNb\nQefOYBAsx1d/dEQsQKMwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBE\nAiBGD8rOkl+2S1veyMAx/QHmPXf9P81hVEgKUS8pXFkm2QIgBNCse6lUAVjkTD2Q\nd8v4ytiikkthrqvxTvMQxx90720=\n-----END CERTIFICATE-----';

const TS = '2026-10-02T00:00:00.000Z';
const STATION_ID = 'sta_000000000001';

const caRow = {
  id: 3,
  certificateType: 'V2GRootCertificate',
  certificate: 'PEM',
  serialNumber: '01',
  issuer: 'CN=Root',
  subject: 'CN=Root',
  validFrom: TS,
  validTo: TS,
  hashAlgorithm: null,
  issuerNameHash: null,
  issuerKeyHash: null,
  status: 'active',
  source: 'hubject',
  createdAt: TS,
  updatedAt: TS,
};

const csrRow = {
  id: 4,
  stationId: STATION_ID,
  csr: 'CSR',
  certificateType: 'ChargingStationCertificate',
  requestId: 1,
  status: 'pending',
  signedCertificateChain: null,
  providerReference: null,
  errorMessage: null,
  submittedAt: null,
  completedAt: null,
  createdAt: TS,
  updatedAt: TS,
};

const stationCertRow = {
  id: 5,
  stationId: STATION_ID,
  certificateType: 'ChargingStationCertificate',
  certificate: 'PEM',
  serialNumber: null,
  issuer: null,
  subject: null,
  validFrom: null,
  validTo: null,
  hashAlgorithm: null,
  issuerNameHash: null,
  issuerKeyHash: null,
  parentCaId: null,
  source: 'station',
  status: 'active',
  createdAt: TS,
  updatedAt: TS,
};

describe('PnC certificate routes under /v1', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(rateLimit, { global: false });
    await app.register(
      async (instance) => {
        pncCertificateRoutes(instance);
      },
      { prefix: '/v1' },
    );
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    chains.length = 0;
    isPncEnabledMock.mockResolvedValue(true);
    writeAuditMock.mockResolvedValue(undefined);
    publishMock.mockResolvedValue(undefined);
  });

  function call(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload != null ? { payload } : {}),
    });
  }

  describe('PnC feature gate', () => {
    it('returns 403 PNC_DISABLED for certificate routes when PnC is off', async () => {
      isPncEnabledMock.mockResolvedValue(false);
      const res = await call('GET', '/v1/pnc/ca-certificates');
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'Plug and Charge is disabled', code: 'PNC_DISABLED' });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('serves certificate routes when PnC is on', async () => {
      dbResults = [[], []];
      const res = await call('GET', '/v1/pnc/ca-certificates');
      expect(res.statusCode).toBe(200);
      expect(isPncEnabledMock).toHaveBeenCalled();
    });
  });

  describe('GET /pnc/ca-certificates', () => {
    it('filters by type and status and pages with the offset', async () => {
      dbResults = [[caRow], [{ count: 11 }]];
      const res = await call(
        'GET',
        '/v1/pnc/ca-certificates?certificateType=V2GRootCertificate&status=active&page=2&limit=5',
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [caRow], total: 11 });
      expect(eqMock).toHaveBeenCalledWith('ca.type', 'V2GRootCertificate');
      expect(eqMock).toHaveBeenCalledWith('ca.status', 'active');
      expect(chains[0]?.['offset']).toHaveBeenCalledWith(5);
      expect(chains[0]?.['limit']).toHaveBeenCalledWith(5);
    });

    it('returns total 0 when the count row is missing', async () => {
      dbResults = [[], []];
      const res = await call('GET', '/v1/pnc/ca-certificates');
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(eqMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /pnc/ca-certificates', () => {
    it('rejects a certificate that is not valid PEM', async () => {
      const res = await call('POST', '/v1/pnc/ca-certificates', {
        certificateType: 'MORootCertificate',
        certificate: 'not a certificate',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'certificate is not a valid PEM-encoded X.509 certificate',
        code: 'VALIDATION_ERROR',
      });
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('GET /pnc/csr-requests', () => {
    it('filters by status and station', async () => {
      dbResults = [[csrRow], [{ count: 1 }]];
      const res = await call('GET', `/v1/pnc/csr-requests?status=pending&stationId=${STATION_ID}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [csrRow], total: 1 });
      expect(eqMock).toHaveBeenCalledWith('csr.status', 'pending');
      expect(eqMock).toHaveBeenCalledWith('csr.stationId', STATION_ID);
    });

    it('returns total 0 without filters when no count row', async () => {
      dbResults = [[], []];
      const res = await call('GET', '/v1/pnc/csr-requests');
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  describe('POST /pnc/csr-requests/:id/sign', () => {
    it('rejects a chain without a PEM certificate block', async () => {
      const res = await call('POST', '/v1/pnc/csr-requests/4/sign', {
        signedCertificateChain: 'garbage text',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'signedCertificateChain is not a valid PEM-encoded certificate',
        code: 'VALIDATION_ERROR',
      });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('rejects a PEM block whose body does not parse', async () => {
      const res = await call('POST', '/v1/pnc/csr-requests/4/sign', {
        signedCertificateChain: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /pnc/csr-requests/:id/sign with a valid PEM', () => {
    it('returns 404 when no pending CSR matches', async () => {
      dbResults = [[]];
      const res = await call('POST', '/v1/pnc/csr-requests/4/sign', {
        signedCertificateChain: CA_PEM,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Pending CSR not found', code: 'CSR_NOT_FOUND' });
      expect(db.update).not.toHaveBeenCalled();
      expect(writeAuditMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /pnc/csr-requests/:id/reject', () => {
    it('marks a pending CSR rejected and audits it', async () => {
      dbResults = [[{ id: 4 }]];
      const res = await call('POST', '/v1/pnc/csr-requests/4/reject');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(chains[0]?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'rejected', completedAt: expect.any(Date) }),
      );
      expect(eqMock).toHaveBeenCalledWith('csr.status', 'pending');
      expect(writeAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'certificate_id' }),
        expect.objectContaining({ entityId: '4', action: 'csr_rejected' }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('returns 404 when no pending CSR matches', async () => {
      dbResults = [[]];
      const res = await call('POST', '/v1/pnc/csr-requests/99/reject');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Pending CSR not found', code: 'CSR_NOT_FOUND' });
      expect(writeAuditMock).not.toHaveBeenCalled();
    });
  });

  describe('GET /pnc/station-certificates', () => {
    it('filters by station and status', async () => {
      dbResults = [[stationCertRow], [{ count: 1 }]];
      const res = await call(
        'GET',
        `/v1/pnc/station-certificates?stationId=${STATION_ID}&status=active`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [stationCertRow], total: 1 });
      expect(eqMock).toHaveBeenCalledWith('sc.stationId', STATION_ID);
      expect(eqMock).toHaveBeenCalledWith('sc.status', 'active');
    });

    it('returns total 0 without filters when no count row', async () => {
      dbResults = [[], []];
      const res = await call('GET', '/v1/pnc/station-certificates');
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  describe('POST /pnc/refresh-root-certificates rate limit', () => {
    it('allows three refreshes per minute and refuses the fourth', async () => {
      publishMock.mockRejectedValue(new Error('redis down'));
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await call('POST', '/v1/pnc/refresh-root-certificates');
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([502, 502, 502, 429]);
    });
  });
});
