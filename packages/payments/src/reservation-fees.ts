// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import {
  chargingStations,
  db,
  driverPaymentMethods,
  getCompanyCurrency,
  getPlatformFeePercent,
  paymentRecords,
  reservations,
  resolveReservationFeeTerms,
  writeReservationAudit,
} from '@evtivity/database';
import type { PaymentChargeType } from '@evtivity/database';
import { priceFee, priceTimedFee, reservationHoldingMinutes } from '@evtivity/lib';
import type { PricedAmount, TaxBasis } from '@evtivity/lib';
import type { PaymentContext } from './context.js';
import { errorMessage } from './context.js';
import { PaymentDeclinedError, PaymentProviderNotConfiguredError } from './errors.js';
import { reservationFeeKey } from './idempotency-keys.js';
import { pinnedProvider } from './pinning.js';
import {
  findReservationCharge,
  markChargeCaptured,
  markChargeFailed,
  recordPendingCharge,
  reservationFeeRequest,
} from './payment-records.js';
import { PAYOUT_NOT_READY_FAILURE, sitePayoutReadiness } from './payout-accounts.js';
import { getSitePaymentConfig } from './settings.js';
import type { PaymentProvider } from './types.js';

/**
 * Reservation cancellation and no-show fees. The fee is entered in the
 * company tax basis, like tariff prices (net: tax is added; gross: tax is
 * included), and priced by the pricing engine (priceFee, priceTimedFee) at
 * the tax rate of the station's tariff for the driver. The caller passes the
 * reservation's fee terms (resolveReservationFeeTerms in @evtivity/database:
 * the snapshot taken at creation, or the current terms for an older
 * reservation). Each charge is a payment record (`charge_type`,
 * `reservation_id`, `tax_rate`), charged on the driver's default card through
 * the provider the card is saved with and the site's payout account, with the
 * platform fee of its net amount, and counted in revenue.
 */
export type ReservationFeeType = Extract<
  PaymentChargeType,
  'reservation_cancellation' | 'reservation_no_show'
>;

export interface ReservationFeeInput {
  type: ReservationFeeType;
  /** Internal reservation row id. */
  reservationId: string;
  driverId: string;
  siteId: string | null;
  /**
   * The fee in the tax basis: a flat amount in cents of the company currency
   * (cancellation fee), or a price per minute in major units times the
   * minutes held (no-show fee).
   */
  fee: { amountCents: number } | { pricePerMinute: string | number | null; minutes: number };
  /** The tax basis the fee is entered in. */
  basis: TaxBasis;
  /** Tax rate as a fraction (0.19); null for none. */
  taxRate: string | number | null;
}

/** The fee of a charge, net, tax, and gross, from the pricing engine. */
export function priceReservationFee(
  input: Pick<ReservationFeeInput, 'fee' | 'basis' | 'taxRate'>,
): PricedAmount {
  return 'amountCents' in input.fee
    ? priceFee({ amountCents: input.fee.amountCents, taxRate: input.taxRate, basis: input.basis })
    : priceTimedFee({
        pricePerMinute: input.fee.pricePerMinute,
        minutes: input.fee.minutes,
        taxRate: input.taxRate,
        basis: input.basis,
      });
}

export type ReservationFeeResult =
  | {
      status: 'charged';
      paymentRecordId: number;
      grossCents: number;
      netCents: number;
      taxCents: number;
      taxRate: number;
      currency: string;
    }
  /** Nothing charged: no amount, no default card, or payments not configured. */
  | { status: 'skipped'; reason: 'no_amount' | 'no_payment_method' | 'payments_not_configured' }
  /** The fee for this reservation and type was already recorded (a retry). */
  | { status: 'duplicate'; paymentRecordId: number }
  | { status: 'failed'; paymentRecordId: number; reason: string };

const DESCRIPTION: Record<ReservationFeeType, string> = {
  reservation_cancellation: 'Reservation cancellation fee',
  reservation_no_show: 'Reservation no-show fee',
};

/**
 * Why a fee charge failed, as the reason of its `fee_failed` audit row
 * (`RESERVATION_FEE_FAILURE_REASONS` in `@evtivity/lib/ai-insights`).
 */
type FeeFailureReason = 'declined' | 'no_payment_method' | 'provider_error';

/**
 * Audits a charge outcome on the reservation (G17): `fee_charged` with the
 * amount, or `fee_failed` with its reason. The reservation insights read the
 * `fee_failed` rows. Fail-open: writeAudit logs and continues (P9).
 */
async function auditFee(
  input: ReservationFeeInput,
  ctx: PaymentContext,
  outcome:
    | { kind: 'charged'; paymentRecordId: number; grossCents: number; currency: string }
    | { kind: 'failed'; reason: FeeFailureReason; paymentRecordId: number | null; detail: string },
): Promise<void> {
  const label = input.type === 'reservation_no_show' ? 'no-show fee' : 'cancellation fee';
  await writeReservationAudit(
    outcome.kind === 'charged'
      ? {
          reservationId: input.reservationId,
          action: 'fee_charged',
          actor: 'system',
          notes: `${label} ${String(outcome.grossCents)} ${outcome.currency}, payment record ${String(outcome.paymentRecordId)}`,
        }
      : {
          reservationId: input.reservationId,
          action: 'fee_failed',
          actor: 'system',
          reason: outcome.reason,
          notes:
            outcome.paymentRecordId != null
              ? `${label}, payment record ${String(outcome.paymentRecordId)}: ${outcome.detail}`
              : `${label}: ${outcome.detail}`,
        },
    undefined,
    {
      warn: (obj, msg) => {
        ctx.logger.warn(obj as object, msg);
      },
    },
  );
}

/**
 * Charges a reservation fee once. The payment record is inserted as `pending`
 * before the card is charged (unique per reservation and fee type, so a retry
 * or a concurrent call charges nothing), then marked `captured` or `failed`.
 * A crash between the two leaves the `pending` record for reconciliation.
 * The idempotency key derives from the reservation id
 * (`cancellation-fee-<id>`, `no-show-fee-<id>`).
 */
export async function chargeReservationFee(
  input: ReservationFeeInput,
  ctx: PaymentContext,
): Promise<ReservationFeeResult> {
  const charge = priceReservationFee(input);
  if (charge.grossCents <= 0) return { status: 'skipped', reason: 'no_amount' };
  const taxRate = charge.taxRate;

  const [method] = await db
    .select({
      provider: driverPaymentMethods.provider,
      customerId: driverPaymentMethods.providerCustomerId,
      methodId: driverPaymentMethods.providerPaymentMethodId,
    })
    .from(driverPaymentMethods)
    .where(
      and(
        eq(driverPaymentMethods.driverId, input.driverId),
        eq(driverPaymentMethods.isDefault, true),
      ),
    )
    .limit(1);
  if (method == null) {
    await auditFee(input, ctx, {
      kind: 'failed',
      reason: 'no_payment_method',
      paymentRecordId: null,
      detail: 'the driver has no default payment method',
    });
    return { status: 'skipped', reason: 'no_payment_method' };
  }
  const customerId = method.customerId;
  const methodId = method.methodId;

  let provider: PaymentProvider;
  try {
    provider = await pinnedProvider(ctx.registry, method.provider);
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) {
      await auditFee(input, ctx, {
        kind: 'failed',
        reason: 'provider_error',
        paymentRecordId: null,
        detail: 'the payment provider of the card is not configured',
      });
      return { status: 'skipped', reason: 'payments_not_configured' };
    }
    throw err;
  }

  const [currency, site, platformFeePercent] = await Promise.all([
    getCompanyCurrency(),
    input.siteId != null ? getSitePaymentConfig(input.siteId) : Promise.resolve(null),
    getPlatformFeePercent(input.siteId),
  ]);
  const payoutAccountId = site?.payoutAccountId ?? null;

  // The request is stored with the record: a resume after a crash sends the
  // same parameters with the same key, which the provider requires (G11).
  const recordId = await recordPendingCharge(
    {
      chargeType: input.type,
      reservationId: input.reservationId,
      driverId: input.driverId,
      sitePaymentConfigId: site?.configId ?? null,
      provider: provider.id,
      customerId,
      methodId,
      currency,
      taxRate,
      feeRequest: { grossCents: charge.grossCents, platformFeePercent, payoutAccountId },
    },
    ctx,
  );
  if (recordId == null) {
    const existing = await findReservationCharge(input.reservationId, input.type);
    return { status: 'duplicate', paymentRecordId: existing ?? 0 };
  }

  return chargeRecordedFee(
    recordId,
    input,
    charge,
    { provider, customerId, methodId, currency, payoutAccountId, platformFeePercent },
    ctx,
  );
}

interface RecordedFeeTarget {
  provider: PaymentProvider;
  customerId: string;
  methodId: string;
  currency: string;
  payoutAccountId: string | null;
  platformFeePercent: number;
}

/**
 * Charges a recorded `pending` fee once on the provider with the reservation
 * key (`cancellation-fee-<id>`, `no-show-fee-<id>`), then marks the record
 * `captured` or `failed` and audits the outcome. Shared by the first charge
 * and the reconciliation resume of a record whose charge never answered: the
 * same key makes the provider replay the first answer (P7).
 */
async function chargeRecordedFee(
  recordId: number,
  input: ReservationFeeInput,
  charge: PricedAmount,
  target: RecordedFeeTarget,
  ctx: PaymentContext,
): Promise<ReservationFeeResult> {
  const { provider, customerId, methodId, currency } = target;
  const taxRate = charge.taxRate;
  // O5, fail closed: a payout account that is not ready gets no charge, and
  // the charge is not moved to the platform either.
  const readiness =
    input.siteId != null && target.payoutAccountId != null
      ? await sitePayoutReadiness(input.siteId, ctx)
      : 'none';
  if (readiness === 'not_ready') {
    await markChargeFailed(recordId, PAYOUT_NOT_READY_FAILURE, ctx);
    await auditFee(input, ctx, {
      kind: 'failed',
      reason: 'provider_error',
      paymentRecordId: recordId,
      detail: PAYOUT_NOT_READY_FAILURE,
    });
    ctx.logger.warn(
      { paymentRecordId: recordId, reservationId: input.reservationId, siteId: input.siteId },
      'Reservation fee not charged: the payout account of the site is not ready',
    );
    return { status: 'failed', paymentRecordId: recordId, reason: PAYOUT_NOT_READY_FAILURE };
  }

  let paymentId: string;
  try {
    const result = await provider.chargeSavedMethod({
      customerId,
      methodId,
      grossCents: charge.grossCents,
      currency,
      feeTaxRate: taxRate,
      platformFeePercent: target.platformFeePercent,
      payoutAccountId: target.payoutAccountId,
      description: DESCRIPTION[input.type],
      metadata: { reservationId: input.reservationId, type: `${input.type}_fee` },
      idempotencyKey: reservationFeeKey(input.type, input.reservationId),
    });
    paymentId = result.paymentId;
  } catch (err) {
    const reason = errorMessage(err, 'Unknown payment error');
    await markChargeFailed(recordId, reason, ctx);
    await auditFee(input, ctx, {
      kind: 'failed',
      reason: err instanceof PaymentDeclinedError ? 'declined' : 'provider_error',
      paymentRecordId: recordId,
      detail: reason,
    });
    return { status: 'failed', paymentRecordId: recordId, reason };
  }

  if (
    !(await markChargeCaptured(
      recordId,
      {
        provider: provider.id,
        paymentId,
        amountCents: charge.grossCents,
      },
      ctx,
    ))
  ) {
    ctx.logger.error(
      { paymentRecordId: recordId, paymentId },
      'Reservation fee charged but its record had moved on; manual reconciliation required',
    );
  }
  await auditFee(input, ctx, {
    kind: 'charged',
    paymentRecordId: recordId,
    grossCents: charge.grossCents,
    currency,
  });
  return {
    status: 'charged',
    paymentRecordId: recordId,
    grossCents: charge.grossCents,
    netCents: charge.netCents,
    taxCents: charge.taxCents,
    taxRate,
    currency,
  };
}

/**
 * A reservation fee record whose charge has not answered for this long is
 * resumed by reconciliation (a crash after `recordPendingCharge`, G11). Fee
 * charges answer in seconds, so an hour leaves a running charge alone.
 */
export const RESERVATION_FEE_RESUME_AFTER_MINUTES = 60;
/**
 * Inside this window the provider still replays the key (Stripe keeps keys
 * 24 hours), so a resume charges once. An older record is marked `failed`.
 */
export const RESERVATION_FEE_RESUME_MAX_HOURS = 23;
const RESERVATION_FEE_RESUME_LIMIT = 200;

export interface ReservationFeeResumeResult {
  /** Records charged again with their key. */
  resumed: number;
  /** Records past the key window, marked failed for an operator to check. */
  expired: number;
  /** Records that could not be resumed (reservation missing, provider lookup failed). */
  errors: string[];
}

/** The `ReservationFeeInput` of a recorded fee, rebuilt from the reservation's terms. */
async function feeInputOfRecord(
  reservationId: string,
  type: ReservationFeeType,
  driverId: string,
): Promise<ReservationFeeInput | null> {
  const [row] = await db
    .select({
      stationId: reservations.stationId,
      driverId: reservations.driverId,
      siteId: chargingStations.siteId,
      startsAt: reservations.startsAt,
      createdAt: reservations.createdAt,
      expiresAt: reservations.expiresAt,
      feeTaxBasis: reservations.feeTaxBasis,
      feeTaxRate: reservations.feeTaxRate,
      feePerMinute: reservations.feePerMinute,
      feeCancellationCents: reservations.feeCancellationCents,
    })
    .from(reservations)
    .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
    .where(eq(reservations.id, reservationId))
    .limit(1);
  if (row == null) return null;
  const terms = await resolveReservationFeeTerms(row);
  return {
    type,
    reservationId,
    driverId,
    siteId: row.siteId,
    fee:
      type === 'reservation_no_show'
        ? {
            pricePerMinute: terms.feePerMinute,
            minutes: reservationHoldingMinutes({
              startsAt: row.startsAt,
              createdAt: row.createdAt,
              expiresAt: row.expiresAt,
            }),
          }
        : { amountCents: terms.cancellationFeeCents },
    basis: terms.basis,
    taxRate: terms.taxRate,
  };
}

/**
 * Resumes reservation fee records left `pending` without a provider payment
 * (G11): the process crashed after `recordPendingCharge`. Inside
 * RESERVATION_FEE_RESUME_MAX_HOURS the charge runs again with the same key and
 * the amount rebuilt from the reservation's terms, so the provider replays a
 * charge that went through and makes one that did not. An older record is
 * marked `failed` with a reason naming the key and audited `fee_failed`, the
 * `addStaleRebillCharges` pattern. Fail-open per record.
 */
export async function resumeStaleReservationFees(
  ctx: PaymentContext,
  now: Date = new Date(),
): Promise<ReservationFeeResumeResult> {
  const result: ReservationFeeResumeResult = { resumed: 0, expired: 0, errors: [] };
  const staleBefore = new Date(now.getTime() - RESERVATION_FEE_RESUME_AFTER_MINUTES * 60_000);
  const keyWindowStart = new Date(now.getTime() - RESERVATION_FEE_RESUME_MAX_HOURS * 3_600_000);
  const records = await db
    .select({
      id: paymentRecords.id,
      chargeType: paymentRecords.chargeType,
      reservationId: paymentRecords.reservationId,
      driverId: paymentRecords.driverId,
      provider: paymentRecords.provider,
      customerId: paymentRecords.providerCustomerId,
      methodId: paymentRecords.providerPaymentMethodId,
      currency: paymentRecords.currency,
      metadata: paymentRecords.metadata,
      createdAt: paymentRecords.createdAt,
    })
    .from(paymentRecords)
    .where(
      and(
        eq(paymentRecords.status, 'pending'),
        isNull(paymentRecords.providerPaymentId),
        isNotNull(paymentRecords.reservationId),
        inArray(paymentRecords.chargeType, ['reservation_cancellation', 'reservation_no_show']),
        lt(paymentRecords.createdAt, staleBefore),
      ),
    )
    .orderBy(paymentRecords.id)
    .limit(RESERVATION_FEE_RESUME_LIMIT);

  for (const record of records) {
    const reservationId = record.reservationId as string;
    const type = record.chargeType as ReservationFeeType;
    const key = reservationFeeKey(type, reservationId);
    try {
      if (record.createdAt < keyWindowStart) {
        const reason = `No provider answer within ${String(RESERVATION_FEE_RESUME_MAX_HOURS)} hours; check the provider for a payment with the key ${key}`;
        if (await markChargeFailed(record.id, reason, ctx)) {
          result.expired++;
          await auditFee(
            {
              type,
              reservationId,
              driverId: record.driverId ?? '',
              siteId: null,
              fee: { amountCents: 0 },
              basis: 'net',
              taxRate: null,
            },
            ctx,
            {
              kind: 'failed',
              reason: 'provider_error',
              paymentRecordId: record.id,
              detail: reason,
            },
          );
          ctx.logger.warn(
            { paymentRecordId: record.id, reservationId, key },
            'Reservation fee without a provider answer past the key window; marked failed',
          );
        }
        continue;
      }
      if (
        record.driverId == null ||
        record.provider == null ||
        record.customerId == null ||
        record.methodId == null
      ) {
        result.errors.push(`Reservation fee record ${String(record.id)} misses its payment ids`);
        continue;
      }
      const input = await feeInputOfRecord(reservationId, type, record.driverId);
      if (input == null) {
        result.errors.push(
          `Reservation fee record ${String(record.id)}: reservation ${reservationId} not found`,
        );
        continue;
      }
      const provider = await pinnedProvider(ctx.registry, record.provider);
      // The stored request keeps the parameters the key was first sent with:
      // a provider refuses a reused key with other parameters. A record from
      // before the request was stored is repriced on the reservation's terms.
      const stored = reservationFeeRequest(record.metadata);
      const priced = priceReservationFee(input);
      const site =
        stored == null && input.siteId != null ? await getSitePaymentConfig(input.siteId) : null;
      await chargeRecordedFee(
        record.id,
        input,
        stored != null ? { ...priced, grossCents: stored.grossCents } : priced,
        {
          provider,
          customerId: record.customerId,
          methodId: record.methodId,
          currency: record.currency,
          payoutAccountId:
            stored != null ? stored.payoutAccountId : (site?.payoutAccountId ?? null),
          platformFeePercent:
            stored != null ? stored.platformFeePercent : await getPlatformFeePercent(input.siteId),
        },
        ctx,
      );
      result.resumed++;
    } catch (err) {
      ctx.logger.warn(
        { err, paymentRecordId: record.id, reservationId },
        'Resuming a stale reservation fee failed',
      );
      result.errors.push(
        `Reservation fee record ${String(record.id)} not resumed: ${errorMessage(err, 'Unknown error')}`,
      );
    }
  }
  return result;
}
