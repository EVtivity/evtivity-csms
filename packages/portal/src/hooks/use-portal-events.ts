// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL } from '../lib/config';

const BASE_URL = API_BASE_URL;

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;

export function usePortalEvents(): void {
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const backoffDelayRef = useRef(INITIAL_BACKOFF_MS);
  const lastMessageAtRef = useRef(Date.now());

  useEffect(() => {
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

    function scheduleReconnect(): void {
      clearReconnectTimer();
      const delay = backoffDelayRef.current;
      backoffDelayRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
      reconnectTimerRef.current = setTimeout(connect, delay);
    }

    function connect(): void {
      clearReconnectTimer();

      const url = `${BASE_URL}/v1/portal/events`;
      const es = new EventSource(url, { withCredentials: true });
      eventSourceRef.current = es;

      es.onopen = () => {
        backoffDelayRef.current = INITIAL_BACKOFF_MS;
        lastMessageAtRef.current = Date.now();
      };

      es.onmessage = (messageEvent: MessageEvent<string>) => {
        lastMessageAtRef.current = Date.now();

        let parsed: { type?: string; caseId?: string };
        try {
          parsed = JSON.parse(messageEvent.data) as { type?: string; caseId?: string };
        } catch {
          return;
        }

        if (parsed.type === 'notification.created') {
          void queryClient.invalidateQueries({ queryKey: ['portal-notifications-unread'] });
          void queryClient.invalidateQueries({ queryKey: ['portal-notifications'] });
          return;
        }

        if (
          parsed.type === 'supportCase.created' ||
          parsed.type === 'supportCase.updated' ||
          parsed.type === 'supportCase.newMessage'
        ) {
          void queryClient.invalidateQueries({ queryKey: ['portal-support-cases'] });
          if (parsed.caseId != null) {
            void queryClient.invalidateQueries({
              queryKey: ['portal-support-case', parsed.caseId],
            });
          }
        }
      };

      es.onerror = () => {
        es.close();
        eventSourceRef.current = null;
        scheduleReconnect();
      };
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
    };
  }, [queryClient]);
}
