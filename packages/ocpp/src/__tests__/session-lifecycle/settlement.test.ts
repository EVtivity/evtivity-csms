// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '@evtivity/lib';
import { BELOW_MINIMUM_CAPTURE_PREFIX } from '@evtivity/payments';
import type { SettlementOutcome } from '@evtivity/payments';
import type { ProjectionDeps } from '../../server/projection-support/context.js';
import type { ProjectionAttempt } from '../../server/projection-retry.js';
import {
  projectNotifySettlement,
  settleTransactionEnded,
} from '../../server/session-lifecycle/settlement.js';

const {
  mockSettleSessionPayment,
  mockRecordTerminalSettlement,
  mockDispatchDriverNotification,
  mockLowCreditNotice,
} = vi.hoisted(() => ({
  mockSettleSessionPayment: vi.fn(),
  mockRecordTerminalSettlement: vi.fn(),
  mockDispatchDriverNotification: vi.fn(),
  mockLowCreditNotice: vi.fn(),
}));

vi.mock('@evtivity/payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/payments')>()),
  settleSessionPayment: mockSettleSessionPayment,
  recordTerminalSettlement: mockRecordTerminalSettlement,
  dispatchPrepaidLowCreditNotice: mockLowCreditNotice,
}));

vi.mock('../../server/notification-dispatcher.js', () => ({
  dispatchDriverNotification: mockDispatchDriverNotification,
  ALL_TEMPLATES_DIRS: [],
}));

const sessionRow = {
  id: 'sess-1',
  final_cost_cents: 1234,
  station_uuid: 'station-uuid',
  currency: 'USD',
  station_ocpp_id: 'CS-1',
  site_id: 'site-1',
};

function endedSessionRow(status: string): Record<string, unknown> {
  return {
    driver_id: 'drv-1',
    energy_delivered_wh: 10000,
    final_cost_cents: 1234,
    started_at: '2026-10-06T10:00:00.000Z',
    ended_at: '2026-10-06T11:00:00.000Z',
    status,
    tariff_tax_rate: null,
    currency: 'USD',
  };
}

function endedEvent(eventType = 'Ended'): DomainEvent {
  return {
    eventType: 'ocpp.TransactionEvent',
    aggregateType: 'ChargingStation',
    aggregateId: 'CS-1',
    payload: { eventType, transactionId: 'tx-1', stationId: 'CS-1' },
    occurredAt: new Date('2026-10-06T11:00:00.000Z'),
  };
}

let sqlResults: unknown[][];
let claimedNotices: Set<string>;
let deps: ProjectionDeps;
let sql: ReturnType<typeof vi.fn>;
let publish: ReturnType<typeof vi.fn>;
let notifyChange: ReturnType<typeof vi.fn>;
let logger: {
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  sqlResults = [];
  claimedNotices = new Set();
  // The end notice claims (completed_notified_at, receipt_notified_at) answer
  // by column: a claim already taken returns no row. Every other statement
  // takes the next queued result.
  sql = vi.fn((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('?') : '';
    const claim = /SET (completed_notified_at|receipt_notified_at) = now\(\)/.exec(text);
    if (claim != null) {
      const column = claim[1] as string;
      if (claimedNotices.has(column)) return Promise.resolve([]);
      claimedNotices.add(column);
      return Promise.resolve([{ id: 'sess-1' }]);
    }
    return Promise.resolve(sqlResults.shift() ?? []);
  });
  publish = vi.fn(() => Promise.resolve());
  notifyChange = vi.fn(() => Promise.resolve());
  mockDispatchDriverNotification.mockResolvedValue(undefined);
  mockLowCreditNotice.mockResolvedValue(true);
  logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  deps = {
    sql,
    eventBus: { track: vi.fn((p: Promise<unknown>) => p) },
    pubsub: { publish },
    logger,
    payments: { registry: {}, logger },
    lookups: { resolveSiteName: vi.fn(() => Promise.resolve('Main Site')) },
    notify: { notifyChange },
  } as unknown as ProjectionDeps;
});

function sentEvents(): string[] {
  return mockDispatchDriverNotification.mock.calls.map((c) => c[1] as string);
}

function variablesOf(eventType: string): Record<string, unknown> {
  const call = mockDispatchDriverNotification.mock.calls.find((c) => c[1] === eventType);
  return call?.[3] as Record<string, unknown>;
}

// A single run: every step runs.
const attempt: ProjectionAttempt = {
  number: 1,
  isLast: true,
  once: (_key, step) => step(),
  memo: (_key, step) => step(),
};

describe('settleTransactionEnded', () => {
  it('ignores a TransactionEvent that is not Ended', async () => {
    const result = await settleTransactionEnded(deps, endedEvent('Updated'), attempt);
    expect(result).toBeNull();
    expect(sql).not.toHaveBeenCalled();
    expect(mockSettleSessionPayment).not.toHaveBeenCalled();
  });

  it('returns null and settles nothing when the session is unknown', async () => {
    sqlResults = [[]];
    const result = await settleTransactionEnded(deps, endedEvent(), attempt);
    expect(result).toBeNull();
    expect(mockSettleSessionPayment).not.toHaveBeenCalled();
    expect(mockDispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('settles through the payment context of the deps', async () => {
    sqlResults = [[sessionRow], [endedSessionRow('completed')], []];
    mockSettleSessionPayment.mockResolvedValue({ mode: 'none' });
    await settleTransactionEnded(deps, endedEvent(), attempt);
    expect(mockSettleSessionPayment).toHaveBeenCalledWith('sess-1', deps.payments, {
      rethrowConnectionErrors: false,
      resumeAdjustment: false,
    });
  });

  it('prepaid: a debit already recorded is logged as such and still published', async () => {
    sqlResults = [[sessionRow], [endedSessionRow('completed')], []];
    mockSettleSessionPayment.mockResolvedValue({
      mode: 'prepaid',
      tokenId: 'tok-1',
      debitedCents: 1234,
      balanceCents: 766,
      repeated: true,
    });

    await settleTransactionEnded(deps, endedEvent(), attempt);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', tokenId: 'tok-1' }),
      'Prepaid debit already recorded',
    );
    expect(notifyChange).toHaveBeenCalledWith(
      'payment.settled',
      'station-uuid',
      'site-1',
      'sess-1',
    );
    expect(publish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({ eventType: 'token.changed', tokenId: 'tok-1' }),
    );
  });

  it('passes the retry options of the run to the payment service', async () => {
    sqlResults = [[sessionRow], [endedSessionRow('completed')], []];
    mockSettleSessionPayment.mockResolvedValue({ mode: 'none' });

    await settleTransactionEnded(deps, endedEvent(), { ...attempt, number: 2, isLast: false });

    expect(mockSettleSessionPayment).toHaveBeenCalledWith('sess-1', deps.payments, {
      rethrowConnectionErrors: true,
      resumeAdjustment: true,
    });
  });

  it('prepaid: notifies payment.settled, publishes token.changed, sends the session end emails', async () => {
    const outcome: SettlementOutcome = {
      mode: 'prepaid',
      tokenId: 'tok-1',
      debitedCents: 1234,
      balanceCents: 766,
    };
    sqlResults = [[sessionRow], [endedSessionRow('completed')], []];
    mockSettleSessionPayment.mockResolvedValue(outcome);

    const result = await settleTransactionEnded(deps, endedEvent(), attempt);

    expect(result).toEqual(outcome);
    expect(notifyChange).toHaveBeenCalledWith(
      'payment.settled',
      'station-uuid',
      'site-1',
      'sess-1',
    );
    expect(publish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({ eventType: 'token.changed', tokenId: 'tok-1' }),
    );
    expect(sentEvents()).toEqual(['session.Completed', 'session.Receipt']);
    expect(variablesOf('session.Receipt')).toMatchObject({
      notCharged: false,
      durationMinutes: 60,
    });
    expect(mockLowCreditNotice).toHaveBeenCalledWith(outcome, {
      templatesDirs: [],
      pubsub: deps.pubsub,
    });
  });

  it('prepaid: a repeated debit sends no low credit notice', async () => {
    sqlResults = [[sessionRow], [endedSessionRow('completed')], []];
    mockSettleSessionPayment.mockResolvedValue({
      mode: 'prepaid',
      tokenId: 'tok-1',
      debitedCents: 1234,
      balanceCents: 266,
      repeated: true,
    });

    await settleTransactionEnded(deps, endedEvent(), attempt);

    expect(mockLowCreditNotice).not.toHaveBeenCalled();
  });

  it('prepaid: the low credit notice is a once step, skipped on a rerun that already ran it', async () => {
    sqlResults = [[sessionRow], [endedSessionRow('completed')], []];
    mockSettleSessionPayment.mockResolvedValue({
      mode: 'prepaid',
      tokenId: 'tok-1',
      debitedCents: 1234,
      balanceCents: 266,
    });
    const done = new Set(['settle:prepaid-low-credit']);
    const rerun: ProjectionAttempt = {
      ...attempt,
      number: 2,
      once: (key, step) => (done.has(key) ? Promise.resolve(undefined as never) : step()),
    };

    await settleTransactionEnded(deps, endedEvent(), rerun);

    expect(mockLowCreditNotice).not.toHaveBeenCalled();
  });

  it('prepaid: a failed low credit notice is logged at warn and the settlement returns', async () => {
    const outcome: SettlementOutcome = {
      mode: 'prepaid',
      tokenId: 'tok-1',
      debitedCents: 1234,
      balanceCents: 266,
    };
    sqlResults = [[sessionRow], [endedSessionRow('completed')], []];
    mockSettleSessionPayment.mockResolvedValue(outcome);
    mockLowCreditNotice.mockRejectedValue(new Error('smtp down'));

    await expect(settleTransactionEnded(deps, endedEvent(), attempt)).resolves.toEqual(outcome);
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-1', tokenId: 'tok-1' }),
        'Prepaid low credit notice failed; continuing',
      );
    });
  });

  it('card captured and recorded: sends session.PaymentReceived after the session end emails', async () => {
    const outcome: SettlementOutcome = {
      mode: 'card',
      status: 'captured',
      paymentRecordId: 7,
      driverId: 'drv-1',
      capturedCents: 1234,
      shortfallCents: 0,
      recorded: true,
    };
    sqlResults = [
      [sessionRow],
      [endedSessionRow('completed')],
      [{ status: 'captured', failure_reason: null }],
    ];
    mockSettleSessionPayment.mockResolvedValue(outcome);

    const result = await settleTransactionEnded(deps, endedEvent(), attempt);

    expect(result).toEqual(outcome);
    expect(sentEvents()).toEqual([
      'session.Completed',
      'session.Receipt',
      'session.PaymentReceived',
    ]);
    expect(variablesOf('session.PaymentReceived')).toMatchObject({
      siteName: 'Main Site',
      stationId: 'CS-1',
      transactionId: 'tx-1',
      amountCents: 1234,
      currency: 'USD',
    });
    expect(variablesOf('session.Completed')).toMatchObject({ notCharged: false });
    expect(notifyChange).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('account: sends the session end emails billed to the fleet, nothing else', async () => {
    const outcome: SettlementOutcome = { mode: 'account', billingFleetId: 'flt-1' };
    sqlResults = [
      [sessionRow],
      [{ ...endedSessionRow('completed'), billing_mode: 'account', billing_fleet_name: 'Acme' }],
      [],
    ];
    mockSettleSessionPayment.mockResolvedValue(outcome);

    const result = await settleTransactionEnded(deps, endedEvent(), attempt);

    expect(result).toEqual(outcome);
    expect(sentEvents()).toEqual(['session.Completed', 'session.Receipt']);
    for (const eventType of ['session.Completed', 'session.Receipt']) {
      expect(variablesOf(eventType)).toMatchObject({
        billingMode: 'account',
        billedTo: 'Acme',
        notCharged: false,
      });
    }
    expect(notifyChange).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('account with a payment record (operator hold): the emails do not say billed to the fleet', async () => {
    sqlResults = [
      [sessionRow],
      [{ ...endedSessionRow('completed'), billing_mode: 'account', billing_fleet_name: 'Acme' }],
      [{ status: 'captured', failure_reason: null }],
    ];
    mockSettleSessionPayment.mockResolvedValue({ mode: 'none' });

    await settleTransactionEnded(deps, endedEvent(), attempt);

    expect(variablesOf('session.Receipt')).toMatchObject({ billingMode: 'card', billedTo: '' });
  });

  it('card: the session end emails carry billingMode card and no billedTo', async () => {
    sqlResults = [
      [sessionRow],
      [{ ...endedSessionRow('completed'), billing_mode: 'card', billing_fleet_name: null }],
      [],
    ];
    mockSettleSessionPayment.mockResolvedValue({ mode: 'none' });

    await settleTransactionEnded(deps, endedEvent(), attempt);

    expect(variablesOf('session.Completed')).toMatchObject({ billingMode: 'card', billedTo: '' });
  });

  it('card captured but not recorded: no session.PaymentReceived', async () => {
    sqlResults = [[sessionRow], [endedSessionRow('completed')], []];
    mockSettleSessionPayment.mockResolvedValue({
      mode: 'card',
      status: 'captured',
      paymentRecordId: 7,
      driverId: 'drv-1',
      capturedCents: 1234,
      shortfallCents: 0,
      recorded: false,
    });

    await settleTransactionEnded(deps, endedEvent(), attempt);

    expect(sentEvents()).toEqual(['session.Completed', 'session.Receipt']);
  });

  // Finding JB-3: an async provider confirms the capture later by webhook;
  // the webhook sends the receipt, or payment.CaptureFailed and no receipt.
  it.each(['capture', 'adjust'])(
    'card %s pending: holds the receipt back without claiming it',
    async (pendingOperation) => {
      sqlResults = [
        [sessionRow],
        [endedSessionRow('completed')],
        [{ status: 'captured', failure_reason: null, pending_operation: pendingOperation }],
      ];
      mockSettleSessionPayment.mockResolvedValue({
        mode: 'card',
        status: 'captured',
        paymentRecordId: 7,
        driverId: 'drv-1',
        capturedCents: 1234,
        shortfallCents: 0,
        recorded: false,
      });

      await settleTransactionEnded(deps, endedEvent(), attempt);

      expect(sentEvents()).toEqual(['session.Completed']);
      expect(claimedNotices.has('receipt_notified_at')).toBe(false);
    },
  );

  it('card failed: sends payment.CaptureFailed with the reason cut to 200 characters', async () => {
    sqlResults = [
      [sessionRow],
      [endedSessionRow('completed')],
      [{ status: 'failed', failure_reason: 'declined' }],
    ];
    mockSettleSessionPayment.mockResolvedValue({
      mode: 'card',
      status: 'failed',
      paymentRecordId: 7,
      driverId: 'drv-1',
      reason: 'x'.repeat(300),
    });

    await settleTransactionEnded(deps, endedEvent(), attempt);

    // No receipt after a failed capture (JC-3): there is no payment to confirm.
    expect(sentEvents()).toEqual(['session.Completed', 'payment.CaptureFailed']);
    const vars = variablesOf('payment.CaptureFailed');
    expect(vars).toMatchObject({ stationId: 'CS-1', transactionId: 'tx-1' });
    expect((vars.reason as string).length).toBe(200);
    expect(claimedNotices.has('receipt_notified_at')).toBe(false);
  });

  it('a second Ended of the session sends no end notice again (claims taken)', async () => {
    sqlResults = [[sessionRow], [endedSessionRow('completed')], []];
    mockSettleSessionPayment.mockResolvedValue({ mode: 'none' });
    await settleTransactionEnded(deps, endedEvent(), attempt);
    expect(sentEvents()).toEqual(['session.Completed', 'session.Receipt']);

    mockDispatchDriverNotification.mockClear();
    sqlResults = [[sessionRow], [endedSessionRow('completed')], []];
    await settleTransactionEnded(deps, endedEvent(), attempt);
    expect(sentEvents()).toEqual([]);
  });

  it('a rerun keeps the claim it made and sends the claimed notice once', async () => {
    sqlResults = [[sessionRow], [endedSessionRow('completed')], []];
    mockSettleSessionPayment.mockResolvedValue({ mode: 'none' });
    const memos = new Map<string, unknown>([
      ['settle:session.Completed:claim', [{ id: 'sess-1' }]],
    ]);
    claimedNotices.add('completed_notified_at');
    const rerun: ProjectionAttempt = {
      ...attempt,
      number: 2,
      memo: <T>(key: string, step: () => Promise<T>) =>
        memos.has(key) ? Promise.resolve(memos.get(key) as T) : step(),
    };
    await settleTransactionEnded(deps, endedEvent(), rerun);
    expect(sentEvents()).toEqual(['session.Completed', 'session.Receipt']);
  });

  it('card cancelled below the provider minimum: session end emails say nothing was charged', async () => {
    sqlResults = [
      [sessionRow],
      [endedSessionRow('completed')],
      [{ status: 'cancelled', failure_reason: `${BELOW_MINIMUM_CAPTURE_PREFIX} (30 < 50)` }],
    ];
    mockSettleSessionPayment.mockResolvedValue({
      mode: 'card',
      status: 'cancelled',
      paymentRecordId: 7,
      recorded: true,
    });

    await settleTransactionEnded(deps, endedEvent(), attempt);

    expect(sentEvents()).toEqual(['session.Completed', 'session.Receipt']);
    expect(variablesOf('session.Completed')).toMatchObject({ notCharged: true });
    expect(variablesOf('session.Receipt')).toMatchObject({ notCharged: true });
  });

  it.each<[string, SettlementOutcome]>([
    [
      'card adjusting',
      { mode: 'card', status: 'adjusting', paymentRecordId: 7, driverId: 'drv-1' },
    ],
    ['guest', { mode: 'guest' }],
    ['none', { mode: 'none' }],
  ])('%s: only the session end emails', async (_name, outcome) => {
    sqlResults = [[sessionRow], [endedSessionRow('completed')], []];
    mockSettleSessionPayment.mockResolvedValue(outcome);

    const result = await settleTransactionEnded(deps, endedEvent(), attempt);

    expect(result).toEqual(outcome);
    expect(sentEvents()).toEqual(['session.Completed', 'session.Receipt']);
    expect(notifyChange).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['faulted', 'failed'])('%s session: no session end emails', async (status) => {
    sqlResults = [[sessionRow], [endedSessionRow(status)]];
    mockSettleSessionPayment.mockResolvedValue({ mode: 'none' });

    await settleTransactionEnded(deps, endedEvent(), attempt);

    expect(mockDispatchDriverNotification).not.toHaveBeenCalled();
    // The payment record is not read for a session that gets no emails.
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it('logs and continues when the session end notifications fail', async () => {
    sql.mockResolvedValueOnce([sessionRow]).mockRejectedValueOnce(new Error('db down'));
    mockSettleSessionPayment.mockResolvedValue({
      mode: 'prepaid',
      tokenId: 'tok-1',
      debitedCents: 1,
      balanceCents: 0,
    });

    await settleTransactionEnded(deps, endedEvent(), attempt);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1' }),
      'Session end notifications failed; continuing',
    );
    expect(publish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({ eventType: 'token.changed', tokenId: 'tok-1' }),
    );
  });
});

function settlementEvent(payload: Record<string, unknown>): DomainEvent {
  return {
    eventType: 'ocpp.NotifySettlement',
    aggregateType: 'ChargingStation',
    aggregateId: 'CS-1',
    payload,
    occurredAt: new Date('2026-10-06T11:00:00.000Z'),
  };
}

describe('projectNotifySettlement', () => {
  it('logs and writes nothing when a required field is missing', async () => {
    await projectNotifySettlement(deps, settlementEvent({ transactionId: 'tx-1' }));

    expect(logger.warn).toHaveBeenCalledWith(
      { stationId: 'CS-1', transactionId: 'tx-1', settlementAmount: undefined },
      'NotifySettlement missing required fields; skipping',
    );
    expect(sql).not.toHaveBeenCalled();
    expect(mockRecordTerminalSettlement).not.toHaveBeenCalled();
  });

  it('writes nothing for an unknown transaction', async () => {
    sqlResults = [[]];
    await projectNotifySettlement(
      deps,
      settlementEvent({ transactionId: 'tx-unknown', settlementAmount: 12.34 }),
    );

    expect(sql).toHaveBeenCalledTimes(1);
    expect(mockRecordTerminalSettlement).not.toHaveBeenCalled();
    expect(notifyChange).not.toHaveBeenCalled();
    expect(mockDispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('logs a duplicate settlement and sends nothing', async () => {
    sqlResults = [
      [{ id: 'sess-1', driver_id: 'drv-1', station_id: 'station-uuid', currency: 'USD' }],
    ];
    mockRecordTerminalSettlement.mockResolvedValue(false);

    await projectNotifySettlement(
      deps,
      settlementEvent({ transactionId: 'tx-1', settlementAmount: 12.34 }),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      { transactionId: 'tx-1', sessionId: 'sess-1' },
      'Duplicate NotifySettlement ignored; payment already exists for session',
    );
    expect(notifyChange).not.toHaveBeenCalled();
    expect(mockDispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('records the settlement in cents and notifies the driver', async () => {
    sqlResults = [
      [{ id: 'sess-1', driver_id: 'drv-1', station_id: 'station-uuid', currency: 'USD' }],
    ];
    mockRecordTerminalSettlement.mockResolvedValue(true);

    await projectNotifySettlement(
      deps,
      settlementEvent({ transactionId: 'tx-1', settlementAmount: 12.34 }),
    );

    expect(mockRecordTerminalSettlement).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      driverId: 'drv-1',
      currency: 'USD',
      capturedCents: 1234,
    });
    expect(notifyChange).toHaveBeenCalledWith('payment.settled', null, null, 'sess-1');
    expect(sentEvents()).toEqual(['session.PaymentReceived', 'payment.Complete']);
    expect(variablesOf('session.PaymentReceived')).toMatchObject({
      siteName: 'Main Site',
      amountCents: 1234,
    });
  });
});
