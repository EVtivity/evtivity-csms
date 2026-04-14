// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PubSubClient } from '@evtivity/lib';

let instance: PubSubClient | null = null;

export function setPubSub(client: PubSubClient): void {
  instance = client;
}

export function getPubSub(): PubSubClient {
  if (instance == null) {
    // Return a no-op client when PubSub is not initialized (e.g., integration tests without Redis).
    // Callers that pass getPubSub() as an optional parameter will get a safe stub instead of a throw.
    return {
      publish: async () => {},
      subscribe: () => {},
      ping: () => Promise.resolve(false),
    } as unknown as PubSubClient;
  }
  return instance;
}
