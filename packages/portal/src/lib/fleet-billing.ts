// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Who gets the monthly invoice of account sessions: the fleet, or the driver (member invoice). */
export type InvoicedTo = 'fleet' | 'member';

/** How the driver pays a session they start (GET /v1/portal/auth/me, charger pricing). */
export interface DriverBilling {
  mode: 'card' | 'account';
  fleetName: string | null;
  /** Null for card. Optional: absent in responses of servers before v0.1.46. */
  invoicedTo?: InvoicedTo | null;
}

/** The billing state of a session billed to a fleet (portal session list and detail). */
export interface SessionAccountBilling {
  state: 'unbilled' | 'invoiced' | 'paid';
  fleetName: string;
  invoicedTo?: InvoicedTo;
  /** On a member-billed session: the driver's invoice it is on, null until invoiced. */
  invoiceId?: string | null;
  invoiceNumber?: string | null;
}

/** The fleet a charge on account goes through, and who it is invoiced to. */
export interface AccountBillingAt {
  fleetName: string;
  invoicedTo: InvoicedTo;
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
 * The account billing of a session started at this charger, or null when the
 * driver pays by card. The charger pricing answers for the station (null at a
 * free vend site); until it loads, or when the station has no pricing, the
 * driver profile answers.
 */
export function accountBillingAt(
  pricing: { billing?: DriverBilling | null } | undefined,
  driverBilling: DriverBilling | undefined,
): AccountBillingAt | null {
  const billing = pricing != null ? (pricing.billing ?? null) : (driverBilling ?? null);
  if (billing?.mode !== 'account' || billing.fleetName == null) return null;
  return {
    fleetName: billing.fleetName,
    invoicedTo: billing.invoicedTo === 'member' ? 'member' : 'fleet',
  };
}
