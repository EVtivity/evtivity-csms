// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { pgTable, serial, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const domainEvents = pgTable(
  'domain_events',
  {
    id: serial('id').primaryKey(),
    eventType: varchar('event_type', { length: 255 }).notNull(),
    aggregateType: varchar('aggregate_type', { length: 100 }).notNull(),
    aggregateId: varchar('aggregate_id', { length: 255 }).notNull(),
    payload: jsonb('payload').notNull(),
    metadata: jsonb('metadata'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_domain_events_event_type').on(table.eventType),
    index('idx_domain_events_aggregate').on(table.aggregateType, table.aggregateId),
    index('idx_domain_events_occurred_at').on(table.occurredAt),
  ],
);
