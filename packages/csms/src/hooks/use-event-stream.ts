// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef } from 'react';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL } from '../lib/config';
import { useAuth } from '../lib/auth';
import { getQueryKeysForEvent, type CsmsEvent } from './event-query-keys';

const BASE_URL = API_BASE_URL;

/** Minimum seconds between SSE-triggered refetches of the same query key. */
const THROTTLE_MS = 5_000;

/**
 * Per-key throttle for SSE-triggered query invalidation.
 *
 * Each unique query key gets its own independent timer. The first event
 * for a key starts a {@link THROTTLE_MS} window. All subsequent events
 * for that same key within the window are absorbed. When the timer fires,
 * one invalidation is sent for that key.
 *
 * This prevents request floods when many stations emit events in quick
 * succession while still giving each query its own refresh cadence.
 */
class InvalidationBatcher {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queryClient: QueryClient;

  constructor(queryClient: QueryClient) {
    this.queryClient = queryClient;
  }

  add(keys: string[][]): void {
    for (const key of keys) {
      const serialized = JSON.stringify(key);
      if (this.timers.has(serialized)) continue;
      this.timers.set(
        serialized,
        setTimeout(() => {
          this.timers.delete(serialized);
          void this.queryClient.invalidateQueries({
            queryKey: JSON.parse(serialized) as string[],
          });
        }, THROTTLE_MS),
      );
    }
  }

  destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}

/** Initial reconnection delay in milliseconds. */
const INITIAL_BACKOFF_MS = 1_000;

/** Maximum reconnection delay in milliseconds. */
const MAX_BACKOFF_MS = 30_000;

/** If no message is received within this window, reconnect. */
const HEARTBEAT_TIMEOUT_MS = 60_000;

export function useEventStream(): void {
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const backoffDelayRef = useRef(INITIAL_BACKOFF_MS);
  const lastMessageAtRef = useRef(Date.now());
  const batcherRef = useRef<InvalidationBatcher | null>(null);

  useEffect(() => {
    const { isAuthenticated } = useAuth.getState();
    if (!isAuthenticated) return;

    const batcher = new InvalidationBatcher(queryClient);
    batcherRef.current = batcher;

    function clearReconnectTimer(): void {
      if (reconnectTimerRef.current != null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function clearHeartbeatInterval(): void {
      if (heartbeatIntervalRef.current != null) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    }

    function connect(): void {
      clearReconnectTimer();

      const url = `${BASE_URL}/v1/events/stream`;
      const es = new EventSource(url, { withCredentials: true });
      eventSourceRef.current = es;

      es.onopen = () => {
        backoffDelayRef.current = INITIAL_BACKOFF_MS;
        lastMessageAtRef.current = Date.now();
      };

      es.onmessage = (messageEvent: MessageEvent<string>) => {
        lastMessageAtRef.current = Date.now();

        let event: CsmsEvent;
        try {
          event = JSON.parse(messageEvent.data) as CsmsEvent;
        } catch {
          return;
        }

        const keys = getQueryKeysForEvent(event);
        if (keys.length > 0) {
          batcher.add(keys);
        }
      };

      es.onerror = () => {
        es.close();
        eventSourceRef.current = null;
        scheduleReconnect();
      };
    }

    function scheduleReconnect(): void {
      clearReconnectTimer();
      const delay = backoffDelayRef.current;
      backoffDelayRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
      reconnectTimerRef.current = setTimeout(connect, delay);
    }

    connect();

    heartbeatIntervalRef.current = setInterval(() => {
      const elapsed = Date.now() - lastMessageAtRef.current;
      if (elapsed >= HEARTBEAT_TIMEOUT_MS && eventSourceRef.current != null) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
        scheduleReconnect();
      }
    }, HEARTBEAT_TIMEOUT_MS / 2);

    return () => {
      clearReconnectTimer();
      clearHeartbeatInterval();
      if (eventSourceRef.current != null) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      batcher.destroy();
      batcherRef.current = null;
    };
  }, [queryClient]);
}
