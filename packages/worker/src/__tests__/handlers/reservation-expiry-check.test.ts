// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const mockClient = vi.fn();
vi.mock('@evtivity/database', () => ({
  client: (...args: unknown[]) => mockClient(...args),
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
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/api/src/lib/pubsub.js', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

const mockResolveTariff = vi.fn();
vi.mock('@evtivity/api/src/services/tariff.service.js', () => ({
  resolveTariff: (...args: unknown[]) => mockResolveTariff(...args),
}));

const mockChargeNoShow = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/api/src/lib/reservation-fees.js', () => ({
  chargeReservationNoShowFee: (...args: unknown[]) => mockChargeNoShow(...args),
}));

const mockDispatchDriver = vi.fn();
vi.mock('@evtivity/lib', () => ({
  dispatchDriverNotification: (...args: unknown[]) => mockDispatchDriver(...args),
}));

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
    mockResolveTariff.mockReset();
    mockChargeNoShow.mockReset();
    mockChargeNoShow.mockResolvedValue(undefined);
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
          starts_at: new Date('2026-01-01T10:00:00Z'),
          expires_at: new Date('2026-01-01T11:00:00Z'),
          created_at: new Date('2026-01-01T10:00:00Z'),
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mockResolveTariff.mockResolvedValue({
      id: 't_1',
      reservationFeePerMinute: '0.05',
      currency: 'USD',
      pricePerKwh: null,
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      taxRate: null,
    });

    const { reservationExpiryCheckHandler } =
      await import('../../handlers/reservation-expiry-check.js');
    await reservationExpiryCheckHandler(log);

    // 60 min * $0.05 = $3.00 = 300 cents. 5th arg is the resolved tariff
    // currency, which the fee helper persists on the payment record.
    expect(mockChargeNoShow).toHaveBeenCalledWith('drv_1', 'site_1', 300, 'rsv_1', 'USD');
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
          expires_at: new Date(),
          has_session: true,
        },
      ])
      .mockResolvedValueOnce([]);
    mockResolveTariff.mockResolvedValue({ reservationFeePerMinute: '0.10' });

    const { reservationExpiryCheckHandler } =
      await import('../../handlers/reservation-expiry-check.js');
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
          expires_at: new Date(),
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);

    const { reservationExpiryCheckHandler } =
      await import('../../handlers/reservation-expiry-check.js');
    await reservationExpiryCheckHandler(log);

    expect(mockChargeNoShow).not.toHaveBeenCalled();
    expect(mockResolveTariff).not.toHaveBeenCalled();
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
          expires_at: new Date(),
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mockResolveTariff.mockResolvedValue({ reservationFeePerMinute: '0' });

    const { reservationExpiryCheckHandler } =
      await import('../../handlers/reservation-expiry-check.js');
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
          expires_at: new Date(),
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
          expires_at: new Date(),
          has_session: true,
        },
      ])
      .mockResolvedValueOnce([]);

    const { reservationExpiryCheckHandler } =
      await import('../../handlers/reservation-expiry-check.js');
    await reservationExpiryCheckHandler(log);

    const cancelCalls = mockPublish.mock.calls.filter((c) =>
      String(c[1]).includes('"action":"CancelReservation"'),
    );
    expect(cancelCalls).toHaveLength(2);
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
          starts_at: new Date('2026-01-01T10:00:00Z'),
          expires_at: new Date('2026-01-01T11:00:00Z'),
          created_at: new Date('2026-01-01T09:00:00Z'),
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);

    const { reservationExpiryCheckHandler } =
      await import('../../handlers/reservation-expiry-check.js');
    await reservationExpiryCheckHandler(log);

    const cancelCalls = mockPublish.mock.calls.filter((c) =>
      String(c[1]).includes('"action":"CancelReservation"'),
    );
    expect(cancelCalls).toHaveLength(0);
    expect(mockResolveTariff).not.toHaveBeenCalled();
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
          expires_at: new Date(),
          created_at: new Date(),
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mockResolveTariff.mockResolvedValue({ reservationFeePerMinute: null, currency: 'USD' });

    const { reservationExpiryCheckHandler } =
      await import('../../handlers/reservation-expiry-check.js');
    await reservationExpiryCheckHandler(log);

    expect(mockResolveTariff).toHaveBeenCalledWith('sta_nr', 'drv_1');
    expect(mockChargeNoShow).not.toHaveBeenCalled();
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
          expires_at: new Date('2026-01-01T10:30:00Z'),
          created_at: new Date('2026-01-01T10:00:00Z'),
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mockResolveTariff.mockResolvedValue({
      reservationFeePerMinute: '0.05',
      currency: 'USD',
    });

    const { reservationExpiryCheckHandler } =
      await import('../../handlers/reservation-expiry-check.js');
    await reservationExpiryCheckHandler(log);

    // 30 min from created_at to expires_at * $0.05 = $1.50 = 150 cents.
    expect(mockChargeNoShow).toHaveBeenCalledWith('drv_1', 'site_inst', 150, 'rsv_instant', 'USD');
  });

  it('does not charge when computed hold duration rounds to zero minutes', async () => {
    const sameInstant = new Date('2026-01-01T10:00:00Z');
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
    mockResolveTariff.mockResolvedValue({
      reservationFeePerMinute: '0.05',
      currency: 'USD',
    });

    const { reservationExpiryCheckHandler } =
      await import('../../handlers/reservation-expiry-check.js');
    await reservationExpiryCheckHandler(log);

    expect(mockChargeNoShow).not.toHaveBeenCalled();
  });

  it('skips expiring notification dispatch for upcoming reservations with no driver', async () => {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    mockClient
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'rsv_nodriver', driver_id: null, expires_at: expiresAt }]);

    const { reservationExpiryCheckHandler } =
      await import('../../handlers/reservation-expiry-check.js');
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
          expires_at: new Date(),
          created_at: new Date(),
          has_session: true,
        },
      ])
      .mockResolvedValueOnce([]);
    mockPublish.mockRejectedValueOnce(new Error('redis down'));

    const { reservationExpiryCheckHandler } =
      await import('../../handlers/reservation-expiry-check.js');
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
          starts_at: new Date('2026-01-01T10:00:00Z'),
          expires_at: new Date('2026-01-01T11:00:00Z'),
          created_at: new Date('2026-01-01T10:00:00Z'),
          has_session: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mockResolveTariff.mockResolvedValue({
      reservationFeePerMinute: '0.05',
      currency: 'USD',
    });
    mockChargeNoShow.mockRejectedValueOnce(new Error('stripe error'));

    const { reservationExpiryCheckHandler } =
      await import('../../handlers/reservation-expiry-check.js');
    await reservationExpiryCheckHandler(log);

    expect(mockChargeNoShow).toHaveBeenCalledWith('drv_1', 'site_ff', 300, 'rsv_feefail', 'USD');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'rsv_feefail',
        driverId: 'drv_1',
      }),
      'Failed to charge no-show reservation fee',
    );
  });

  it('dispatches reservation.Expiring notification for upcoming reservations', async () => {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    mockClient
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'rsv_soon', driver_id: 'drv_x', expires_at: expiresAt }]);

    const { reservationExpiryCheckHandler } =
      await import('../../handlers/reservation-expiry-check.js');
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
