// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Real self-signed test PEM (same as stations-routes.test.ts) so the
// X509Certificate check in the sign route accepts it.
const TEST_PEM_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDYTCCAkmgAwIBAgIUTRwcMo/cq2a8TDMda6I+GpAzyJQwDQYJKoZIhvcNAQEL
BQAwQDELMAkGA1UEBhMCVVMxFjAUBgNVBAoMDUVWdGl2aXR5IFRlc3QxGTAXBgNV
BAMMEEVWdGl2aXR5IFRlc3QgQ0EwHhcNMjYwMjIxMTgxNjEzWhcNMzYwMjE5MTgx
NjEzWjBAMQswCQYDVQQGEwJVUzEWMBQGA1UECgwNRVZ0aXZpdHkgVGVzdDEZMBcG
A1UEAwwQRVZ0aXZpdHkgVGVzdCBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
AQoCggEBANsDGoiIRlgTFls3z+pPNTFTG9lxQlXwBhlw9i/wV3yQJPdqSgxFDgp7
PHCev7IHSgP0nBBfHQ560gFjtgMP+8Pgmeqtt8RGknxZPeSMePxwuzvkf1+XYfta
Bg6QAgoChDJkdFbXlqANzE6BB685h+OKI6wDbvOqxFGReQHodBX2ENGk/c0p2BXn
I/9IydpRL5FC918ex++GE9DAf9gZHO35J12WWp5QDmmZHBGrowFLv0nTuISZ0bQw
U/vDGOVR8s/KJ4r0jyb9MuSQFJkg1VBM6j36Ge8vMrQmWoi2yZLGYYaKp+R1zN+V
8DwkbXeQRy4jiqyBYApET5txG2uGuLECAwEAAaNTMFEwHQYDVR0OBBYEFH1zUD3V
8/aR7jGSi5ptHCmMWIUDMB8GA1UdIwQYMBaAFH1zUD3V8/aR7jGSi5ptHCmMWIUD
MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBADQ2+W8418Zkytha
LIilVOLJdK+AKpWrZWRNYkb/JnEu/husUfZXaxxOUQB+/gEhh4EeFcTSWkEh2GiU
XZbZ9zXDVqKLNBgubMKRjJh7XA4uASdP2dKt7u/aerYdBGPd2Uuku6IBLVNWxHap
GYQS+sRDqF0Qhk6ZnPUUuqpEFcP7/Ib3/Bna1XC/6nitqfoF5jMPZcahQY9eOVR2
2t30h0+FJcLlHC2Sit+scgqcNsIH7dLrn/DGBqRGuNDbLr0en7Gwr1AXUOSpc8/W
43o8KYRCfMwahBKbuSBXvueAXJNpWYEPGxEcZc+sH/IqssqdzsqB8ZGZghiLh6uI
qf/5BbM=
-----END CERTIFICATE-----`;

const { publishMock, state } = vi.hoisted(() => ({
  publishMock: vi.fn((): Promise<void> => Promise.resolve()),
  state: {
    csrRow: null as Record<string, unknown> | null,
    stationRows: [] as Record<string, unknown>[],
  },
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

vi.mock('@evtivity/database', () => {
  const selectChain = {
    from: () => selectChain,
    where: () => Promise.resolve(state.csrRow == null ? [] : [state.csrRow]),
  };
  const updateChain = {
    set: () => updateChain,
    where: () => Promise.resolve([]),
  };
  return {
    db: {
      select: () => selectChain,
      update: () => updateChain,
      execute: () => Promise.resolve(state.stationRows),
    },
    pkiCaCertificates: {},
    pkiCsrRequests: {},
    stationCertificates: {},
    certificateAuditLog: {},
    writeAudit: vi.fn(() => Promise.resolve()),
    isPncEnabled: vi.fn(() => Promise.resolve(true)),
  };
});

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: publishMock }),
}));

import { registerAuth } from '../plugins/auth.js';
import { pncCertificateRoutes } from '../routes/pnc-certificates.js';

describe('POST /pnc/csr-requests/:id/sign', () => {
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
    vi.clearAllMocks();
    state.csrRow = { id: 5, stationId: 'sta_000000000001', certificateType: 'V2GCertificate' };
    state.stationRows = [{ station_id: 'CS-001' }];
  });

  async function sign(): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/pnc/csr-requests/5/sign',
      headers: { authorization: `Bearer ${token}` },
      payload: { signedCertificateChain: TEST_PEM_CERTIFICATE },
    });
    return res.statusCode;
  }

  it('publishes CertificateSigned to the station on ocpp_commands', async () => {
    expect(await sign()).toBe(200);

    const call = publishMock.mock.calls.find((c) => (c as unknown[])[0] === 'ocpp_commands') as
      | [string, string]
      | undefined;
    expect(call).toBeDefined();
    const message = JSON.parse(call?.[1] ?? '{}') as Record<string, unknown>;
    expect(Object.keys(message)).toEqual(['commandId', 'stationId', 'action', 'payload']);
    expect(message).toEqual({
      commandId: expect.any(String),
      stationId: 'CS-001',
      action: 'CertificateSigned',
      payload: { certificateChain: TEST_PEM_CERTIFICATE, certificateType: 'V2GCertificate' },
    });
  });

  it('publishes nothing when the CSR has no station', async () => {
    state.csrRow = { id: 5, stationId: null, certificateType: 'V2GCertificate' };

    expect(await sign()).toBe(200);
    expect(publishMock.mock.calls.some((c) => (c as unknown[])[0] === 'ocpp_commands')).toBe(false);
  });
});
