// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { AppError } from '@evtivity/lib';
import { db, drivers, driverAuditLog, writeAudit } from '@evtivity/database';
import type { AuditActorInfo } from '../lib/audit-actor.js';

// The only writer of a driver's billing address (the drivers.billing_*
// columns, P3): the bill-to block of the invoices a fleet addresses to each
// member. The driver edits it in the portal and the app, an operator in the
// CSMS. No tax ID: drivers are private persons (data minimization).

/** A driver's billing address. A null name prints the first and last name. */
export interface DriverBillingAddress {
  billingName: string | null;
  billingStreet: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZip: string | null;
  billingCountry: string | null;
}

export type DriverBillingAddressPatch = {
  [K in keyof DriverBillingAddress]?: string | null | undefined;
};

/** The address fields with their column widths. */
export const DRIVER_BILLING_ADDRESS_MAX_LENGTHS = {
  billingName: 255,
  billingStreet: 255,
  billingCity: 100,
  billingState: 100,
  billingZip: 20,
  billingCountry: 100,
} as const satisfies Record<keyof DriverBillingAddress, number>;

const ADDRESS_KEYS = Object.keys(
  DRIVER_BILLING_ADDRESS_MAX_LENGTHS,
) as (keyof DriverBillingAddress)[];

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface DriverBillingContext {
  actor: AuditActorInfo;
  log: Logger;
}

/** The address columns, for a select that reads them with other driver fields. */
export const driverBillingAddressColumns = {
  billingName: drivers.billingName,
  billingStreet: drivers.billingStreet,
  billingCity: drivers.billingCity,
  billingState: drivers.billingState,
  billingZip: drivers.billingZip,
  billingCountry: drivers.billingCountry,
};

const driverNotFound = (): AppError => new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');

/**
 * The address after the patch: text trimmed, blank is null. Keys not in the
 * patch keep their current value.
 */
export function mergeBillingAddress(
  current: DriverBillingAddress,
  patch: DriverBillingAddressPatch,
): DriverBillingAddress {
  const next = { ...current };
  for (const key of ADDRESS_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    const trimmed = value?.trim() ?? '';
    next[key] = trimmed === '' ? null : trimmed;
  }
  return next;
}

/** The keys whose value differs, with their before and after values. */
export function diffBillingAddress(
  before: DriverBillingAddress,
  after: DriverBillingAddress,
): { before: Partial<DriverBillingAddress>; after: Partial<DriverBillingAddress> } | null {
  const b: Partial<DriverBillingAddress> = {};
  const a: Partial<DriverBillingAddress> = {};
  for (const key of ADDRESS_KEYS) {
    if (before[key] !== after[key]) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  if (Object.keys(a).length === 0) return null;
  return { before: b, after: a };
}

/** The driver's billing address. Throws 404 DRIVER_NOT_FOUND. */
export async function getDriverBillingAddress(driverId: string): Promise<DriverBillingAddress> {
  const [row] = await db
    .select(driverBillingAddressColumns)
    .from(drivers)
    .where(eq(drivers.id, driverId));
  if (row == null) throw driverNotFound();
  return row;
}

/**
 * Updates the driver's billing address under a row lock. Keys left out keep
 * their value; null or a blank string clears a field. Only a change is
 * written and audited (driver_audit_log `billing_address_updated` with the
 * changed keys, actor driver or operator), so a repeated request writes
 * nothing (P7). Throws 404 DRIVER_NOT_FOUND.
 */
export async function updateDriverBillingAddress(
  driverId: string,
  patch: DriverBillingAddressPatch,
  ctx: DriverBillingContext,
): Promise<DriverBillingAddress> {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ ...driverBillingAddressColumns, erasedAt: drivers.erasedAt })
      .from(drivers)
      .where(eq(drivers.id, driverId))
      .for('update');
    if (row == null) throw driverNotFound();
    const { erasedAt, ...current } = row;
    // An erased driver is an anonymized stub: no address comes back.
    if (erasedAt != null) throw new AppError('The driver was erased', 409, 'DRIVER_ERASED');
    const next = mergeBillingAddress(current, patch);
    const diff = diffBillingAddress(current, next);
    if (diff == null) return { address: current, diff };
    await tx
      .update(drivers)
      .set({ ...diff.after, updatedAt: new Date() })
      .where(eq(drivers.id, driverId));
    return { address: next, diff };
  });

  // After the commit: a failed audit insert inside the transaction would abort it.
  if (result.diff != null) {
    await writeAudit(
      { table: driverAuditLog, idColumn: 'driver_id' },
      {
        entityId: driverId,
        entityIdSnapshot: driverId,
        action: 'billing_address_updated',
        ...ctx.actor,
        before: result.diff.before,
        after: result.diff.after,
      },
      db,
      ctx.log,
    );
  }
  return result.address;
}
