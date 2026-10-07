// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { MessageTimeoutError, type OcppTestServer } from '../cs-server.js';
import {
  waitForChargingState,
  startAndWaitForCharging,
  waitForTransactionEventType,
  waitForTriggerReason,
  drainMessages,
  waitForMatchingMessage,
  startFileServer,
  setVariables,
  collectMessages,
  sleep,
  waitForTransactionEventAfterQueue,
  transactionStartsAtAuthorization,
  noTransactionAtTimeoutStep,
} from '../cs-test-helpers.js';
import { PICS_V2_1 } from '../pics/v2_1.js';

/**
 * A Test System that already received `messages`: waitForMessage hands out the
 * first buffered message of the action and rejects (like a timeout) when none is left.
 */
function fakeServer(
  messages: Array<{ action: string; payload: Record<string, unknown> }>,
  commandReply: Record<string, unknown> = {},
): OcppTestServer & { waits: number[]; commands: Array<[string, Record<string, unknown>]> } {
  const waits: number[] = [];
  const commands: Array<[string, Record<string, unknown>]> = [];
  const waitForMessage = (action: string, timeoutMs: number): Promise<Record<string, unknown>> => {
    waits.push(timeoutMs);
    const idx = messages.findIndex((m) => m.action === action);
    if (idx === -1) return Promise.reject(new MessageTimeoutError(action, timeoutMs));
    const [m] = messages.splice(idx, 1);
    return Promise.resolve(m?.payload ?? {});
  };
  return {
    waits,
    commands,
    waitForMessage,
    async waitForMessageOrNull(action: string, timeoutMs: number) {
      try {
        return await waitForMessage(action, timeoutMs);
      } catch (err) {
        if (err instanceof MessageTimeoutError) return null;
        throw err;
      }
    },
    sendCommand(action: string, payload: Record<string, unknown>) {
      commands.push([action, payload]);
      return Promise.resolve(commandReply);
    },
  } as unknown as OcppTestServer & {
    waits: number[];
    commands: Array<[string, Record<string, unknown>]>;
  };
}

const te = (payload: Record<string, unknown>): { action: string; payload: typeof payload } => ({
  action: 'TransactionEvent',
  payload,
});

describe('TransactionEvent waits', () => {
  it('waitForChargingState skips other states and returns the matching event', async () => {
    const server = fakeServer([
      te({ seqNo: 0, transactionInfo: { chargingState: 'EVConnected' } }),
      te({ seqNo: 1 }),
      te({ seqNo: 2, transactionInfo: { chargingState: 'Charging' } }),
    ]);
    await expect(waitForChargingState(server, 'Charging', 5000)).resolves.toMatchObject({
      seqNo: 2,
    });
  });

  it('waitForChargingState returns null when the state never comes', async () => {
    const server = fakeServer([te({ transactionInfo: { chargingState: 'Idle' } })]);
    await expect(waitForChargingState(server, 'Charging', 5000)).resolves.toBeNull();
  });

  it('startAndWaitForCharging plugs in, starts and waits for Charging', async () => {
    const server = fakeServer([te({ transactionInfo: { chargingState: 'Charging' }, id: 'x' })]);
    const station = {
      plugIn: vi.fn(() => Promise.resolve()),
      startCharging: vi.fn(() => Promise.resolve(undefined)),
    };
    await expect(startAndWaitForCharging({ station, server }, 2, 'TOKEN')).resolves.toMatchObject({
      id: 'x',
    });
    expect(station.plugIn).toHaveBeenCalledWith(2);
    expect(station.startCharging).toHaveBeenCalledWith(2, 'TOKEN');
  });

  it('waitForTransactionEventType matches the eventType', async () => {
    const server = fakeServer([te({ eventType: 'Updated' }), te({ eventType: 'Ended', n: 1 })]);
    await expect(waitForTransactionEventType(server, 'Ended', 5000)).resolves.toEqual({
      eventType: 'Ended',
      n: 1,
    });
    await expect(waitForTransactionEventType(server, 'Ended', 5000)).resolves.toBeNull();
  });

  it('waitForTriggerReason matches the triggerReason', async () => {
    const server = fakeServer([
      te({ triggerReason: 'MeterValuePeriodic' }),
      te({ triggerReason: 'StopAuthorized' }),
    ]);
    await expect(waitForTriggerReason(server, 'StopAuthorized', 5000)).resolves.toEqual({
      triggerReason: 'StopAuthorized',
    });
    await expect(waitForTriggerReason(server, 'Deauthorized', 5000)).resolves.toBeNull();
  });

  it('the waits return null at once for a zero timeout', async () => {
    const server = fakeServer([te({ eventType: 'Ended' })]);
    await expect(waitForTransactionEventType(server, 'Ended', 0)).resolves.toBeNull();
    await expect(waitForChargingState(server, 'Charging', 0)).resolves.toBeNull();
    await expect(waitForTriggerReason(server, 'X', 0)).resolves.toBeNull();
    expect(server.waits).toEqual([]);
  });

  it('waitForTransactionEventAfterQueue skips queued offline events', async () => {
    const server = fakeServer([
      te({ offline: true, seqNo: 0 }),
      te({ offline: true, seqNo: 1 }),
      te({ seqNo: 2 }),
    ]);
    await expect(waitForTransactionEventAfterQueue(server, 5000)).resolves.toEqual({ seqNo: 2 });
  });

  it('waitForTransactionEventAfterQueue rejects when no live event arrives', async () => {
    const server = fakeServer([te({ offline: true })]);
    await expect(waitForTransactionEventAfterQueue(server, 5000)).rejects.toThrow('Timed out');
  });
});

describe('message collection', () => {
  it('drainMessages returns every buffered message of the action, up to 20', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      action: 'StatusNotification',
      payload: { i },
    }));
    const server = fakeServer([...many, { action: 'Heartbeat', payload: {} }]);
    const drained = await drainMessages(server, 'StatusNotification', 10);
    expect(drained).toHaveLength(20);
    expect(drained[0]).toEqual({ i: 0 });
    expect(await drainMessages(server, 'StatusNotification', 10)).toHaveLength(5);
  });

  it('waitForMatchingMessage consumes non-matching messages and returns the match', async () => {
    const server = fakeServer([
      { action: 'NotifyEvent', payload: { id: 1 } },
      { action: 'NotifyEvent', payload: { id: 2 } },
    ]);
    await expect(
      waitForMatchingMessage(server, 'NotifyEvent', (p) => p['id'] === 2, 5000),
    ).resolves.toEqual({ id: 2 });
    await expect(
      waitForMatchingMessage(server, 'NotifyEvent', () => true, 5000),
    ).resolves.toBeNull();
  });

  it('collectMessages collects until the action stops arriving', async () => {
    const server = fakeServer([
      { action: 'MeterValues', payload: { a: 1 } },
      { action: 'MeterValues', payload: { a: 2 } },
    ]);
    expect(await collectMessages(server, 'MeterValues', 50, 1000)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(server.waits.every((w) => w <= 50)).toBe(true);
  });

  it('collectMessages with no time left returns nothing', async () => {
    const server = fakeServer([{ action: 'MeterValues', payload: {} }]);
    expect(await collectMessages(server, 'MeterValues', 50, 0)).toEqual([]);
  });
});

describe('setVariables', () => {
  it('sends SetVariables with EVSE and instance, and lists the results not Accepted', async () => {
    const server = fakeServer([], {
      setVariableResult: [
        { attributeStatus: 'Accepted', component: { name: 'A' }, variable: { name: 'x' } },
        {
          attributeStatus: 'Rejected',
          component: { name: 'TxCtrlr' },
          variable: { name: 'EVConnectionTimeOut' },
        },
        { attributeStatus: 'UnknownVariable' },
      ],
    });
    const failed = await setVariables(server, [
      { component: 'TxCtrlr', variable: 'EVConnectionTimeOut', value: '30' },
      { component: 'EVSE', variable: 'Power', value: '7', evseId: 1, instance: 'Max' },
    ]);
    expect(failed).toEqual([
      'TxCtrlr.EVConnectionTimeOut=Rejected',
      'undefined.undefined=UnknownVariable',
    ]);
    expect(server.commands[0]).toEqual([
      'SetVariables',
      {
        setVariableData: [
          {
            component: { name: 'TxCtrlr' },
            variable: { name: 'EVConnectionTimeOut' },
            attributeValue: '30',
          },
          {
            component: { name: 'EVSE', evse: { id: 1 } },
            variable: { name: 'Power', instance: 'Max' },
            attributeValue: '7',
          },
        ],
      },
    ]);
  });

  it('returns an empty list when the reply has no results', async () => {
    const server = fakeServer([], {});
    expect(await setVariables(server, [{ component: 'C', variable: 'V', value: '1' }])).toEqual([]);
  });
});

describe('startFileServer', () => {
  it('serves the file at its path, counts downloads and answers 404 elsewhere', async () => {
    const content = Buffer.from('firmware-bytes');
    const fs = await startFileServer('/fw.bin', content);
    try {
      expect(fs.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/fw\.bin$/);
      const res = await fetch(fs.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(Buffer.from(await res.arrayBuffer())).toEqual(content);
      expect(fs.downloads()).toBe(1);

      const missing = await fetch(fs.url.replace('/fw.bin', '/other'));
      expect(missing.status).toBe(404);
      const post = await fetch(fs.url, { method: 'POST' });
      expect(post.status).toBe(404);
      expect(fs.downloads()).toBe(1);
    } finally {
      await fs.close();
    }
  });
});

describe('sleep', () => {
  it('resolves after the given time', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const p = sleep(1000).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cable plugin timeout helpers', () => {
  it('transactionStartsAtAuthorization follows PICS C-09.2', () => {
    expect(transactionStartsAtAuthorization()).toBe(PICS_V2_1.items['C-09.2']?.supported === true);
  });

  it('noTransactionAtTimeoutStep passes when no TransactionEvent arrives', async () => {
    const step = await noTransactionAtTimeoutStep(fakeServer([]), 4, 50);
    expect(step).toMatchObject({
      step: 4,
      status: 'passed',
      actual: 'No TransactionEventRequest',
    });
  });

  it('noTransactionAtTimeoutStep fails and lists the events that arrived', async () => {
    const step = await noTransactionAtTimeoutStep(
      fakeServer([
        te({ eventType: 'Started', triggerReason: 'Authorized' }),
        te({ eventType: 'Ended', triggerReason: 'EVConnectTimeout' }),
      ]),
      5,
      50,
    );
    expect(step.status).toBe('failed');
    expect(step.actual).toBe('TransactionEventRequest Started/Authorized, Ended/EVConnectTimeout');
  });
});
