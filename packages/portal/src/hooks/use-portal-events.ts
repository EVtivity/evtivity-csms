// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL } from '../lib/config';

const BASE_URL = API_BASE_URL;

export function usePortalEvents(): void {
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const url = `${BASE_URL}/v1/portal/events`;
    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;

    es.onmessage = (messageEvent: MessageEvent<string>) => {
      let parsed: { type?: string };
      try {
        parsed = JSON.parse(messageEvent.data) as { type?: string };
      } catch {
        return;
      }

      if (parsed.type === 'notification.created') {
        void queryClient.invalidateQueries({ queryKey: ['portal-notifications-unread'] });
        void queryClient.invalidateQueries({ queryKey: ['portal-notifications'] });
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [queryClient]);
}
