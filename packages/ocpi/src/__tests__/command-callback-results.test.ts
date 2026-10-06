// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PubSubClient } from '@evtivity/lib';

const { safeFetchMock, publishOcppCommandMock, getOutboundTokenMock, partnerRows } = vi.hoisted(
  () => ({
    safeFetchMock: vi.fn(),
    publishOcppCommandMock: vi.fn(),
    getOutboundTokenMock: vi.fn(),
    partnerRows: [] as { allowPrivateNetwork: boolean }[],
  }),
);

vi.mock('@evtivity/database', async (importOriginal) => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(partnerRows).then(resolve);
  return {
    ...(await importOriginal<typeof import('@evtivity/database')>()),
    db: { select: vi.fn(() => chain) },
  };
});
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  safeFetch: safeFetchMock,
  publishOcppCommand: publishOcppCommandMock,
}));
vi.mock('../lib/outbound-token.js', () => ({ getOutboundToken: getOutboundTokenMock }));

const { OcpiCommandCallbackService, getCommandCallbackService, initCommandCallbackService } =
  await import('../services/command-callback.service.js');

type Handler = (payload: string) => void;

function makePubsub(): { pubsub: PubSubClient; handlers: Handler[]; unsubscribe: () => void } {
  const handlers: Handler[] = [];
  const unsubscribe = vi.fn().mockResolvedValue(undefined);
  const pubsub: PubSubClient = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((_channel: string, handler: Handler) => {
      handlers.push(handler);
      return Promise.resolve({ unsubscribe });
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { pubsub, handlers, unsubscribe };
}

function postedBody(): unknown {
  const init = safeFetchMock.mock.calls[0]?.[1] as { body: string } | undefined;
  if (init == null) throw new Error('no callback posted');
  return JSON.parse(init.body);
}

type CommandType =
  | 'START_SESSION'
  | 'STOP_SESSION'
  | 'RESERVE_NOW'
  | 'CANCEL_RESERVATION'
  | 'UNLOCK_CONNECTOR';

async function resultFor(
  commandType: CommandType,
  result: Record<string, unknown>,
): Promise<unknown> {
  const { pubsub, handlers } = makePubsub();
  const service = new OcpiCommandCallbackService(pubsub);
  await service.start();
  service.registerCommand('cmd-1', 'https://emsp.example.com/cb/1', 'opr_1', commandType);
  handlers[0]?.(JSON.stringify({ commandId: 'cmd-1', ...result }));
  await service.stop();
  return postedBody();
}

beforeEach(() => {
  safeFetchMock.mockReset();
  safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
  publishOcppCommandMock.mockReset();
  publishOcppCommandMock.mockResolvedValue(undefined);
  getOutboundTokenMock.mockReset();
  getOutboundTokenMock.mockResolvedValue('token-b');
  partnerRows.length = 0;
});

describe('OCPP to OCPI command result mapping', () => {
  it.each([
    ['START_SESSION', 'Accepted', 'ACCEPTED'],
    ['START_SESSION', 'Rejected', 'REJECTED'],
    ['STOP_SESSION', 'Accepted', 'ACCEPTED'],
    ['STOP_SESSION', 'Rejected', 'REJECTED'],
    ['RESERVE_NOW', 'Accepted', 'ACCEPTED'],
    ['RESERVE_NOW', 'Occupied', 'EVSE_OCCUPIED'],
    ['RESERVE_NOW', 'Faulted', 'EVSE_INOPERATIVE'],
    ['RESERVE_NOW', 'Rejected', 'REJECTED'],
    ['RESERVE_NOW', 'Unavailable', 'REJECTED'],
    ['CANCEL_RESERVATION', 'Accepted', 'CANCELED_RESERVATION'],
    ['CANCEL_RESERVATION', 'Rejected', 'UNKNOWN_RESERVATION'],
    ['CANCEL_RESERVATION', 'Other', 'REJECTED'],
    ['UNLOCK_CONNECTOR', 'Unlocked', 'ACCEPTED'],
    ['UNLOCK_CONNECTOR', 'UnlockFailed', 'FAILED'],
    ['UNLOCK_CONNECTOR', 'OngoingAuthorizedTransaction', 'REJECTED'],
  ] as const)('%s with OCPP status %s posts %s', async (type, status, expected) => {
    expect(await resultFor(type, { response: { status } })).toEqual({ result: expected });
  });

  it('posts FAILED when the OCPP command errored', async () => {
    expect(await resultFor('START_SESSION', { error: 'Station offline' })).toEqual({
      result: 'FAILED',
    });
  });

  it('posts FAILED when the result has no response', async () => {
    expect(await resultFor('STOP_SESSION', {})).toEqual({ result: 'FAILED' });
  });

  it('treats a response without a status as a rejection', async () => {
    expect(await resultFor('START_SESSION', { response: {} })).toEqual({ result: 'REJECTED' });
  });
});

describe('callback POST', () => {
  it('sends the OCPI headers with the base64 outbound token', async () => {
    await resultFor('START_SESSION', { response: { status: 'Accepted' } });

    const init = safeFetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: `Token ${Buffer.from('token-b').toString('base64')}`,
    });
    expect(init.headers['OCPI-from-country-code']).toEqual(expect.any(String));
    expect(init.headers['OCPI-from-party-id']).toEqual(expect.any(String));
    expect(getOutboundTokenMock).toHaveBeenCalledWith('opr_1');
  });

  it('defaults to public addresses when the partner row is gone', async () => {
    await resultFor('START_SESSION', { response: { status: 'Accepted' } });
    expect(safeFetchMock).toHaveBeenCalledWith(
      'https://emsp.example.com/cb/1',
      expect.objectContaining({ allowPrivateNetworks: false }),
    );
  });

  it('does not post when no outbound token is stored', async () => {
    getOutboundTokenMock.mockResolvedValue(null);
    const { pubsub, handlers } = makePubsub();
    const service = new OcpiCommandCallbackService(pubsub);
    await service.start();
    service.registerCommand('cmd-1', 'https://emsp.example.com/cb/1', 'opr_1', 'START_SESSION');
    handlers[0]?.(JSON.stringify({ commandId: 'cmd-1', response: { status: 'Accepted' } }));
    await service.stop();

    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('survives a rejected or failing partner callback', async () => {
    safeFetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(resultFor('START_SESSION', { response: { status: 'Accepted' } })).resolves.toEqual(
      { result: 'ACCEPTED' },
    );

    safeFetchMock.mockReset();
    safeFetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { pubsub, handlers } = makePubsub();
    const service = new OcpiCommandCallbackService(pubsub);
    await service.start();
    service.registerCommand('cmd-2', 'https://emsp.example.com/cb/2', 'opr_1', 'STOP_SESSION');
    handlers[0]?.(JSON.stringify({ commandId: 'cmd-2', response: { status: 'Accepted' } }));
    await expect(service.stop()).resolves.toBeUndefined();
    expect(safeFetchMock).toHaveBeenCalledOnce();
  });

  it('ignores invalid JSON and results for commands it did not register', async () => {
    const { pubsub, handlers } = makePubsub();
    const service = new OcpiCommandCallbackService(pubsub);
    await service.start();
    service.registerCommand('cmd-1', 'https://emsp.example.com/cb/1', 'opr_1', 'START_SESSION');
    handlers[0]?.('{oops');
    handlers[0]?.(JSON.stringify({ commandId: 'someone-else', response: { status: 'Accepted' } }));
    await service.stop();

    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('posts a result only once per command', async () => {
    const { pubsub, handlers } = makePubsub();
    const service = new OcpiCommandCallbackService(pubsub);
    await service.start();
    service.registerCommand('cmd-1', 'https://emsp.example.com/cb/1', 'opr_1', 'START_SESSION');
    const payload = JSON.stringify({ commandId: 'cmd-1', response: { status: 'Accepted' } });
    handlers[0]?.(payload);
    handlers[0]?.(payload);
    await service.stop();

    expect(safeFetchMock).toHaveBeenCalledOnce();
  });
});

describe('command lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates a UUID command id', () => {
    const service = new OcpiCommandCallbackService(makePubsub().pubsub);
    expect(service.generateCommandId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('publishes the OCPP command through publishOcppCommand', async () => {
    const { pubsub } = makePubsub();
    const service = new OcpiCommandCallbackService(pubsub);
    await service.dispatchOcppCommand('cmd-1', 'CS-1', 'RequestStartTransaction', { evseId: 1 });

    expect(publishOcppCommandMock).toHaveBeenCalledWith(pubsub, {
      commandId: 'cmd-1',
      stationId: 'CS-1',
      action: 'RequestStartTransaction',
      payload: { evseId: 1 },
    });
  });

  it('posts TIMEOUT for a command with no result after 30 seconds', async () => {
    vi.useFakeTimers();
    const { pubsub, unsubscribe } = makePubsub();
    const service = new OcpiCommandCallbackService(pubsub);
    await service.start();
    service.registerCommand('cmd-1', 'https://emsp.example.com/cb/1', 'opr_1', 'RESERVE_NOW');

    // The 10 s sweep at 10 and 20 s keeps it; the one at 40 s is past the 30 s limit.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(safeFetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);

    vi.useRealTimers();
    await service.stop();

    expect(safeFetchMock).toHaveBeenCalledOnce();
    expect(postedBody()).toEqual({ result: 'TIMEOUT' });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('stop() before start() is a no-op', async () => {
    const { pubsub, unsubscribe } = makePubsub();
    const service = new OcpiCommandCallbackService(pubsub);
    await service.stop();
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});

describe('singleton', () => {
  it('throws before initCommandCallbackService runs', () => {
    expect(() => getCommandCallbackService()).toThrow('Command callback service not initialized');
  });

  it('returns the instance created by initCommandCallbackService', () => {
    const service = initCommandCallbackService(makePubsub().pubsub);
    expect(getCommandCallbackService()).toBe(service);
  });
});
