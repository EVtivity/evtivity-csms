// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PubSubClient } from '@evtivity/lib';

function makeMockPubSub(): PubSubClient {
  return {
    publish: async () => {},
    subscribe: async () => ({ unsubscribe: async () => {} }),
    close: async () => {},
  };
}

describe('pubsub', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe('getPubSub before initialization', () => {
    it('returns a no-op stub when called before setPubSub', async () => {
      const { getPubSub } = await import('../lib/pubsub.js');
      const stub = getPubSub();
      expect(stub).toBeDefined();
      expect(typeof stub.publish).toBe('function');
    });
  });

  describe('setPubSub', () => {
    it('sets the client so getPubSub returns it', async () => {
      const { setPubSub, getPubSub } = await import('../lib/pubsub.js');
      const client = makeMockPubSub();
      setPubSub(client);
      const result = getPubSub();
      expect(result).toBe(client);
    });

    it('overwrites a previously set client', async () => {
      const { setPubSub, getPubSub } = await import('../lib/pubsub.js');
      const client1 = makeMockPubSub();
      const client2 = makeMockPubSub();
      setPubSub(client1);
      setPubSub(client2);
      expect(getPubSub()).toBe(client2);
    });
  });

  describe('getPubSub', () => {
    it('returns the exact same reference that was set', async () => {
      const { setPubSub, getPubSub } = await import('../lib/pubsub.js');
      const client = makeMockPubSub();
      setPubSub(client);
      expect(getPubSub()).toBe(client);
      expect(getPubSub()).toBe(client);
    });
  });
});
