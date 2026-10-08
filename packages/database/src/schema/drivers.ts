// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  text,
  serial,
  varchar,
  integer,
  bigint,
  numeric,
  boolean,
  timestamp,
  date,
  smallint,
  check,
  index,
  uniqueIndex,
  unique,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createId } from '../lib/id.js';
import { chargingStations } from './assets.js';
import { chargingSessions } from './charging.js';

export const guestSessionStatusEnum = pgEnum('guest_session_status', [
  'pending_payment',
  'payment_authorized',
  'charging',
  'completed',
  'failed',
  'expired',
]);

export const drivers = pgTable(
  'drivers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('driver')),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    email: varchar('email', { length: 255 }),
    phone: varchar('phone', { length: 50 }),
    passwordHash: varchar('password_hash', { length: 255 }),
    registrationSource: varchar('registration_source', { length: 20 }).notNull().default('admin'),
    language: varchar('language', { length: 10 }).notNull().default('en'),
    timezone: varchar('timezone', { length: 50 }).notNull().default('America/New_York'),
    themePreference: varchar('theme_preference', { length: 10 }).notNull().default('light'),
    distanceUnit: varchar('distance_unit', { length: 10 }).notNull().default('miles'),
    // 'gross' or 'net'. Null follows the company setting company.priceDisplay.
    priceDisplay: varchar('price_display', { length: 10 }),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    mfaMethod: varchar('mfa_method', { length: 20 }),
    totpSecretEnc: varchar('totp_secret_enc', { length: 500 }),
    isActive: boolean('is_active').notNull().default(true),
    emailVerified: boolean('email_verified').notNull().default(false),
    lastNotificationReadAt: timestamp('last_notification_read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_drivers_email').on(table.email),
    // Partial unique index on LOWER(email) is defined in migration
    // 0052_drivers_email_partial_unique.sql (Drizzle's uniqueIndex does not
    // support expression columns or partial WHERE clauses, so the index is
    // SQL-only). Combined with email normalization in the API layer, this
    // enforces case-insensitive uniqueness on non-null driver emails.
  ],
);

export const driverNotificationPreferences = pgTable(
  'driver_notification_preferences',
  {
    id: serial('id').primaryKey(),
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    emailEnabled: boolean('email_enabled').notNull().default(true),
    smsEnabled: boolean('sms_enabled').notNull().default(true),
    pushEnabled: boolean('push_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_driver_notification_prefs_driver').on(table.driverId)],
);

export const guestSessions = pgTable(
  'guest_sessions',
  {
    id: serial('id').primaryKey(),
    stationOcppId: varchar('station_ocpp_id', { length: 255 }).notNull(),
    evseId: integer('evse_id').notNull(),
    chargingSessionId: text('charging_session_id').references(() => chargingSessions.id, {
      onDelete: 'cascade',
    }),
    // Provider of the guest's hold and its payment id. Null for a free guest
    // session.
    provider: varchar('provider', { length: 32 }),
    providerPaymentId: varchar('provider_payment_id', { length: 255 }),
    guestEmail: varchar('guest_email', { length: 255 }).notNull(),
    preAuthAmountCents: integer('pre_auth_amount_cents'),
    // Transaction limit returned in the OCPP 2.1 TransactionEventResponse when
    // the transaction starts (C24.FR.02, C25.FR.24). Null means no limit.
    maxCostCents: integer('max_cost_cents'),
    maxEnergyWh: integer('max_energy_wh'),
    maxTimeSeconds: integer('max_time_seconds'),
    status: guestSessionStatusEnum('status').notNull().default('pending_payment'),
    sessionToken: varchar('session_token', { length: 64 }).notNull().unique(),
    // Payments P10 Part B: set by the one request that sends
    // RequestStartTransaction for this session (the start route, or the
    // 3DS details route, which can run more than once). Null until then.
    startRequestedAt: timestamp('start_requested_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_guest_sessions_station').on(table.stationOcppId, table.evseId),
    index('idx_guest_sessions_token').on(table.sessionToken),
    index('idx_guest_sessions_status').on(table.status),
    index('idx_guest_sessions_charging_session').on(table.chargingSessionId),
  ],
);

export const driverTokens = pgTable(
  'driver_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('driverToken')),
    driverId: text('driver_id').references(() => drivers.id, { onDelete: 'cascade' }),
    idToken: varchar('id_token', { length: 255 }).notNull(),
    tokenType: varchar('token_type', { length: 20 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: varchar('revoked_reason', { length: 100 }),
    // Prepaid credit in cents of the company currency (OCPP 2.1 C17). Null
    // means the token is not prepaid. Zero or less is answered NoCredit.
    prepaidBalanceCents: integer('prepaid_balance_cents'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_driver_tokens_id_token').on(table.idToken),
    index('idx_driver_tokens_driver_id').on(table.driverId),
    index('idx_driver_tokens_expires_at').on(table.expiresAt),
  ],
);

// tokenAuditLog moved to schema/audit.ts as part of the unified per-entity
// audit scheme (migration 0035). Re-exported here for backward compatibility
// with importers that still reach into schema/drivers.
export { tokenAuditLog, tokenAuditActionEnum } from './audit.js';

export const authorizeOutcomeEnum = pgEnum('authorize_outcome', [
  'accepted',
  'invalid',
  'blocked',
  'expired',
  'no_credit',
  'concurrent_tx',
  'unknown',
  'db_error',
]);

export const authorizeAttempts = pgTable(
  'authorize_attempts',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id'),
    idToken: varchar('id_token', { length: 255 }).notNull(),
    tokenType: varchar('token_type', { length: 20 }),
    matchedTokenId: text('matched_token_id'),
    matchedDriverId: text('matched_driver_id'),
    outcome: authorizeOutcomeEnum('outcome').notNull(),
    ocppVersion: varchar('ocpp_version', { length: 10 }),
    reason: varchar('reason', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_authorize_attempts_station_created_at').on(table.stationId, table.createdAt),
    index('idx_authorize_attempts_id_token').on(table.idToken),
    index('idx_authorize_attempts_outcome').on(table.outcome),
    index('idx_authorize_attempts_created_at').on(table.createdAt),
    index('idx_authorize_attempts_matched_token_id').on(table.matchedTokenId),
    index('idx_authorize_attempts_matched_driver_id').on(table.matchedDriverId),
  ],
);

export const vehicles = pgTable(
  'vehicles',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('vehicle')),
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    make: varchar('make', { length: 100 }),
    model: varchar('model', { length: 100 }),
    year: varchar('year', { length: 4 }),
    vin: varchar('vin', { length: 17 }),
    licensePlate: varchar('license_plate', { length: 20 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_vehicles_driver_id').on(table.driverId)],
);

export const fleets = pgTable(
  'fleets',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('fleet')),
    name: varchar('name', { length: 255 }).notNull(),
    description: varchar('description', { length: 500 }),
    // Charge on account: the members' sessions are billed to the fleet (no card,
    // no hold). Off: the members pay by card. See features/fleet-billing.md.
    accountBillingEnabled: boolean('account_billing_enabled').notNull().default(false),
    // Fleet billing profile (who the fleet invoice goes to and how). Written
    // only by updateFleetBillingProfile in fleet.service.ts.
    billingContactEmails: text('billing_contact_emails')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    billingLegalName: varchar('billing_legal_name', { length: 255 }),
    billingStreet: varchar('billing_street', { length: 255 }),
    billingCity: varchar('billing_city', { length: 100 }),
    billingState: varchar('billing_state', { length: 100 }),
    billingZip: varchar('billing_zip', { length: 20 }),
    billingCountry: varchar('billing_country', { length: 100 }),
    billingTaxId: varchar('billing_tax_id', { length: 50 }),
    invoiceLanguage: varchar('invoice_language', { length: 10 }).notNull().default('en'),
    // Days from issue to due date; null uses the invoice.paymentTermsDays setting.
    paymentTermsDays: integer('payment_terms_days'),
    // The monthly run invoices the fleet automatically (needs a billing contact).
    autoInvoice: boolean('auto_invoice').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Credit limit of the account billing (cents of the company currency, null:
    // no limit). An account start is refused while the fleet's exposure is at or
    // above it; the billing contacts are warned at the warning percent. See
    // features/fleet-billing.md (credit limit).
    creditLimitCents: integer('credit_limit_cents'),
    creditLimitWarningPercent: smallint('credit_limit_warning_percent').notNull().default(80),
  },
  (table) => [
    check(
      'fleets_payment_terms_days_check',
      sql`${table.paymentTermsDays} IS NULL OR ${table.paymentTermsDays} BETWEEN 0 AND 365`,
    ),
    check(
      'fleets_auto_invoice_contact_check',
      sql`NOT ${table.autoInvoice} OR cardinality(${table.billingContactEmails}) > 0`,
    ),
    check(
      'fleets_credit_limit_cents_check',
      sql`${table.creditLimitCents} IS NULL OR ${table.creditLimitCents} > 0`,
    ),
    check(
      'fleets_credit_limit_warning_percent_check',
      sql`${table.creditLimitWarningPercent} BETWEEN 1 AND 99`,
    ),
  ],
);

/** The credit limit notices of a fleet: a warning and a reached notice. */
export const FLEET_CREDIT_LIMIT_NOTICE_KINDS = ['warning', 'reached'] as const;
export type FleetCreditLimitNoticeKind = (typeof FLEET_CREDIT_LIMIT_NOTICE_KINDS)[number];

/**
 * One row per fleet, calendar month (system timezone) and notice kind: the
 * claim that sends fleet.CreditLimitWarning and fleet.CreditLimitReached once
 * per month (P7).
 */
export const fleetCreditLimitNotices = pgTable(
  'fleet_credit_limit_notices',
  {
    fleetId: text('fleet_id')
      .notNull()
      .references(() => fleets.id, { onDelete: 'cascade' }),
    periodStart: date('period_start').notNull(),
    kind: varchar('kind', { length: 8 }).$type<FleetCreditLimitNoticeKind>().notNull(),
    exposureCents: bigint('exposure_cents', { mode: 'number' }).notNull(),
    limitCents: bigint('limit_cents', { mode: 'number' }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'fleet_credit_limit_notices_pkey',
      columns: [table.fleetId, table.periodStart, table.kind],
    }),
    check('fleet_credit_limit_notices_kind_check', sql`${table.kind} IN ('warning', 'reached')`),
  ],
);

/**
 * One row per fleet and month (system timezone) whose scheduled invoice job
 * failed for good. `invoice_number` is the live invoice of the month at the
 * failure (issued, email not sent), null when none was issued. The hourly
 * fleet-invoice-run cron claims the rows not reported yet (`reported_at`) and
 * sends one fleet.InvoiceRunFailed digest per month. The scheduled run skips
 * a recorded month: the operator bills it by hand.
 */
export const fleetInvoiceRunFailures = pgTable(
  'fleet_invoice_run_failures',
  {
    fleetId: text('fleet_id')
      .notNull()
      .references(() => fleets.id, { onDelete: 'cascade' }),
    periodStart: date('period_start').notNull(),
    invoiceNumber: text('invoice_number'),
    errorMessage: text('error_message').notNull(),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      name: 'fleet_invoice_run_failures_pkey',
      columns: [table.fleetId, table.periodStart],
    }),
    index('idx_fleet_invoice_run_failures_unreported')
      .on(table.failedAt)
      .where(sql`${table.reportedAt} IS NULL`),
  ],
);

export const fleetDrivers = pgTable(
  'fleet_drivers',
  {
    id: serial('id').primaryKey(),
    fleetId: text('fleet_id')
      .notNull()
      .references(() => fleets.id, { onDelete: 'cascade' }),
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    // The member pays by card although the fleet bills on account.
    accountBillingOptOut: boolean('account_billing_opt_out').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_fleet_drivers_fleet_id').on(table.fleetId),
    index('idx_fleet_drivers_driver_id').on(table.driverId),
    unique('uq_fleet_drivers_fleet_driver').on(table.fleetId, table.driverId),
  ],
);

export const fleetStations = pgTable(
  'fleet_stations',
  {
    id: serial('id').primaryKey(),
    fleetId: text('fleet_id')
      .notNull()
      .references(() => fleets.id, { onDelete: 'cascade' }),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_fleet_stations_fleet_id').on(table.fleetId),
    index('idx_fleet_stations_station_id').on(table.stationId),
    unique('uq_fleet_stations_fleet_station').on(table.fleetId, table.stationId),
  ],
);

export const driverFavoriteStations = pgTable(
  'driver_favorite_stations',
  {
    id: serial('id').primaryKey(),
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_driver_favorite_stations_unique').on(table.driverId, table.stationId),
    index('idx_driver_favorite_stations_driver').on(table.driverId),
  ],
);

export const stationWatches = pgTable(
  'station_watches',
  {
    id: serial('id').primaryKey(),
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // Unfired watches auto-expire so stale rows do not linger after a driver
    // forgets about them. The dispatch path filters on expires_at > now().
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (table) => [
    uniqueIndex('idx_station_watches_unique').on(table.driverId, table.stationId),
    index('idx_station_watches_driver').on(table.driverId),
    index('idx_station_watches_station').on(table.stationId),
    // Supports the cache refresh (expires_at > now()) and the prune cron.
    index('idx_station_watches_expires').on(table.expiresAt),
  ],
);

export const vehicleEfficiencyLookup = pgTable(
  'vehicle_efficiency_lookup',
  {
    id: serial('id').primaryKey(),
    make: varchar('make', { length: 100 }).notNull(),
    model: varchar('model', { length: 100 }).notNull(),
    year: varchar('year', { length: 4 }),
    efficiencyMiPerKwh: numeric('efficiency_mi_per_kwh', { precision: 5, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_vel_make_model_year').on(
      sql`LOWER(${table.make})`,
      sql`LOWER(${table.model})`,
      sql`COALESCE(${table.year}, '')`,
    ),
  ],
);
