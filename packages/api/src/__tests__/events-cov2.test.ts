// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import type { IncomingMessage, ClientRequest } from 'node:http';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

vi.mock('@evtivity/database', () => ({
  db: {},
  client: {},
  refreshTokens: {},
  users: {},
  userPermissions: {},
  clearSecuritySettingsCache: vi.fn(),
  clearStationMessageSettingsCache: vi.fn(),
  clearSystemSettingsCache: vi.fn(),
}));

const { getUserSiteIds, subscribe, unsubscribe, handlers } = vi.hoisted(() => {
  const handlers: Array<(payload: string) => void> = [];
  const unsubscribe = vi.fn().mockResolvedValue(undefined);
  const subscribe = vi.fn((_channel: string, handler: (payload: string) => void) => {
    handlers.push(handler);
    return Promise.resolve({ unsubscribe });
  });
  return { getUserSiteIds: vi.fn(), subscribe, unsubscribe, handlers };
});

vi.mock('../lib/site-access.js', () => ({ getUserSiteIds, clearSiteAccessCacheLocal: vi.fn() }));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: vi.fn(), subscribe, close: vi.fn() }),
}));

import { registerAuth } from '../plugins/auth.js';
import { isUserActive } from '../lib/user-active.js';
import { startCacheInvalidateListener } from '../services/cache-invalidate-listener.js';
import {
  closeUserEventStreams,
  eventStreamRoutes,
  isEventVisible,
  SITELESS_EVENT_TYPES,
} from '../routes/events.js';

interface Stream {
  res: IncomingMessage;
  req: ClientRequest;
  chunks: string[];
  waitFor: (text: string) => Promise<void>;
}

function openStream(port: number, token: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: `/events/stream?token=${token}`, method: 'GET' },
      (res) => {
        res.setEncoding('utf8');
        const chunks: string[] = [];
        const waiters: Array<{ text: string; done: () => void }> = [];
        res.on('data', (chunk: string) => {
          chunks.push(chunk);
          const all = chunks.join('');
          for (const w of [...waiters]) {
            if (all.includes(w.text)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.done();
            }
          }
        });
        const waitFor = (text: string): Promise<void> =>
          new Promise((done) => {
            if (chunks.join('').includes(text)) {
              done();
              return;
            }
            waiters.push({ text, done });
          });
        void waitFor(': connected').then(() => {
          resolve({ res, req, chunks, waitFor });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('event stream fan-out', () => {
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    handlers.length = 0;
    app = Fastify();
    await app.register(cookie);
    await registerAuth(app);
    eventStreamRoutes(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    port = typeof address === 'object' && address != null ? address.port : 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  it('delivers site events only to clients allowed on that site, siteless events to all-site clients and reviewed global types to all', async () => {
    getUserSiteIds.mockResolvedValueOnce(['sit_a']).mockResolvedValueOnce(null);
    const scoped = await openStream(port, app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' }));
    const admin = await openStream(port, app.jwt.sign({ userId: 'usr_2', roleId: 'rol_1' }));

    expect(subscribe).toHaveBeenCalledWith('csms_events', expect.any(Function));
    expect(handlers).toHaveLength(1);
    const handler = handlers[0]!;

    handler(JSON.stringify({ type: 'x', siteId: 'sit_b', n: 1 }));
    handler(JSON.stringify({ type: 'x', siteId: 'sit_a', n: 2 }));
    handler('not-json{');
    handler(JSON.stringify({ type: 'x', n: 3 }));
    handler(JSON.stringify({ eventType: 'token.changed', stationId: 'sta_1', n: 4 }));
    handler(JSON.stringify({ eventType: 'token.changed', tokenId: 'tok_1', n: 5 }));

    await admin.waitFor('"n":5');
    await scoped.waitFor('"n":5');

    const adminText = admin.chunks.join('');
    const scopedText = scoped.chunks.join('');
    expect(adminText).toContain('data: {"type":"x","siteId":"sit_b","n":1}\n\n');
    expect(adminText).toContain('"n":2');
    expect(adminText).toContain('data: not-json{\n\n');
    expect(adminText).toContain('"n":3');
    expect(adminText).toContain('"n":4');
    expect(scopedText).not.toContain('"n":1');
    expect(scopedText).toContain('"siteId":"sit_a","n":2');
    expect(scopedText).not.toContain('not-json');
    expect(scopedText).not.toContain('"n":3');
    expect(scopedText).not.toContain('"n":4');
    expect(scopedText).toContain('"tokenId":"tok_1","n":5');

    scoped.req.destroy();
    admin.req.destroy();
  }, 5000);

  it('unsubscribes when the last client disconnects and resubscribes for a new client', async () => {
    getUserSiteIds.mockResolvedValue(null);
    const token = app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' });
    const first = await openStream(port, token);
    expect(subscribe).toHaveBeenCalledTimes(1);

    const closed = new Promise<void>((resolve) => {
      first.res.on('close', () => {
        resolve();
      });
    });
    first.req.destroy();
    await closed;
    await vi.waitFor(() => {
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    const second = await openStream(port, token);
    expect(subscribe).toHaveBeenCalledTimes(2);
    second.req.destroy();
  }, 5000);

  it('sends a keepalive comment every 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    getUserSiteIds.mockResolvedValue(null);
    const stream = await openStream(port, app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' }));
    expect(stream.chunks.join('')).not.toContain(': keepalive');

    vi.advanceTimersByTime(30_000);
    await stream.waitFor(': keepalive\n\n');
    expect(stream.chunks.join('')).toContain(': keepalive\n\n');
    stream.req.destroy();
  }, 5000);

  it('refuses an MFA-pending token and a driver token like app.authenticate', async () => {
    const statusOf = (token: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path: `/events/stream?token=${token}`, method: 'GET' },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => (body += c));
            res.on('end', () => {
              resolve({ status: res.statusCode ?? 0, body });
            });
          },
        );
        req.on('error', reject);
        req.end();
      });

    const mfa = await statusOf(
      app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1', mfaPending: true }),
    );
    expect(mfa.status).toBe(401);
    expect(mfa.body).toContain('MFA_REQUIRED');

    const driver = await statusOf(app.jwt.sign({ driverId: 'drv_1', type: 'driver' }));
    expect(driver.status).toBe(401);
    expect(driver.body).toContain('UNAUTHORIZED');
    expect(getUserSiteIds).not.toHaveBeenCalled();
  }, 5000);

  it('refuses a deactivated operator with ACCOUNT_DEACTIVATED', async () => {
    vi.mocked(isUserActive).mockResolvedValueOnce(false);
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const token = app.jwt.sign({ userId: 'usr_off', roleId: 'rol_1' });
      const req = request(
        { host: '127.0.0.1', port, path: `/events/stream?token=${token}`, method: 'GET' },
        (r) => {
          let body = '';
          r.setEncoding('utf8');
          r.on('data', (c: string) => (body += c));
          r.on('end', () => {
            resolve({ status: r.statusCode ?? 0, body });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(401);
    expect(res.body).toContain('ACCOUNT_DEACTIVATED');
    expect(vi.mocked(isUserActive)).toHaveBeenCalledWith('usr_off');
    expect(getUserSiteIds).not.toHaveBeenCalled();
  }, 5000);

  it('ends the open streams of a deactivated operator on the cache_invalidate active message', async () => {
    getUserSiteIds.mockResolvedValue(['sit_a']);
    const listener = await startCacheInvalidateListener(app.log);
    const deliver = [...subscribe.mock.calls]
      .reverse()
      .find((call) => call[0] === 'cache_invalidate')?.[1];
    expect(deliver).toBeDefined();
    const target = await openStream(port, app.jwt.sign({ userId: 'usr_d', roleId: 'rol_1' }));
    const other = await openStream(port, app.jwt.sign({ userId: 'usr_k', roleId: 'rol_1' }));
    const ended = new Promise<void>((resolve) => {
      target.res.on('end', () => {
        resolve();
      });
    });

    deliver?.(JSON.stringify({ kind: 'active', userId: 'usr_d' }));
    await ended;
    expect(other.res.complete).toBe(false);
    other.req.destroy();
    await listener.unsubscribe();
  }, 5000);

  it('ends the stream when the token expires', async () => {
    getUserSiteIds.mockResolvedValue(['sit_a']);
    const stream = await openStream(
      port,
      app.jwt.sign({ userId: 'usr_exp', roleId: 'rol_1' }, { expiresIn: '1s' }),
    );
    await new Promise<void>((resolve) => {
      stream.res.on('end', () => {
        resolve();
      });
    });
    expect(stream.res.complete).toBe(true);
  }, 5000);

  it('ends only the given user streams on an access change', async () => {
    getUserSiteIds.mockResolvedValue(['sit_a']);
    const target = await openStream(port, app.jwt.sign({ userId: 'usr_t', roleId: 'rol_1' }));
    const other = await openStream(port, app.jwt.sign({ userId: 'usr_o', roleId: 'rol_1' }));
    const ended = new Promise<void>((resolve) => {
      target.res.on('end', () => {
        resolve();
      });
    });

    closeUserEventStreams('usr_t');
    await ended;

    handlers[0]?.(JSON.stringify({ eventType: 'x', siteId: 'sit_a', n: 9 }));
    await other.waitFor('"n":9');
    other.req.destroy();
  }, 5000);

  it('applies an access change during the site lookup and holds events until the scope is known', async () => {
    let resolveFirst: (ids: string[]) => void = () => {};
    getUserSiteIds
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(['sit_a']);

    const opening = openStream(port, app.jwt.sign({ userId: 'usr_r', roleId: 'rol_1' }));
    await vi.waitFor(() => {
      expect(getUserSiteIds).toHaveBeenCalledTimes(1);
      expect(handlers).toHaveLength(1);
    });
    // Published while the scope resolves: held, then filtered by the new scope.
    handlers[0]?.(JSON.stringify({ eventType: 'x', siteId: 'sit_b', n: 1 }));
    handlers[0]?.(JSON.stringify({ eventType: 'x', siteId: 'sit_a', n: 2 }));
    // Site B is removed during the lookup: the old answer is not used.
    closeUserEventStreams('usr_r');
    resolveFirst(['sit_a', 'sit_b']);

    const stream = await opening;
    await stream.waitFor('"n":2');
    handlers[0]?.(JSON.stringify({ eventType: 'x', siteId: 'sit_b', n: 3 }));
    handlers[0]?.(JSON.stringify({ eventType: 'x', siteId: 'sit_a', n: 4 }));
    await stream.waitFor('"n":4');

    expect(getUserSiteIds).toHaveBeenCalledTimes(2);
    const body = stream.chunks.join('');
    expect(body).not.toContain('"n":1');
    expect(body).not.toContain('"n":3');
    stream.req.destroy();
  }, 5000);
});

describe('isEventVisible', () => {
  it('shows every event, parsed or not, to an all-site client', () => {
    expect(isEventVisible(null, { eventType: 'x' })).toBe(true);
    expect(isEventVisible(null, undefined)).toBe(true);
  });

  it('shows a site-restricted client its own sites only', () => {
    expect(isEventVisible(['sit_a'], { eventType: 'station.status', siteId: 'sit_a' })).toBe(true);
    expect(isEventVisible(['sit_a'], { eventType: 'station.status', siteId: 'sit_b' })).toBe(false);
    expect(isEventVisible([], { eventType: 'station.status', siteId: 'sit_a' })).toBe(false);
  });

  it('hides siteless events from a site-restricted client unless reviewed as global', () => {
    expect(isEventVisible(['sit_a'], { eventType: 'station.status', stationId: 'sta_1' })).toBe(
      false,
    );
    expect(isEventVisible(['sit_a'], { eventType: 'access.log' })).toBe(false);
    expect(isEventVisible(['sit_a'], { type: 'TransactionStarted', sessionId: 's' })).toBe(false);
    expect(isEventVisible(['sit_a'], 'not an object')).toBe(false);
    for (const type of SITELESS_EVENT_TYPES) {
      expect(isEventVisible(['sit_a'], { eventType: type })).toBe(true);
      expect(isEventVisible(['sit_a'], { eventType: type, stationId: 'sta_1' })).toBe(false);
      expect(isEventVisible(['sit_a'], { eventType: type, sessionId: 'ses_1' })).toBe(false);
    }
  });

  it('scopes station-less support case events by the sites of their linked sessions', () => {
    for (const eventType of [
      'supportCase.created',
      'supportCase.updated',
      'supportCase.newMessage',
    ]) {
      expect(SITELESS_EVENT_TYPES.has(eventType)).toBe(false);
      const base = { eventType, caseId: 'cas_1', stationId: null, siteId: null };
      expect(isEventVisible(['sit_a', 'sit_b'], { ...base, caseSiteIds: ['sit_a', 'sit_b'] })).toBe(
        true,
      );
      // One session at another site, no linked session, or an unsited one.
      expect(isEventVisible(['sit_a'], { ...base, caseSiteIds: ['sit_a', 'sit_b'] })).toBe(false);
      expect(isEventVisible(['sit_a'], { ...base, caseSiteIds: [] })).toBe(false);
      expect(isEventVisible(['sit_a'], { ...base, caseSiteIds: null })).toBe(false);
      expect(isEventVisible(['sit_a'], base)).toBe(false);
      expect(isEventVisible(null, { ...base, caseSiteIds: null })).toBe(true);
      // A case at a station follows the station's site.
      expect(isEventVisible(['sit_a'], { ...base, stationId: 'sta_1', siteId: 'sit_a' })).toBe(
        true,
      );
      expect(
        isEventVisible(['sit_a'], { ...base, stationId: 'sta_1', caseSiteIds: ['sit_a'] }),
      ).toBe(false);
    }
  });
});
