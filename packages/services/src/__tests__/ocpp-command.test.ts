// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface MockSubscription {
  unsubscribe: () => Promise<void>;
}
type SubscribeFn = (channel: string, cb: (raw: string) => void) => Promise<MockSubscription>;

const { publishMock, subscribeMock } = vi.hoisted(() => ({
  publishMock: vi.fn(async (_channel: string, _payload: string): Promise<void> => undefined),
  subscribeMock: vi.fn<SubscribeFn>(),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: publishMock, subscribe: subscribeMock }),
}));

import { sendOcppCommandAndWait } from '../ocpp-command.js';

const unsubscribeMock = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  unsubscribeMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sendOcppCommandAndWait', () => {
  it('publishes the command with the resolved commandId and resolves on a matching result', async () => {
    const ref: { handler: ((raw: string) => void) | null } = { handler: null };
    subscribeMock.mockImplementation(async (_channel: string, cb: (raw: string) => void) => {
      ref.handler = cb;
      return { unsubscribe: unsubscribeMock };
    });

    const promise = sendOcppCommandAndWait('CS-1', 'Reset', { type: 'Hard' }, 'ocpp2.1');

    // Wait a tick for subscribe().then() to register the subscription + publish.
    await vi.waitFor(() => {
      expect(publishMock).toHaveBeenCalledTimes(1);
    });

    const [channel, raw] = publishMock.mock.calls[0] as [string, string];
    expect(channel).toBe('ocpp_commands');
    const sent = JSON.parse(raw) as Record<string, unknown>;
    expect(sent).toMatchObject({
      stationId: 'CS-1',
      action: 'Reset',
      payload: { type: 'Hard' },
      version: 'ocpp2.1',
    });
    expect(typeof sent['commandId']).toBe('string');

    // Deliver the matching result.
    ref.handler?.(
      JSON.stringify({ commandId: sent['commandId'], response: { status: 'Accepted' } }),
    );

    const result = await promise;
    expect(result.response).toEqual({ status: 'Accepted' });
    expect(result.commandId).toBe(sent['commandId']);
    expect(unsubscribeMock).toHaveBeenCalled();
  });

  it('omits version from the published payload when not provided', async () => {
    const ref: { handler: ((raw: string) => void) | null } = { handler: null };
    subscribeMock.mockImplementation(async (_channel: string, cb: (raw: string) => void) => {
      ref.handler = cb;
      return { unsubscribe: unsubscribeMock };
    });

    const promise = sendOcppCommandAndWait('CS-2', 'TriggerMessage', {
      requestedMessage: 'Heartbeat',
    });
    await vi.waitFor(() => {
      expect(publishMock).toHaveBeenCalledTimes(1);
    });
    const raw = (publishMock.mock.calls[0] as [string, string])[1];
    const sent = JSON.parse(raw) as Record<string, unknown>;
    expect('version' in sent).toBe(false);

    ref.handler?.(JSON.stringify({ commandId: sent['commandId'], response: {} }));
    await promise;
  });

  it('ignores results with a non-matching commandId and unparseable JSON', async () => {
    const ref: { handler: ((raw: string) => void) | null } = { handler: null };
    subscribeMock.mockImplementation(async (_channel: string, cb: (raw: string) => void) => {
      ref.handler = cb;
      return { unsubscribe: unsubscribeMock };
    });

    const promise = sendOcppCommandAndWait('CS-3', 'Reset', {});
    await vi.waitFor(() => {
      expect(publishMock).toHaveBeenCalledTimes(1);
    });
    const sent = JSON.parse((publishMock.mock.calls[0] as [string, string])[1]) as {
      commandId: string;
    };

    // Garbage and wrong-id messages must not resolve.
    ref.handler?.('not-json');
    ref.handler?.(JSON.stringify({ commandId: 'some-other-id', response: { status: 'X' } }));
    expect(unsubscribeMock).not.toHaveBeenCalled();

    // The real result resolves it.
    ref.handler?.(JSON.stringify({ commandId: sent.commandId, response: { ok: true } }));
    const result = await promise;
    expect(result.response).toEqual({ ok: true });
  });

  it('resolves with a timeout error when no response arrives within 35s', async () => {
    vi.useFakeTimers();
    subscribeMock.mockImplementation(async () => ({ unsubscribe: unsubscribeMock }));

    const promise = sendOcppCommandAndWait('CS-4', 'Reset', {});
    // Let the subscribe().then() microtask run.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(35_000);

    const result = await promise;
    expect(result.error).toBe('No response within 35s');
    expect(unsubscribeMock).toHaveBeenCalled();
  });

  it('returns an internal-error result when subscribe rejects', async () => {
    subscribeMock.mockRejectedValue(new Error('redis down'));
    const result = await sendOcppCommandAndWait('CS-5', 'Reset', {});
    expect(result.error).toBe('Internal error sending command');
  });

  it('wraps a non-Error subscribe rejection into the internal-error result', async () => {
    subscribeMock.mockRejectedValue('string failure');
    const result = await sendOcppCommandAndWait('CS-6', 'Reset', {});
    expect(result.error).toBe('Internal error sending command');
  });

  it('unsubscribes the already-registered subscription when the publish step throws', async () => {
    // subscribe resolves (subscription gets set), then publish rejects: the
    // catch path must unsubscribe the live subscription.
    subscribeMock.mockResolvedValue({ unsubscribe: unsubscribeMock });
    publishMock.mockRejectedValueOnce(new Error('publish failed'));

    const result = await sendOcppCommandAndWait('CS-7', 'Reset', {});

    expect(result.error).toBe('Internal error sending command');
    expect(unsubscribeMock).toHaveBeenCalled();
  });
});
