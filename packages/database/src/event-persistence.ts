// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { EventPersistence, DomainEvent } from '@evtivity/lib';
import { maskUrlPasswords } from '@evtivity/lib/secret-config';
import { db } from './config.js';
import { domainEvents } from './schema/events.js';

export class PgEventPersistence implements EventPersistence {
  async persist(event: DomainEvent): Promise<void> {
    await db.insert(domainEvents).values({
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      // The stored copy masks the password of every file transfer URL
      // (`command.Queued` holds the real command for the offline queue, which
      // the projection gets unmasked). domain_events is an audit trail only.
      payload: maskUrlPasswords(event.payload),
      metadata: event.metadata ?? null,
      occurredAt: event.occurredAt ?? new Date(),
    });
  }
}
