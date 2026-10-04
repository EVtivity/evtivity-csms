// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { pgTable, varchar, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const webhookEvents = pgTable(
  'webhook_events',
  {
    eventId: varchar('event_id', { length: 255 }).primaryKey(),
    // Provider that sent the event (P4). The default covers inserts of the
    // previous release, which only received Stripe webhooks. P8 makes
    // (provider, event_id) the primary key using the unique index below.
    provider: varchar('provider', { length: 32 }).notNull().default('stripe'),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('webhook_events_provider_event_id_key').on(table.provider, table.eventId),
  ],
);
