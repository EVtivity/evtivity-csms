// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { EventPersistence, DomainEvent } from '@evtivity/lib';
import { db } from './config.js';
import { domainEvents } from './schema/events.js';

export class PgEventPersistence implements EventPersistence {
  async persist(event: DomainEvent): Promise<void> {
    await db.insert(domainEvents).values({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
      metadata: event.metadata ?? null,
      occurredAt: event.occurredAt ?? new Date(),
    });
  }
}
