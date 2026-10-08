// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { chargingSessions } from '@evtivity/database';
import type { AccountBilling } from '@evtivity/database';

/**
 * How the driver pays a session started now (portal and mobile app): `account`
 * when a fleet bills it (`resolveAccountBilling`), else `card`.
 */
export const driverBillingSchema = z
  .object({
    mode: z
      .enum(['card', 'account'])
      .describe(
        'How a session the driver starts is paid: account (billed to a fleet, no payment method needed) or card',
      ),
    fleetName: z
      .string()
      .nullable()
      .describe('Name of the fleet the sessions are billed to; null for card'),
  })
  .passthrough();

export type DriverBilling = z.infer<typeof driverBillingSchema>;

export function toDriverBilling(billing: AccountBilling | null): DriverBilling {
  return billing == null
    ? { mode: 'card', fleetName: null }
    : { mode: 'account', fleetName: billing.fleetName };
}

/**
 * The billing state of a session billed to a fleet, for the driver. Only the
 * state and the fleet name: the fleet invoice (number, PDF) is the fleet's
 * document and is never exposed to drivers.
 */
export const sessionAccountBillingSchema = z
  .object({
    state: z
      .enum(['unbilled', 'invoiced', 'paid'])
      .describe(
        'unbilled (not on a fleet invoice yet), invoiced (on an issued fleet invoice), or paid (the fleet paid the invoice)',
      ),
    fleetName: z.string().describe('Name of the fleet the session is billed to'),
  })
  .passthrough();

export type SessionAccountBilling = z.infer<typeof sessionAccountBillingSchema>;

/**
 * Select columns for a session's account billing. A session is billed on
 * account when it is stamped `account` and has no payment record (one with a
 * record was paid by card, features/fleet-billing.md).
 */
export function sessionAccountBillingColumns() {
  return {
    billingMode: chargingSessions.billingMode,
    billingFleetName: sql<
      string | null
    >`(SELECT f.name FROM fleets f WHERE f.id = ${chargingSessions.billingFleetId})`,
    billingInvoiceStatus: sql<
      string | null
    >`(SELECT i.status::text FROM invoices i WHERE i.id = ${chargingSessions.invoiceId})`,
    billingHasPaymentRecord: sql<boolean>`EXISTS (SELECT 1 FROM payment_records pr WHERE pr.session_id = ${chargingSessions.id})`,
  };
}

export interface SessionAccountBillingRow {
  billingMode: string | null;
  billingFleetName: string | null;
  billingInvoiceStatus: string | null;
  billingHasPaymentRecord: boolean;
}

/** The driver-facing account billing of a session, or null when it is not billed on account. */
export function toSessionAccountBilling(
  row: SessionAccountBillingRow,
): SessionAccountBilling | null {
  if (
    row.billingMode !== 'account' ||
    row.billingHasPaymentRecord ||
    row.billingFleetName == null
  ) {
    return null;
  }
  const state =
    row.billingInvoiceStatus === 'paid'
      ? 'paid'
      : row.billingInvoiceStatus === 'issued'
        ? 'invoiced'
        : 'unbilled';
  return { state, fleetName: row.billingFleetName };
}

/** Replaces the billing columns of a session row with its `accountBilling`. */
export function withAccountBilling<T extends SessionAccountBillingRow>(
  row: T,
): Omit<T, keyof SessionAccountBillingRow> & { accountBilling: SessionAccountBilling | null } {
  const { billingMode, billingFleetName, billingInvoiceStatus, billingHasPaymentRecord, ...rest } =
    row;
  return {
    ...rest,
    accountBilling: toSessionAccountBilling({
      billingMode,
      billingFleetName,
      billingInvoiceStatus,
      billingHasPaymentRecord,
    }),
  };
}
