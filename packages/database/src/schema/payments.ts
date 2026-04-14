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
} from 'drizzle-orm/pg-core';
import { sites } from './assets.js';
import { drivers } from './drivers.js';
import { chargingSessions } from './charging.js';

export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'pre_authorized',
  'captured',
  'partially_refunded',
  'refunded',
  'failed',
  'cancelled',
]);

export const sitePaymentConfigs = pgTable('site_payment_configs', {
  id: serial('id').primaryKey(),
  siteId: text('site_id')
    .notNull()
    .unique()
    .references(() => sites.id, { onDelete: 'cascade' }),
  stripeConnectedAccountId: varchar('stripe_connected_account_id', { length: 255 }),
  currency: varchar('currency', { length: 3 }).notNull().default('USD'),
  preAuthAmountCents: integer('pre_auth_amount_cents').notNull().default(5000),
  platformFeePercent: numeric('platform_fee_percent'),
  isEnabled: boolean('is_enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const driverPaymentMethods = pgTable(
  'driver_payment_methods',
  {
    id: serial('id').primaryKey(),
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    stripeCustomerId: varchar('stripe_customer_id', { length: 255 }).notNull(),
    stripePaymentMethodId: varchar('stripe_payment_method_id', { length: 255 }).notNull(),
    cardBrand: varchar('card_brand', { length: 20 }),
    cardLast4: varchar('card_last4', { length: 4 }),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_driver_payment_methods_driver_id').on(table.driverId),
    index('idx_driver_payment_methods_stripe_customer_id').on(table.stripeCustomerId),
  ],
);

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
    paymentSource: varchar('payment_source', { length: 20 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    preAuthAmountCents: integer('pre_auth_amount_cents'),
    capturedAmountCents: integer('captured_amount_cents'),
    refundedAmountCents: integer('refunded_amount_cents').notNull().default(0),
    status: paymentStatusEnum('status').notNull().default('pending'),
    failureReason: varchar('failure_reason', { length: 500 }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_payment_records_session_id').on(table.sessionId),
    index('idx_payment_records_driver_id').on(table.driverId),
    index('idx_payment_records_status').on(table.status),
    index('idx_payment_records_stripe_payment_intent_id').on(table.stripePaymentIntentId),
    index('idx_payment_records_created_at').on(table.createdAt),
    index('idx_payment_records_site_payment_config_id').on(table.sitePaymentConfigId),
  ],
);
