// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `client` is a tagged template. Each call records its SQL text and values;
// the query runs (through `h.sqlHandler`) only when awaited, so the nested
// `expiryUpdate()` fragment is never routed on its own.
interface ClientCall {
  text: string;
  values: unknown[];
}

const h = vi.hoisted(() => ({
  calls: [] as ClientCall[],
  sqlHandler: { fn: (_text: string, _values: unknown[]): unknown[] => [] },
  writeAudit: vi.fn(async (..._args: unknown[]) => undefined),
  alertWatchers: vi.fn(async (..._args: unknown[]) => false),
  feeTerms: vi.fn(),
  holdingMinutes: vi.fn((..._args: unknown[]) => 30),
  charge: vi.fn(),
  applyCancel: vi.fn(),
  notify: vi.fn(async (..._args: unknown[]) => undefined),
  publishCancel: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('@evtivity/database', () => {
  const client = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    return {
      __sqlText: text,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        h.calls.push({ text, values });
        return Promise.resolve()
          .then(() => h.sqlHandler.fn(text, values))
          .then(resolve, reject);
      },
    };
  };
  return {
    client,
    alertStationWatchersIfAvailable: h.alertWatchers,
    resolveReservationFeeTerms: h.feeTerms,
    toDate: (v: Date | string) => new Date(v),
    toDateOrNull: (v: Date | string | null) => (v == null ? null : new Date(v)),
    writeReservationAudit: h.writeAudit,
  };
});

vi.mock('@evtivity/lib', () => ({ reservationHoldingMinutes: h.holdingMinutes }));
vi.mock('@evtivity/payments', () => ({ chargeReservationFee: h.charge }));
vi.mock('../reservation-cancel.js', () => ({ applyReservationCancellation: h.applyCancel }));
vi.mock('../reservation.service.js', () => ({ publishCancelReservation: h.publishCancel }));
vi.mock('../reservation-notify.js', async () => {
  const actual = await vi.importActual<typeof import('../reservation-notify.js')>(
    '../reservation-notify.js',
  );
  return {
    notifyReservationDriver: h.notify,
    cancelReasonNoticeFlags: actual.cancelReasonNoticeFlags,
  };
});

import {
  cancelHoldsForStationOutage,
  expireDueReservations,
  expireStationReportedReservation,
  settleDueNoShowFees,
  settleNoShowFee,
} from '../reservation-expiry.js';
import type { ReservationExpiryDeps } from '../reservation-expiry.js';

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
const pubsub = { publish: vi.fn(async () => undefined), subscribe: vi.fn() };
const deps = {
  pubsub,
  payments: { registry: 'registry' },
  logger,
} as unknown as ReservationExpiryDeps;

const FEE_ROW = {
  id: 'rsv_1',
  driver_id: 'drv_1',
  station_id: 'sta_1',
  site_id: 'sit_1',
  starts_at: null,
  created_at: '2026-10-11 10:00:00+00',
  expires_at: '2026-10-11 10:30:00+00',
  updated_at: '2026-10-11 10:30:00+00',
  fee_tax_basis: 'net',
  fee_tax_rate: '0.19',
  fee_per_minute: '0.50',
  fee_cancellation_cents: 500,
};

function expiredRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rsv_1',
    driver_id: 'drv_1',
    prior_status: 'active',
    reservation_ocpp_id: 42,
    station_uuid: 'sta_1',
    station_ocpp_id: 'CS-1',
    site_id: 'sit_1',
    expires_at: '2026-10-11 10:30:00+00',
    no_show_fee_state: 'none',
    ...overrides,
  };
}

/** The no_show_fee_state values written by setFeeState. */
function feeStatesWritten(): unknown[] {
  return h.calls
    .filter((c) => c.text.includes('SET no_show_fee_state =') && c.text.includes("= 'due'"))
    .filter((c) => !c.text.includes('make_interval'))
    .map((c) => c.values[0]);
}

/** Routes the settle SELECT, the payment record lookup, and the expiry statement. */
function routeSql(opts: {
  expired?: Array<Record<string, unknown>>;
  feeRow?: Record<string, unknown> | null;
  recordStatus?: string;
  stale?: Array<{ id: string }>;
  due?: Array<{ id: string }>;
  holds?: Array<Record<string, unknown>>;
}): void {
  h.sqlHandler.fn = (text) => {
    if (text.includes('WITH pre AS')) return opts.expired ?? [];
    if (text.includes('FROM reservations r') && text.includes('fee_per_minute')) {
      return opts.feeRow === null ? [] : [opts.feeRow ?? FEE_ROW];
    }
    if (text.includes('FROM payment_records')) {
      return opts.recordStatus != null ? [{ status: opts.recordStatus }] : [];
    }
    if (text.includes('make_interval')) return opts.stale ?? [];
    if (text.includes('SELECT id FROM reservations WHERE no_show_fee_state')) return opts.due ?? [];
    if (text.includes('SELECT id, reservation_id, driver_id')) return opts.holds ?? [];
    return [];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  routeSql({});
  h.feeTerms.mockResolvedValue({ basis: 'net', taxRate: '0.19', feePerMinute: '0.50' });
  h.holdingMinutes.mockReturnValue(30);
  h.charge.mockResolvedValue({
    status: 'charged',
    paymentRecordId: 7,
    grossCents: 1785,
    netCents: 1500,
    taxCents: 285,
    taxRate: 0.19,
    currency: 'USD',
  });
  h.applyCancel.mockResolvedValue({
    cancelled: true,
    statusBefore: 'active',
    feeChargedCents: 0,
    feeChargeFailed: false,
    feeCurrency: null,
  });
});

describe('settleNoShowFee', () => {
  it('TC-RES-14: charges the snapshot fee for the minutes held and marks it charged', async () => {
    await settleNoShowFee(deps, 'rsv_1');
    expect(h.feeTerms).toHaveBeenCalledWith({
      stationId: 'sta_1',
      driverId: 'drv_1',
      feeTaxBasis: 'net',
      feeTaxRate: '0.19',
      feePerMinute: '0.50',
      feeCancellationCents: 500,
    });
    expect(h.charge).toHaveBeenCalledWith(
      {
        type: 'reservation_no_show',
        reservationId: 'rsv_1',
        driverId: 'drv_1',
        siteId: 'sit_1',
        fee: { pricePerMinute: '0.50', minutes: 30 },
        basis: 'net',
        taxRate: '0.19',
      },
      deps.payments,
    );
    expect(feeStatesWritten()).toEqual(['charged']);
  });

  it('TC-RES-14: an instant reservation holds from created_at', async () => {
    await settleNoShowFee(deps, 'rsv_1');
    expect(h.holdingMinutes).toHaveBeenCalledWith({
      startsAt: null,
      createdAt: new Date('2026-10-11T10:00:00Z'),
      expiresAt: new Date('2026-10-11T10:30:00Z'),
    });
  });

  it('TC-RES-14: a declined charge marks the fee failed', async () => {
    h.charge.mockResolvedValueOnce({ status: 'failed', paymentRecordId: 7, reason: 'declined' });
    await settleNoShowFee(deps, 'rsv_1');
    expect(feeStatesWritten()).toEqual(['failed']);
  });

  it('TC-RES-14: skipped no_amount marks none, skipped no_payment_method marks failed', async () => {
    h.charge.mockResolvedValueOnce({ status: 'skipped', reason: 'no_amount' });
    await settleNoShowFee(deps, 'rsv_1');
    h.charge.mockResolvedValueOnce({ status: 'skipped', reason: 'no_payment_method' });
    await settleNoShowFee(deps, 'rsv_1');
    expect(feeStatesWritten()).toEqual(['none', 'failed']);
  });

  it('TC-RES-14: a duplicate takes the state of its payment record', async () => {
    h.charge.mockResolvedValue({ status: 'duplicate', paymentRecordId: 7 });
    routeSql({ recordStatus: 'captured' });
    await settleNoShowFee(deps, 'rsv_1');
    routeSql({ recordStatus: 'failed' });
    await settleNoShowFee(deps, 'rsv_1');
    routeSql({ recordStatus: 'cancelled' });
    await settleNoShowFee(deps, 'rsv_1');
    expect(feeStatesWritten()).toEqual(['charged', 'failed', 'failed']);
    const lookup = h.calls.find((c) => c.text.includes('FROM payment_records'));
    expect(lookup?.values).toEqual([7]);
  });

  it('TC-RES-14: a duplicate still pending (crash after recordPendingCharge) stays due', async () => {
    h.charge.mockResolvedValueOnce({ status: 'duplicate', paymentRecordId: 7 });
    routeSql({ recordStatus: 'pending' });
    await settleNoShowFee(deps, 'rsv_1');
    expect(feeStatesWritten()).toEqual([]);
  });

  it('TC-RES-14: terms without a holding fee, or no minutes held, mark none without charging', async () => {
    h.feeTerms.mockResolvedValueOnce({ basis: 'net', taxRate: '0', feePerMinute: null });
    await settleNoShowFee(deps, 'rsv_1');
    h.feeTerms.mockResolvedValueOnce({ basis: 'net', taxRate: '0', feePerMinute: '0' });
    await settleNoShowFee(deps, 'rsv_1');
    h.holdingMinutes.mockReturnValueOnce(0);
    await settleNoShowFee(deps, 'rsv_1');
    expect(h.charge).not.toHaveBeenCalled();
    expect(feeStatesWritten()).toEqual(['none', 'none', 'none']);
  });

  it('TC-RES-14: a reservation without a driver marks none', async () => {
    routeSql({ feeRow: { ...FEE_ROW, driver_id: null } });
    await settleNoShowFee(deps, 'rsv_1');
    expect(h.charge).not.toHaveBeenCalled();
    expect(feeStatesWritten()).toEqual(['none']);
  });

  it('TC-RES-14: a fee no longer due (rerun, second pod) charges nothing', async () => {
    routeSql({ feeRow: null });
    await settleNoShowFee(deps, 'rsv_1');
    const select = h.calls[0];
    expect(select?.text).toContain("r.no_show_fee_state = 'due'");
    expect(h.charge).not.toHaveBeenCalled();
    expect(feeStatesWritten()).toEqual([]);
  });

  it('TC-RES-14: every state write is guarded on due, so a settled fee is never rewritten', async () => {
    await settleNoShowFee(deps, 'rsv_1');
    const write = h.calls.find((c) => c.text.includes('SET no_show_fee_state ='));
    expect(write?.text).toContain("AND no_show_fee_state = 'due'");
  });

  it('TC-RES-14: a charge error leaves the fee due for the next run and is logged', async () => {
    h.charge.mockRejectedValueOnce(new Error('provider down'));
    await expect(settleNoShowFee(deps, 'rsv_1')).resolves.toBeUndefined();
    expect(feeStatesWritten()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'rsv_1' }),
      'No-show fee settle failed; retried next run',
    );
  });
});

describe('settleDueNoShowFees', () => {
  it('TC-RES-14: gives up fees due for 24 hours, then settles every due fee', async () => {
    h.charge.mockResolvedValue({ status: 'skipped', reason: 'no_amount' });
    routeSql({ stale: [{ id: 'rsv_old' }], due: [{ id: 'rsv_1' }, { id: 'rsv_2' }] });
    const settled = await settleDueNoShowFees(deps, 50);
    expect(settled).toBe(2);
    const stale = h.calls.find((c) => c.text.includes('make_interval'));
    expect(stale?.text).toContain("SET no_show_fee_state = 'failed'");
    expect(stale?.values).toEqual([24]);
    const due = h.calls.find((c) => c.text.includes('SELECT id FROM reservations'));
    expect(due?.values).toEqual([50]);
    expect(h.charge).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      { reservationId: 'rsv_old' },
      expect.stringContaining('marked failed'),
    );
  });
});

describe('expireDueReservations (cron)', () => {
  it('TC-RES-14: the expiry statement sets the fee due only for an acked active hold with a driver and no session', async () => {
    await expireDueReservations(deps);
    const expiry = h.calls.find((c) => c.text.includes('WITH pre AS'));
    expect(expiry?.text).toContain("status IN ('active', 'scheduled') AND expires_at < now()");
    expect(expiry?.text).toContain('FOR UPDATE SKIP LOCKED');
    // The nested fragment carries the fee CASE.
    const fragment = (expiry?.values[0] as { __sqlText: string }).__sqlText;
    expect(fragment).toContain("pre.prior_status = 'active'");
    expect(fragment).toContain('r.station_ack_at IS NOT NULL');
    expect(fragment).toContain('r.driver_id IS NOT NULL');
    expect(fragment).toContain("r.no_show_fee_state = 'none'");
    expect(fragment).toContain('charging_sessions s WHERE s.reservation_id = r.id');
  });

  it('TC-RES-14: an expired row with a due fee is settled in the same run', async () => {
    routeSql({ expired: [expiredRow({ no_show_fee_state: 'due' })] });
    await expireDueReservations(deps);
    expect(h.charge).toHaveBeenCalledTimes(1);
    expect(feeStatesWritten()).toEqual(['charged']);
  });

  it('TC-RES-22: the expired audit reason tells a no-show from a hold that was never one', async () => {
    routeSql({
      expired: [
        expiredRow({ id: 'r_due', no_show_fee_state: 'due', acked: true }),
        expiredRow({ id: 'r_waived', no_show_fee_state: 'waived', acked: true }),
        expiredRow({ id: 'r_nodrv', driver_id: null, acked: true }),
        expiredRow({ id: 'r_sched', prior_status: 'scheduled', acked: false }),
        expiredRow({ id: 'r_unacked', acked: false }),
      ],
    });
    await expireDueReservations(deps);
    const reasons = Object.fromEntries(
      h.writeAudit.mock.calls
        .map((c) => c[0] as { reservationId: string; action: string; reason?: string })
        .filter((a) => a.action === 'expired')
        .map((a) => [a.reservationId, a.reason]),
    );
    expect(reasons).toEqual({
      r_due: 'no_show',
      r_waived: 'waived',
      r_nodrv: 'no_driver',
      r_sched: 'not_on_station',
      r_unacked: 'not_on_station',
    });
  });

  it('TC-RES-14: an expired row without a due fee charges nothing', async () => {
    routeSql({ expired: [expiredRow({ no_show_fee_state: 'none' })] });
    await expireDueReservations(deps);
    expect(h.charge).not.toHaveBeenCalled();
  });

  it('TC-RES-13: a cron expiry audits, notifies with the OCPP id and sends CancelReservation for an active hold', async () => {
    routeSql({
      expired: [
        expiredRow(),
        expiredRow({ id: 'rsv_2', prior_status: 'scheduled', reservation_ocpp_id: 43 }),
      ],
    });
    const rows = await expireDueReservations(deps);
    expect(rows.map((r) => r.id)).toEqual(['rsv_1', 'rsv_2']);
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'rsv_1',
        action: 'expired',
        actor: 'system',
        statusBefore: 'active',
        statusAfter: 'expired',
        notes: null,
      }),
      undefined,
      logger,
    );
    expect(h.notify).toHaveBeenCalledWith(
      'reservation.Expired',
      { reservationDbId: 'rsv_1', reservationOcppId: 42, stationOcppId: 'CS-1', driverId: 'drv_1' },
      {},
      deps,
    );
    // Only the active hold reached the station.
    expect(h.publishCancel).toHaveBeenCalledTimes(1);
    expect(h.publishCancel).toHaveBeenCalledWith(pubsub, 'CS-1', 42, logger);
    expect(h.alertWatchers).toHaveBeenCalledTimes(2);
    // One reservation.changed per site.
    const changed = pubsub.publish.mock.calls.filter(
      (c: unknown[]) => c[0] === 'csms_events',
    ) as unknown[][];
    expect(changed).toHaveLength(1);
    expect(JSON.parse(changed[0]?.[1] as string)).toEqual({
      eventType: 'reservation.changed',
      stationId: null,
      siteId: 'sit_1',
      sessionId: null,
    });
  });

  it('TC-RES-13: a station-watch or SSE failure is logged and the run continues', async () => {
    routeSql({ expired: [expiredRow({ no_show_fee_state: 'due' })] });
    h.alertWatchers.mockRejectedValueOnce(new Error('watch'));
    pubsub.publish.mockRejectedValueOnce(new Error('redis'));
    await expect(expireDueReservations(deps)).resolves.toHaveLength(1);
    expect(h.charge).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'rsv_1' }),
      'Station-watch check after expiry failed',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_1' }),
      'reservation.changed publish failed',
    );
  });
});

describe('expireStationReportedReservation', () => {
  it('TC-RES-12: scoped to the reporting station, never an in_use row', async () => {
    await expireStationReportedReservation(deps, { stationUuid: 'sta_1', reservationOcppId: 42 });
    const expiry = h.calls.find((c) => c.text.includes('WITH pre AS'));
    expect(expiry?.text).toContain('reservation_id = ?');
    expect(expiry?.text).toContain('AND station_id = ?');
    expect(expiry?.text).toContain("status IN ('active', 'scheduled')");
    expect(expiry?.text).not.toContain('in_use');
    expect(expiry?.values.slice(0, 2)).toEqual([42, 'sta_1']);
  });

  it('TC-RES-12: returns false and does nothing when no live row matched', async () => {
    const result = await expireStationReportedReservation(deps, {
      stationUuid: 'sta_1',
      reservationOcppId: 42,
    });
    expect(result).toBe(false);
    expect(h.writeAudit).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('TC-RES-13: a station-reported expiry charges the due fee once and notifies, without CancelReservation', async () => {
    routeSql({ expired: [expiredRow({ no_show_fee_state: 'due' })] });
    const result = await expireStationReportedReservation(deps, {
      stationUuid: 'sta_1',
      reservationOcppId: 42,
    });
    expect(result).toBe(true);
    expect(h.publishCancel).not.toHaveBeenCalled();
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'expired', notes: 'station-reported expiry' }),
      undefined,
      logger,
    );
    expect(h.notify).toHaveBeenCalledWith(
      'reservation.Expired',
      expect.objectContaining({ reservationOcppId: 42 }),
      {},
      deps,
    );
    expect(h.charge).toHaveBeenCalledTimes(1);
  });
});

describe('cancelHoldsForStationOutage', () => {
  const hold = {
    id: 'rsv_1',
    reservation_id: 42,
    driver_id: 'drv_1',
    starts_at: null,
    created_at: '2026-10-11 10:00:00+00',
  };

  it('TC-RES-21: cancels each active hold as system without a fee, sends CancelReservation and notifies the driver', async () => {
    routeSql({ holds: [hold] });
    const count = await cancelHoldsForStationOutage(deps, {
      stationUuid: 'sta_1',
      stationOcppId: 'CS-1',
      siteId: 'sit_1',
      cause: 'faulted',
    });
    expect(count).toBe(1);
    expect(h.applyCancel).toHaveBeenCalledWith({
      reservationDbId: 'rsv_1',
      siteId: 'sit_1',
      driverId: 'drv_1',
      startsAt: new Date('2026-10-11T10:00:00Z'),
      createdAt: new Date('2026-10-11T10:00:00Z'),
      actor: 'system',
      reason: 'station_unavailable_during_hold',
      auditAction: 'station_faulted',
      note: 'station faulted',
      chargeFee: false,
      pubsub,
      logger,
    });
    expect(h.publishCancel).toHaveBeenCalledWith(pubsub, 'CS-1', 42, logger);
    expect(h.notify).toHaveBeenCalledWith(
      'reservation.Cancelled',
      { reservationDbId: 'rsv_1', reservationOcppId: 42, stationOcppId: 'CS-1', driverId: 'drv_1' },
      { cancellationFeeFormatted: '', stationUnavailable: true },
      deps,
    );
    const select = h.calls.find((c) => c.text.includes('SELECT id, reservation_id'));
    expect(select?.text).toContain("status = 'active'");
    expect(select?.text).not.toContain('evse_id');
  });

  it('TC-RES-21: an offline station notes the cause, and a connector fault limits to its EVSE', async () => {
    routeSql({ holds: [hold] });
    await cancelHoldsForStationOutage(deps, {
      stationUuid: 'sta_1',
      stationOcppId: 'CS-1',
      siteId: null,
      cause: 'offline',
      evseUuid: 'evs_1',
    });
    expect(h.applyCancel).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'station offline' }),
    );
    const select = h.calls.find((c) => c.text.includes('SELECT id, reservation_id'));
    expect(select?.text).toContain('AND evse_id = ?');
    expect(select?.values).toEqual(['sta_1', 'evs_1']);
  });

  it('TC-RES-21: a hold another path already ended gets no CancelReservation and no notice', async () => {
    routeSql({ holds: [hold] });
    h.applyCancel.mockResolvedValueOnce({ cancelled: false, statusBefore: null });
    const count = await cancelHoldsForStationOutage(deps, {
      stationUuid: 'sta_1',
      stationOcppId: 'CS-1',
      siteId: null,
      cause: 'faulted',
    });
    expect(count).toBe(0);
    expect(h.publishCancel).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('TC-RES-21: one failing hold is logged and the others are still cancelled', async () => {
    routeSql({ holds: [hold, { ...hold, id: 'rsv_2', reservation_id: 43 }] });
    h.applyCancel.mockRejectedValueOnce(new Error('db'));
    const count = await cancelHoldsForStationOutage(deps, {
      stationUuid: 'sta_1',
      stationOcppId: 'CS-1',
      siteId: null,
      cause: 'faulted',
    });
    expect(count).toBe(1);
    expect(h.publishCancel).toHaveBeenCalledWith(pubsub, 'CS-1', 43, logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'rsv_1' }),
      'Cancelling a hold of an unavailable station failed',
    );
  });
});
