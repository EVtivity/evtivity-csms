// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const { subscribe, handlers, stationRows } = vi.hoisted(() => {
  const handlers: Array<(payload: string) => void> = [];
  const subscribe = vi.fn((_channel: string, handler: (payload: string) => void) => {
    handlers.push(handler);
    return Promise.resolve({ unsubscribe: vi.fn().mockResolvedValue(undefined) });
  });
  return { subscribe, handlers, stationRows: { value: [] as unknown[] } };
});

vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(stationRows.value).then(resolve);
  return {
    db: chain,
    client: {},
    refreshTokens: {},
    users: {},
    drivers: {},
    chargingStations: { stationId: 'stationId', onboardingStatus: 'onboardingStatus' },
  };
});

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: vi.fn(), subscribe, close: vi.fn() }),
}));

import { registerAuth } from '../plugins/auth.js';
import { isDriverActive } from '../lib/driver-active.js';
import { closeDriverEventStreams, portalEventRoutes } from '../routes/portal/events.js';
import { portalStationEventRoutes } from '../routes/portal/station-events.js';

interface Response {
  status: number;
  res: IncomingMessage;
  body: () => string;
  waitFor: (text: string) => Promise<void>;
  ended: Promise<void>;
}

function open(port: number, path: string, token?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: token != null ? { authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        res.setEncoding('utf8');
        const ended = new Promise<void>((done) => {
          res.on('end', () => {
            done();
          });
        });
        let body = '';
        const waiters: Array<{ text: string; done: () => void }> = [];
        res.on('data', (chunk: string) => {
          body += chunk;
          for (const w of [...waiters]) {
            if (body.includes(w.text)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.done();
            }
          }
        });
        const waitFor = (text: string): Promise<void> =>
          new Promise((done) => {
            if (body.includes(text)) done();
            else waiters.push({ text, done });
          });
        resolve({ status: res.statusCode ?? 0, res, body: () => body, waitFor, ended });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('portal event streams', () => {
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    handlers.length = 0;
    stationRows.value = [];
    app = Fastify();
    await app.register(cookie);
    await registerAuth(app);
    portalEventRoutes(app);
    portalStationEventRoutes(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    port = typeof address === 'object' && address != null ? address.port : 0;
  });

  afterEach(async () => {
    vi.mocked(isDriverActive).mockReset();
    await app.close();
  });

  it('refuses a deactivated driver on the stream and on authenticateDriver', async () => {
    vi.mocked(isDriverActive).mockResolvedValue(false);
    const token = app.jwt.sign({ driverId: 'drv_off', type: 'driver' });

    const stream = await open(port, '/portal/events', token);
    await stream.ended;
    expect(stream.status).toBe(401);
    expect(stream.body()).toContain('ACCOUNT_DEACTIVATED');
    expect(isDriverActive).toHaveBeenCalledWith('drv_off');

    const guarded = Fastify();
    await registerAuth(guarded);
    guarded.get('/portal/me', { onRequest: [guarded.authenticateDriver] }, () => ({ ok: true }));
    const res = await guarded.inject({
      method: 'GET',
      url: '/portal/me',
      headers: {
        authorization: `Bearer ${guarded.jwt.sign({ driverId: 'drv_off', type: 'driver' })}`,
      },
    });
    await guarded.close();
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('ACCOUNT_DEACTIVATED');
  }, 5000);

  it("ends only the deactivated driver's open streams", async () => {
    const off = await open(
      port,
      '/portal/events',
      app.jwt.sign({ driverId: 'drv_a', type: 'driver' }),
    );
    const other = await open(
      port,
      '/portal/events',
      app.jwt.sign({ driverId: 'drv_b', type: 'driver' }),
    );
    await off.waitFor(': connected');
    await other.waitFor(': connected');

    closeDriverEventStreams('drv_a');
    await off.ended;
    expect(off.res.complete).toBe(true);
    expect(other.res.complete).toBe(false);
  }, 5000);

  it('refuses an MFA-pending driver token and an operator token like authenticateDriver', async () => {
    const mfa = await open(
      port,
      '/portal/events',
      app.jwt.sign({ driverId: 'drv_1', type: 'driver', mfaPending: true }),
    );
    await mfa.ended;
    expect(mfa.status).toBe(401);
    expect(mfa.body()).toContain('MFA_REQUIRED');

    const operator = await open(
      port,
      '/portal/events',
      app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' }),
    );
    await operator.ended;
    expect(operator.status).toBe(403);
    expect(operator.body()).toContain('FORBIDDEN_DRIVER_TOKEN');

    const anonymous = await open(port, '/portal/events');
    await anonymous.ended;
    expect(anonymous.status).toBe(401);
  }, 5000);

  it('ends the driver stream when the token expires', async () => {
    const stream = await open(
      port,
      '/portal/events',
      app.jwt.sign({ driverId: 'drv_exp', type: 'driver' }, { expiresIn: '1s' }),
    );
    expect(stream.status).toBe(200);
    await stream.waitFor(': connected');
    await stream.ended;
    expect(stream.res.complete).toBe(true);
  }, 5000);

  it('answers 404 for a station the portal does not list (pending, blocked or unknown)', async () => {
    stationRows.value = [];
    const res = await open(port, '/portal/chargers/CS-PENDING/events');
    await res.ended;
    expect(res.status).toBe(404);
    expect(res.body()).toContain('STATION_NOT_FOUND');
  }, 5000);

  it('forwards station status events without the internal station or site ids', async () => {
    stationRows.value = [{ id: 'sta_internal01' }];
    const stream = await open(port, '/portal/chargers/CS-1/events');
    expect(stream.status).toBe(200);
    await stream.waitFor(': connected');
    for (const handler of handlers) {
      handler(
        JSON.stringify({
          eventType: 'station.status',
          stationId: 'sta_internal01',
          siteId: 'sit_internal01',
        }),
      );
    }
    await stream.waitFor('station.status');
    expect(stream.body()).toContain('"stationId":"CS-1"');
    expect(stream.body()).not.toContain('sta_internal01');
    expect(stream.body()).not.toContain('sit_internal01');
    stream.res.destroy();
  }, 5000);
});
