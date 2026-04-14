// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Instance = {
  status: string;
  connect: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => boolean;
};

// vi.hoisted ensures this runs before vi.mock, making it accessible in the factory
const { mockInstances, BaseEmitter } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class BaseEmitter {
    private _listeners: Map<string, Listener[]> = new Map();

    on(event: string, listener: Listener): this {
      const arr = this._listeners.get(event) ?? [];
      arr.push(listener);
      this._listeners.set(event, arr);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      (this._listeners.get(event) ?? []).forEach((l) => l(...args));
      return true;
    }
  }

  return { mockInstances: [] as unknown[], BaseEmitter };
});

vi.mock('ioredis', () => {
  class MockRedis extends BaseEmitter {
    status = 'wait';
    connect = vi.fn().mockResolvedValue(undefined);
    publish = vi.fn().mockResolvedValue(1);
    subscribe = vi.fn().mockResolvedValue(undefined);
    unsubscribe = vi.fn().mockResolvedValue(undefined);
    quit = vi.fn().mockResolvedValue('OK');

    constructor() {
      super();
      mockInstances.push(this);
    }
  }

  return { Redis: MockRedis };
});

describe('RedisPubSubClient', () => {
  let RedisPubSubClientClass: Awaited<ReturnType<typeof importClient>>;

  async function importClient() {
    const { RedisPubSubClient } = await import('../pubsub-redis.js');
    return RedisPubSubClient;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInstances.length = 0;
    RedisPubSubClientClass = await importClient();
  });

  function makeClient() {
    return new RedisPubSubClientClass('redis://localhost:6379');
  }

  function getPublisher() {
    return mockInstances[0] as Instance;
  }

  function getSubscriber() {
    return mockInstances[1] as Instance;
  }

  it('creates two Redis instances on construction', async () => {
    await makeClient();
    expect(mockInstances).toHaveLength(2);
  });

  describe('publish', () => {
    it('connects publisher when status is wait, then publishes', async () => {
      const client = await makeClient();
      const publisher = getPublisher();
      publisher.status = 'wait';
      await client.publish('ch', 'msg');
      expect(publisher.connect).toHaveBeenCalled();
      expect(publisher.publish).toHaveBeenCalledWith('ch', 'msg');
    });

    it('skips connect when publisher is already connected', async () => {
      const client = await makeClient();
      const publisher = getPublisher();
      publisher.status = 'ready';
      await client.publish('ch', 'msg');
      expect(publisher.connect).not.toHaveBeenCalled();
      expect(publisher.publish).toHaveBeenCalledWith('ch', 'msg');
    });
  });

  describe('subscribe', () => {
    it('connects subscriber when status is wait on first subscribe', async () => {
      const client = await makeClient();
      const subscriber = getSubscriber();
      subscriber.status = 'wait';
      await client.subscribe('ch1', vi.fn());
      expect(subscriber.connect).toHaveBeenCalled();
      expect(subscriber.subscribe).toHaveBeenCalledWith('ch1');
    });

    it('skips connect when subscriber is already connected', async () => {
      const client = await makeClient();
      const subscriber = getSubscriber();
      subscriber.status = 'ready';
      await client.subscribe('ch1', vi.fn());
      expect(subscriber.connect).not.toHaveBeenCalled();
    });

    it('only subscribes to Redis channel once for multiple handlers on same channel', async () => {
      const client = await makeClient();
      const subscriber = getSubscriber();
      subscriber.status = 'ready';
      await client.subscribe('ch1', vi.fn());
      await client.subscribe('ch1', vi.fn());
      expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    });

    it('delivers message to all handlers on the channel', async () => {
      const client = await makeClient();
      const subscriber = getSubscriber();
      subscriber.status = 'ready';
      const h1 = vi.fn();
      const h2 = vi.fn();
      await client.subscribe('ch1', h1);
      await client.subscribe('ch1', h2);

      subscriber.emit('message', 'ch1', 'payload');

      expect(h1).toHaveBeenCalledWith('payload');
      expect(h2).toHaveBeenCalledWith('payload');
    });

    it('ignores messages for unregistered channels', async () => {
      const client = await makeClient();
      const subscriber = getSubscriber();
      subscriber.status = 'ready';
      const h1 = vi.fn();
      await client.subscribe('ch1', h1);

      subscriber.emit('message', 'other-channel', 'payload');

      expect(h1).not.toHaveBeenCalled();
    });

    it('ignores message events for channels with no handlers map entry', async () => {
      await makeClient();
      const subscriber = getSubscriber();
      // No subscribe call - emitting a message should not throw
      expect(() => {
        subscriber.emit('message', 'nonexistent', 'data');
      }).not.toThrow();
    });

    it('returns subscription with unsubscribe that removes the handler', async () => {
      const client = await makeClient();
      const subscriber = getSubscriber();
      subscriber.status = 'ready';
      const h1 = vi.fn();
      const h2 = vi.fn();
      const sub1 = await client.subscribe('ch1', h1);
      await client.subscribe('ch1', h2);

      await sub1.unsubscribe();
      subscriber.emit('message', 'ch1', 'msg');

      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledWith('msg');
    });

    it('unsubscribes from Redis when last handler removed', async () => {
      const client = await makeClient();
      const subscriber = getSubscriber();
      subscriber.status = 'ready';
      const h1 = vi.fn();
      const sub = await client.subscribe('ch1', h1);

      await sub.unsubscribe();

      expect(subscriber.unsubscribe).toHaveBeenCalledWith('ch1');
    });

    it('does not unsubscribe from Redis when other handlers remain', async () => {
      const client = await makeClient();
      const subscriber = getSubscriber();
      subscriber.status = 'ready';
      const h1 = vi.fn();
      const h2 = vi.fn();
      const sub1 = await client.subscribe('ch1', h1);
      await client.subscribe('ch1', h2);

      await sub1.unsubscribe();

      expect(subscriber.unsubscribe).not.toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('quits both publisher and subscriber', async () => {
      const client = await makeClient();
      await client.close();
      expect(getPublisher().quit).toHaveBeenCalled();
      expect(getSubscriber().quit).toHaveBeenCalled();
    });
  });
});
