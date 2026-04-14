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

describe('Display messages projection', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;

  const mockPubSub: PubSubClient = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    eventBus = createMockEventBus();
    // Register projections with a dummy database URL and mock pub/sub
    // We only test that the subscription is registered, not actual DB operations
    registerProjections(eventBus, 'postgres://test:test@localhost:5432/test', mockPubSub);
  });

  it('registers a subscriber for ocpp.NotifyDisplayMessages', () => {
    const handlers = eventBus.subscribers.get('ocpp.NotifyDisplayMessages');
    expect(handlers).toBeDefined();
    expect(handlers?.length).toBeGreaterThanOrEqual(1);
  });

  it('registers subscribers for all expected event types', () => {
    const expectedEvents = [
      'station.Connected',
      'station.Disconnected',
      'ocpp.BootNotification',
      'ocpp.Heartbeat',
      'ocpp.StatusNotification',
      'ocpp.TransactionEvent',
      'ocpp.MeterValues',
      'ocpp.FirmwareStatusNotification',
      'ocpp.SecurityEventNotification',
      'ocpp.ReservationStatusUpdate',
      'ocpp.NotifySettlement',
      'ocpp.MessageLog',
      'ocpp.NotifyDisplayMessages',
    ];

    for (const eventType of expectedEvents) {
      const handlers = eventBus.subscribers.get(eventType);
      expect(handlers, `Missing subscriber for ${eventType}`).toBeDefined();
    }
  });
});
