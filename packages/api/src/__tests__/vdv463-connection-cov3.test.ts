// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DepotSystem } from '@evtivity/database';
import type { WebSocket } from 'ws';
import { Vdv463Connection, type ConnectionDeps } from '../vdv463/connection.js';

const system = {
  id: 'dps_1',
  presystemId: 'depot-1',
  name: 'Depot One',
  systemType: 'BMS',
  passwordHash: 'hash-1',
  isEnabled: true,
  infoIntervalSeconds: 60,
  requestTimeoutSeconds: 30,
  maxRetries: 1,
  keepaliveTimeoutSeconds: 300,
} as unknown as DepotSystem;

class FakeWs extends EventEmitter {
  sent: string[] = [];
  closedWith: number | null = null;
  pings = 0;
  terminated = false;
  closeThrows = false;
  pingThrows = false;
  send(text: string): void {
    this.sent.push(text);
  }
  close(code: number): void {
    if (this.closeThrows) throw new Error('close failed');
    this.closedWith = code;
    this.emit('close');
  }
  ping(): void {
    if (this.pingThrows) throw new Error('ping failed');
    this.pings++;
  }
  terminate(): void {
    this.terminated = true;
  }
}

const BOOT_ID = '11111111-1111-4111-8111-111111111111';
const LIST_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';

function frame(type: number, id: string, action: string, payload: unknown, presystem = 'depot-1') {
  return Buffer.from(
    JSON.stringify([type, 'BMS', presystem, '2026-11-03T10:00:00Z', id, action, payload]),
  );
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

interface Harness {
  ws: FakeWs;
  connection: Vdv463Connection;
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  timeouts: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  intervals: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  clock: { ms: number };
  onClosed: ReturnType<typeof vi.fn>;
  deps: ConnectionDeps;
  parsed: () => unknown[][];
}

function setup(overrides: Partial<ConnectionDeps> = {}, row: DepotSystem = system): Harness {
  const ws = new FakeWs();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const timeouts: Harness['timeouts'] = [];
  const intervals: Harness['intervals'] = [];
  const clock = { ms: Date.parse('2026-11-03T10:00:00Z') };
  const onClosed = vi.fn();
  const deps: ConnectionDeps = {
    log,
    now: () => new Date(clock.ms),
    readSnapshot: () => Promise.resolve([]),
    applyRequests: () => Promise.resolve(),
    recordBoot: () => Promise.resolve(),
    recordMessage: () => Promise.resolve(),
    recheck: () => Promise.resolve(row),
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms, cleared: false });
      return (timeouts.length - 1) as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (t) => {
      const e = timeouts[t as unknown as number];
      if (e != null) e.cleared = true;
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms, cleared: false });
      return (intervals.length - 1) as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: (t) => {
      const e = intervals[t as unknown as number];
      if (e != null) e.cleared = true;
    },
    onClosed,
    ...overrides,
  };
  const connection = new Vdv463Connection(ws as unknown as WebSocket, row, deps);
  return {
    ws,
    connection,
    log,
    timeouts,
    intervals,
    clock,
    onClosed,
    deps,
    parsed: () => ws.sent.map((t) => JSON.parse(t) as unknown[]),
  };
}

async function boot(h: Harness): Promise<void> {
  h.ws.emit('message', frame(1, BOOT_ID, 'BootNotification', { presystem: 'BMS' }), false);
  await flush();
}

/** The last ProvideChargingInformation request the connection sent. */
function lastInfo(h: Harness): unknown[] | undefined {
  return h
    .parsed()
    .filter((f) => f[0] === 1 && f[5] === 'ProvideChargingInformation')
    .at(-1);
}

describe('bus depot connection framing', () => {
  it('answers a binary frame with an error frame', async () => {
    const h = setup();
    h.ws.emit('message', Buffer.from('x'), true);
    await flush();
    const answer = h.parsed().at(-1);
    expect(answer?.[0]).toBe(3);
    expect(answer?.[5]).toBe('Unknown');
    expect(JSON.stringify(answer)).toContain('Messages are JSON text frames');
  });

  it('answers invalid JSON, an unknown action and an invalid frame with their reasons', async () => {
    const h = setup();
    h.ws.emit('message', 'not json', false);
    h.ws.emit('message', frame(1, BOOT_ID, 'NoSuchAction', {}), false);
    h.ws.emit('message', Buffer.from(JSON.stringify([1, 'BMS'])), false);
    await flush();
    const texts = h.ws.sent.join('\n');
    expect(texts).toContain('The message is not valid JSON');
    expect(texts).toContain('Unknown message action');
    expect(texts).toContain('The message is not a valid VDV 463 frame');
    // The unknown action keeps its UUID message id.
    expect(h.parsed()[1]?.[4]).toBe(BOOT_ID);
  });

  it('never answers an invalid error frame', async () => {
    const h = setup();
    h.ws.emit('message', Buffer.from(JSON.stringify([3, 'BMS', 'depot-1'])), false);
    await flush();
    expect(h.ws.sent).toHaveLength(0);
  });

  it('answers a request of another presystem id, and ignores its confirmation', async () => {
    const h = setup();
    h.ws.emit(
      'message',
      frame(1, BOOT_ID, 'BootNotification', { presystem: 'BMS' }, 'other'),
      false,
    );
    h.ws.emit('message', frame(2, OTHER_ID, 'ProvideChargingInformation', {}, 'other'), false);
    await flush();
    expect(h.ws.sent).toHaveLength(1);
    expect(h.ws.sent[0]).toContain('PresystemId does not match the signed-in depot system');
  });

  it('refuses a ProvideChargingInformation request from the depot system', async () => {
    const h = setup();
    h.ws.emit('message', frame(1, BOOT_ID, 'ProvideChargingInformation', {}), false);
    await flush();
    expect(h.ws.sent[0]).toContain('Only the charging management system sends this request');
  });

  it('answers a payload that fails its schema', async () => {
    const h = setup();
    h.ws.emit('message', frame(1, BOOT_ID, 'BootNotification', { wrong: true }), false);
    await flush();
    const answer = h.parsed()[0];
    expect(answer?.[0]).toBe(3);
    expect(JSON.stringify(answer)).toContain('Invalid payload');
  });

  it('asks for a BootNotification before a request list', async () => {
    const h = setup();
    h.ws.emit(
      'message',
      frame(1, LIST_ID, 'ProvideChargingRequests', { chargingRequestList: [] }),
      false,
    );
    await flush();
    expect(h.ws.sent[0]).toContain('Send a BootNotification first');
  });

  it('logs a message time that could not be stored', async () => {
    const h = setup({ recordMessage: () => Promise.reject(new Error('db')) });
    h.ws.emit('message', 'not json', false);
    await flush();
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ depotSystemId: 'dps_1' }),
      'Depot system message time not stored',
    );
  });

  it('closes a connection over the message rate', async () => {
    const h = setup();
    for (let i = 0; i < 61; i++) h.ws.emit('message', 'not json', false);
    await flush();
    expect(h.ws.closedWith).toBe(4004);
    // The 61st message is not answered.
    expect(h.ws.sent).toHaveLength(60);
  });

  it('logs a socket error', () => {
    const h = setup();
    h.ws.emit('error', new Error('boom'));
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ depotSystemId: 'dps_1' }),
      'Depot system connection error',
    );
  });
});

describe('bus depot connection boot', () => {
  it('rejects a BootNotification of another system type and closes', async () => {
    const h = setup();
    h.ws.emit('message', frame(1, BOOT_ID, 'BootNotification', { presystem: 'ITCS' }), false);
    await flush();
    const answer = h.parsed()[0];
    expect(answer?.[0]).toBe(2);
    expect(answer?.[6]).toEqual({ status: 'Rejected' });
    expect(h.ws.closedWith).toBe(4001);
    expect(h.connection.isBooted).toBe(false);
  });

  it('accepts the boot, starts the info timer and sends the first charging information', async () => {
    const recordBoot = vi.fn(() => Promise.reject(new Error('db')));
    const h = setup({ recordBoot });
    await boot(h);
    expect(h.parsed()[0]?.[6]).toEqual({ status: 'Accepted' });
    expect(h.connection.isBooted).toBe(true);
    expect(h.connection.systemId).toBe('dps_1');
    expect(recordBoot).toHaveBeenCalledWith('dps_1');
    expect(h.log.warn).toHaveBeenCalledWith(expect.anything(), 'Depot system boot time not stored');
    // The ping timer and the info timer at the system's interval.
    expect(h.intervals.map((i) => i.ms)).toEqual([30_000, 60_000]);
    expect(lastInfo(h)?.[6]).toEqual({ depotInfoList: [] });
  });

  it('logs a recheck that fails before the boot and answers nothing', async () => {
    const h = setup({ recheck: () => Promise.reject(new Error('db')) });
    await boot(h);
    expect(h.ws.sent).toHaveLength(0);
    expect(h.log.error).toHaveBeenCalledWith(expect.anything(), 'Depot system request failed');
  });

  it('closes on a changed system type at the recheck', async () => {
    const h = setup({ recheck: () => Promise.resolve({ ...system, systemType: 'ITCS' }) });
    await boot(h);
    expect(h.ws.closedWith).toBe(4005);
    expect(h.ws.sent).toHaveLength(0);
  });

  it('restarts the info timer with the new interval on a reload', async () => {
    const h = setup();
    h.connection.reload({ ...system, infoIntervalSeconds: 10 });
    // Not booted: no info timer yet.
    expect(h.intervals).toHaveLength(1);
    await boot(h);
    h.connection.reload({ ...system, infoIntervalSeconds: 10 });
    expect(h.intervals.at(-2)?.cleared).toBe(true);
    expect(h.intervals.at(-1)?.ms).toBe(10_000);
  });
});

describe('bus depot connection request lists', () => {
  it('confirms a resent list again and applies it once', async () => {
    const applyRequests = vi.fn(() => Promise.resolve());
    const h = setup({ applyRequests });
    await boot(h);
    const list = frame(1, LIST_ID, 'ProvideChargingRequests', { chargingRequestList: [] });
    h.ws.emit('message', list, false);
    await flush();
    h.ws.emit('message', list, false);
    await flush();
    expect(applyRequests).toHaveBeenCalledTimes(1);
    expect(h.parsed().filter((f) => f[0] === 2 && f[4] === LIST_ID)).toHaveLength(2);
  });

  it('logs a recheck failure and applies nothing', async () => {
    let fail = false;
    const applyRequests = vi.fn(() => Promise.resolve());
    const h = setup({
      applyRequests,
      recheck: () => (fail ? Promise.reject(new Error('db')) : Promise.resolve(system)),
    });
    await boot(h);
    fail = true;
    h.ws.emit(
      'message',
      frame(1, LIST_ID, 'ProvideChargingRequests', { chargingRequestList: [] }),
      false,
    );
    await flush();
    expect(applyRequests).not.toHaveBeenCalled();
    expect(h.log.error).toHaveBeenCalledWith(
      expect.anything(),
      'Depot system recheck failed, the list is not applied',
    );
    expect(h.ws.sent.some((t) => t.includes(LIST_ID))).toBe(false);
  });
});

describe('bus depot connection charging information', () => {
  it('clears the wait on its confirmation and sends the next one', async () => {
    const h = setup();
    await boot(h);
    const info = lastInfo(h);
    const id = info?.[4] as string;
    expect(h.timeouts).toHaveLength(1);
    expect(h.timeouts[0]?.ms).toBe(30_000);
    // Another one is not sent while it waits.
    await h.connection.sendInformation();
    expect(h.parsed().filter((f) => f[5] === 'ProvideChargingInformation')).toHaveLength(1);
    h.ws.emit('message', frame(2, id, 'ProvideChargingInformation', {}), false);
    await flush();
    expect(h.timeouts[0]?.cleared).toBe(true);
    await h.connection.sendInformation();
    expect(h.parsed().filter((f) => f[5] === 'ProvideChargingInformation')).toHaveLength(2);
  });

  it('logs a confirmation it does not wait for and one with an unexpected payload', async () => {
    const h = setup();
    await boot(h);
    h.ws.emit('message', frame(2, OTHER_ID, 'ProvideChargingInformation', {}), false);
    await flush();
    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: OTHER_ID }),
      'Unexpected depot system confirmation',
    );
    const id = lastInfo(h)?.[4] as string;
    h.ws.emit('message', frame(2, id, 'ProvideChargingInformation', { extra: 1 }), false);
    await flush();
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ProvideChargingInformation' }),
      'Depot system confirmation with an unexpected payload',
    );
    expect(h.timeouts[0]?.cleared).toBe(true);
  });

  it('takes an error frame as the answer to the request it names', async () => {
    const h = setup();
    await boot(h);
    h.ws.emit(
      'message',
      frame(3, OTHER_ID, 'ProvideChargingInformation', { errorMessage: 'x' }),
      false,
    );
    await flush();
    expect(h.timeouts[0]?.cleared).toBe(false);
    const id = lastInfo(h)?.[4] as string;
    h.ws.emit('message', frame(3, id, 'ProvideChargingInformation', 'cannot read it'), false);
    await flush();
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'cannot read it' }),
      'Depot system answered with an error',
    );
    expect(h.timeouts[0]?.cleared).toBe(true);
    // No answer is sent to an error frame.
    expect(h.parsed().filter((f) => f[0] === 3)).toHaveLength(0);
  });

  it('resends after the wait, then closes after the retries', async () => {
    const h = setup();
    await boot(h);
    const info = h.ws.sent.find((t) => t.includes('ProvideChargingInformation'));
    h.timeouts[0]?.fn();
    expect(h.ws.sent.filter((t) => t === info)).toHaveLength(2);
    expect(h.timeouts).toHaveLength(2);
    expect(h.ws.closedWith).toBeNull();
    h.timeouts[1]?.fn();
    expect(h.ws.closedWith).toBe(4003);
    expect(h.onClosed).toHaveBeenCalledWith(h.connection);
  });

  it('ignores the wait of a request already confirmed', async () => {
    const h = setup();
    await boot(h);
    const id = lastInfo(h)?.[4] as string;
    h.ws.emit('message', frame(2, id, 'ProvideChargingInformation', {}), false);
    await flush();
    const sent = h.ws.sent.length;
    h.timeouts[0]?.fn();
    expect(h.ws.sent).toHaveLength(sent);
    expect(h.ws.closedWith).toBeNull();
  });

  it('logs a snapshot read that fails and sends nothing', async () => {
    const h = setup({ readSnapshot: () => Promise.reject(new Error('db')) });
    await boot(h);
    expect(lastInfo(h)).toBeUndefined();
    expect(h.log.error).toHaveBeenCalledWith(
      expect.anything(),
      'Depot system charging information not built, this cycle is skipped',
    );
  });

  it('sends nothing when the connection closed during the snapshot read', async () => {
    let release: () => void = () => {};
    const h = setup({
      readSnapshot: () =>
        new Promise((resolve) => {
          release = () => {
            resolve([]);
          };
        }),
    });
    await boot(h);
    h.connection.close(1000, 'bye');
    release();
    await flush();
    expect(lastInfo(h)).toBeUndefined();
  });

  it('sends the information from the info timer', async () => {
    const h = setup();
    await boot(h);
    const id = lastInfo(h)?.[4] as string;
    h.ws.emit('message', frame(2, id, 'ProvideChargingInformation', {}), false);
    await flush();
    h.intervals[1]?.fn();
    await flush();
    expect(h.parsed().filter((f) => f[5] === 'ProvideChargingInformation')).toHaveLength(2);
  });
});

describe('bus depot connection keepalive and close', () => {
  it('pings while the system is active, and keeps it alive on ping and pong', () => {
    const h = setup();
    h.clock.ms += 200_000;
    h.ws.emit('ping');
    h.clock.ms += 200_000;
    h.ws.emit('pong');
    h.clock.ms += 200_000;
    h.intervals[0]?.fn();
    expect(h.ws.pings).toBe(1);
    expect(h.ws.closedWith).toBeNull();
  });

  it('logs a ping that fails', () => {
    const h = setup();
    h.ws.pingThrows = true;
    h.intervals[0]?.fn();
    expect(h.log.warn).toHaveBeenCalledWith(expect.anything(), 'Depot system ping failed');
  });

  it('closes a silent connection after the keepalive time', () => {
    const h = setup();
    h.clock.ms += 300_001;
    h.intervals[0]?.fn();
    expect(h.ws.closedWith).toBe(4002);
    expect(h.ws.pings).toBe(0);
    expect(h.intervals[0]?.cleared).toBe(true);
  });

  it('terminates the socket when the close throws, once', () => {
    const h = setup();
    h.ws.closeThrows = true;
    h.connection.close(4005, 'off');
    h.connection.close(4005, 'off');
    expect(h.ws.terminated).toBe(true);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.anything(),
      'Depot system connection close failed',
    );
    expect(h.onClosed).toHaveBeenCalledTimes(1);
  });

  it('sends nothing and clears the wait after the close', async () => {
    const h = setup();
    await boot(h);
    const sent = h.ws.sent.length;
    h.ws.emit('close');
    expect(h.timeouts[0]?.cleared).toBe(true);
    expect(h.intervals.every((i) => i.cleared)).toBe(true);
    await h.connection.sendInformation();
    h.ws.emit(
      'message',
      frame(1, LIST_ID, 'ProvideChargingRequests', { chargingRequestList: [] }),
      false,
    );
    await flush();
    expect(h.ws.sent).toHaveLength(sent);
  });
});
