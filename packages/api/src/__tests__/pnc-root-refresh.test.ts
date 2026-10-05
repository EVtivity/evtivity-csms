// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { writeAuditMock } = vi.hoisted(() => ({ writeAuditMock: vi.fn(() => Promise.resolve()) }));

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
  db: {},
  pkiCaCertificates: {},
  pkiCsrRequests: {},
  stationCertificates: {},
  certificateAuditLog: {},
  writeAudit: writeAuditMock,
  isPncEnabled: vi.fn(() => Promise.resolve(true)),
}));

// A pub/sub that hands each pnc_commands publish to `ocppReply`, standing in
// for the OCPP server's subscriber.
type Reply = (command: { commandId: string; action: string }) => Record<string, unknown> | null;
const state: { ocppReply: Reply; handlers: Map<string, (raw: string) => void> } = {
  ocppReply: () => null,
  handlers: new Map(),
};
const publishMock = vi.fn(async (channel: string, payload: string): Promise<void> => {
  if (channel !== 'pnc_commands') return;
  const reply = state.ocppReply(JSON.parse(payload) as { commandId: string; action: string });
  if (reply != null) state.handlers.get('pnc_command_results')?.(JSON.stringify(reply));
});
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({
    publish: publishMock,
    subscribe: async (channel: string, handler: (raw: string) => void) => {
      state.handlers.set(channel, handler);
      return {
        unsubscribe: async () => {
          state.handlers.delete(channel);
        },
      };
    },
  }),
}));

import { registerAuth } from '../plugins/auth.js';
import { pncCertificateRoutes } from '../routes/pnc-certificates.js';

describe('POST /pnc/refresh-root-certificates', () => {
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
    state.handlers.clear();
    state.ocppReply = () => null;
  });

  async function refresh(): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const res = await app.inject({
      method: 'POST',
      url: '/pnc/refresh-root-certificates',
      headers: { authorization: `Bearer ${token}` },
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

  it('asks the OCPP server over pnc_commands and returns its counts', async () => {
    state.ocppReply = (command) => ({ commandId: command.commandId, fetched: 3, added: 1 });

    const res = await refresh();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, fetched: 3, added: 1 });
    const command = JSON.parse(
      (publishMock.mock.calls.find((c) => c[0] === 'pnc_commands') as [string, string])[1],
    ) as Record<string, unknown>;
    expect(command).toEqual({ commandId: expect.any(String), action: 'refreshRootCertificates' });
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'root_certificates_refreshed',
        after: { fetched: 3, added: 1 },
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(publishMock).toHaveBeenCalledWith(
      'cache_invalidate',
      JSON.stringify({ cache: 'pkiCaCertificates' }),
    );
    expect(state.handlers.size).toBe(0);
  });

  it('skips the cache invalidation when no root was added', async () => {
    state.ocppReply = (command) => ({ commandId: command.commandId, fetched: 2, added: 0 });

    const res = await refresh();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, fetched: 2, added: 0 });
    expect(publishMock).not.toHaveBeenCalledWith('cache_invalidate', expect.anything());
  });

  it('returns 502 without an audit row when the provider fails', async () => {
    state.ocppReply = (command) => ({
      commandId: command.commandId,
      error: 'Hubject root cert fetch failed: 503',
    });

    const res = await refresh();

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({
      error: 'Root certificate refresh from the PKI provider failed',
      code: 'PKI_ROOT_REFRESH_FAILED',
    });
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('returns 502 when the command cannot be published', async () => {
    publishMock.mockRejectedValueOnce(new Error('redis down'));

    const res = await refresh();

    expect(res.statusCode).toBe(502);
    expect(res.body['code']).toBe('PKI_ROOT_REFRESH_FAILED');
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('ignores replies for other commands', async () => {
    state.ocppReply = (command) => {
      state.handlers.get('pnc_command_results')?.(
        JSON.stringify({ commandId: 'someone-else', error: 'not mine' }),
      );
      return { commandId: command.commandId, fetched: 1, added: 1 };
    };

    const res = await refresh();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, fetched: 1, added: 1 });
  });
});
