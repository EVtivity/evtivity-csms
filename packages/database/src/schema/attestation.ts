// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { pgTable, text, integer, varchar, timestamp } from 'drizzle-orm/pg-core';

// Apple App Attest keys are device-bound (login happens before we know the
// driver), so the store is keyed by the mobile X-Device-Id. The public key and
// signature counter let the backend verify each later assertion and reject
// replays. Android Play Integrity is stateless and stores nothing here.
export const mobileAttestKeys = pgTable('mobile_attest_keys', {
  deviceId: text('device_id').primaryKey(),
  keyId: text('key_id').notNull(),
  publicKey: text('public_key').notNull(),
  signCount: integer('sign_count').notNull().default(0),
  platform: varchar('platform', { length: 10 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
