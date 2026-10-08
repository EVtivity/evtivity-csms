// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** How the driver pays a session they start (GET /v1/portal/auth/me, charger pricing). */
export interface DriverBilling {
  mode: 'card' | 'account';
  fleetName: string | null;
}

/** The billing state of a session billed to a fleet (portal session list and detail). */
export interface SessionAccountBilling {
  state: 'unbilled' | 'invoiced' | 'paid';
  fleetName: string;
}

/**
 * How the signed-in driver pays, from GET /v1/portal/auth/me. A fleet change
 * reaches the driver by notification, so a minute of staleness is fine.
 */
export function useDriverBilling(enabled = true): DriverBilling | undefined {
  const { data } = useQuery({
    queryKey: ['portal-driver-billing'],
    queryFn: () => api.get<{ billing?: DriverBilling }>('/v1/portal/auth/me'),
    enabled,
    staleTime: 60_000,
  });
  return data?.billing;
}

/**
 * The fleet a session started at this charger is billed to, or null when the
 * driver pays by card. The charger pricing answers for the station (null at a
 * free vend site); until it loads, or when the station has no pricing, the
 * driver profile answers.
 */
export function billedToFleet(
  pricing: { billing?: DriverBilling | null } | undefined,
  driverBilling: DriverBilling | undefined,
): string | null {
  const billing = pricing != null ? (pricing.billing ?? null) : (driverBilling ?? null);
  return billing?.mode === 'account' ? billing.fleetName : null;
}
