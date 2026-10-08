// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { EventBus, DomainEvent, PubSubClient } from '@evtivity/lib';
import { projectionQueueFor, sessionGatedKey } from '../../server/projection-queue.js';

// SQL mock answered by statement text, so the test does not depend on the
// statement order of the Started step.
const sqlCalls: string[] = [];

function route(text: string): unknown[] {
  if (text.includes('ocpp_protocol FROM charging_stations')) return [{ ocpp_protocol: 'ocpp2.1' }];
  if (text.includes('FROM charging_stations')) return [{ id: 'sta_0001' }];
  if (text.includes('INSERT INTO charging_sessions')) return [{ id: 'session-1' }];
  return [];
}

function createSqlMock() {
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    void values;
    const text = strings.join('?');
    sqlCalls.push(text);
    return Promise.resolve(route(text));
  };
  (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v) => v;
  (sqlFn as unknown as { unsafe: (text: string) => string }).unsafe = (text) => text;
  (sqlFn as unknown as { begin: (fn: (tx: unknown) => unknown) => unknown }).begin = (fn) =>
    fn(sqlFn);
  return sqlFn as unknown;
}

vi.mock('postgres', () => {
  const factory = () => createSqlMock();
  factory.PostgresError = class extends Error {};
  return { default: factory };
});

vi.mock('../../../../database/src/lib/idling-setting.js', () => ({
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../../../database/src/lib/pricing-settings.js', () => ({
  isSplitBillingEnabled: vi.fn().mockResolvedValue(false),
}));

vi.mock('@evtivity/database', async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../../database/src/lib/session-end-request.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../../database/src/lib/station-status.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../../database/src/lib/driver-availability.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../../database/src/lib/station-watch.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../../database/src/lib/session-pricing.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../../database/src/lib/tariff-resolution.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>('../../../../database/src/lib/pg-errors.js')),
  getCompanyTaxBasis: vi.fn().mockResolvedValue('net'),
  client: createSqlMock(),
  isRoamingEnabled: vi.fn().mockResolvedValue(false),
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(0),
  isSplitBillingEnabled: vi.fn().mockResolvedValue(false),
  getOfflineCommandTtlHours: vi.fn().mockResolvedValue(24),
  isSiteFreeVendEnabledByStation: vi.fn().mockResolvedValue(false),
  getCompanyCurrency: vi.fn().mockResolvedValue('USD'),
  getCompanyPriceDisplay: vi.fn().mockResolvedValue('net'),
  writeReservationAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../server/notification-dispatcher.js', () => ({
  dispatchOcppNotification: vi.fn().mockResolvedValue(undefined),
  dispatchDriverNotification: vi.fn().mockResolvedValue(undefined),
  dispatchSystemNotification: vi.fn().mockResolvedValue(undefined),
  ALL_TEMPLATES_DIRS: ['/mock/templates'],
}));

vi.mock('../../lib/payments.js', () => ({
  paymentRegistry: {},
  paymentContext: () => ({ registry: {}, logger: {} }),
  activePaymentProvider: () => Promise.resolve({ id: 'stripe' }),
}));

// The gate fails the way an undecryptable payment key makes it fail.
const gateError = new Error('payment settings cannot be decrypted');
const mockRunPaymentGate = vi.fn();
vi.mock('../../server/session-lifecycle/payment-gate.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runPaymentGate: (...args: unknown[]) => mockRunPaymentGate(...args) as unknown,
}));

const mockLoggerError = vi.fn();
vi.mock('@evtivity/lib', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib')>('@evtivity/lib');
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
    debug: vi.fn(),
  };
  return {
    ...actual,
    createLogger: () => ({ ...logger, child: () => logger }),
  };
});

function createMockEventBus() {
  const subscribers = new Map<string, Array<(event: DomainEvent) => Promise<void>>>();
  return {
    subscribe(eventType: string, handler: (event: DomainEvent) => Promise<void>) {
      const handlers = subscribers.get(eventType) ?? [];
      handlers.push(handler);
      subscribers.set(eventType, handlers);
    },
    async emit(eventType: string, event: DomainEvent) {
      for (const handler of subscribers.get(eventType) ?? []) {
        await handler(event);
      }
    },
    track: <T>(work: Promise<T>) => work,
    publish: vi.fn(),
  } as unknown as EventBus & { emit: (eventType: string, event: DomainEvent) => Promise<void> };
}

function transactionEvent(payload: Record<string, unknown>): DomainEvent {
  return {
    eventType: 'ocpp.TransactionEvent',
    aggregateType: 'ChargingStation',
    aggregateId: 'CS-1',
    payload: { stationId: 'CS-1', transactionId: 'tx-1', ...payload },
    occurredAt: new Date(),
  };
}

describe('TransactionEvent Started when the payment gate fails', () => {
  const pubsub: PubSubClient = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    await import('../../server/event-projections.js');
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    mockRunPaymentGate.mockRejectedValue(gateError);
  });

  it('drains the buffer, publishes the screen, clears the watch, and still reports the error', async () => {
    const { registerProjections } = await import('../../server/event-projections.js');
    const eventBus = createMockEventBus();
    registerProjections(eventBus, pubsub);

    // An Updated before its Started finds no session and is buffered.
    const updated = transactionEvent({
      eventType: 'Updated',
      seqNo: 1,
      triggerReason: 'MeterValuePeriodic',
      timestamp: '2024-01-01T00:05:00Z',
    });
    await eventBus.emit('ocpp.TransactionEvent', updated);
    expect(eventBus.publish).not.toHaveBeenCalled();

    await eventBus.emit(
      'ocpp.TransactionEvent',
      transactionEvent({
        eventType: 'Started',
        seqNo: 0,
        triggerReason: 'Authorized',
        timestamp: '2024-01-01T00:00:00Z',
        chargingState: 'Charging',
        idToken: 'TOKEN-1',
      }),
    );

    expect(mockRunPaymentGate).toHaveBeenCalledTimes(1);
    // The gate signal fires after a failed gate too, so the 2.1 handler waiting
    // for an account session's ceiling (plan S8) answers at once without one.
    await expect(
      projectionQueueFor(eventBus).waitForSignal(sessionGatedKey('CS-1', 'tx-1'), 0),
    ).resolves.toBe(true);
    // Buffer drained.
    expect(eventBus.publish).toHaveBeenCalledWith(updated);
    // Station screen published.
    expect(pubsub.publish).toHaveBeenCalledWith(
      'station_message_transaction',
      expect.stringContaining('"eventType":"started"'),
    );
    // Starting driver's station watch cleared.
    expect(sqlCalls.some((text) => text.includes('DELETE FROM station_watches'))).toBe(true);
    // The gate failure still surfaces.
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.TransactionEvent',
        error: 'payment settings cannot be decrypted',
      }),
      'Event projection failed',
    );
    expect(
      mockLoggerError.mock.calls.filter((call) => call[1] === 'Event projection failed'),
    ).toHaveLength(1);
  });
});
