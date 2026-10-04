// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from './logger.js';
import { createInFlightTracker } from './in-flight.js';

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
  /**
   * Waits for events published so far (and events their handlers publish) to
   * finish persistence and handler dispatch. Resolves false when handlers are
   * still running after `timeoutMs`. Call at shutdown before closing the
   * clients the handlers use.
   */
  drain(timeoutMs: number): Promise<boolean>;
  /**
   * Registers background work a handler starts without awaiting (a
   * notification dispatch), so `drain()` waits for it too. Returns `work`.
   */
  track<T>(work: Promise<T>): Promise<T>;
}

export interface EventBusOptions {
  // Event types to dispatch to subscribers but NOT archive via the
  // persistence hook. High-volume telemetry types (per-frame message logs,
  // meter values, heartbeats) have dedicated queryable tables written by
  // their projections; archiving them again in domain_events tripled the
  // database write load and grew an unread 10 GB table in days.
  persistDenylist?: Iterable<string>;
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly logger: Logger;
  private readonly persistence: EventPersistence | null;
  private readonly persistDenylist: Set<string>;
  private readonly inFlight = createInFlightTracker();

  constructor(logger: Logger, persistence?: EventPersistence, options?: EventBusOptions) {
    this.logger = logger;
    this.persistence = persistence ?? null;
    this.persistDenylist = new Set(options?.persistDenylist ?? []);
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

    // One tracked promise covers persistence and handler dispatch, so
    // `drain()` sees the event from publish until its last handler settles.
    // The caller waits only for persistence; handlers run in the background.
    let persisted: () => void = () => undefined;
    const persistDone = new Promise<void>((resolve) => {
      persisted = resolve;
    });
    void this.inFlight.track(this.process(eventWithTime, persisted));
    await persistDone;
  }

  drain(timeoutMs: number): Promise<boolean> {
    return this.inFlight.drain(timeoutMs);
  }

  track<T>(work: Promise<T>): Promise<T> {
    return this.inFlight.track(work);
  }

  private async process(event: DomainEvent, persisted: () => void): Promise<void> {
    try {
      if (this.persistence != null && !this.persistDenylist.has(event.eventType)) {
        // Fail-open: domain-event persistence is an audit trail, not the source
        // of truth (projections update the domain tables). Callers fire publish
        // with `void`, so a rejection here is an unhandledRejection that kills
        // the whole process -- a transient DB connect timeout during a
        // reconnect storm crash-looped the OCPP server this way.
        try {
          await this.persistence.persist(event);
        } catch (err) {
          this.logger.warn(
            { eventType: event.eventType, aggregateId: event.aggregateId, err },
            'Domain event persistence failed; continuing with handler dispatch',
          );
        }
      }
    } finally {
      persisted();
    }

    const handlers = this.handlers.get(event.eventType) ?? [];
    if (handlers.length === 0) {
      this.logger.debug({ eventType: event.eventType }, 'No handlers for event');
      return;
    }

    // Handlers run in the background so callers (OCPP handlers) are not
    // blocked by slow DB projections. Errors are logged but do not propagate,
    // including a handler that throws before returning its promise.
    const results = await Promise.allSettled(
      handlers.map((handler) => {
        try {
          return handler(event);
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(
          { eventType: event.eventType, error: result.reason },
          'Event handler failed',
        );
      }
    }
  }
}
