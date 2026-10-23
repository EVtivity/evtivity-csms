// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { tryParseJson } from '@evtivity/lib/safe-json';
import { API_BASE_URL } from '../lib/config';

const BASE_URL = API_BASE_URL;

/** Wait before opening a stream again after the server closed or refused it. */
export const STATION_EVENTS_RETRY_MS = 30_000;

/**
 * Subscribe to real-time SSE events for a specific station.
 * Works for both guest and authenticated users (public endpoint).
 * Invalidates station and charger queries on station.status events.
 *
 * A browser EventSource never retries a refused stream (a 429 at the per-client
 * or process cap), so the hook opens a new one after
 * STATION_EVENTS_RETRY_MS. Until then the pages' periodic refetch keeps the
 * status current.
 */
export function useStationEvents(stationId: string | undefined): void {
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (stationId == null) return;

    const url = `${BASE_URL}/v1/portal/chargers/${stationId}/events`;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const onMessage = (messageEvent: MessageEvent<string>): void => {
      const value = tryParseJson(messageEvent.data);
      if (value == null || typeof value !== 'object') {
        console.warn('Ignored a station event that is not a JSON object', messageEvent.data);
        return;
      }
      const parsed = value as { eventType?: string };

      if (parsed.eventType === 'station.status') {
        void queryClient.invalidateQueries({ queryKey: ['station-detail', stationId] });
        void queryClient.invalidateQueries({ queryKey: ['station-landing', stationId] });
        void queryClient.invalidateQueries({ queryKey: ['charger-info', stationId] });
        void queryClient.invalidateQueries({ queryKey: ['charger-pricing', stationId] });
        void queryClient.invalidateQueries({ queryKey: ['guest-charger-config', stationId] });
      }
    };

    const open = (): void => {
      const es = new EventSource(url);
      eventSourceRef.current = es;
      es.onmessage = onMessage;
      es.onerror = () => {
        // A network drop reconnects by itself (CONNECTING); a closed stream does not.
        if (es.readyState !== EventSource.CLOSED || stopped || retry != null) return;
        retry = setTimeout(() => {
          retry = null;
          if (!stopped) open();
        }, STATION_EVENTS_RETRY_MS);
      };
    };
    open();

    return () => {
      stopped = true;
      if (retry != null) clearTimeout(retry);
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [stationId, queryClient]);
}
