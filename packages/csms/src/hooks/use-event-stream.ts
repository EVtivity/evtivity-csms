// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef } from 'react';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL } from '../lib/config';
import { useAuth } from '../lib/auth';

const BASE_URL = API_BASE_URL;

/** Minimum seconds between SSE-triggered refetches of the same query key. */
const THROTTLE_MS = 5_000;

interface CsmsEvent {
  eventType: string;
  stationId: string | null;
  siteId: string | null;
  sessionId: string | null;
  caseId: string | null;
  runId: number | null;
}

function getQueryKeysForEvent(event: CsmsEvent): string[][] {
  const keys: string[][] = [];
  const { eventType, stationId, siteId } = event;

  switch (eventType) {
    case 'station.status':
      keys.push(['dashboard', 'stats']);
      keys.push(['dashboard', 'station-status']);
      keys.push(['dashboard', 'uptime']);
      keys.push(['dashboard', 'ocpp-health']);
      keys.push(['stations']);
      if (stationId != null) {
        keys.push(['stations', stationId]);
        keys.push(['stations', stationId, 'metrics']);
        keys.push(['stations', stationId, 'connectors']);
      }
      if (siteId != null) {
        keys.push(['sites', siteId, 'metrics']);
        keys.push(['sites', siteId, 'stations']);
        keys.push(['sites', siteId, 'layout']);
      }
      break;

    case 'session.started':
    case 'session.ended':
      keys.push(['dashboard', 'stats']);
      keys.push(['dashboard', 'session-history']);
      keys.push(['dashboard', 'energy-history']);
      keys.push(['dashboard', 'utilization']);
      keys.push(['dashboard', 'peak-usage']);
      keys.push(['dashboard', 'financial-stats']);
      keys.push(['dashboard', 'revenue-history']);
      keys.push(['sessions']);
      keys.push(['transactions']);
      if (stationId != null) {
        keys.push(['stations', stationId, 'metrics']);
        keys.push(['stations', stationId, 'sessions']);
        keys.push(['stations', stationId, 'revenue-history']);
      }
      if (siteId != null) {
        keys.push(['sites', siteId, 'metrics']);
        keys.push(['sites', siteId, 'sessions']);
        keys.push(['sites', siteId, 'layout']);
        keys.push(['sites', siteId, 'revenue-history']);
      }
      break;

    case 'session.updated':
      keys.push(['sessions']);
      keys.push(['transactions']);
      if (stationId != null) {
        keys.push(['stations', stationId, 'sessions']);
        keys.push(['stations', stationId, 'metrics']);
      }
      if (siteId != null) {
        keys.push(['sites', siteId, 'sessions']);
        keys.push(['sites', siteId, 'metrics']);
      }
      break;

    case 'meter.values':
      keys.push(['dashboard', 'financial-stats']);
      keys.push(['dashboard', 'revenue-history']);
      if (stationId != null) {
        keys.push(['stations', stationId, 'meter-values']);
        keys.push(['stations', stationId, 'energy-history']);
        keys.push(['stations', stationId, 'revenue-history']);
        keys.push(['stations', stationId, 'metrics']);
        keys.push(['station-meter-values']);
      }
      if (siteId != null) {
        keys.push(['sites', siteId, 'meter-values']);
        keys.push(['sites', siteId, 'energy-history']);
        keys.push(['sites', siteId, 'layout']);
        keys.push(['sites', siteId, 'load-management']);
        keys.push(['sites', siteId, 'revenue-history']);
        keys.push(['sites', siteId, 'metrics']);
      }
      break;

    case 'payment.settled':
      keys.push(['dashboard', 'stats']);
      keys.push(['dashboard', 'financial-stats']);
      keys.push(['dashboard', 'payment-breakdown']);
      keys.push(['transactions']);
      break;

    case 'load.updated':
      if (siteId != null) {
        keys.push(['sites', siteId, 'load-management']);
      }
      break;

    case 'ocpp.message':
      if (stationId != null) {
        keys.push(['stations', stationId, 'ocpp-logs']);
      }
      break;

    case 'ocpp.health':
      keys.push(['dashboard', 'ocpp-health']);
      break;

    case 'supportCase.created':
    case 'supportCase.updated':
    case 'supportCase.newMessage':
      keys.push(['support-cases']);
      keys.push(['support-cases-unread-count']);
      if (event.caseId != null) {
        keys.push(['support-cases', event.caseId]);
      }
      break;

    case 'certificate.signed':
    case 'certificate.expiring':
    case 'certificate.expired':
      keys.push(['pnc-ca-certificates']);
      keys.push(['pnc-station-certificates']);
      keys.push(['pnc-csr-requests']);
      if (stationId != null) {
        keys.push(['stations', stationId, 'certificates']);
      }
      break;

    case 'octt.progress':
      keys.push(['octt-runs']);
      if (event.runId != null) {
        keys.push(['octt-runs', String(event.runId)]);
        keys.push(['octt-runs', String(event.runId), 'summary']);
      }
      break;
  }

  return keys;
}

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
