// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { chargingSessions, ACCOUNT_INVOICE_RECIPIENTS } from '@evtivity/database';
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
    invoicedTo: z
      .enum(ACCOUNT_INVOICE_RECIPIENTS)
      .nullable()
      .describe(
        "Who gets the monthly invoice of the driver's account sessions: fleet (the fleet's invoice, never shown to the driver) or member (the driver's own invoice, listed by GET /v1/portal/invoices); null for card",
      ),
  })
  .passthrough();

export type DriverBilling = z.infer<typeof driverBillingSchema>;

export function toDriverBilling(billing: AccountBilling | null): DriverBilling {
  return billing == null
    ? { mode: 'card', fleetName: null, invoicedTo: null }
    : { mode: 'account', fleetName: billing.fleetName, invoicedTo: billing.recipient };
}

/**
 * The billing state of a session billed to a fleet, for the driver. A fleet
 * invoice (number, PDF) is the fleet's document and is never exposed to
 * drivers. A member invoice is the driver's own, so a member-billed session
 * carries its id and number.
 */
export const sessionAccountBillingSchema = z
  .object({
    state: z
      .enum(['unbilled', 'invoiced', 'paid'])
      .describe(
        'unbilled (not on an invoice yet), invoiced (on an issued invoice), or paid (the invoice is paid)',
      ),
    fleetName: z.string().describe('Name of the fleet the session is billed to'),
    invoicedTo: z
      .enum(ACCOUNT_INVOICE_RECIPIENTS)
      .describe(
        "Who the session is invoiced to, stamped when it started: fleet (on the fleet's invoice) or member (on the driver's own monthly invoice)",
      ),
    invoiceId: z
      .string()
      .nullable()
      .describe(
        "On a member-billed session: the driver's invoice it is on (GET /v1/portal/invoices/:id), null until invoiced. Always null for a session invoiced to the fleet",
      ),
    invoiceNumber: z
      .string()
      .nullable()
      .describe('On a member-billed session: the number of that invoice, null until invoiced'),
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
    billingMemberBilled: chargingSessions.memberBilled,
    billingInvoiceId: chargingSessions.invoiceId,
    billingInvoiceNumber: sql<
      string | null
    >`(SELECT i.invoice_number FROM invoices i WHERE i.id = ${chargingSessions.invoiceId})`,
  };
}

/**
 * SQL: the session is invoiced to its fleet, not to the driver (the
 * `invoicedTo: 'fleet'` case of `toSessionAccountBilling`): stamped
 * `account`, not member billed, a fleet, and no payment record.
 */
export function billedToFleetSql(): SQL {
  return sql`(${chargingSessions.billingMode} = 'account'
    AND NOT ${chargingSessions.memberBilled}
    AND ${chargingSessions.billingFleetId} IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM payment_records pr WHERE pr.session_id = ${chargingSessions.id}))`;
}

export interface SessionAccountBillingRow {
  billingMode: string | null;
  billingFleetName: string | null;
  billingInvoiceStatus: string | null;
  billingHasPaymentRecord: boolean;
  billingMemberBilled: boolean;
  billingInvoiceId: string | null;
  billingInvoiceNumber: string | null;
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
  if (!row.billingMemberBilled) {
    // The fleet invoice stays the fleet's document: no id or number.
    return {
      state,
      fleetName: row.billingFleetName,
      invoicedTo: 'fleet',
      invoiceId: null,
      invoiceNumber: null,
    };
  }
  // A credit note releases the session (invoice_id back to null), so the id
  // is always the live member invoice, which the driver may read.
  return {
    state,
    fleetName: row.billingFleetName,
    invoicedTo: 'member',
    invoiceId: row.billingInvoiceId,
    invoiceNumber: row.billingInvoiceId != null ? row.billingInvoiceNumber : null,
  };
}

/** Replaces the billing columns of a session row with its `accountBilling`. */
export function withAccountBilling<T extends SessionAccountBillingRow>(
  row: T,
): Omit<T, keyof SessionAccountBillingRow> & { accountBilling: SessionAccountBilling | null } {
  const {
    billingMode,
    billingFleetName,
    billingInvoiceStatus,
    billingHasPaymentRecord,
    billingMemberBilled,
    billingInvoiceId,
    billingInvoiceNumber,
    ...rest
  } = row;
  return {
    ...rest,
    accountBilling: toSessionAccountBilling({
      billingMode,
      billingFleetName,
      billingInvoiceStatus,
      billingHasPaymentRecord,
      billingMemberBilled,
      billingInvoiceId,
      billingInvoiceNumber,
    }),
  };
}
