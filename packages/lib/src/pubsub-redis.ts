// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Redis } from 'ioredis';
import type { PubSubClient, Subscription } from './pubsub.js';

export class RedisPubSubClient implements PubSubClient {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly handlers = new Map<string, Set<(payload: string) => void>>();

  constructor(url: string) {
    this.publisher = new Redis(url, { lazyConnect: true });
    this.subscriber = new Redis(url, { lazyConnect: true });

    this.subscriber.on('message', (channel: string, message: string) => {
      const channelHandlers = this.handlers.get(channel);
      if (channelHandlers == null) return;
      for (const handler of channelHandlers) {
        handler(message);
      }
    });
  }

  async publish(channel: string, payload: string): Promise<void> {
    if (this.publisher.status === 'wait') {
      await this.publisher.connect();
    }
    await this.publisher.publish(channel, payload);
  }

  async subscribe(channel: string, handler: (payload: string) => void): Promise<Subscription> {
    if (this.subscriber.status === 'wait') {
      await this.subscriber.connect();
    }

    let channelHandlers = this.handlers.get(channel);
    if (channelHandlers == null) {
      channelHandlers = new Set();
      this.handlers.set(channel, channelHandlers);
      await this.subscriber.subscribe(channel);
    }

    channelHandlers.add(handler);

    return {
      unsubscribe: async () => {
        channelHandlers.delete(handler);
        if (channelHandlers.size === 0) {
          this.handlers.delete(channel);
          await this.subscriber.unsubscribe(channel);
        }
      },
    };
  }

  async ping(): Promise<boolean> {
    try {
      if (this.publisher.status === 'wait') {
        await this.publisher.connect();
      }
      await this.publisher.ping();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.subscriber.quit();
    await this.publisher.quit();
  }
}
