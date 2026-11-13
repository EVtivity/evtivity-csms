// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createServer, type Server } from 'node:http';
import { connect as connectTcp, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const PASSWORD = 'correct-horse-battery';

const system = {
  id: 'dps_1',
  presystemId: 'depot-1',
  name: 'Depot One',
  systemType: 'BMS',
  isEnabled: true,
  passwordHash: 'hash',
  authLockedUntil: null as Date | null,
  failedAuthCount: 0,
  infoIntervalSeconds: 60,
  requestTimeoutSeconds: 30,
  maxRetries: 2,
  keepaliveTimeoutSeconds: 300,
};

const db = vi.hoisted(() => ({
  enabled: true,
  row: null as Record<string, unknown> | null,
  gate: null as Promise<void> | null,
  isEnabled: vi.fn(),
  getDepotSystem: vi.fn(),
  getByPresystemId: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  clearVdv463SettingCache: vi.fn(),
  isVdv463Enabled: db.isEnabled,
  getDepotSystem: db.getDepotSystem,
  getDepotSystemByPresystemId: db.getByPresystemId,
  recordDepotSystemAuthFailure: vi.fn(() => Promise.resolve(false)),
  recordDepotSystemConnected: vi.fn(() => Promise.resolve()),
  recordDepotSystemBoot: vi.fn(() => Promise.resolve()),
  recordDepotSystemMessage: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/depot-system-password.js', () => ({
  verifyDepotSystemPassword: vi.fn(async (hash: string | null, password: string) => {
    if (db.gate != null) await db.gate;
    return hash != null && password === 'correct-horse-battery';
  }),
}));

const auditLock = vi.hoisted(() => vi.fn());
vi.mock('../services/depot-system-requests.js', () => ({
  auditDepotSystemAuthLock: auditLock,
}));

const { attachVdv463Server, basicCredentials, pickSubprotocol } =
  await import('../vdv463/server.js');
const { VDV463_ADDRESS_LOCK_FAILURES } = await import('../vdv463/auth-failures.js');

type Handler = (message: string) => void;

interface FakePubSub {
  publish: ReturnType<typeof vi.fn>;
  subscribe: (channel: string, h: Handler) => Promise<{ unsubscribe: () => Promise<void> }>;
  close: () => Promise<void>;
  deliver: (message: unknown) => void;
}

function fakePubSub(subscribeFails = false): FakePubSub {
  const handlers: Handler[] = [];
  return {
    publish: vi.fn(() => Promise.resolve()),
    subscribe: (_channel, h) => {
      if (subscribeFails) return Promise.reject(new Error('redis down'));
      handlers.push(h);
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
    close: () => Promise.resolve(),
    deliver: (message) => {
      for (const h of handlers) h(typeof message === 'string' ? message : JSON.stringify(message));
    },
  };
}

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let server: Server | null = null;
let port = 0;
let handle: ReturnType<typeof attachVdv463Server> | null = null;
let pubsub: FakePubSub;

async function start(opts: { subscribeFails?: boolean } = {}): Promise<void> {
  db.enabled = true;
  db.row = { ...system };
  db.gate = null;
  db.isEnabled.mockImplementation(() => Promise.resolve(db.enabled));
  db.getDepotSystem.mockImplementation(() => Promise.resolve(db.row));
  db.getByPresystemId.mockImplementation((id: string) =>
    Promise.resolve(id === 'depot-1' ? db.row : null),
  );
  auditLock.mockImplementation(() => Promise.resolve());
  server = createServer();
  const s = server;
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  port = (s.address() as AddressInfo).port;
  pubsub = fakePubSub(opts.subscribeFails);
  // No now, timers, failure store or audit hook: the defaults apply.
  handle = attachVdv463Server(s, {
    log,
    pubsub: pubsub as unknown as Parameters<typeof attachVdv463Server>[1]['pubsub'],
    trustProxy: false,
    allowPlain: true,
    readSnapshot: () => Promise.resolve([]),
    applyRequests: () => Promise.resolve(),
  });
}

afterEach(async () => {
  vi.useRealTimers();
  if (handle != null) await handle.close();
  handle = null;
  const s = server;
  if (s != null) await new Promise<void>((resolve) => s.close(() => resolve()));
  server = null;
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function auth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

function connect(
  opts: { password?: string | null; protocol?: string | null } = {},
): Promise<{ status: number; ws?: WebSocket }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    const password = opts.password === undefined ? PASSWORD : opts.password;
    if (password != null) headers['authorization'] = auth('depot-1', password);
    const url = `ws://127.0.0.1:${String(port)}/vdv463`;
    const ws =
      opts.protocol === null
        ? new WebSocket(url, { headers })
        : new WebSocket(url, opts.protocol ?? 'v1.463.vdv.de', { headers });
    ws.on('open', () => {
      resolve({ status: 101, ws });
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
    });
    ws.on('error', () => {
      resolve({ status: 0 });
    });
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)));
}

async function live(): Promise<WebSocket> {
  const { status, ws } = await connect();
  expect(status).toBe(101);
  if (ws == null) throw new Error('no connection');
  return ws;
}

describe('basicCredentials', () => {
  it('reads the user and the password, split at the first colon', () => {
    expect(basicCredentials(auth('depot-1', 'a:b'))).toEqual({ user: 'depot-1', password: 'a:b' });
    expect(basicCredentials(`bAsIc ${Buffer.from('u:p').toString('base64')}  `)).toEqual({
      user: 'u',
      password: 'p',
    });
  });

  it('returns null without a header, for another scheme, no colon or an empty user', () => {
    expect(basicCredentials(undefined)).toBeNull();
    expect(basicCredentials('Bearer abc')).toBeNull();
    expect(basicCredentials('Basic')).toBeNull();
    expect(basicCredentials(`Basic ${Buffer.from('nocolon').toString('base64')}`)).toBeNull();
    expect(basicCredentials(`Basic ${Buffer.from(':pw').toString('base64')}`)).toBeNull();
  });
});

describe('pickSubprotocol', () => {
  it('answers the subprotocol the client offered, or false', () => {
    expect(pickSubprotocol(new Set(['v1.463.vdv.de']))).toBe('v1.463.vdv.de');
    expect(pickSubprotocol(new Set(['ocpp2.1']))).toBe(false);
    expect(pickSubprotocol(new Set())).toBe(false);
  });
});

describe('bus depot interface upgrades with the default dependencies', () => {
  it('signs in, boots through the recheck and lists the live connection', async () => {
    await start();
    const ws = await live();
    expect(handle?.connections().has('dps_1')).toBe(true);
    expect(pubsub.publish).toHaveBeenCalledWith(
      'depot_system_changed',
      expect.stringContaining('"kickExcept"'),
    );
    const frames: unknown[][] = [];
    ws.on('message', (d: Buffer) => frames.push(JSON.parse(d.toString('utf8')) as unknown[]));
    ws.send(
      JSON.stringify([
        1,
        'BMS',
        'depot-1',
        '2026-11-03T10:00:00Z',
        '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f',
        'BootNotification',
        { presystem: 'BMS' },
      ]),
    );
    await vi.waitFor(() => {
      expect(frames.some((f) => f[0] === 2)).toBe(true);
    });
    expect(frames.find((f) => f[0] === 2)?.[6]).toEqual({ status: 'Accepted' });
    expect(db.getDepotSystem).toHaveBeenCalledWith('dps_1');
    ws.close();
  });

  it('closes on the recheck when the stored system is disabled', async () => {
    await start();
    const ws = await live();
    const done = closed(ws);
    db.getDepotSystem.mockResolvedValue({ ...system, isEnabled: false });
    ws.send(
      JSON.stringify([
        1,
        'BMS',
        'depot-1',
        '2026-11-03T10:00:00Z',
        '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f',
        'BootNotification',
        { presystem: 'BMS' },
      ]),
    );
    expect(await done).toBe(4005);
  });

  it('answers 401 without credentials, then 429 past the upgrades per address', async () => {
    await start();
    for (let i = 0; i < 20; i++) {
      expect((await connect({ password: null })).status).toBe(401);
    }
    expect((await connect({ password: null })).status).toBe(429);
    expect(db.getByPresystemId).not.toHaveBeenCalled();
  });

  it('closes a connection that offers no supported subprotocol', async () => {
    await start();
    const { status, ws } = await connect({ protocol: null });
    expect(status).toBe(101);
    if (ws == null) throw new Error('no connection');
    expect(await closed(ws)).toBe(1002);
    expect(handle?.connections().size).toBe(0);
  });

  it('replaces the older connection of the same depot system', async () => {
    await start();
    const first = await live();
    const firstClosed = closed(first);
    const second = await live();
    expect(await firstClosed).toBe(4000);
    expect(handle?.connections().size).toBe(1);
    second.close();
  });

  it('logs a connection it could not announce to the other processes', async () => {
    await start();
    pubsub.publish.mockRejectedValue(new Error('redis down'));
    const ws = await live();
    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ depotSystemId: 'dps_1' }),
        'Depot system connection not announced to the other processes',
      );
    });
    ws.close();
  });

  it('answers 500 when the sign-in read fails', async () => {
    await start();
    db.getByPresystemId.mockRejectedValue(new Error('db down'));
    expect((await connect()).status).toBe(500);
    expect(log.error).toHaveBeenCalledWith(expect.anything(), 'Depot system connection failed');
  });

  it('logs an address lock it could not audit', async () => {
    await start();
    auditLock.mockRejectedValue(new Error('audit down'));
    // The default clock: move the date past each address wait (at most 15 minutes).
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-03T10:00:00Z') });
    for (let i = 0; i < VDV463_ADDRESS_LOCK_FAILURES; i++) {
      expect((await connect({ password: 'wrong' })).status).toBe(401);
      vi.setSystemTime(Date.now() + 20 * 60_000);
    }
    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ depotSystemId: 'dps_1' }),
        'Depot system sign-in lock not audited',
      );
    });
    expect(auditLock).toHaveBeenCalledTimes(1);
  });
});

describe('bus depot interface handshake timeout', () => {
  it('destroys a socket whose sign-in does not finish in time, and answers nothing after', async () => {
    await start();
    let release: () => void = () => {};
    db.gate = new Promise<void>((r) => {
      release = r;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const socket: Socket = connectTcp(port, '127.0.0.1');
    let text = '';
    socket.on('data', (d: Buffer) => {
      text += d.toString('utf8');
    });
    const closedP = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    socket.write(
      'GET /vdv463 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Protocol: v1.463.vdv.de\r\n' +
        `Authorization: ${auth('depot-1', PASSWORD)}\r\n\r\n`,
    );
    // The password check waits on the gate.
    await vi.waitFor(() => {
      expect(db.getByPresystemId).toHaveBeenCalled();
    });
    vi.advanceTimersByTime(10_000);
    await closedP;
    release();
    await flush();
    expect(text).toBe('');
    expect(handle?.connections().size).toBe(0);
  });
});

describe('bus depot interface change channel', () => {
  it('ignores a malformed event, one without an id and one for no live connection', async () => {
    await start();
    const ws = await live();
    pubsub.deliver('not json');
    pubsub.deliver({ id: 42 });
    pubsub.deliver({ id: 'dps_other', close: true });
    await flush();
    expect(handle?.connections().size).toBe(1);
    expect(db.getDepotSystem).not.toHaveBeenCalled();
    ws.close();
  });

  it('keeps its own connection on its own kick and closes on a newer one elsewhere', async () => {
    await start();
    const ws = await live();
    const connection = handle?.connections().get('dps_1');
    pubsub.deliver({ id: 'dps_1', kickExcept: connection?.id });
    expect(handle?.connections().size).toBe(1);
    const done = closed(ws);
    pubsub.deliver({ id: 'dps_1', kickExcept: 'another-connection' });
    expect(await done).toBe(4000);
  });

  it('closes on a close event', async () => {
    await start();
    const ws = await live();
    const done = closed(ws);
    pubsub.deliver({ id: 'dps_1', close: true });
    expect(await done).toBe(4005);
  });

  it('reloads an enabled system and logs a reload read that fails', async () => {
    await start();
    const ws = await live();
    const connection = handle?.connections().get('dps_1');
    if (connection == null) throw new Error('no connection');
    const reload = vi.spyOn(connection, 'reload');
    db.getDepotSystem.mockResolvedValueOnce({ ...system, infoIntervalSeconds: 10 });
    pubsub.deliver({ id: 'dps_1' });
    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalledWith(expect.objectContaining({ infoIntervalSeconds: 10 }));
    });
    db.getDepotSystem.mockRejectedValueOnce(new Error('db down'));
    pubsub.deliver({ id: 'dps_1' });
    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ depotSystemId: 'dps_1' }),
        'Depot system not reloaded',
      );
    });
    expect(handle?.connections().size).toBe(1);
    ws.close();
  });

  it('logs an interface switch it could not read and keeps the connections', async () => {
    await start();
    const ws = await live();
    db.isEnabled.mockRejectedValueOnce(new Error('db down'));
    pubsub.deliver({ all: true });
    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith(
        expect.anything(),
        'Depot interface switch not read, connections recheck it',
      );
    });
    expect(handle?.connections().size).toBe(1);
    ws.close();
  });

  it('logs a change channel it could not subscribe', async () => {
    await start({ subscribeFails: true });
    await vi.waitFor(() => {
      expect(log.error).toHaveBeenCalledWith(
        expect.anything(),
        'Depot system change channel not subscribed',
      );
    });
  });
});
