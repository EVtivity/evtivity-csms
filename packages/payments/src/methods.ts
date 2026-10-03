// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  db,
  driverPaymentMethods,
  drivers,
  getCompanyCountry,
  getCompanyCurrency,
} from '@evtivity/database';
import type { PaymentContext } from './context.js';
import { errorMessage } from './context.js';
import { PaymentMethodOwnershipError, PaymentProviderNotConfiguredError } from './errors.js';
import { activeProvider, pinnedProvider, providerOfStoredIds } from './pinning.js';
import type { MethodSetupChannel, MethodSetupSession, PaymentProvider } from './types.js';

/**
 * Saved payment methods and the driver's provider customer. The only writer
 * of `driver_payment_methods` and of `drivers.stripe_customer_id` (P3), for
 * the portal, the operator dashboard and the mobile app alike. A method is
 * verified server side with the provider it belongs to (never client
 * asserted), and a method is removed from the provider it was saved with.
 */

export type DriverPaymentMethod = typeof driverPaymentMethods.$inferSelect;

interface DriverRow {
  id: string;
  email: string | null;
  firstName: string;
  lastName: string;
  customerId: string | null;
}

async function findDriver(driverId: string): Promise<DriverRow | null> {
  const [row] = await db
    .select({
      id: drivers.id,
      email: drivers.email,
      firstName: drivers.firstName,
      lastName: drivers.lastName,
      customerId: drivers.stripeCustomerId,
    })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  return row ?? null;
}

async function setDriverCustomer(driverId: string, customerId: string): Promise<void> {
  await db
    .update(drivers)
    .set({ stripeCustomerId: customerId, updatedAt: new Date() })
    .where(eq(drivers.id, driverId));
}

/**
 * The driver's customer, from the driver row or (drivers who saved a card
 * before the column existed) their first saved method, which is then stored
 * on the driver. Null when the driver has none.
 */
async function storedCustomer(driver: DriverRow): Promise<string | null> {
  if (driver.customerId != null) return driver.customerId;
  const [method] = await db
    .select({ customerId: driverPaymentMethods.stripeCustomerId })
    .from(driverPaymentMethods)
    .where(eq(driverPaymentMethods.driverId, driver.id))
    .limit(1);
  if (method == null) return null;
  await setDriverCustomer(driver.id, method.customerId);
  driver.customerId = method.customerId;
  return method.customerId;
}

/** Whether another driver already holds this customer (on the driver row or a saved method). */
async function customerOwnedByOtherDriver(customerId: string, driverId: string): Promise<boolean> {
  const rows = await db.execute<{ owned: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM drivers WHERE stripe_customer_id = ${customerId} AND id <> ${driverId}
      UNION ALL
      SELECT 1 FROM driver_payment_methods
      WHERE stripe_customer_id = ${customerId} AND driver_id <> ${driverId}
    ) AS owned
  `);
  return rows[0]?.owned === true;
}

async function createCustomer(
  driver: DriverRow,
  provider: PaymentProvider,
  idempotencyKey: string,
): Promise<string> {
  const { customerId } = await provider.createCustomer({
    email: driver.email ?? '',
    name: `${driver.firstName} ${driver.lastName}`,
    idempotencyKey,
  });
  await setDriverCustomer(driver.id, customerId);
  return customerId;
}

/**
 * The driver's customer at `provider`, created (key
 * `customer_<driverId>_<provider>`, P7) and stored when the driver has none
 * there yet.
 */
async function ensureCustomer(driver: DriverRow, provider: PaymentProvider): Promise<string> {
  const stored = await storedCustomer(driver);
  if (stored != null && providerOfStoredIds({ customerId: stored }) === provider.id) return stored;
  return createCustomer(driver, provider, `customer_${driver.id}_${provider.id}`);
}

export type MethodSetupOutcome =
  | { status: 'started'; providerId: string; customerId: string; session: MethodSetupSession }
  | { status: 'driver_not_found' }
  | { status: 'not_configured' }
  | { status: 'failed'; reason: string };

/**
 * Starts adding a card for a driver with the active provider: the customer
 * (created on first use), then the provider's setup session (Stripe: a
 * card-only SetupIntent; the native channel adds an ephemeral key for the
 * mobile PaymentSheet, in the API version the SDK pins). A customer the
 * provider no longer knows (deleted, or created under another account) is
 * replaced once with a new one (key `customer_<driverId>_<provider>_<stale id>`).
 */
export async function startDriverMethodSetup(
  input: { driverId: string; channel: MethodSetupChannel; nativeSdkVersion?: string },
  ctx: PaymentContext,
): Promise<MethodSetupOutcome> {
  const driver = await findDriver(input.driverId);
  if (driver == null) return { status: 'driver_not_found' };
  let provider: PaymentProvider | null;
  try {
    provider = await activeProvider(ctx.registry);
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) return { status: 'not_configured' };
    throw err;
  }
  if (provider == null) return { status: 'not_configured' };
  if (input.channel === 'native' && !provider.capabilities.nativeMobileSheet) {
    return { status: 'not_configured' };
  }

  const [currency, countryCode] = await Promise.all([getCompanyCurrency(), getCompanyCountry()]);
  const active = provider;
  const setup = (customerId: string): Promise<MethodSetupSession> =>
    active.startMethodSetup({
      customerId,
      channel: input.channel,
      currency,
      countryCode: countryCode ?? '',
      ...(input.nativeSdkVersion != null ? { nativeSdkVersion: input.nativeSdkVersion } : {}),
    });

  try {
    let customerId = await ensureCustomer(driver, provider);
    let session: MethodSetupSession;
    try {
      session = await setup(customerId);
    } catch (err) {
      if (!provider.isUnknownCustomerError(err)) throw err;
      ctx.logger.warn(
        { err, oldCustomerId: customerId, driverId: driver.id },
        'Provider rejected the stored customer; creating a new one',
      );
      customerId = await createCustomer(
        driver,
        provider,
        `customer_${driver.id}_${provider.id}_${customerId}`,
      );
      session = await setup(customerId);
    }
    return { status: 'started', providerId: provider.id, customerId, session };
  } catch (err) {
    ctx.logger.warn({ err, driverId: driver.id }, 'Payment method setup failed');
    return { status: 'failed', reason: errorMessage(err, 'Payment setup failed') };
  }
}

export type SaveMethodOutcome =
  | { status: 'saved'; method: DriverPaymentMethod }
  | { status: 'driver_not_found' }
  /** The driver has no customer yet: payment setup was not started. */
  | { status: 'not_initialized' }
  | { status: 'forbidden' }
  | { status: 'not_configured' }
  | { status: 'verify_failed'; reason: string };

/**
 * Saves the method the client confirmed (Stripe: the SetupIntent's
 * PaymentMethod id). The customer must be the driver's own; when an operator
 * adds a card for a driver without one (`adoptCustomer`), the customer of
 * the setup becomes the driver's. The provider reads the method back and
 * checks it is attached to that customer (a forged pair is refused), and its
 * brand and last 4 digits are stored. The first method is the default.
 */
export async function saveDriverMethod(
  input: { driverId: string; customerId: string; methodId: string; adoptCustomer: boolean },
  ctx: PaymentContext,
): Promise<SaveMethodOutcome> {
  const driver = await findDriver(input.driverId);
  if (driver == null) return { status: 'driver_not_found' };
  let customerId = await storedCustomer(driver);
  if (customerId == null) {
    if (!input.adoptCustomer) return { status: 'not_initialized' };
    // The setup's customer becomes the driver's, unless it is someone else's.
    if (await customerOwnedByOtherDriver(input.customerId, driver.id)) {
      return { status: 'forbidden' };
    }
    customerId = input.customerId;
  }
  if (input.customerId !== customerId) return { status: 'forbidden' };

  let details;
  try {
    const provider = await pinnedProvider(ctx.registry, { customerId, methodId: input.methodId });
    details = await provider.verifyMethod({ methodId: input.methodId, customerId });
  } catch (err) {
    if (err instanceof PaymentMethodOwnershipError) return { status: 'forbidden' };
    if (err instanceof PaymentProviderNotConfiguredError) return { status: 'not_configured' };
    ctx.logger.warn(
      { err, paymentMethodId: input.methodId },
      'Failed to verify the payment method; refusing to save it',
    );
    return {
      status: 'verify_failed',
      reason: errorMessage(err, 'Could not verify payment method'),
    };
  }
  if (driver.customerId == null) await setDriverCustomer(driver.id, customerId);

  const existing = await db
    .select({ id: driverPaymentMethods.id })
    .from(driverPaymentMethods)
    .where(eq(driverPaymentMethods.driverId, driver.id));
  const [method] = await db
    .insert(driverPaymentMethods)
    .values({
      driverId: driver.id,
      stripeCustomerId: customerId,
      stripePaymentMethodId: details.methodId,
      cardBrand: details.brand,
      cardLast4: details.last4,
      isDefault: existing.length === 0,
    })
    .returning();
  if (method == null) throw new Error('Failed to save payment method');
  return { status: 'saved', method };
}

/**
 * The driver's methods, newest first. Rows saved without card details
 * (legacy) are filled in from the provider once; a failed read is logged and
 * the row is returned as is (fail open).
 */
export async function listDriverMethods(
  driverId: string,
  ctx: PaymentContext,
): Promise<DriverPaymentMethod[]> {
  const rows = await db
    .select()
    .from(driverPaymentMethods)
    .where(eq(driverPaymentMethods.driverId, driverId))
    .orderBy(desc(driverPaymentMethods.createdAt), desc(driverPaymentMethods.id));
  const missing = rows.filter(
    (r) =>
      r.cardLast4 == null &&
      providerOfStoredIds({ customerId: r.stripeCustomerId }) !== 'simulated',
  );
  await Promise.all(
    missing.map(async (row) => {
      try {
        const provider = await pinnedProvider(ctx.registry, {
          customerId: row.stripeCustomerId,
          methodId: row.stripePaymentMethodId,
        });
        const details = await provider.verifyMethod({
          methodId: row.stripePaymentMethodId,
          customerId: row.stripeCustomerId,
        });
        if (details.brand == null && details.last4 == null) return;
        await db
          .update(driverPaymentMethods)
          .set({ cardBrand: details.brand, cardLast4: details.last4, updatedAt: new Date() })
          .where(eq(driverPaymentMethods.id, row.id));
        row.cardBrand = details.brand;
        row.cardLast4 = details.last4;
      } catch (err) {
        ctx.logger.warn(
          { err, paymentMethodId: row.stripePaymentMethodId },
          'Failed to backfill card details from the payment provider',
        );
      }
    }),
  );
  return rows;
}

export type RemoveMethodOutcome =
  | { status: 'removed' }
  | { status: 'not_found' }
  /** The method holds an open payment of an active session. */
  | { status: 'in_use' };

/**
 * Removes a saved method: detached from its provider (best effort, logged),
 * deleted, and when it was the default the oldest remaining method becomes
 * the default so the next charge still finds one. With `blockWhenInUse` a
 * method holding an open payment of an active session is kept (deleting it
 * would strand the hold).
 */
export async function removeDriverMethod(
  input: { driverId: string; methodRowId: number; blockWhenInUse: boolean },
  ctx: PaymentContext,
): Promise<RemoveMethodOutcome> {
  const [method] = await db
    .select()
    .from(driverPaymentMethods)
    .where(
      and(
        eq(driverPaymentMethods.id, input.methodRowId),
        eq(driverPaymentMethods.driverId, input.driverId),
      ),
    );
  if (method == null) return { status: 'not_found' };

  if (input.blockWhenInUse) {
    const inUse = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM payment_records pr
      JOIN charging_sessions cs ON cs.id = pr.session_id
      WHERE pr.driver_id = ${input.driverId}
        AND pr.stripe_payment_method_id = ${method.stripePaymentMethodId}
        AND pr.status IN ('pending', 'pre_authorized')
        AND cs.status = 'active'
    `);
    if ((inUse[0]?.count ?? 0) > 0) return { status: 'in_use' };
  }

  try {
    const provider = await pinnedProvider(ctx.registry, {
      customerId: method.stripeCustomerId,
      methodId: method.stripePaymentMethodId,
    });
    await provider.detachMethod({
      customerId: method.stripeCustomerId,
      methodId: method.stripePaymentMethodId,
    });
  } catch (err) {
    // An unconfigured provider or an already detached method is expected;
    // the provider-side method is left for manual cleanup (P9 fail open).
    ctx.logger.warn(
      { err, paymentMethodId: method.stripePaymentMethodId },
      'Failed to detach the payment method at the provider; deleting the local row anyway',
    );
  }

  // Delete and promotion in one transaction, so two concurrent removals
  // never leave the driver without a default.
  await db.transaction(async (tx) => {
    await tx.delete(driverPaymentMethods).where(eq(driverPaymentMethods.id, method.id));
    if (!method.isDefault) return;
    const [next] = await tx
      .select({ id: driverPaymentMethods.id })
      .from(driverPaymentMethods)
      .where(eq(driverPaymentMethods.driverId, input.driverId))
      .orderBy(asc(driverPaymentMethods.createdAt))
      .limit(1)
      .for('update');
    if (next != null) {
      await tx
        .update(driverPaymentMethods)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(driverPaymentMethods.id, next.id));
    }
  });
  return { status: 'removed' };
}

/**
 * Makes a method the driver's default in one UPDATE, so two concurrent calls
 * never leave two defaults. Null when the method is not the driver's.
 */
export async function setDefaultDriverMethod(
  driverId: string,
  methodRowId: number,
): Promise<DriverPaymentMethod | null> {
  const [method] = await db
    .select({ id: driverPaymentMethods.id })
    .from(driverPaymentMethods)
    .where(
      and(eq(driverPaymentMethods.id, methodRowId), eq(driverPaymentMethods.driverId, driverId)),
    );
  if (method == null) return null;
  await db
    .update(driverPaymentMethods)
    .set({ isDefault: sql`(${driverPaymentMethods.id} = ${methodRowId})`, updatedAt: new Date() })
    .where(eq(driverPaymentMethods.driverId, driverId));
  const [updated] = await db
    .select()
    .from(driverPaymentMethods)
    .where(eq(driverPaymentMethods.id, methodRowId));
  return updated ?? null;
}
