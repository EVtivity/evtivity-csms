// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { InMemoryEventBus } from '../events.js';
import type { DomainEvent, EventPersistence } from '../events.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventType: 'test.event',
    aggregateType: 'Test',
    aggregateId: '123',
    payload: { value: 1 },
    ...overrides,
  };
}

describe('InMemoryEventBus', () => {
  it('delivers events to subscribed handlers', async () => {
    const bus = new InMemoryEventBus(logger);
    const handler = vi.fn().mockResolvedValue(undefined);

    bus.subscribe('test.event', handler);
    await bus.publish(makeEvent());

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'test.event' }));
  });

  it('does not call handlers for other event types', async () => {
    const bus = new InMemoryEventBus(logger);
    const handler = vi.fn().mockResolvedValue(undefined);

    bus.subscribe('other.event', handler);
    await bus.publish(makeEvent());

    expect(handler).not.toHaveBeenCalled();
  });

  it('calls multiple handlers for the same event type', async () => {
    const bus = new InMemoryEventBus(logger);
    const handler1 = vi.fn().mockResolvedValue(undefined);
    const handler2 = vi.fn().mockResolvedValue(undefined);

    bus.subscribe('test.event', handler1);
    bus.subscribe('test.event', handler2);
    await bus.publish(makeEvent());

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it('continues processing when a handler throws', async () => {
    const bus = new InMemoryEventBus(logger);
    const failingHandler = vi.fn().mockRejectedValue(new Error('handler failed'));
    const successHandler = vi.fn().mockResolvedValue(undefined);

    bus.subscribe('test.event', failingHandler);
    bus.subscribe('test.event', successHandler);
    await bus.publish(makeEvent());

    expect(failingHandler).toHaveBeenCalledOnce();
    expect(successHandler).toHaveBeenCalledOnce();
  });

  it('persists events before dispatching', async () => {
    const persistence: EventPersistence = {
      persist: vi.fn().mockResolvedValue(undefined),
    };
    const bus = new InMemoryEventBus(logger, persistence);
    const handler = vi.fn().mockResolvedValue(undefined);

    bus.subscribe('test.event', handler);
    await bus.publish(makeEvent());

    expect(persistence.persist).toHaveBeenCalledOnce();
    expect(persistence.persist).toHaveBeenCalledBefore(handler);
  });

  it('still dispatches handlers when persistence fails (fail-open)', async () => {
    const persistence: EventPersistence = {
      persist: vi.fn().mockRejectedValue(new Error('CONNECT_TIMEOUT')),
    };
    const bus = new InMemoryEventBus(logger, persistence);
    const handler = vi.fn().mockResolvedValue(undefined);

    bus.subscribe('test.event', handler);
    // Must not reject: callers fire publish with `void`, so a rejection here
    // becomes an unhandledRejection that kills the process.
    await expect(bus.publish(makeEvent())).resolves.toBeUndefined();

    expect(handler).toHaveBeenCalledOnce();
  });

  it('skips persistence for denylisted event types but still dispatches handlers', async () => {
    const persistence: EventPersistence = {
      persist: vi.fn().mockResolvedValue(undefined),
    };
    const bus = new InMemoryEventBus(logger, persistence, {
      persistDenylist: ['ocpp.MeterValues'],
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.subscribe('ocpp.MeterValues', handler);
    bus.subscribe('ocpp.StatusNotification', handler);

    await bus.publish({ ...makeEvent(), eventType: 'ocpp.MeterValues' });
    await bus.publish({ ...makeEvent(), eventType: 'ocpp.StatusNotification' });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(persistence.persist).toHaveBeenCalledOnce();
    expect((persistence.persist as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      eventType: 'ocpp.StatusNotification',
    });
  });

  it('sets occurredAt if not provided', async () => {
    const bus = new InMemoryEventBus(logger);
    const handler = vi.fn().mockResolvedValue(undefined);

    bus.subscribe('test.event', handler);
    await bus.publish(makeEvent());

    const received = handler.mock.calls[0]?.[0] as DomainEvent;
    expect(received.occurredAt).toBeInstanceOf(Date);
  });
});
