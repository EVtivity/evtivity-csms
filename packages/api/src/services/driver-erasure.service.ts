// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, isNull } from 'drizzle-orm';
import {
  db,
  drivers,
  vehicles,
  chargingSessions,
  driverNotificationPreferences,
  driverPushTokens,
  mfaChallenges,
  userTokens,
  driverAuditLog,
  writeAudit,
} from '@evtivity/database';
import { AppError } from '@evtivity/lib';
import { eraseDriverMethods } from '@evtivity/payments';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { paymentContext } from '../lib/payments.js';
import { applyDriverDeactivation } from './driver-status.service.js';
import { deleteRecoveryCodes, deleteWebauthnCredentials } from './mfa-factor.service.js';

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}

export interface DriverErasureResult {
  erasedAt: Date;
  paymentMethodsRemoved: number;
  vehiclesRemoved: number;
  tokensDeactivated: number;
}

/** 409 DRIVER_ERASED: the driver's personal data was erased; the stub cannot change. */
export function driverErasedError(): AppError {
  return new AppError('The driver was erased', 409, 'DRIVER_ERASED');
}

/**
 * Erases a driver's personal data (GDPR right to erasure). The only writer of
 * `drivers.erased_at`. Irreversible.
 *
 * - Anonymizes the driver row: names blank, email, phone, billing address,
 *   password, MFA and preferences cleared, inactive. The row stays as a stub,
 *   so sessions, payment records, invoices and credit notes keep their
 *   driver id and their own snapshots for accounting.
 * - Deletes the vehicles, notification preferences, push tokens, MFA
 *   challenges, recovery codes, passkeys and emailed links.
 * - Detaches and deletes the saved payment methods and provider customers
 *   through the payments methods service.
 * - Deactivates the tokens, revokes the sessions and ends the portal streams
 *   through applyDriverDeactivation. The tokens stay (inactive) for the
 *   authorization history.
 * - Writes one `driver.erased` audit row holding counts only. Audit rows
 *   written before keep their snapshots: history is not rewritten.
 *
 * Refused with 409 DRIVER_HAS_ACTIVE_SESSION while a session of the driver is
 * active (its payment hold needs the saved method) and 409 DRIVER_ERASED for a
 * driver already erased.
 */
export async function eraseDriver(
  driverId: string,
  ctx: { actor: AuditActorInfo; log: Logger },
): Promise<DriverErasureResult> {
  const [driver] = await db
    .select({ id: drivers.id, erasedAt: drivers.erasedAt })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  if (driver == null) throw new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');
  if (driver.erasedAt != null) throw driverErasedError();

  const [active] = await db
    .select({ id: chargingSessions.id })
    .from(chargingSessions)
    .where(and(eq(chargingSessions.driverId, driverId), eq(chargingSessions.status, 'active')))
    .limit(1);
  if (active != null) {
    throw new AppError(
      'The driver has an active charging session',
      409,
      'DRIVER_HAS_ACTIVE_SESSION',
    );
  }

  const erasedAt = new Date();
  const vehiclesRemoved = await db.transaction(async (tx) => {
    // Guarded on erased_at, so of two concurrent erasures one wins.
    const [stub] = await tx
      .update(drivers)
      .set({
        firstName: '',
        lastName: '',
        email: null,
        phone: null,
        passwordHash: null,
        totpSecretEnc: null,
        mfaEnabled: false,
        mfaMethod: null,
        isActive: false,
        emailVerified: false,
        priceDisplay: null,
        lastNotificationReadAt: null,
        billingName: null,
        billingStreet: null,
        billingCity: null,
        billingState: null,
        billingZip: null,
        billingCountry: null,
        erasedAt,
        updatedAt: erasedAt,
      })
      .where(and(eq(drivers.id, driverId), isNull(drivers.erasedAt)))
      .returning({ id: drivers.id });
    if (stub == null) throw driverErasedError();

    // Sessions keep their history: vehicle_id is set null by the foreign key.
    const removedVehicles = await tx
      .delete(vehicles)
      .where(eq(vehicles.driverId, driverId))
      .returning({ id: vehicles.id });
    await tx
      .delete(driverNotificationPreferences)
      .where(eq(driverNotificationPreferences.driverId, driverId));
    await tx.delete(driverPushTokens).where(eq(driverPushTokens.driverId, driverId));
    await tx.delete(mfaChallenges).where(eq(mfaChallenges.driverId, driverId));
    await deleteRecoveryCodes({ driverId }, tx);
    await deleteWebauthnCredentials({ driverId }, tx);
    await tx.delete(userTokens).where(eq(userTokens.driverId, driverId));
    return removedVehicles.length;
  });

  // After the commit: the row is already anonymized, so the token
  // notifications below find no address to send to.
  const { removed: paymentMethodsRemoved } = await eraseDriverMethods(
    driverId,
    paymentContext(ctx.log, ctx.actor),
  );
  const { tokensDeactivated } = await applyDriverDeactivation(driverId, ctx);

  await writeAudit(
    { table: driverAuditLog, idColumn: 'driver_id' },
    {
      entityId: driverId,
      entityIdSnapshot: driverId,
      action: 'erased',
      ...ctx.actor,
      before: null,
      after: { erased: true, paymentMethodsRemoved, vehiclesRemoved, tokensDeactivated },
    },
    db,
    ctx.log,
  );

  return { erasedAt, paymentMethodsRemoved, vehiclesRemoved, tokensDeactivated };
}
