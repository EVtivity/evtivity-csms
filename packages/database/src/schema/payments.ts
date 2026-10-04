// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  text,
  serial,
  varchar,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { sites, chargingStations } from './assets.js';
import { drivers } from './drivers.js';
import { chargingSessions } from './charging.js';
import { users } from './identity.js';
import { reservations } from './reservations.js';

export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'pre_authorized',
  'captured',
  'partially_refunded',
  'refunded',
  'failed',
  'cancelled',
]);

/** Payout account states read from the provider (plan P3.5). */
export const PAYOUT_ACCOUNT_STATES = [
  'onboarding',
  'action_required',
  'pending',
  'active',
  'disabled',
] as const;

export const sitePaymentConfigs = pgTable(
  'site_payment_configs',
  {
    id: serial('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .unique()
      .references(() => sites.id, { onDelete: 'cascade' }),
    stripeConnectedAccountId: varchar('stripe_connected_account_id', { length: 255 }),
    // The site's payout account at the payment provider (P4). Same value as
    // stripe_connected_account_id until P8 drops that column.
    payoutAccountId: varchar('payout_account_id', { length: 255 }),
    preAuthAmountCents: integer('pre_auth_amount_cents').notNull().default(5000),
    platformFeePercent: numeric('platform_fee_percent'),
    isEnabled: boolean('is_enabled').notNull().default(true),
    // The payout account's state as last read from the provider. Null means
    // unknown (never read): the first use reads it.
    payoutAccountStatus: varchar('payout_account_status', { length: 20 }),
    // Capabilities, requirements due and disabled reason of that read.
    payoutAccountDetails: jsonb('payout_account_details'),
    // When that read happened; an older read never overwrites a newer one.
    payoutAccountCheckedAt: timestamp('payout_account_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'site_payment_configs_payout_account_status_check',
      sql`${table.payoutAccountStatus} IS NULL OR ${table.payoutAccountStatus} IN ('onboarding', 'action_required', 'pending', 'active', 'disabled')`,
    ),
    index('idx_site_payment_configs_payout_account_id').on(table.payoutAccountId),
  ],
);

/**
 * Onboarding invite links for a site host's payout account (plan P3.5, O4).
 * The raw token goes only into the link; the row keeps its SHA-256.
 */
export const sitePayoutInvites = pgTable(
  'site_payout_invites',
  {
    id: serial('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    sentTo: varchar('sent_to', { length: 255 }),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('site_payout_invites_token_hash_key').on(table.tokenHash),
    index('idx_site_payout_invites_site_id').on(table.siteId),
  ],
);

// Payments P4 (expand): the provider columns sit next to the stripe_* columns
// until P8 drops those. Triggers from 0120_payment_provider_columns.sql
// (payment_records_provider_sync, driver_payment_methods_provider_sync,
// guest_sessions_provider_sync, site_payment_configs_payout_sync and
// drivers_payment_customer_sync) copy the old columns written by pods of the
// previous release into the new ones; P8 drops them with the old columns.

export const driverPaymentMethods = pgTable(
  'driver_payment_methods',
  {
    id: serial('id').primaryKey(),
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    // Null for providers other than Stripe and simulated (payments P10, 0126):
    // pods of the previous release must never read an Adyen id as a Stripe id.
    stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
    stripePaymentMethodId: varchar('stripe_payment_method_id', { length: 255 }),
    // Nullable until P8 (rows of the previous release get them by trigger).
    provider: varchar('provider', { length: 32 }),
    providerCustomerId: varchar('provider_customer_id', { length: 255 }),
    providerPaymentMethodId: varchar('provider_payment_method_id', { length: 255 }),
    cardBrand: varchar('card_brand', { length: 20 }),
    cardLast4: varchar('card_last4', { length: 4 }),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_driver_payment_methods_driver_id').on(table.driverId),
    index('idx_driver_payment_methods_stripe_customer_id').on(table.stripeCustomerId),
    // Per driver, not global: before P2 operator saves did not verify methods,
    // so the same method id can sit on two drivers.
    uniqueIndex('uq_driver_payment_methods_driver_provider_method').on(
      table.driverId,
      table.provider,
      table.providerPaymentMethodId,
    ),
    index('idx_driver_payment_methods_provider_method').on(
      table.provider,
      table.providerPaymentMethodId,
    ),
    index('idx_driver_payment_methods_provider_customer').on(
      table.provider,
      table.providerCustomerId,
    ),
  ],
);

/** A driver's customer at each payment provider (P4). */
export const driverPaymentCustomers = pgTable(
  'driver_payment_customers',
  {
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    providerCustomerId: varchar('provider_customer_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.driverId, table.provider] }),
    index('idx_driver_payment_customers_provider_customer').on(
      table.provider,
      table.providerCustomerId,
    ),
  ],
);

/**
 * What a payment record charges: a charging session (one record per session,
 * session_id set) or a reservation fee (reservation_id set, one record per
 * reservation and fee type).
 */
/** An async operation waiting for the provider's webhook (payments P10, 0126). */
export const PENDING_PAYMENT_OPERATIONS = ['capture', 'cancel', 'adjust'] as const;
export type PendingPaymentOperation = (typeof PENDING_PAYMENT_OPERATIONS)[number];

/**
 * One provider refund of a payment record (`payment_records.provider_refunds`).
 * `refundId` is the provider's reference of the refund (Adyen: the modification
 * pspReference); `paymentId` the charge it refunds (the hold or a top-up).
 * Async refunds start `pending` and move once to `succeeded` or `failed`.
 */
export interface ProviderRefundEntry {
  refundId: string;
  paymentId: string;
  amountCents: number;
  state: 'pending' | 'succeeded' | 'failed';
  requestedAt: string;
  settledAt?: string;
}

export const PAYMENT_CHARGE_TYPES = [
  'session',
  'reservation_cancellation',
  'reservation_no_show',
] as const;
export type PaymentChargeType = (typeof PAYMENT_CHARGE_TYPES)[number];

export const paymentRecords = pgTable(
  'payment_records',
  {
    id: serial('id').primaryKey(),
    sessionId: text('session_id')
      .unique()
      .references(() => chargingSessions.id, { onDelete: 'cascade' }),
    driverId: text('driver_id').references(() => drivers.id, { onDelete: 'set null' }),
    sitePaymentConfigId: integer('site_payment_config_id').references(() => sitePaymentConfigs.id),
    stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }).unique(),
    stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
    stripePaymentMethodId: varchar('stripe_payment_method_id', { length: 255 }),
    // Provider of the stored ids; null for prepaid and terminal payments.
    provider: varchar('provider', { length: 32 }),
    providerPaymentId: varchar('provider_payment_id', { length: 255 }),
    providerCustomerId: varchar('provider_customer_id', { length: 255 }),
    providerPaymentMethodId: varchar('provider_payment_method_id', { length: 255 }),
    paymentSource: varchar('payment_source', { length: 20 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    preAuthAmountCents: integer('pre_auth_amount_cents'),
    capturedAmountCents: integer('captured_amount_cents'),
    refundedAmountCents: integer('refunded_amount_cents').notNull().default(0),
    status: paymentStatusEnum('status').notNull().default('pending'),
    failureReason: varchar('failure_reason', { length: 500 }),
    lastActorUserId: text('last_actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lastActionReason: varchar('last_action_reason', { length: 500 }),
    metadata: jsonb('metadata'),
    chargeType: varchar('charge_type', { length: 30 })
      .$type<PaymentChargeType>()
      .notNull()
      .default('session'),
    reservationId: text('reservation_id').references(() => reservations.id, {
      onDelete: 'set null',
    }),
    // Tax rate (fraction) a reservation fee was taxed at: the station tariff's
    // rate. The amount charged includes it. Null on session records, which
    // carry their rate on the session (tariff_tax_rate).
    taxRate: numeric('tax_rate'),
    // Async providers (payments P10): the operation waiting for its webhook,
    // the provider's reference of it (kept after confirmation, so a late
    // capture failure still matches) and when it was requested.
    pendingOperation: varchar('pending_operation', { length: 16 }).$type<PendingPaymentOperation>(),
    pendingOperationRef: varchar('pending_operation_ref', { length: 64 }),
    pendingOperationAt: timestamp('pending_operation_at', { withTimezone: true }),
    providerRefunds: jsonb('provider_refunds')
      .$type<ProviderRefundEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Opaque provider state of the hold (Adyen adjustAuthorisationData, P10d).
    providerState: jsonb('provider_state').$type<Record<string, string>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_payment_records_session_id').on(table.sessionId),
    check(
      'payment_records_pending_operation_check',
      sql`${table.pendingOperation} IS NULL OR ${table.pendingOperation} IN ('capture', 'cancel', 'adjust')`,
    ),
    index('idx_payment_records_pending_operation')
      .on(table.pendingOperationAt)
      .where(sql`${table.pendingOperation} IS NOT NULL`),
    uniqueIndex('uq_payment_records_reservation_charge')
      .on(table.reservationId, table.chargeType)
      .where(sql`${table.reservationId} IS NOT NULL`),
    check(
      'payment_records_charge_type_check',
      sql`${table.chargeType} IN ('session', 'reservation_cancellation', 'reservation_no_show')`,
    ),
    index('idx_payment_records_driver_id').on(table.driverId),
    index('idx_payment_records_status').on(table.status),
    index('idx_payment_records_stripe_payment_intent_id').on(table.stripePaymentIntentId),
    index('idx_payment_records_created_at').on(table.createdAt),
    index('idx_payment_records_site_payment_config_id').on(table.sitePaymentConfigId),
    uniqueIndex('payment_records_provider_payment_id_key').on(
      table.provider,
      table.providerPaymentId,
    ),
    // GIN index idx_payment_records_top_ups on (metadata -> 'topUps')
    // jsonb_path_ops is defined in 0123_payment_provider_indexes.sql (Drizzle
    // cannot express an expression index with an operator class). It serves
    // the top-up lookup metadata -> 'topUps' @> '[{"paymentId": ...}]'.
  ],
);

// Dynamic QR code ad hoc payments (OCPP 2.1 C25). One row per station that the
// CSMS configured through WebPaymentsCtrlr. The shared secret is AES-256-GCM
// ciphertext (SETTINGS_ENCRYPTION_KEY); the station holds it write-only.
export const stationWebPaymentConfigs = pgTable('station_web_payment_configs', {
  stationId: text('station_id')
    .primaryKey()
    .references(() => chargingStations.id, { onDelete: 'cascade' }),
  sharedSecretEnc: text('shared_secret_enc').notNull(),
  validitySeconds: integer('validity_seconds').notNull(),
  totpLength: integer('totp_length').notNull(),
  totpVersion: varchar('totp_version', { length: 10 }).notNull(),
  urlTemplate: text('url_template').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
