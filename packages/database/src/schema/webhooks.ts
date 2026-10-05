// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { pgTable, varchar, timestamp, primaryKey } from 'drizzle-orm/pg-core';

export const webhookEvents = pgTable(
  'webhook_events',
  {
    eventId: varchar('event_id', { length: 255 }).notNull(),
    // Provider that sent the event. Event ids are unique per provider only.
    provider: varchar('provider', { length: 32 }).notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.eventId] })],
);
