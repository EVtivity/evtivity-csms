// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL } from '../lib/config';

const BASE_URL = API_BASE_URL;

/**
 * Subscribe to real-time SSE events for a specific station.
 * Works for both guest and authenticated users (public endpoint).
 * Invalidates station and charger queries on station.status events.
 */
export function useStationEvents(stationId: string | undefined): void {
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (stationId == null) return;

    const url = `${BASE_URL}/v1/portal/chargers/${stationId}/events`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (messageEvent: MessageEvent<string>) => {
      let parsed: { eventType?: string };
      try {
        parsed = JSON.parse(messageEvent.data) as { eventType?: string };
      } catch {
        return;
      }

      if (parsed.eventType === 'station.status') {
        void queryClient.invalidateQueries({ queryKey: ['station-detail', stationId] });
        void queryClient.invalidateQueries({ queryKey: ['station-landing', stationId] });
        void queryClient.invalidateQueries({ queryKey: ['charger-info', stationId] });
        void queryClient.invalidateQueries({ queryKey: ['charger-pricing', stationId] });
        void queryClient.invalidateQueries({ queryKey: ['guest-charger-config', stationId] });
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [stationId, queryClient]);
}
