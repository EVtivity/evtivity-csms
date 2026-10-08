// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const sessions: unknown[][] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where']) chain[method] = () => chain;
  chain['then'] = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(sessions.shift() ?? []).then(resolve, reject);
  return {
    sessions,
    select: vi.fn(() => chain),
    dispatchDriverNotification: vi.fn(),
    dispatchSessionReceiptIfDue: vi.fn(),
    sendGuestReceiptForSession: vi.fn(),
  };
});

vi.mock('../session-receipt-notice.js', () => ({
  dispatchSessionReceiptIfDue: h.dispatchSessionReceiptIfDue,
}));
vi.mock('../guest-payments.js', () => ({
  sendGuestReceiptForSession: h.sendGuestReceiptForSession,
}));

vi.mock('@evtivity/database', () => ({
  db: { select: h.select },
  client: { __client: true },
  chargingSessions: { id: 'cs.id', transactionId: 'cs.tx', stationId: 'cs.station_id' },
  chargingStations: { id: 'st.id', stationId: 'st.station_id', siteId: 'st.site_id' },
  sites: { id: 'si.id', name: 'si.name' },
  reservations: { id: 'r.id', reservationId: 'r.reservation_id' },
}));
vi.mock('drizzle-orm', () => ({ eq: (a: unknown, b: unknown) => ({ eq: [a, b] }) }));
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchDriverNotification: h.dispatchDriverNotification,
}));

import { dispatchPaymentWebhookNotices } from '../webhook-notices.js';
import type { PaymentRecord } from '../payment-records.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const publish = vi.fn();
const pubsub = { publish, subscribe: vi.fn(), ping: vi.fn() };
const SESSION = {
  transactionId: 'tx-1',
  stationOcppId: 'CS-1',
  stationUuid: 'st1',
  siteId: 'site1',
  siteName: 'Depot',
};

function rec(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 9,
    sessionId: 's1',
    driverId: 'd1',
    currency: 'EUR',
    capturedAmountCents: 4000,
    chargeType: 'session',
    ...overrides,
  } as PaymentRecord;
}

const deps = { templatesDirs: ['/t'], pubsub: pubsub as never, logger };

beforeEach(() => {
  vi.clearAllMocks();
  h.sessions.length = 0;
  publish.mockResolvedValue(undefined);
  h.dispatchDriverNotification.mockResolvedValue(undefined);
});

describe('dispatchPaymentWebhookNotices', () => {
  it('tells the driver about a failed capture and refreshes the operator UI', async () => {
    h.sessions.push([SESSION]);
    await dispatchPaymentWebhookNotices(
      [{ kind: 'capture_failed', record: rec(), reason: 'Insufficient balance' }],
      deps,
    );
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      { __client: true },
      'payment.CaptureFailed',
      'd1',
      {
        stationId: 'CS-1',
        transactionId: 'tx-1',
        amountFormatted: expect.objectContaining({ cents: 4000, currency: 'EUR' }) as unknown,
        reason: 'Insufficient balance',
      },
      ['/t'],
      pubsub,
    );
    expect(publish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({
        eventType: 'payment.settled',
        stationId: 'st1',
        siteId: 'site1',
        sessionId: 's1',
        paymentRecordId: 9,
        change: 'capture_failed',
      }),
    );
  });

  it('tells the driver about a confirmed refund', async () => {
    h.sessions.push([SESSION]);
    await dispatchPaymentWebhookNotices(
      [{ kind: 'refund_succeeded', record: rec(), amountCents: 700 }],
      deps,
    );
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      { __client: true },
      'payment.Refunded',
      'd1',
      expect.objectContaining({ amountCents: 700, currency: 'EUR', transactionId: 's1' }),
      ['/t'],
      pubsub,
    );
  });

  it('sends the fee refund notice for a reservation fee and refreshes the operator UI', async () => {
    // No session lookup (no session id); one reservation lookup.
    h.sessions.push([{ reservationId: 1042 }]);
    await dispatchPaymentWebhookNotices(
      [
        {
          kind: 'refund_succeeded',
          record: rec({
            sessionId: null,
            chargeType: 'reservation_no_show',
            reservationId: 'rsv_1',
          }),
          amountCents: 700,
        },
      ],
      deps,
    );
    expect(h.dispatchDriverNotification).toHaveBeenCalledOnce();
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      { __client: true },
      'payment.FeeRefunded',
      'd1',
      expect.objectContaining({
        amountCents: 700,
        currency: 'EUR',
        feeType: 'no_show',
        isNoShowFee: true,
        reservationId: '1042',
      }),
      ['/t'],
      pubsub,
    );
    expect(publish).toHaveBeenCalledWith(
      'csms_events',
      expect.stringContaining('"change":"refund_succeeded"'),
    );
  });

  it('sends the payment receipt of a session settled after its adjustment', async () => {
    h.sessions.push([SESSION]);
    await dispatchPaymentWebhookNotices(
      [{ kind: 'session_paid', record: rec(), amountCents: 7000 }],
      deps,
    );
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      { __client: true },
      'session.PaymentReceived',
      'd1',
      {
        siteName: 'Depot',
        stationId: 'CS-1',
        transactionId: 'tx-1',
        amountCents: 7000,
        amountFormatted: expect.objectContaining({ cents: 7000, currency: 'EUR' }) as unknown,
        currency: 'EUR',
      },
      ['/t'],
      pubsub,
    );
  });

  // Finding JB-3: the receipt the settlement held back while an async
  // capture was pending goes out once the provider confirms it.
  it('sends the held-back session receipt once a capture is confirmed', async () => {
    h.sessions.push([SESSION]);
    await dispatchPaymentWebhookNotices([{ kind: 'capture_confirmed', record: rec() }], deps);
    expect(h.dispatchSessionReceiptIfDue).toHaveBeenCalledWith('s1', deps);
    expect(h.sendGuestReceiptForSession).not.toHaveBeenCalled();
    expect(h.dispatchDriverNotification).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      'csms_events',
      expect.stringContaining('"change":"capture_confirmed"'),
    );
  });

  it('sends the guest receipt once a guest capture is confirmed', async () => {
    h.sessions.push([SESSION]);
    await dispatchPaymentWebhookNotices(
      [{ kind: 'capture_confirmed', record: rec({ driverId: null }) }],
      deps,
    );
    expect(h.sendGuestReceiptForSession).toHaveBeenCalledWith('s1', deps);
    expect(h.dispatchSessionReceiptIfDue).not.toHaveBeenCalled();
  });

  it('sends the session receipt after a session settled after its adjustment', async () => {
    h.sessions.push([SESSION]);
    await dispatchPaymentWebhookNotices(
      [{ kind: 'session_paid', record: rec(), amountCents: 7000 }],
      deps,
    );
    expect(h.dispatchSessionReceiptIfDue).toHaveBeenCalledWith('s1', deps);
  });

  it('sends no receipt for a confirmed capture of a no-show fee', async () => {
    h.sessions.push([SESSION]);
    await dispatchPaymentWebhookNotices(
      [{ kind: 'capture_confirmed', record: rec({ chargeType: 'reservation_no_show' }) }],
      deps,
    );
    expect(h.dispatchSessionReceiptIfDue).not.toHaveBeenCalled();
    expect(h.sendGuestReceiptForSession).not.toHaveBeenCalled();
  });

  it('sends the receipt with empty labels when the session is gone', async () => {
    h.sessions.push([]);
    await dispatchPaymentWebhookNotices(
      [{ kind: 'session_paid', record: rec(), amountCents: 7000 }],
      deps,
    );
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      { __client: true },
      'session.PaymentReceived',
      'd1',
      expect.objectContaining({ siteName: '', stationId: '', transactionId: '' }),
      ['/t'],
      pubsub,
    );
  });

  it('only refreshes the UI for other changes, guest records and records without a session', async () => {
    await dispatchPaymentWebhookNotices(
      [
        { kind: 'record_changed', record: rec({ sessionId: null }) },
        {
          kind: 'capture_failed',
          record: rec({ driverId: null, sessionId: null }),
          reason: null,
        },
        { kind: 'refund_failed', record: rec({ sessionId: null }), amountCents: 1, reason: null },
        {
          kind: 'session_paid',
          record: rec({ driverId: null, sessionId: null }),
          amountCents: 1,
        },
        {
          kind: 'disputed',
          record: rec({ sessionId: null }),
          disputeId: 'CB1',
          reason: null,
        },
      ],
      { ...deps, pubsub: null },
    );
    expect(h.dispatchDriverNotification).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
  });

  it('fails open and continues with the next notice', async () => {
    h.sessions.push([SESSION], [SESSION]);
    h.dispatchDriverNotification.mockRejectedValueOnce(new Error('smtp down'));
    await dispatchPaymentWebhookNotices(
      [
        { kind: 'capture_failed', record: rec(), reason: null },
        { kind: 'record_changed', record: rec({ id: 10 }) },
      ],
      deps,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRecordId: 9, kind: 'capture_failed' }),
      'Payment webhook notification failed; continuing',
    );
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
