// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

type Chain = Record<string, ReturnType<typeof vi.fn>> & { then: unknown };
const chains: { kind: string; chain: Chain }[] = [];
function makeChain(kind: string): Chain {
  const chain = {} as Chain;
  for (const m of ['where', 'values', 'onConflictDoUpdate']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
    Promise.resolve([]).then(resolve, reject);
  chains.push({ kind, chain });
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    insert: vi.fn(() => makeChain('insert')),
    delete: vi.fn(() => makeChain('delete')),
  },
  notifications: {},
  drivers: {},
  driverPushTokens: { token: 'token-col', driverId: 'driver-col' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  sql: vi.fn(),
  desc: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { portalNotificationRoutes } from '../routes/portal/notifications.js';

const DRIVER_ID = 'drv_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalNotificationRoutes);
  await app.ready();
  return app;
}

describe('Portal push token routes', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = await buildApp();
    auth = { authorization: `Bearer ${app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    chains.length = 0;
  });

  it('registers a push token and only refreshes a row the driver owns', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/portal/notifications/push-token',
      headers: auth,
      payload: { token: 'ExponentPushToken[abc]', platform: 'ios' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const chain = chains.find((c) => c.kind === 'insert')?.chain;
    expect(chain?.['values']).toHaveBeenCalledWith(
      expect.objectContaining({
        driverId: DRIVER_ID,
        token: 'ExponentPushToken[abc]',
        platform: 'ios',
      }),
    );
    expect(chain?.['onConflictDoUpdate']).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'token-col',
        set: expect.objectContaining({ platform: 'ios' }),
        setWhere: { eq: ['driver-col', DRIVER_ID] },
      }),
    );
  });

  it('rejects an unknown platform', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/portal/notifications/push-token',
      headers: auth,
      payload: { token: 'abc', platform: 'windows' },
    });
    expect(res.statusCode).toBe(400);
    expect(chains).toHaveLength(0);
  });

  it('rejects an anonymous request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/portal/notifications/push-token',
      payload: { token: 'abc', platform: 'android' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('unregisters only the driver own token', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/portal/notifications/push-token?token=ExponentPushToken%5Babc%5D',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const chain = chains.find((c) => c.kind === 'delete')?.chain;
    expect(chain?.['where']).toHaveBeenCalledWith({
      and: [{ eq: ['token-col', 'ExponentPushToken[abc]'] }, { eq: ['driver-col', DRIVER_ID] }],
    });
  });

  it('requires the token query parameter to unregister', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/portal/notifications/push-token',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(chains).toHaveLength(0);
  });
});
