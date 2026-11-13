// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Display message routes: site scope refusals and the OCPP version refusal.

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const m = vi.hoisted(() => ({
  results: [] as unknown[][],
  sets: [] as unknown[],
  send: vi.fn(),
  writeAudit: vi.fn(),
  getUserSiteIds: vi.fn(),
  checkStationSiteAccess: vi.fn(),
}));

vi.mock('@evtivity/database', () => {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const k of [
      'from',
      'where',
      'orderBy',
      'limit',
      'offset',
      'innerJoin',
      'values',
      'returning',
    ]) {
      c[k] = vi.fn(() => c);
    }
    c['set'] = vi.fn((v: unknown) => {
      m.sets.push(v);
      return c;
    });
    c['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve(m.results.shift() ?? []).then(resolve, reject);
    return c;
  };
  return {
    writeAudit: m.writeAudit,
    stationAuditLog: { name: 'station_audit_log' },
    db: {
      select: vi.fn(() => chain()),
      insert: vi.fn(() => chain()),
      update: vi.fn(() => chain()),
    },
    displayMessages: {},
    chargingStations: {},
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

vi.mock('@evtivity/services/ocpp-command', () => ({ sendOcppCommandAndWait: m.send }));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: m.getUserSiteIds,
  invalidateSiteAccessCache: vi.fn(),
  checkStationSiteAccess: m.checkStationSiteAccess,
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

import { OCPP_VERSION_MISMATCH } from '@evtivity/lib';
import { registerAuth } from '../plugins/auth.js';
import { displayMessageRoutes } from '../routes/display-messages.js';

const STATION = 'sta_000000000001';
const SITE_A = 'sit_000000000001';
const SITE_B = 'sit_000000000002';
const station = {
  id: STATION,
  stationId: 'CS-1',
  siteId: SITE_B,
  isOnline: true,
  ocppProtocol: 'ocpp2.1',
};
const payload = { priority: 'NormalCycle', format: 'UTF8', content: 'Hello' };

describe('display message routes (cov3)', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(displayMessageRoutes);
    await app.ready();
    headers = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'r' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    m.results = [];
    m.sets = [];
    m.send.mockReset();
    m.writeAudit.mockReset().mockResolvedValue(undefined);
    m.getUserSiteIds.mockReset().mockResolvedValue([SITE_A]);
    m.checkStationSiteAccess.mockReset().mockResolvedValue(true);
  });

  it('answers 404 to the list of a station outside the caller sites', async () => {
    m.checkStationSiteAccess.mockResolvedValueOnce(false);
    const res = await app.inject({
      method: 'GET',
      url: `/stations/${STATION}/display-messages`,
      headers,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('STATION_NOT_FOUND');
  });

  it('answers 404 to a new message on a station of another site and sends nothing', async () => {
    m.results.push([station]);
    const res = await app.inject({
      method: 'POST',
      url: `/stations/${STATION}/display-messages`,
      headers,
      payload,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('STATION_NOT_FOUND');
    expect(m.send).not.toHaveBeenCalled();
  });

  it('marks the message rejected when the server refuses it for the station OCPP version', async () => {
    m.getUserSiteIds.mockResolvedValue(null);
    m.results.push([station], [{ maxId: 3 }], [{ id: 11 }]);
    m.send.mockResolvedValueOnce({
      commandId: 'c',
      code: OCPP_VERSION_MISMATCH,
      error: 'SetDisplayMessage needs OCPP 2.x',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/stations/${STATION}/display-messages`,
      headers,
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'SetDisplayMessage needs OCPP 2.x',
      code: 'OCPP_VERSION_MISMATCH',
    });
    expect(m.sets[0]).toMatchObject({ status: 'rejected' });
    expect(m.writeAudit.mock.calls[0]?.[1]).toMatchObject({
      action: 'display_message_set',
      notes: expect.stringContaining('refused: SetDisplayMessage needs OCPP 2.x'),
    });
  });

  it('answers 404 to clearing a message of another site and sends nothing', async () => {
    m.results.push([
      { id: 1, ocppMessageId: 4, status: 'accepted', stationOcppId: 'CS-1', siteId: SITE_B },
    ]);
    const res = await app.inject({
      method: 'DELETE',
      url: `/stations/${STATION}/display-messages/1`,
      headers,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('MESSAGE_NOT_FOUND');
    expect(m.send).not.toHaveBeenCalled();
  });

  it('clears an accepted message and stores the station reply', async () => {
    m.getUserSiteIds.mockResolvedValue(null);
    m.results.push([
      { id: 1, ocppMessageId: 4, status: 'accepted', stationOcppId: 'CS-1', siteId: SITE_B },
    ]);
    m.send.mockResolvedValueOnce({ commandId: 'c', response: { status: 'Accepted' } });
    const res = await app.inject({
      method: 'DELETE',
      url: `/stations/${STATION}/display-messages/1`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(m.send).toHaveBeenCalledWith('CS-1', 'ClearDisplayMessage', { id: 4 });
    expect(m.sets[0]).toMatchObject({ status: 'cleared', ocppResponse: { status: 'Accepted' } });
  });

  it('answers 404 to a refresh of a station of another site and sends nothing', async () => {
    m.results.push([station]);
    const res = await app.inject({
      method: 'POST',
      url: `/stations/${STATION}/display-messages/refresh`,
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('STATION_NOT_FOUND');
    expect(m.send).not.toHaveBeenCalled();
  });
});
