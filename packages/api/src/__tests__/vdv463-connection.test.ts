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
  isEnabled: true,
  infoIntervalSeconds: 60,
  requestTimeoutSeconds: 30,
  maxRetries: 2,
  keepaliveTimeoutSeconds: 300,
} as unknown as DepotSystem;

class FakeWs extends EventEmitter {
  sent: string[] = [];
  closedWith: number | null = null;
  send(text: string): void {
    this.sent.push(text);
  }
  close(code: number): void {
    this.closedWith = code;
    this.emit('close');
  }
  ping(): void {}
  terminate(): void {}
}

function frame(id: string, action: string, payload: unknown): string {
  return JSON.stringify([1, 'BMS', 'depot-1', '2026-11-03T10:00:00Z', id, action, payload]);
}

const BOOT_ID = '11111111-1111-4111-8111-111111111111';
const LIST_ID = '22222222-2222-4222-8222-222222222222';

function setup(
  recheck: ConnectionDeps['recheck'],
  apply: ConnectionDeps['applyRequests'] = () => Promise.resolve(),
): {
  ws: FakeWs;
  connection: Vdv463Connection;
  applyRequests: ReturnType<typeof vi.fn>;
  readSnapshot: ReturnType<typeof vi.fn>;
} {
  const ws = new FakeWs();
  const applyRequests = vi.fn(apply);
  const readSnapshot = vi.fn(() => Promise.resolve([]));
  const connection = new Vdv463Connection(ws as unknown as WebSocket, system, {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => new Date('2026-11-03T10:00:00Z'),
    readSnapshot,
    applyRequests,
    recordBoot: () => Promise.resolve(),
    recordMessage: () => Promise.resolve(),
    recheck,
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => undefined,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
    onClosed: () => undefined,
  });
  return { ws, connection, applyRequests, readSnapshot };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('bus depot connection kill switch recheck', () => {
  it('applies a list while the interface and the system stay on', async () => {
    const { ws, applyRequests } = setup(() => Promise.resolve(system));
    ws.emit(
      'message',
      Buffer.from(frame(BOOT_ID, 'BootNotification', { presystem: 'BMS' })),
      false,
    );
    await flush();
    ws.emit(
      'message',
      Buffer.from(frame(LIST_ID, 'ProvideChargingRequests', { chargingRequestList: [] })),
      false,
    );
    await flush();
    expect(applyRequests).toHaveBeenCalledTimes(1);
    expect(ws.closedWith).toBeNull();
  });

  it('closes without confirming or applying a list once the switch is off', async () => {
    let allowed: DepotSystem | null = system;
    const { ws, applyRequests } = setup(() => Promise.resolve(allowed));
    ws.emit(
      'message',
      Buffer.from(frame(BOOT_ID, 'BootNotification', { presystem: 'BMS' })),
      false,
    );
    await flush();
    const sentBefore = ws.sent.length;
    allowed = null;
    ws.emit(
      'message',
      Buffer.from(frame(LIST_ID, 'ProvideChargingRequests', { chargingRequestList: [] })),
      false,
    );
    await flush();
    expect(applyRequests).not.toHaveBeenCalled();
    expect(ws.closedWith).toBe(4005);
    expect(ws.sent.slice(sentBefore).some((t) => t.includes(LIST_ID))).toBe(false);
  });

  it('sends no charging information once the system is disabled', async () => {
    let calls = 0;
    // The boot is allowed; the system is disabled before its first information.
    const { ws, readSnapshot } = setup(() => Promise.resolve(calls++ === 0 ? system : null));
    ws.emit(
      'message',
      Buffer.from(frame(BOOT_ID, 'BootNotification', { presystem: 'BMS' })),
      false,
    );
    await flush();
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(ws.closedWith).toBe(4005);
  });

  it('applies nothing when the recheck read fails (fails closed)', async () => {
    let fail = false;
    const { ws, applyRequests } = setup(() =>
      fail ? Promise.reject(new Error('db down')) : Promise.resolve(system),
    );
    ws.emit(
      'message',
      Buffer.from(frame(BOOT_ID, 'BootNotification', { presystem: 'BMS' })),
      false,
    );
    await flush();
    fail = true;
    ws.emit(
      'message',
      Buffer.from(frame(LIST_ID, 'ProvideChargingRequests', { chargingRequestList: [] })),
      false,
    );
    await flush();
    expect(applyRequests).not.toHaveBeenCalled();
  });

  it('keeps at most one list waiting while another applies: the newest replaces it', async () => {
    let release: () => void = () => {};
    const { ws, applyRequests } = setup(
      () => Promise.resolve(system),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    ws.emit(
      'message',
      Buffer.from(frame(BOOT_ID, 'BootNotification', { presystem: 'BMS' })),
      false,
    );
    await flush();
    const ids = Array.from(
      { length: 10 },
      (_, i) => `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`,
    );
    for (const id of ids) {
      ws.emit(
        'message',
        Buffer.from(
          frame(id, 'ProvideChargingRequests', {
            chargingRequestList: [
              {
                chargingRequestId: id,
                vehicleId: 'V',
                chargingRequestData: { minTargetSoc: 1, maxTargetSoc: 2 },
              },
            ],
          }),
        ),
        false,
      );
    }
    await flush();
    expect(applyRequests).toHaveBeenCalledTimes(1);
    release();
    await flush();
    release();
    await flush();
    // The first list and the newest one: the eight in between were replaced.
    expect(applyRequests).toHaveBeenCalledTimes(2);
    const applied = applyRequests.mock.calls.map(
      (c) => (c[1] as Array<{ chargingRequestId: string }>)[0]?.chargingRequestId,
    );
    expect(applied).toEqual([ids[0], ids[9]]);
    // Every list is confirmed once.
    for (const id of ids) {
      expect(
        ws.sent.filter((t) => t.includes(id) && t.startsWith('[2,')),
        id,
      ).toHaveLength(1);
    }
  });

  it('closes when the stored password or type changed even without a change event', async () => {
    const withHash = { ...system, passwordHash: 'hash-1' };
    let row: DepotSystem = withHash;
    const ws = new FakeWs();
    const applyRequests = vi.fn(() => Promise.resolve());
    new Vdv463Connection(ws as unknown as WebSocket, withHash, {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => new Date('2026-11-03T10:00:00Z'),
      readSnapshot: () => Promise.resolve([]),
      applyRequests,
      recordBoot: () => Promise.resolve(),
      recordMessage: () => Promise.resolve(),
      recheck: () => Promise.resolve(row),
      setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
      onClosed: () => undefined,
    });
    ws.emit(
      'message',
      Buffer.from(frame(BOOT_ID, 'BootNotification', { presystem: 'BMS' })),
      false,
    );
    await flush();
    row = { ...withHash, passwordHash: 'hash-2' };
    ws.emit(
      'message',
      Buffer.from(frame(LIST_ID, 'ProvideChargingRequests', { chargingRequestList: [] })),
      false,
    );
    await flush();
    expect(applyRequests).not.toHaveBeenCalled();
    expect(ws.closedWith).toBe(4005);
  });
});

describe('bus depot connection boot and error frames', () => {
  it('closes a disabled system before its BootNotification is confirmed (AUTH-I4)', async () => {
    const disabled = { ...system, isEnabled: false } as DepotSystem;
    const { ws } = setup(() => Promise.resolve(disabled));
    ws.emit(
      'message',
      Buffer.from(frame(BOOT_ID, 'BootNotification', { presystem: 'BMS' })),
      false,
    );
    await flush();
    expect(ws.closedWith).toBe(4005);
    expect(ws.sent.some((t) => t.includes(BOOT_ID))).toBe(false);
  });

  it('echoes no message id that is not a UUID and no unknown action (OCPP-I3)', async () => {
    const { ws } = setup(() => Promise.resolve(system));
    const longId = 'x'.repeat(10_000);
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify([1, 'BMS', 'depot-1', '2026-11-03T10:00:00Z', longId, '<b>evil</b>', {}]),
      ),
      false,
    );
    await flush();
    const answer = JSON.parse(ws.sent.at(-1) ?? '[]') as unknown[];
    expect(answer[0]).toBe(3);
    expect(answer[4]).not.toBe(longId);
    expect(answer[4]).toMatch(/^[0-9a-f-]{36}$/);
    expect(answer[5]).toBe('Unknown');
    expect(ws.sent.at(-1)?.length ?? 0).toBeLessThan(500);
  });
});
