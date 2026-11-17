// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface FleetSummaryDay {
  date: string;
  sessions: number;
  energyWh: number;
  costCents?: number;
}

export interface FleetSummaryInvoice {
  id: string;
  invoiceNumber: string;
  fleetId: string | null;
  fleetName: string;
  kind: string;
  status: string;
  totalCents: number;
  currency: string;
  issuedAt: string | null;
  createdAt: string;
}

/** GET /v1/fleets/metrics-summary: the money keys only with payments:read. */
export interface FleetSummary {
  fleetId: string | null;
  sessionCount: number;
  energyWh: number;
  costCents?: number;
  currency?: string;
  /** The fleet closest to its credit limit (with one fleet picked: that fleet). */
  creditLimit?: {
    fleetId: string;
    fleetName: string;
    limitCents: number;
    exposureCents: number;
    usedPercent: number;
    fleetCount: number;
  } | null;
  history: FleetSummaryDay[];
  invoices?: FleetSummaryInvoice[];
}

const REFETCH_INTERVAL = 60_000;

/** The summary behind every fleet card and chart of the Dashboard: one fleet, or every one. */
export function useFleetDashboard(options: {
  enabled: boolean;
  fleetId: string | null;
  dateQuery: string;
}) {
  const params = new URLSearchParams(options.dateQuery);
  if (options.fleetId != null) params.set('fleetId', options.fleetId);
  return useQuery({
    queryKey: ['dashboard', 'fleet-summary', options.fleetId, options.dateQuery],
    queryFn: () => api.get<FleetSummary>(`/v1/fleets/metrics-summary?${params.toString()}`),
    refetchInterval: REFETCH_INTERVAL,
    enabled: options.enabled,
  });
}
