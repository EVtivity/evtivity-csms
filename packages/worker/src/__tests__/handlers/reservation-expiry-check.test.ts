// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const mockClient = vi.fn();
const mockAlertStationWatchers = vi.fn(async (..._args: unknown[]) => false);
vi.mock('@evtivity/database', () => ({
  client: (...args: unknown[]) => mockClient(...args),
  alertStationWatchersIfAvailable: (...args: unknown[]) => mockAlertStationWatchers(...args),
  pricingGroups: {},
  pricingGroupStations: {},
  pricingGroupSites: {},
  pricingGroupDrivers: {},
  pricingGroupFleets: {},
  tariffs: {},
  pricingHolidays: {},
  fleetMembers: {},
  driverPaymentMethods: {},
  writeReservationAudit: vi.fn().mockResolvedValue(undefined),
  reservationDiffChanged: vi.fn().mockReturnValue(false),
  resolveReservationFeeTerms: (...args: unknown[]) => mockFeeTerms(...args),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

const mockFeeTerms = vi.fn();

/** Fee terms with a holding fee per minute on the net basis, no tax. */
function terms(feePerMinute: string | null): Record<string, unknown> {
  return { basis: 'net', taxRate: null, feePerMinute, cancellationFeeCents: 0 };
}

const mockChargeNoShow = vi.fn().mockResolvedValue({ status: 'skipped', reason: 'no_amount' });
vi.mock('@evtivity/payments', () => ({
  chargeReservationFee: (...args: unknown[]) => mockChargeNoShow(...args),
}));

const paymentCtx = { registry: 'registry', logger: 'logger' };
const mockPaymentContext = vi.fn((_log: unknown) => paymentCtx);
vi.mock('../../lib/payments.js', () => ({
  paymentContext: (log: unknown) => mockPaymentContext(log),
}));

const mockDispatchDriver = vi.fn();
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  dispatchDriverNotification: (...args: unknown[]) => mockDispatchDriver(...args),
}));

// The module is imported after the mocks above are initialized. The first import loads the
// whole module graph, which under coverage on a busy machine took longer than one test's
// 5 s timeout, so it happens once here with its own timeout instead of inside the first test.
let mod: typeof import('../../handlers/reservation-expiry-check.js');
beforeAll(async () => {
  mod = await import('../../handlers/reservation-expiry-check.js');
}, 30_000);

describe('reservationExpiryCheckHandler', () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.mockReset();
    mockFeeTerms.mockReset();
    mockChargeNoShow.mockReset();
    mockChargeNoShow.mockResolvedValue({ status: 'skipped', reason: 'no_amount' });
  });

  it('charges no-show fee for active reservation that expired without a session', async () => {
    // 1st client call: expired CTE -- one row, no linked session, has driver
    // 2nd client call: expiringSoon SELECT -- empty
    mockClient
      .mockResolvedValueOnce([
        {
          id: 'rsv_1',
          driver_id: 'drv_1',
          prior_status: 'active',
          reservation_ocpp_id: 42,
          station_ocpp_id: 'CS-001',
          station_uuid: 'sta_1',
          site_id: 'site_1',
          starts_at: '2026-01-01T10:00:00Z',
          expires_at: '2026-01-01T11:00:00Z',
          created_at: '2026-01-01T10:00:00Z',
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mockFeeTerms.mockResolvedValue(terms('0.05'));

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    // 60 min at 0.05 per minute, priced by the engine in the charge helper.
    expect(mockChargeNoShow).toHaveBeenCalledWith(
      {
        type: 'reservation_no_show',
        reservationId: 'rsv_1',
        driverId: 'drv_1',
        siteId: 'site_1',
        fee: { pricePerMinute: '0.05', minutes: 60 },
        basis: 'net',
        taxRate: null,
      },
      paymentCtx,
    );
    expect(mockPaymentContext).toHaveBeenCalledWith(log);
    expect(mockPublish).toHaveBeenCalledWith(
      'ocpp_commands',
      expect.stringContaining('"action":"CancelReservation"'),
    );
    expect(mockDispatchDriver).toHaveBeenCalledWith(
      expect.anything(),
      'reservation.Expired',
      'drv_1',
      expect.objectContaining({ reservationId: 'rsv_1' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('skips no-show fee when reservation had a linked session', async () => {
    mockClient
      .mockResolvedValueOnce([
        {
          id: 'rsv_2',
          driver_id: 'drv_1',
          prior_status: 'active',
          reservation_ocpp_id: 43,
          station_ocpp_id: 'CS-001',
          station_uuid: 'sta_1',
          site_id: 'site_1',
          starts_at: null,
          expires_at: new Date().toISOString(),
          has_session: true,
        },
      ])
      .mockResolvedValueOnce([]);
    mockFeeTerms.mockResolvedValue(terms('0.10'));

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(mockChargeNoShow).not.toHaveBeenCalled();
  });

  it('skips no-show fee when reservation has no driver', async () => {
    mockClient
      .mockResolvedValueOnce([
        {
          id: 'rsv_3',
          driver_id: null,
          prior_status: 'active',
          reservation_ocpp_id: 44,
          station_ocpp_id: 'CS-001',
          station_uuid: 'sta_1',
          site_id: 'site_1',
          starts_at: null,
          expires_at: new Date().toISOString(),
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(mockChargeNoShow).not.toHaveBeenCalled();
    expect(mockFeeTerms).not.toHaveBeenCalled();
  });

  it('skips no-show fee when tariff has zero holding rate', async () => {
    mockClient
      .mockResolvedValueOnce([
        {
          id: 'rsv_4',
          driver_id: 'drv_1',
          prior_status: 'active',
          reservation_ocpp_id: 45,
          station_ocpp_id: 'CS-001',
          station_uuid: 'sta_1',
          site_id: 'site_1',
          starts_at: null,
          expires_at: new Date().toISOString(),
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mockFeeTerms.mockResolvedValue(terms('0'));

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(mockChargeNoShow).not.toHaveBeenCalled();
  });

  it('publishes CancelReservation for every expired reservation', async () => {
    mockClient
      .mockResolvedValueOnce([
        {
          id: 'rsv_a',
          driver_id: null,
          prior_status: 'active',
          reservation_ocpp_id: 1,
          station_ocpp_id: 'CS-A',
          station_uuid: 'sta_a',
          site_id: null,
          starts_at: null,
          expires_at: new Date().toISOString(),
          has_session: true,
        },
        {
          id: 'rsv_b',
          driver_id: 'drv_b',
          prior_status: 'active',
          reservation_ocpp_id: 2,
          station_ocpp_id: 'CS-B',
          station_uuid: 'sta_b',
          site_id: null,
          starts_at: null,
          expires_at: new Date().toISOString(),
          has_session: true,
        },
      ])
      .mockResolvedValueOnce([]);

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    const cancelCalls = mockPublish.mock.calls.filter((c) =>
      String(c[1]).includes('"action":"CancelReservation"'),
    );
    expect(cancelCalls).toHaveLength(2);
  });

  // An expired reservation frees its EVSE with no connector status change
  // until the station reports one, so each expiry checks the station watches
  // with the shared availability rule. A failed check does not stop the loop.
  it('checks the station watches of every station with an expired reservation', async () => {
    const row = (id: string, station: string): Record<string, unknown> => ({
      id,
      driver_id: null,
      prior_status: 'scheduled',
      reservation_ocpp_id: 1,
      station_ocpp_id: `CS-${station}`,
      station_uuid: `sta_${station}`,
      site_id: null,
      starts_at: null,
      expires_at: new Date().toISOString(),
      has_session: false,
    });
    mockClient.mockResolvedValueOnce([row('rsv_a', 'a'), row('rsv_b', 'b')]).mockResolvedValue([]);
    mockAlertStationWatchers.mockRejectedValueOnce(new Error('db down'));

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(mockAlertStationWatchers).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ publish: mockPublish }),
      'sta_a',
    );
    expect(mockAlertStationWatchers).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ publish: mockPublish }),
      'sta_b',
    );
  });

  it('skips CancelReservation and no-show fee for scheduled reservations', async () => {
    mockClient
      .mockResolvedValueOnce([
        {
          id: 'rsv_sched',
          driver_id: 'drv_1',
          prior_status: 'scheduled',
          reservation_ocpp_id: 50,
          station_ocpp_id: 'CS-SCHED',
          station_uuid: 'sta_sched',
          site_id: 'site_sched',
          starts_at: '2026-01-01T10:00:00Z',
          expires_at: '2026-01-01T11:00:00Z',
          created_at: '2026-01-01T09:00:00Z',
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    const cancelCalls = mockPublish.mock.calls.filter((c) =>
      String(c[1]).includes('"action":"CancelReservation"'),
    );
    expect(cancelCalls).toHaveLength(0);
    expect(mockFeeTerms).not.toHaveBeenCalled();
    expect(mockChargeNoShow).not.toHaveBeenCalled();
  });

  it('skips no-show fee when tariff has a null holding rate', async () => {
    mockClient
      .mockResolvedValueOnce([
        {
          id: 'rsv_nullrate',
          driver_id: 'drv_1',
          prior_status: 'active',
          reservation_ocpp_id: 51,
          station_ocpp_id: 'CS-NULLRATE',
          station_uuid: 'sta_nr',
          site_id: 'site_nr',
          starts_at: null,
          expires_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mockFeeTerms.mockResolvedValue(terms(null));

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(mockFeeTerms).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'sta_nr', driverId: 'drv_1' }),
    );
    expect(mockChargeNoShow).not.toHaveBeenCalled();
  });

  it('charges nothing for a no-show at a free vend site (zero-fee snapshot)', async () => {
    mockClient
      .mockResolvedValueOnce([
        {
          id: 'rsv_freevend',
          driver_id: 'drv_1',
          prior_status: 'active',
          reservation_ocpp_id: 52,
          station_ocpp_id: 'CS-FREEVEND',
          station_uuid: 'sta_fv',
          site_id: 'site_fv',
          starts_at: new Date(Date.now() - 30 * 60_000).toISOString(),
          expires_at: new Date(Date.now() - 60_000).toISOString(),
          created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
          has_session: false,
          // The snapshot a free vend site records at creation.
          fee_tax_basis: 'gross',
          fee_tax_rate: '0.19',
          fee_per_minute: null,
          fee_cancellation_cents: 0,
        },
      ])
      .mockResolvedValueOnce([]);
    mockFeeTerms.mockResolvedValue({
      basis: 'gross',
      taxRate: '0.19',
      feePerMinute: null,
      cancellationFeeCents: 0,
    });

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(mockFeeTerms).toHaveBeenCalledWith({
      stationId: 'sta_fv',
      driverId: 'drv_1',
      feeTaxBasis: 'gross',
      feeTaxRate: '0.19',
      feePerMinute: null,
      feeCancellationCents: 0,
    });
    expect(mockChargeNoShow).not.toHaveBeenCalled();
  });

  it('charges nothing when the fee terms lookup fails (free vend unknown)', async () => {
    mockClient
      .mockResolvedValueOnce([
        {
          id: 'rsv_fvfail',
          driver_id: 'drv_1',
          prior_status: 'active',
          reservation_ocpp_id: 53,
          station_ocpp_id: 'CS-FVFAIL',
          station_uuid: 'sta_ff',
          site_id: 'site_ff',
          starts_at: new Date(Date.now() - 30 * 60_000).toISOString(),
          expires_at: new Date(Date.now() - 60_000).toISOString(),
          created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
          has_session: false,
          fee_tax_basis: null,
          fee_tax_rate: null,
          fee_per_minute: null,
          fee_cancellation_cents: null,
        },
      ])
      .mockResolvedValueOnce([]);
    mockFeeTerms.mockRejectedValue(new Error('db down'));

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(mockChargeNoShow).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'rsv_fvfail' }),
      'Failed to charge no-show reservation fee',
    );
  });

  it('uses created_at as the hold start for instant reservations with no starts_at', async () => {
    mockClient
      .mockResolvedValueOnce([
        {
          id: 'rsv_instant',
          driver_id: 'drv_1',
          prior_status: 'active',
          reservation_ocpp_id: 52,
          station_ocpp_id: 'CS-INSTANT',
          station_uuid: 'sta_inst',
          site_id: 'site_inst',
          starts_at: null,
          expires_at: '2026-01-01T10:30:00Z',
          created_at: '2026-01-01T10:00:00Z',
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mockFeeTerms.mockResolvedValue(terms('0.05'));

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    // 30 min from created_at to expires_at at 0.05 per minute.
    expect(mockChargeNoShow).toHaveBeenCalledWith(
      {
        type: 'reservation_no_show',
        reservationId: 'rsv_instant',
        driverId: 'drv_1',
        siteId: 'site_inst',
        fee: { pricePerMinute: '0.05', minutes: 30 },
        basis: 'net',
        taxRate: null,
      },
      paymentCtx,
    );
  });

  it('does not charge when computed hold duration rounds to zero minutes', async () => {
    const sameInstant = '2026-01-01T10:00:00Z';
    mockClient
      .mockResolvedValueOnce([
        {
          id: 'rsv_zero',
          driver_id: 'drv_1',
          prior_status: 'active',
          reservation_ocpp_id: 53,
          station_ocpp_id: 'CS-ZERO',
          station_uuid: 'sta_zero',
          site_id: 'site_zero',
          starts_at: sameInstant,
          expires_at: sameInstant,
          created_at: sameInstant,
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mockFeeTerms.mockResolvedValue(terms('0.05'));

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(mockChargeNoShow).not.toHaveBeenCalled();
  });

  it('skips expiring notification dispatch for upcoming reservations with no driver', async () => {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    mockClient
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'rsv_nodriver', driver_id: null, expires_at: expiresAt }]);

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(mockDispatchDriver).not.toHaveBeenCalled();
  });

  it('logs a warning but continues when CancelReservation publish fails', async () => {
    mockClient
      .mockResolvedValueOnce([
        {
          id: 'rsv_pubfail',
          driver_id: 'drv_1',
          prior_status: 'active',
          reservation_ocpp_id: 99,
          station_ocpp_id: 'CS-PUBFAIL',
          station_uuid: 'sta_pf',
          site_id: 'site_pf',
          starts_at: null,
          expires_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          has_session: true,
        },
      ])
      .mockResolvedValueOnce([]);
    mockPublish.mockRejectedValueOnce(new Error('redis down'));

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'rsv_pubfail',
        stationOcppId: 'CS-PUBFAIL',
      }),
      'Failed to publish CancelReservation for expired reservation',
    );
  });

  it('logs a warning but continues when no-show fee charging throws', async () => {
    mockClient
      .mockResolvedValueOnce([
        {
          id: 'rsv_feefail',
          driver_id: 'drv_1',
          prior_status: 'active',
          reservation_ocpp_id: 100,
          station_ocpp_id: 'CS-FEEFAIL',
          station_uuid: 'sta_ff',
          site_id: 'site_ff',
          starts_at: '2026-01-01T10:00:00Z',
          expires_at: '2026-01-01T11:00:00Z',
          created_at: '2026-01-01T10:00:00Z',
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mockFeeTerms.mockResolvedValue(terms('0.05'));
    mockChargeNoShow.mockRejectedValueOnce(new Error('stripe error'));

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(mockChargeNoShow).toHaveBeenCalledWith(
      {
        type: 'reservation_no_show',
        reservationId: 'rsv_feefail',
        driverId: 'drv_1',
        siteId: 'site_ff',
        fee: { pricePerMinute: '0.05', minutes: 60 },
        basis: 'net',
        taxRate: null,
      },
      paymentCtx,
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'rsv_feefail',
        driverId: 'drv_1',
      }),
      'Failed to charge no-show reservation fee',
    );
  });

  for (const [id, basis] of [
    ['TC-T3-20', 'net'],
    ['TC-T3-21', 'gross'],
  ] as const) {
    it(`${id} charges the no-show fee on the ${basis} basis from the snapshot at creation`, async () => {
      mockClient
        .mockResolvedValueOnce([
          {
            ...noShowRow(`rsv_${basis}`),
            expires_at: '2026-01-01T10:30:00Z',
            fee_tax_basis: basis,
            fee_tax_rate: '0.19',
            fee_per_minute: '0.10',
            fee_cancellation_cents: 300,
          },
        ])
        .mockResolvedValueOnce([]);
      mockFeeTerms.mockResolvedValue({
        basis,
        taxRate: '0.19',
        feePerMinute: '0.10',
        cancellationFeeCents: 300,
      });

      const { reservationExpiryCheckHandler } = mod;
      await reservationExpiryCheckHandler(log);

      expect(mockFeeTerms).toHaveBeenCalledWith({
        stationId: 'sta_ns',
        driverId: 'drv_1',
        feeTaxBasis: basis,
        feeTaxRate: '0.19',
        feePerMinute: '0.10',
        feeCancellationCents: 300,
      });
      expect(mockChargeNoShow).toHaveBeenCalledWith(
        {
          type: 'reservation_no_show',
          reservationId: `rsv_${basis}`,
          driverId: 'drv_1',
          siteId: 'site_ns',
          fee: { pricePerMinute: '0.10', minutes: 30 },
          basis,
          taxRate: '0.19',
        },
        paymentCtx,
      );
    });
  }

  function noShowRow(id: string): Record<string, unknown> {
    return {
      id,
      driver_id: 'drv_1',
      prior_status: 'active',
      reservation_ocpp_id: 101,
      station_ocpp_id: 'CS-NOSHOW',
      station_uuid: 'sta_ns',
      site_id: 'site_ns',
      starts_at: '2026-01-01T10:00:00Z',
      expires_at: '2026-01-01T11:00:00Z',
      created_at: '2026-01-01T10:00:00Z',
      has_session: false,
    };
  }

  it('logs the charged no-show fee', async () => {
    mockClient.mockResolvedValueOnce([noShowRow('rsv_charged')]).mockResolvedValueOnce([]);
    mockFeeTerms.mockResolvedValue(terms('0.05'));
    mockChargeNoShow.mockResolvedValueOnce({
      status: 'charged',
      paymentRecordId: 7,
      grossCents: 357,
      netCents: 300,
      taxCents: 57,
      taxRate: 0.19,
      currency: 'EUR',
    });

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(log.info).toHaveBeenCalledWith(
      {
        reservationId: 'rsv_charged',
        driverId: 'drv_1',
        netCents: 300,
        grossCents: 357,
        holdingMinutes: 60,
      },
      'Charged no-show reservation fee',
    );
  });

  it('warns when the no-show fee is declined', async () => {
    mockClient.mockResolvedValueOnce([noShowRow('rsv_declined')]).mockResolvedValueOnce([]);
    mockFeeTerms.mockResolvedValue(terms('0.05'));
    mockChargeNoShow.mockResolvedValueOnce({
      status: 'failed',
      paymentRecordId: 8,
      reason: 'Your card was declined.',
    });

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(log.warn).toHaveBeenCalledWith(
      { reservationId: 'rsv_declined', paymentRecordId: 8 },
      'No-show reservation fee declined: Your card was declined.',
    );
  });

  it('dispatches reservation.Expiring notification for upcoming reservations', async () => {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    mockClient
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'rsv_soon', driver_id: 'drv_x', expires_at: expiresAt }]);

    const { reservationExpiryCheckHandler } = mod;
    await reservationExpiryCheckHandler(log);

    expect(mockDispatchDriver).toHaveBeenCalledWith(
      expect.anything(),
      'reservation.Expiring',
      'drv_x',
      expect.objectContaining({ reservationId: 'rsv_soon' }),
      expect.anything(),
      expect.anything(),
    );
  });
});
