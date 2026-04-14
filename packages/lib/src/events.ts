// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from './logger.js';

export interface DomainEvent {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown> | undefined;
  occurredAt?: Date | undefined;
}

export type EventHandler = (event: DomainEvent) => Promise<void>;

export interface EventPersistence {
  persist(event: DomainEvent): Promise<void>;
}

export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(eventType: string, handler: EventHandler): void;
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly logger: Logger;
  private readonly persistence: EventPersistence | null;

  constructor(logger: Logger, persistence?: EventPersistence) {
    this.logger = logger;
    this.persistence = persistence ?? null;
  }

  subscribe(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  async publish(event: DomainEvent): Promise<void> {
    const eventWithTime = {
      ...event,
      occurredAt: event.occurredAt ?? new Date(),
    };

    if (this.persistence != null) {
      await this.persistence.persist(eventWithTime);
    }

    const handlers = this.handlers.get(event.eventType) ?? [];
    if (handlers.length === 0) {
      this.logger.debug({ eventType: event.eventType }, 'No handlers for event');
      return;
    }

    // Run handlers in background so callers (OCPP handlers) are not blocked
    // by slow DB projections. Errors are logged but do not propagate.
    void Promise.allSettled(handlers.map((handler) => handler(eventWithTime))).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          this.logger.error(
            { eventType: event.eventType, error: result.reason },
            'Event handler failed',
          );
        }
      }
    });
  }
}
