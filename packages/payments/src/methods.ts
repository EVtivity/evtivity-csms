// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  db,
  driverPaymentCustomers,
  driverPaymentMethods,
  drivers,
  getCompanyCountry,
  getCompanyCurrency,
} from '@evtivity/database';
import type { PaymentContext } from './context.js';
import { errorMessage } from './context.js';
import {
  PaymentDeclinedError,
  PaymentMethodOwnershipError,
  PaymentOperationNotSupportedError,
  PaymentProviderNotConfiguredError,
  PaymentValidationError,
} from './errors.js';
import { stripeColumnValue, writesStripeColumns } from './legacy-columns.js';
import { activeProvider, pinnedProvider } from './pinning.js';
import type {
  BrowserContext,
  ClientAction,
  MethodSetupChannel,
  MethodSetupSession,
  MethodSetupStep,
  PaymentProvider,
  PaymentProviderId,
  SavedMethodDetails,
} from './types.js';

/**
 * Saved payment methods and the driver's customer at each provider. The only
 * writer of `driver_payment_methods`, `driver_payment_customers` and
 * `drivers.stripe_customer_id` (P3), for the portal, the operator dashboard
 * and the mobile app alike. A method is verified server side with the
 * provider it belongs to (never client asserted), and a method is removed
 * from the provider it was saved with (its `provider` column).
 */

export type DriverPaymentMethod = typeof driverPaymentMethods.$inferSelect;

interface DriverRow {
  id: string;
  email: string | null;
  firstName: string;
  lastName: string;
}

async function findDriver(driverId: string): Promise<DriverRow | null> {
  const [row] = await db
    .select({
      id: drivers.id,
      email: drivers.email,
      firstName: drivers.firstName,
      lastName: drivers.lastName,
    })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  return row ?? null;
}

/** The driver's customer at the provider, or null when the driver has none there. */
async function customerFor(
  driverId: string,
  providerId: PaymentProviderId,
): Promise<string | null> {
  const [row] = await db
    .select({ customerId: driverPaymentCustomers.providerCustomerId })
    .from(driverPaymentCustomers)
    .where(
      and(
        eq(driverPaymentCustomers.driverId, driverId),
        eq(driverPaymentCustomers.provider, providerId),
      ),
    );
  return row?.customerId ?? null;
}

/**
 * Stores the driver's customer at the provider. A Stripe or simulated
 * customer is also written to `drivers.stripe_customer_id` (P4 dual write,
 * `legacy-columns.ts`).
 */
async function storeCustomer(
  driverId: string,
  providerId: PaymentProviderId,
  customerId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(driverPaymentCustomers)
      .values({ driverId, provider: providerId, providerCustomerId: customerId })
      .onConflictDoUpdate({
        target: [driverPaymentCustomers.driverId, driverPaymentCustomers.provider],
        set: { providerCustomerId: customerId, updatedAt: new Date() },
      });
    if (writesStripeColumns(providerId)) {
      await tx
        .update(drivers)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(drivers.id, driverId));
    }
  });
}

/** Whether another driver already holds this customer of the provider (customer row or saved method). */
async function customerOwnedByOtherDriver(
  providerId: PaymentProviderId,
  customerId: string,
  driverId: string,
): Promise<boolean> {
  const rows = await db.execute<{ owned: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM driver_payment_customers
      WHERE provider = ${providerId} AND provider_customer_id = ${customerId}
        AND driver_id <> ${driverId}
      UNION ALL
      SELECT 1 FROM driver_payment_methods
      WHERE provider = ${providerId} AND provider_customer_id = ${customerId}
        AND driver_id <> ${driverId}
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
  await storeCustomer(driver.id, provider.id, customerId);
  return customerId;
}

/**
 * The driver's customer at `provider`, created (key
 * `customer_<driverId>_<provider>`, P7) and stored when the driver has none
 * there yet.
 */
async function ensureCustomer(driver: DriverRow, provider: PaymentProvider): Promise<string> {
  const stored = await customerFor(driver.id, provider.id);
  if (stored != null) return stored;
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

/**
 * Stores a verified method of the driver's customer at the provider (both
 * column forms, P4). The driver's first method is the default. A method the
 * driver already has returns the stored row (ON CONFLICT, P7).
 */
async function insertMethod(
  driverId: string,
  providerId: PaymentProviderId,
  customerId: string,
  details: SavedMethodDetails,
): Promise<DriverPaymentMethod> {
  // The stripe_* copies stay NULL for other providers (Adyen), so pods of the
  // previous release never send their ids to Stripe (plan P10, layer 2).
  const stripeCustomerId = stripeColumnValue(providerId, customerId);
  const stripePaymentMethodId = stripeColumnValue(providerId, details.methodId);
  const existing = await db
    .select({ id: driverPaymentMethods.id })
    .from(driverPaymentMethods)
    .where(eq(driverPaymentMethods.driverId, driverId));
  const [method] = await db
    .insert(driverPaymentMethods)
    .values({
      driverId,
      provider: providerId,
      providerCustomerId: customerId,
      providerPaymentMethodId: details.methodId,
      stripeCustomerId,
      stripePaymentMethodId,
      cardBrand: details.brand,
      cardLast4: details.last4,
      isDefault: existing.length === 0,
    })
    .onConflictDoNothing({
      target: [
        driverPaymentMethods.driverId,
        driverPaymentMethods.provider,
        driverPaymentMethods.providerPaymentMethodId,
      ],
    })
    .returning();
  if (method != null) return method;
  // Saved before (a double submit or a retry): the stored row.
  const [saved] = await db
    .select()
    .from(driverPaymentMethods)
    .where(
      and(
        eq(driverPaymentMethods.driverId, driverId),
        eq(driverPaymentMethods.provider, providerId),
        eq(driverPaymentMethods.providerPaymentMethodId, details.methodId),
      ),
    );
  if (saved == null) throw new Error('Failed to save payment method');
  return saved;
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
 * PaymentMethod id) with the active provider, which started the setup. The
 * customer must be the driver's own at that provider; when an operator adds a
 * card for a driver without one (`adoptCustomer`), the customer of the setup
 * becomes the driver's. The provider reads the method back and checks it is
 * attached to that customer (a forged pair is refused), and its brand and
 * last 4 digits are stored. The first method is the default. Saving a method
 * the driver already has returns the stored row (P7).
 */
export async function saveDriverMethod(
  input: { driverId: string; customerId: string; methodId: string; adoptCustomer: boolean },
  ctx: PaymentContext,
): Promise<SaveMethodOutcome> {
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

  const stored = await customerFor(driver.id, provider.id);
  let customerId = stored;
  if (customerId == null) {
    if (!input.adoptCustomer) return { status: 'not_initialized' };
    // The setup's customer becomes the driver's, unless it is someone else's.
    if (await customerOwnedByOtherDriver(provider.id, input.customerId, driver.id)) {
      return { status: 'forbidden' };
    }
    customerId = input.customerId;
  }
  if (input.customerId !== customerId) return { status: 'forbidden' };

  let details;
  try {
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
  if (stored == null) await storeCustomer(driver.id, provider.id, customerId);

  const method = await insertMethod(driver.id, provider.id, customerId, details);
  return { status: 'saved', method };
}

export type SetupStepOutcome =
  | { status: 'saved'; method: DriverPaymentMethod }
  | { status: 'action_required'; action: ClientAction }
  | { status: 'refused'; reason: string }
  | {
      status:
        | 'driver_not_found'
        | 'not_initialized'
        | 'not_configured'
        | 'provider_mismatch'
        | 'forbidden';
    }
  | { status: 'invalid'; reason: string };

interface SetupTarget {
  driverId: string;
  provider: PaymentProvider;
  customerId: string;
}

/**
 * The active provider, which must be the provider the client ran its card UI
 * for, and the driver's customer there. The customer always comes from the
 * server, never the client. Without one the setup was not started
 * (`not_initialized`), unless `createCustomer` (an operator adding a card for
 * the driver), which creates it (key `customer_<driverId>_<provider>`, P7).
 */
async function setupTarget(
  driverId: string,
  providerId: string,
  createCustomer: boolean,
  ctx: PaymentContext,
): Promise<SetupTarget | SetupStepOutcome> {
  const driver = await findDriver(driverId);
  if (driver == null) return { status: 'driver_not_found' };
  let provider: PaymentProvider | null;
  try {
    provider = await activeProvider(ctx.registry);
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) return { status: 'not_configured' };
    throw err;
  }
  if (provider == null) return { status: 'not_configured' };
  if (provider.id !== providerId) return { status: 'provider_mismatch' };
  const stored = await customerFor(driver.id, provider.id);
  if (stored != null) return { driverId: driver.id, provider, customerId: stored };
  if (!createCustomer) return { status: 'not_initialized' };
  return { driverId: driver.id, provider, customerId: await ensureCustomer(driver, provider) };
}

/**
 * Runs one provider setup step and maps its result: a saved method is stored
 * (insertMethod), an action goes back to the client, a refusal keeps its
 * reason. A bad payload (unknown test card, no PaymentMethod id) or a step
 * the provider does not have is `invalid`, a method of another customer
 * `forbidden`, a decline `refused`. Other errors (provider unreachable) are
 * thrown (P9).
 */
async function runSetupStep(
  target: SetupTarget,
  step: () => Promise<MethodSetupStep>,
): Promise<SetupStepOutcome> {
  let result: MethodSetupStep;
  try {
    result = await step();
  } catch (err) {
    if (err instanceof PaymentValidationError || err instanceof PaymentOperationNotSupportedError) {
      return { status: 'invalid', reason: err.message };
    }
    if (err instanceof PaymentMethodOwnershipError) return { status: 'forbidden' };
    if (err instanceof PaymentDeclinedError) {
      return { status: 'refused', reason: err.code ?? err.message };
    }
    throw err;
  }
  if (result.status !== 'saved') return result;
  if (result.method.customerId !== target.customerId) return { status: 'forbidden' };
  const method = await insertMethod(
    target.driverId,
    target.provider.id,
    target.customerId,
    result.method,
  );
  return { status: 'saved', method };
}

/** First 32 hex characters of the SHA-256 of `value`: keys stay within 64 characters. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * Submits the card the client collected with the active provider's card UI
 * (Stripe: `{ paymentMethodId }` of the confirmed SetupIntent; simulated:
 * `{ testCard }`; Adyen: its encrypted card data). `providerId` is the
 * provider of the client's setup session; another active provider is
 * `provider_mismatch`. `attemptId` identifies the opened card form: the
 * provider call uses key `method_setup_<sha256(driverId:attemptId)[:32]>`
 * (P7, within Adyen's 64-character limit), and a replayed save returns the
 * stored row. With `adoptCustomer` (the operator
 * route) a driver without a customer at the provider gets one; the driver
 * flow needs the setup started first. `browser` (origin, server-built return
 * URL, browser info) lets the provider ask for a 3DS step.
 */
export async function submitDriverMethodSetup(
  input: {
    driverId: string;
    providerId: string;
    attemptId: string;
    payload: unknown;
    /** The shopper's browser for a 3DS step (Adyen needs it; Stripe and simulated ignore it). */
    browser?: BrowserContext;
    adoptCustomer: boolean;
  },
  ctx: PaymentContext,
): Promise<SetupStepOutcome> {
  const target = await setupTarget(input.driverId, input.providerId, input.adoptCustomer, ctx);
  if ('status' in target) return target;
  return runSetupStep(target, () =>
    target.provider.submitMethodSetup({
      customerId: target.customerId,
      payload: input.payload,
      ...(input.browser != null ? { browser: input.browser } : {}),
      idempotencyKey: `method_setup_${digest(`${input.driverId}:${input.attemptId}`)}`,
    }),
  );
}

/**
 * Continues a setup step that needed a client action (a 3DS result, the
 * simulated challenge `{ methodId, outcome }`), with key
 * `method_setup_details_<sha256(driverId:attemptId:details)[:32]>` (P7): a
 * replay of the same details reaches the same provider answer, and a second
 * step of the same attempt (3DS2 fingerprint, then challenge) gets its own key.
 */
export async function continueDriverMethodSetup(
  input: { driverId: string; providerId: string; attemptId: string; details: unknown },
  ctx: PaymentContext,
): Promise<SetupStepOutcome> {
  const target = await setupTarget(input.driverId, input.providerId, false, ctx);
  if ('status' in target) return target;
  return runSetupStep(target, () =>
    target.provider.continueMethodSetup({
      customerId: target.customerId,
      details: input.details,
      idempotencyKey: `method_setup_details_${digest(
        `${input.driverId}:${input.attemptId}:${JSON.stringify(input.details ?? null)}`,
      )}`,
    }),
  );
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
  const missing = rows.filter((r) => r.cardLast4 == null && r.provider !== 'simulated');
  await Promise.all(
    missing.map(async (row) => {
      try {
        if (row.providerCustomerId == null || row.providerPaymentMethodId == null) {
          throw new Error('Payment method has no provider ids');
        }
        const provider = await pinnedProvider(ctx.registry, row.provider);
        const details = await provider.verifyMethod({
          methodId: row.providerPaymentMethodId,
          customerId: row.providerCustomerId,
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
          { err, paymentMethodId: row.providerPaymentMethodId },
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
        AND pr.provider = ${method.provider}
        AND pr.provider_payment_method_id = ${method.providerPaymentMethodId}
        AND pr.status IN ('pending', 'pre_authorized')
        AND cs.status = 'active'
    `);
    if ((inUse[0]?.count ?? 0) > 0) return { status: 'in_use' };
  }

  try {
    if (method.providerCustomerId == null || method.providerPaymentMethodId == null) {
      throw new Error('Payment method has no provider ids');
    }
    const provider = await pinnedProvider(ctx.registry, method.provider);
    await provider.detachMethod({
      customerId: method.providerCustomerId,
      methodId: method.providerPaymentMethodId,
    });
  } catch (err) {
    // An unconfigured provider or an already detached method is expected;
    // the provider-side method is left for manual cleanup (P9 fail open).
    ctx.logger.warn(
      { err, paymentMethodId: method.providerPaymentMethodId },
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
