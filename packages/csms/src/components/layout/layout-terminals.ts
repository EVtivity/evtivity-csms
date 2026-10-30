// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Payment terminals paired to the stations of a site, for the site layout:
// the 3D reader on the charger and the list in the station popup. Read from
// GET /v1/payment-terminals (paymentTerminals:read); without the permission
// no request is sent and no terminal shows.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import {
  PAYMENT_TERMINALS_KEY,
  terminalName,
  type PaymentTerminal,
} from '@/components/payment-terminals/payment-terminal-types';

export interface LayoutTerminal {
  id: string;
  name: string;
  stationId: string;
  /** OCPP EVSE ID of the paired connector; null when paired to the whole station. */
  evseNumber: number | null;
  hasDisplay: boolean;
  online: boolean | null;
}

/** Active terminals paired to a station, keyed by the station's internal ID. */
export function terminalsByStation(
  terminals: readonly PaymentTerminal[],
): Map<string, LayoutTerminal[]> {
  const out = new Map<string, LayoutTerminal[]>();
  for (const t of terminals) {
    if (t.stationId == null || t.status !== 'active') continue;
    const list = out.get(t.stationId) ?? [];
    list.push({
      id: t.id,
      name: terminalName(t),
      stationId: t.stationId,
      evseNumber: t.evseNumber,
      hasDisplay: t.hasDisplay,
      online: t.online,
    });
    out.set(t.stationId, list);
  }
  return out;
}

/**
 * Which side of the charger a reader goes on: the first EVSE's side (left),
 * the second's (right), or the front for the whole station or another EVSE.
 */
export function terminalSide(evseNumber: number | null): -1 | 0 | 1 {
  if (evseNumber === 1) return -1;
  if (evseNumber === 2) return 1;
  return 0;
}

/** The paired terminals of a site's stations; empty without paymentTerminals:read. */
export function useSiteTerminals(siteId: string): Map<string, LayoutTerminal[]> {
  const canRead = useHasPermission('paymentTerminals:read');
  const { data } = useQuery({
    queryKey: [...PAYMENT_TERMINALS_KEY, 'site', siteId],
    queryFn: () =>
      api.get<{ data: PaymentTerminal[]; total: number }>(
        `/v1/payment-terminals?siteId=${encodeURIComponent(siteId)}&limit=100`,
      ),
    enabled: canRead && siteId !== '',
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  return useMemo(() => terminalsByStation(data?.data ?? []), [data]);
}
