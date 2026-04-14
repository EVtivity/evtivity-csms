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
  index,
  uniqueIndex,
  unique,
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
    // Partial unique index: only enforces uniqueness for non-null emails.
    // The actual index is created in migration 0022_production_hardening.sql
    // with a WHERE clause. Drizzle's uniqueIndex does not support WHERE,
    // so the index definition here is omitted to avoid conflicts.
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
    stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
    guestEmail: varchar('guest_email', { length: 255 }).notNull(),
    preAuthAmountCents: integer('pre_auth_amount_cents'),
    status: guestSessionStatusEnum('status').notNull().default('pending_payment'),
    sessionToken: varchar('session_token', { length: 64 }).notNull().unique(),
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
    driverId: text('driver_id').references(() => drivers.id, { onDelete: 'set null' }),
    idToken: varchar('id_token', { length: 255 }).notNull(),
    tokenType: varchar('token_type', { length: 20 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_driver_tokens_id_token').on(table.idToken),
    index('idx_driver_tokens_driver_id').on(table.driverId),
  ],
);

export const vehicles = pgTable('vehicles', {
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
});

export const fleets = pgTable('fleets', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId('fleet')),
  name: varchar('name', { length: 255 }).notNull(),
  description: varchar('description', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_fleet_drivers_fleet_id').on(table.fleetId),
    index('idx_fleet_drivers_driver_id').on(table.driverId),
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
