// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Static EC P-256 test CA certificate ("OCTT Test SubCA", self-signed).
const CA_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIBwDCCAWegAwIBAgIUZECvpIEtJpg5M81GyF1tIhfEW0wwCgYIKoZIzj0EAwIw\nNjELMAkGA1UEBhMCVVMxDTALBgNVBAoMBE9DVFQxGDAWBgNVBAMMD09DVFQgVGVz\ndCBTdWJDQTAeFw0yNjEwMDEwNDIwMDlaFw00NjA5MjYwNDIwMDlaMDYxCzAJBgNV\nBAYTAlVTMQ0wCwYDVQQKDARPQ1RUMRgwFgYDVQQDDA9PQ1RUIFRlc3QgU3ViQ0Ew\nWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAT+qQsfHqmJiCAQJkymKj708QyTL0Rn\nP4b77NukVQE05xLIfskSpe2DLXc3lNd29/OKm4fFEDG46Iz4QDZA1JC6o1MwUTAd\nBgNVHQ4EFgQUdHkHYZNbQefOYBAsx1d/dEQsQKMwHwYDVR0jBBgwFoAUdHkHYZNb\nQefOYBAsx1d/dEQsQKMwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBE\nAiBGD8rOkl+2S1veyMAx/QHmPXf9P81hVEgKUS8pXFkm2QIgBNCse6lUAVjkTD2Q\nd8v4ytiikkthrqvxTvMQxx90720=\n-----END CERTIFICATE-----';

let dbResults: unknown[][] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['values', 'returning', 'where', 'from', 'set']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve, reject);
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
  },
  pkiCaCertificates: { id: 'id' },
  pkiCsrRequests: {},
  stationCertificates: {},
  certificateAuditLog: {},
  writeAudit: vi.fn(() => Promise.resolve()),
  isPncEnabled: vi.fn(() => Promise.resolve(true)),
}));

const publishMock = vi.fn<(channel: string, payload: string) => Promise<void>>();
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: publishMock }),
}));

import { registerAuth } from '../plugins/auth.js';
import { pncCertificateRoutes } from '../routes/pnc-certificates.js';

describe('PnC CA certificate routes invalidate the OCPP CA cache', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    pncCertificateRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    publishMock.mockReset();
    publishMock.mockResolvedValue(undefined);
  });

  it('publishes cache_invalidate pkiCaCertificates after an upload', async () => {
    dbResults = [
      [
        {
          id: 7,
          certificateType: 'MORootCertificate',
          certificate: CA_PEM,
          serialNumber: null,
          issuer: null,
          subject: null,
          validFrom: null,
          validTo: null,
          hashAlgorithm: null,
          issuerNameHash: null,
          issuerKeyHash: null,
          status: 'active',
          source: 'manual_upload',
          createdAt: '2026-10-02T00:00:00.000Z',
          updatedAt: '2026-10-02T00:00:00.000Z',
        },
      ],
    ];
    const res = await app.inject({
      method: 'POST',
      url: '/pnc/ca-certificates',
      headers: { authorization: `Bearer ${token}` },
      payload: { certificateType: 'MORootCertificate', certificate: CA_PEM },
    });
    expect(res.statusCode).toBe(200);
    expect(publishMock).toHaveBeenCalledWith(
      'cache_invalidate',
      JSON.stringify({ cache: 'pkiCaCertificates' }),
    );
  });

  it('publishes cache_invalidate pkiCaCertificates after a delete', async () => {
    dbResults = [[{ id: 7 }]];
    const res = await app.inject({
      method: 'DELETE',
      url: '/pnc/ca-certificates/7',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(publishMock).toHaveBeenCalledWith(
      'cache_invalidate',
      JSON.stringify({ cache: 'pkiCaCertificates' }),
    );
  });

  it('does not publish when the certificate to delete does not exist', async () => {
    dbResults = [[]];
    const res = await app.inject({
      method: 'DELETE',
      url: '/pnc/ca-certificates/8',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('still succeeds when the publish fails (fail-open)', async () => {
    publishMock.mockRejectedValue(new Error('redis down'));
    dbResults = [[{ id: 9 }]];
    const res = await app.inject({
      method: 'DELETE',
      url: '/pnc/ca-certificates/9',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
