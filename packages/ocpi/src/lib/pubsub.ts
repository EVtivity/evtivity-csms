// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PubSubClient } from '@evtivity/lib';

let instance: PubSubClient | null = null;

export function setPubSub(client: PubSubClient): void {
  instance = client;
}

export function getPubSub(): PubSubClient {
  if (instance == null) {
    // No-op stub when PubSub is not initialized (e.g., tests without Redis).
    return {
      publish: async () => {},
      subscribe: () => {},
      ping: () => Promise.resolve(false),
    } as unknown as PubSubClient;
  }
  return instance;
}

// Tell the CSMS so the Roaming Sessions / CDRs pages reload themselves. The
// reload is page-wide, so the payload carries no ids. Best-effort.
export function notifyRoamingSessionChanged(): void {
  void getPubSub()
    .publish('csms_events', JSON.stringify({ eventType: 'roaming.session.changed' }))
    .catch(() => {
      /* best-effort */
    });
}

export function notifyRoamingCdrChanged(): void {
  void getPubSub()
    .publish('csms_events', JSON.stringify({ eventType: 'roaming.cdr.changed' }))
    .catch(() => {
      /* best-effort */
    });
}
