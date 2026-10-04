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

  describe('drain', () => {
    it('resolves true at once when nothing is in flight', async () => {
      const bus = new InMemoryEventBus(logger);
      await expect(bus.drain(10)).resolves.toBe(true);
    });

    it('waits for running handlers, including events they publish', async () => {
      const bus = new InMemoryEventBus(logger);
      const order: string[] = [];
      let releaseFirst: () => void = () => undefined;
      bus.subscribe('first', async () => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push('first');
        void bus.publish(makeEvent({ eventType: 'second' }));
      });
      bus.subscribe('second', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('second');
      });

      await bus.publish(makeEvent({ eventType: 'first' }));
      const drained = bus.drain(1000).then((result) => {
        order.push('drained');
        return result;
      });
      releaseFirst();

      await expect(drained).resolves.toBe(true);
      expect(order).toEqual(['first', 'second', 'drained']);
    });

    it('waits for background work a handler tracks without awaiting', async () => {
      const bus = new InMemoryEventBus(logger);
      const order: string[] = [];
      bus.subscribe('test', () => {
        void bus.track(
          new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() => {
            order.push('background');
          }),
        );
        order.push('handler');
        return Promise.resolve();
      });

      await bus.publish(makeEvent({ eventType: 'test' }));
      await expect(bus.drain(1000)).resolves.toBe(true);
      order.push('drained');

      expect(order).toEqual(['handler', 'background', 'drained']);
    });

    it('track returns the tracked promise', async () => {
      const bus = new InMemoryEventBus(logger);
      await expect(bus.track(Promise.resolve(7))).resolves.toBe(7);
    });

    it('waits for persistence of an event with no handlers', async () => {
      let releasePersist: () => void = () => undefined;
      const persistence: EventPersistence = {
        persist: () =>
          new Promise<void>((resolve) => {
            releasePersist = resolve;
          }),
      };
      const bus = new InMemoryEventBus(logger, persistence);
      void bus.publish(makeEvent());

      await expect(bus.drain(20)).resolves.toBe(false);
      releasePersist();
      await expect(bus.drain(1000)).resolves.toBe(true);
    });

    it('resolves false when a handler outlives the timeout', async () => {
      const bus = new InMemoryEventBus(logger);
      let release: () => void = () => undefined;
      bus.subscribe('test.event', () => {
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      await bus.publish(makeEvent());

      await expect(bus.drain(20)).resolves.toBe(false);
      release();
      await expect(bus.drain(1000)).resolves.toBe(true);
    });

    it('logs a handler that throws synchronously and keeps dispatching', async () => {
      const bus = new InMemoryEventBus(logger);
      const next = vi.fn().mockResolvedValue(undefined);
      bus.subscribe('test.event', () => {
        throw new Error('sync boom');
      });
      bus.subscribe('test.event', next);
      await bus.publish(makeEvent());

      await expect(bus.drain(1000)).resolves.toBe(true);
      expect(next).toHaveBeenCalledOnce();
    });

    it('counts a failed handler as settled', async () => {
      const bus = new InMemoryEventBus(logger);
      bus.subscribe('test.event', () => Promise.reject(new Error('boom')));
      await bus.publish(makeEvent());

      await expect(bus.drain(1000)).resolves.toBe(true);
    });
  });
});
