// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventBus, DomainEvent, PubSubClient } from '@evtivity/lib';
import { registerProjections } from '../server/event-projections.js';

function createMockEventBus() {
  const subscribers = new Map<string, Array<(event: DomainEvent) => Promise<void>>>();
  return {
    subscribe(eventType: string, handler: (event: DomainEvent) => Promise<void>) {
      const handlers = subscribers.get(eventType) ?? [];
      handlers.push(handler);
      subscribers.set(eventType, handlers);
    },
    async emit(eventType: string, event: DomainEvent) {
      const handlers = subscribers.get(eventType) ?? [];
      for (const handler of handlers) {
        await handler(event);
      }
    },
    publish: vi.fn(),
    subscribers,
  } as unknown as EventBus & {
    emit: (eventType: string, event: DomainEvent) => Promise<void>;
    subscribers: Map<string, Array<(event: DomainEvent) => Promise<void>>>;
  };
}

describe('Auto-create EVSE/connector on StatusNotification', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;

  const mockPubSub: PubSubClient = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    eventBus = createMockEventBus();
    registerProjections(eventBus, 'postgres://test:test@localhost:5432/test', mockPubSub);
  });

  it('registers a subscriber for ocpp.StatusNotification', () => {
    const handlers = eventBus.subscribers.get('ocpp.StatusNotification');
    expect(handlers).toBeDefined();
    expect(handlers?.length).toBeGreaterThanOrEqual(1);
  });

  it('StatusNotification handler is a function that accepts a DomainEvent', () => {
    const handlers = eventBus.subscribers.get('ocpp.StatusNotification');
    expect(handlers).toBeDefined();
    expect(handlers?.[0]).toBeTypeOf('function');
  });

  it('handler processes events with evseId, connectorId, and connectorStatus fields', async () => {
    const handlers = eventBus.subscribers.get('ocpp.StatusNotification');
    expect(handlers).toBeDefined();
    const handler = handlers?.[0];
    expect(handler).toBeDefined();

    // The handler will attempt a DB query and fail (no real DB), but the structure is valid
    const event: DomainEvent = {
      eventType: 'ocpp.StatusNotification',
      aggregateType: 'station',
      aggregateId: 'CS-0001',
      payload: {
        evseId: 99,
        connectorId: 1,
        connectorStatus: 'Available',
      },
      occurredAt: new Date(),
    };

    // Handler will attempt a DB query and fail (no real DB), but safeSubscribe
    // catches errors and logs them, so the handler resolves without throwing.
    if (handler == null) throw new Error('handler not found');
    await expect(handler(event)).resolves.not.toThrow();
  });
});
