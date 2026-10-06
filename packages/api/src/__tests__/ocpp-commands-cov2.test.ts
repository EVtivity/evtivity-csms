// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { results, replies, awaitPubSubReply, publishOcppCommand, writeAudit, getUserSiteIds } =
  vi.hoisted(() => {
    const replies: unknown[] = [];
    return {
      results: [] as unknown[][],
      replies,
      publishOcppCommand: vi.fn().mockResolvedValue(undefined),
      awaitPubSubReply: vi.fn(async (_pubsub: unknown, opts: { send: () => Promise<void> }) => {
        await opts.send();
        return replies.shift() ?? null;
      }),
      writeAudit: vi.fn().mockResolvedValue(undefined),
      getUserSiteIds: vi.fn(),
    };
  });

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  awaitPubSubReply,
  publishOcppCommand,
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({ publish: vi.fn(), subscribe: vi.fn() })),
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
}));

vi.mock('@evtivity/ocpp', () => ({
  ActionRegistry: {
    Reset: { validateRequest: vi.fn().mockReturnValue(true) },
    DataTransfer: { validateRequest: vi.fn().mockReturnValue(true) },
    GetVariables: { validateRequest: vi.fn().mockReturnValue(true) },
  },
  ActionRegistry16: {
    Reset: { validateRequest: vi.fn().mockReturnValue(true) },
  },
}));

vi.mock('../lib/site-access.js', () => ({ getUserSiteIds }));

vi.mock('@evtivity/database', () => {
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
    let p: Promise<unknown> | null = null;
    chain['then'] = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (r: unknown) => unknown,
    ) => {
      p ??= Promise.resolve(results.shift() ?? []);
      return p.then(onFulfilled, onRejected);
    };
    return chain;
  }
  return {
    db: { select: vi.fn(() => makeChain()) },
    chargingStations: { id: 'id', siteId: 'siteId', stationId: 'stationId' },
    stationConfigurations: {},
    stationAuditLog: { name: 'stationAuditLog' },
    writeAudit,
  };
});

import { registerAuth } from '../plugins/auth.js';
import { ocppCommandRoutes } from '../routes/ocpp-commands.js';

const station21 = { id: 'sta_internal', siteId: 'sit_a', ocppProtocol: 'ocpp2.1' };

describe('OCPP command dispatch - uncovered paths', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    ocppCommandRoutes(app);
    await app.ready();
    headers = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    results.length = 0;
    replies.length = 0;
    getUserSiteIds.mockResolvedValue(null);
    writeAudit.mockResolvedValue(undefined);
  });

  it('returns 400 UNKNOWN_ACTION when the action is missing from the registry', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/ClearCache',
      headers,
      payload: { stationId: 'CS-1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'UNKNOWN_ACTION', action: 'ClearCache' });
    expect(publishOcppCommand).not.toHaveBeenCalled();
  });

  it('returns 404 when the station does not exist', async () => {
    results.push([]);
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers,
      payload: { stationId: 'CS-1', type: 'Immediate' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
  });

  it('returns 404 for a site-restricted user when the station has no site', async () => {
    getUserSiteIds.mockResolvedValue(['sit_a']);
    results.push([{ ...station21, siteId: null }]);
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers,
      payload: { stationId: 'CS-1', type: 'Immediate' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('STATION_NOT_FOUND');
    expect(publishOcppCommand).not.toHaveBeenCalled();
  });

  it('refuses a 1.6 command to a 2.1 station with OCPP_VERSION_MISMATCH', async () => {
    results.push([station21]);
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v16/Reset',
      headers,
      payload: { stationId: 'CS-1', type: 'Hard' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'This is an ocpp1.6 command but the station uses ocpp2.1',
      code: 'OCPP_VERSION_MISMATCH',
      action: 'Reset',
    });
    expect(publishOcppCommand).not.toHaveBeenCalled();
  });

  it('returns 202 COMMAND_QUEUED and audits the queued outcome when the station is offline', async () => {
    results.push([station21]);
    replies.push({ queued: true, error: 'Station CS-1 offline, queued' });
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers,
      payload: { stationId: 'CS-1', type: 'Immediate' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      status: 'queued',
      code: 'COMMAND_QUEUED',
      stationId: 'CS-1',
      action: 'Reset',
      message: 'Station CS-1 offline, queued',
    });
    expect(publishOcppCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stationId: 'CS-1',
        action: 'Reset',
        payload: { type: 'Immediate' },
        version: 'ocpp2.1',
      }),
    );
    await vi.waitFor(() => {
      expect(writeAudit).toHaveBeenCalledWith(
        { table: { name: 'stationAuditLog' }, idColumn: 'station_id' },
        expect.objectContaining({
          entityId: 'sta_internal',
          action: 'command_dispatched',
          notes: 'Reset (queued (station offline))',
        }),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  it('uses a default message when a queued reply has no text', async () => {
    results.push([station21]);
    replies.push({ queued: true });
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers,
      payload: { stationId: 'CS-1', type: 'Immediate' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().message).toBe('Station offline, command queued');
  });

  it('stores a truncation marker instead of a payload larger than 16 KB in the audit row', async () => {
    results.push([station21]);
    replies.push({ response: { status: 'Accepted' } });
    const data = 'x'.repeat(20_000);
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/DataTransfer',
      headers,
      payload: { stationId: 'CS-1', vendorId: 'acme', data },
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(writeAudit).toHaveBeenCalled();
    });
    const entry = writeAudit.mock.calls[0]?.[1] as { after: { payload: unknown } };
    expect(entry.after.payload).toEqual({
      _truncated: true,
      _originalBytes: JSON.stringify({ vendorId: 'acme', data }).length,
      _maxBytes: 16 * 1024,
    });
  });

  it('still answers 200 when writing the audit row fails', async () => {
    results.push([station21]);
    replies.push({ response: { status: 'Accepted' } });
    writeAudit.mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(app.log, 'warn');
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers,
      payload: { stationId: 'CS-1', type: 'Immediate' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'accepted', response: { status: 'Accepted' } });
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ stationInternalId: 'sta_internal', action: 'Reset' }),
        'Failed to write command audit log',
      );
    });
    warn.mockRestore();
  });

  it('GetVariables stops at the first failed chunk and returns its error', async () => {
    const item = (name: string) => ({ component: { name: 'C' }, variable: { name } });
    results.push(
      [{ id: 'sta_internal' }], // station lookup for ItemsPerMessage
      [{ value: '1' }], // ItemsPerMessage = 1
      [station21], // first chunk site access lookup
    );
    replies.push({ error: 'No response within 35s' });
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/GetVariables',
      headers,
      payload: { stationId: 'CS-1', getVariableData: [item('A'), item('B')] },
    });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ code: 'COMMAND_TIMEOUT', action: 'GetVariables' });
    expect(publishOcppCommand).toHaveBeenCalledTimes(1);
    expect(publishOcppCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ payload: { getVariableData: [item('A')] } }),
    );
  });
});
