// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { PubSubClient } from '../pubsub.js';
import { awaitPubSubReply } from '../pubsub-reply.js';

type SubscribeFn = (
  channel: string,
  handler: (raw: string) => void,
) => Promise<{ unsubscribe: () => Promise<void> }>;

interface Harness {
  pubsub: PubSubClient;
  deliver: (raw: string) => void;
  unsubscribe: Mock<() => Promise<void>>;
  subscribe: Mock<SubscribeFn>;
}

function makeHarness(): Harness {
  const unsubscribe = vi.fn(async () => {});
  const ref: { handler: ((raw: string) => void) | null } = { handler: null };
  const subscribe = vi.fn<SubscribeFn>(async (_channel, handler) => {
    ref.handler = handler;
    return { unsubscribe };
  });
  const pubsub = { publish: vi.fn(), subscribe, close: vi.fn() } as unknown as PubSubClient;
  return {
    pubsub,
    subscribe,
    unsubscribe,
    deliver: (raw) => {
      ref.handler?.(raw);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('awaitPubSubReply', () => {
  it('sends after subscribing and resolves with the matching reply', async () => {
    const h = makeHarness();
    const send = vi.fn(async () => {
      expect(h.subscribe).toHaveBeenCalledWith('replies', expect.any(Function));
      h.deliver('not json');
      h.deliver(JSON.stringify({ commandId: 'other', value: 1 }));
      h.deliver(JSON.stringify({ commandId: 'cmd-1', value: 2 }));
    });

    const reply = await awaitPubSubReply<{ commandId: string; value: number }>(h.pubsub, {
      replyChannel: 'replies',
      commandId: 'cmd-1',
      timeoutMs: 1000,
      send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(reply).toEqual({ commandId: 'cmd-1', value: 2 });
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('resolves null and unsubscribes when no reply arrives in time', async () => {
    vi.useFakeTimers();
    const h = makeHarness();

    const promise = awaitPubSubReply(h.pubsub, {
      replyChannel: 'replies',
      commandId: 'cmd-2',
      timeoutMs: 500,
      send: async () => {},
    });
    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBeNull();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects and unsubscribes when the send fails', async () => {
    const h = makeHarness();

    await expect(
      awaitPubSubReply(h.pubsub, {
        replyChannel: 'replies',
        commandId: 'cmd-3',
        timeoutMs: 1000,
        send: () => Promise.reject(new Error('redis down')),
      }),
    ).rejects.toThrow('redis down');
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects when the subscription fails, without sending', async () => {
    const h = makeHarness();
    h.subscribe.mockRejectedValueOnce('no redis');
    const send = vi.fn(async () => {});

    await expect(
      awaitPubSubReply(h.pubsub, {
        replyChannel: 'replies',
        commandId: 'cmd-4',
        timeoutMs: 1000,
        send,
      }),
    ).rejects.toThrow('no redis');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing when the timeout passes while subscribing', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const unsubscribe = vi.fn(async () => {});
    h.subscribe.mockImplementationOnce(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
      return { unsubscribe };
    });
    const send = vi.fn(async () => {});

    const promise = awaitPubSubReply(h.pubsub, {
      replyChannel: 'replies',
      commandId: 'cmd-5',
      timeoutMs: 100,
      send,
    });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
