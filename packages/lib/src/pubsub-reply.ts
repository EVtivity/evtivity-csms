// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PubSubClient, Subscription } from './pubsub.js';
import { tryParseJson } from './safe-json.js';

export interface AwaitReplyOptions {
  /** Channel the other process publishes its reply on. */
  replyChannel: string;
  /** Id carried by the request and echoed in the reply. */
  commandId: string;
  timeoutMs: number;
  /** Publishes the request. Runs once the reply subscription is live, so no reply is missed. */
  send: () => Promise<unknown>;
}

/**
 * Request/reply over pub/sub between processes: subscribes to the reply
 * channel, sends the request, and resolves with the first reply whose
 * `commandId` matches, or null when none arrives within `timeoutMs`. Subscribe
 * and send errors reject. The subscription is always released.
 */
export async function awaitPubSubReply<T extends { commandId: string }>(
  pubsub: PubSubClient,
  options: AwaitReplyOptions,
): Promise<T | null> {
  let subscription: Subscription | null = null;
  let settled = false;

  const release = (): void => {
    const current = subscription;
    subscription = null;
    if (current != null) {
      void current.unsubscribe().catch(() => {});
    }
  };

  try {
    return await new Promise<T | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        settled = true;
        release();
        resolve(null);
      }, options.timeoutMs);

      pubsub
        .subscribe(options.replyChannel, (raw: string) => {
          const parsed = tryParseJson(raw) as T | null | undefined;
          if (parsed == null || typeof parsed !== 'object') return;
          if (settled || parsed.commandId !== options.commandId) return;
          settled = true;
          clearTimeout(timeout);
          release();
          resolve(parsed);
        })
        .then(async (sub) => {
          subscription = sub;
          // Timed out while subscribing: drop the subscription, send nothing.
          if (settled) {
            release();
            return;
          }
          await options.send();
        })
        .catch((err: unknown) => {
          settled = true;
          clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  } catch (err) {
    release();
    throw err;
  }
}
