// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { DomainEvent, Logger, PubSubClient } from '@evtivity/lib';
import type { ProjectionDeps } from '../server/projection-support/context.js';

// The shared reservation services (@evtivity/services), asserted per call.
const mockApplyReservationCancellation = vi.fn();
const mockExpireStationReportedReservation = vi.fn();
const mockCancelHoldsForStationOutage = vi.fn();
const mockNotifyReservationDriver = vi.fn();
vi.mock('@evtivity/services/reservation-cancel', () => ({
  applyReservationCancellation: (...args: unknown[]) =>
    mockApplyReservationCancellation(...args) as unknown,
}));
vi.mock('@evtivity/services/reservation-expiry', () => ({
  expireStationReportedReservation: (...args: unknown[]) =>
    mockExpireStationReportedReservation(...args) as unknown,
  cancelHoldsForStationOutage: (...args: unknown[]) =>
    mockCancelHoldsForStationOutage(...args) as unknown,
}));
const mockMatchesStoredHold = vi.fn();
const mockResendStoredHold = vi.fn();
vi.mock('@evtivity/services/reservation.service', () => ({
  reserveNowMatchesStoredHold: (...args: unknown[]) => mockMatchesStoredHold(...args) as unknown,
  resendStoredHold: (...args: unknown[]) => mockResendStoredHold(...args) as unknown,
}));
vi.mock('@evtivity/services/reservation-notify', async () => ({
  // The real notice flags of the two system cancel reasons.
  cancelReasonNoticeFlags: (
    await vi.importActual<Record<string, unknown>>('../../../services/src/reservation-notify.ts')
  )['cancelReasonNoticeFlags'],
  notifyReservationDriver: (...args: unknown[]) => mockNotifyReservationDriver(...args) as unknown,
}));
vi.mock('@evtivity/database', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../database/src/lib/raw-timestamp.js')),
  writeReservationAudit: vi.fn(),
}));
vi.mock('../server/notification-dispatcher.js', () => ({
  ALL_TEMPLATES_DIRS: ['/ocpp/templates', '/api/templates'],
}));

const { projectReserveNowResult, projectReservationStatusUpdate, projectStationOutageHolds } =
  await import('../server/reservation-projections.js');

const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
let route: (text: string) => unknown[] = () => [];
const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join('?');
  sqlCalls.push({ text, values });
  return Promise.resolve(route(text));
}) as unknown as postgres.Sql;

const pubsub = { publish: vi.fn(), subscribe: vi.fn() } as unknown as PubSubClient;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const payments = { registry: {} };
const deps = {
  sql,
  pubsub,
  logger: logger as unknown as Logger,
  payments,
  eventBus: {},
  lookups: {
    resolveStationUuid: vi.fn().mockResolvedValue('sta-1'),
    resolveSiteId: vi.fn().mockResolvedValue('site-1'),
  },
  notify: { notifyChange: vi.fn() },
} as unknown as ProjectionDeps;

function event(eventType: string, payload: Record<string, unknown>): DomainEvent {
  return {
    eventType,
    aggregateType: 'ChargingStation',
    aggregateId: 'CS-1',
    payload,
    occurredAt: new Date(),
  };
}

function reserveNow(status: string, request: Record<string, unknown> = { id: 42 }): DomainEvent {
  return event('command.ReserveNow', { request, response: { status } });
}

const holdRow = {
  id: 'rsv_1',
  driver_id: 'drv_1',
  starts_at: null,
  created_at: '2026-10-11 10:00:00+00',
  expires_at: '2026-10-11 11:00:00+00',
};

const won = {
  cancelled: true,
  statusBefore: 'active',
  feeChargedCents: 0,
  feeChargeFailed: false,
  feeCurrency: null,
};

beforeEach(() => {
  sqlCalls.length = 0;
  route = () => [];
  vi.clearAllMocks();
  mockApplyReservationCancellation.mockResolvedValue(won);
  mockExpireStationReportedReservation.mockResolvedValue(true);
  mockCancelHoldsForStationOutage.mockResolvedValue(1);
  mockNotifyReservationDriver.mockResolvedValue(undefined);
});

describe('command.ReserveNow answer', () => {
  it('TC-RES-07: Accepted sets station_ack_at on the live hold without an ack, and cancels nothing', async () => {
    await projectReserveNowResult(deps, reserveNow('Accepted'));

    const ack = sqlCalls.find((c) => c.text.includes('SET station_ack_at = now()'));
    expect(ack?.text).toContain("status = 'active' AND station_ack_at IS NULL");
    expect(ack?.values).toEqual(['sta-1', 42]);
    expect(mockApplyReservationCancellation).not.toHaveBeenCalled();
    expect(mockNotifyReservationDriver).not.toHaveBeenCalled();
  });

  it('TC-RES-07: reads a 1.6-shaped request by its reservationId', async () => {
    await projectReserveNowResult(deps, reserveNow('Accepted', { reservationId: 9 }));

    expect(sqlCalls.find((c) => c.text.includes('station_ack_at = now()'))?.values).toEqual([
      'sta-1',
      9,
    ]);
  });

  describe('TC-RES-18: a late Accepted of an edit the database rolled back', () => {
    const acked = (text: string): unknown[] =>
      text.includes('station_ack_at IS NOT NULL') ? [{ id: 'rsv_1' }] : [];

    it('2.1: re-sends the stored hold when the accepted values differ', async () => {
      route = acked;
      mockMatchesStoredHold.mockResolvedValueOnce(false);
      const request = {
        id: 42,
        expiryDateTime: '2026-10-11T14:00:00.000Z',
        evseId: 2,
        idToken: { idToken: 'RFID-1', type: 'ISO14443' },
      };

      await projectReserveNowResult(deps, reserveNow('Accepted', request));

      expect(mockMatchesStoredHold).toHaveBeenCalledWith('rsv_1', request);
      expect(mockResendStoredHold).toHaveBeenCalledWith('rsv_1', {
        stationOcppId: 'CS-1',
        cause: 'a late Accepted of an edit the database rolled back',
        pubsub,
        logger,
      });
      expect(mockApplyReservationCancellation).not.toHaveBeenCalled();
    });

    it('1.6: reads the 1.6 request and re-sends the stored hold', async () => {
      route = acked;
      mockMatchesStoredHold.mockResolvedValueOnce(false);
      const request = {
        reservationId: 9,
        expiryDate: '2026-10-11T14:00:00.000Z',
        connectorId: 2,
        idTag: 'RFID-1',
      };

      await projectReserveNowResult(deps, reserveNow('Accepted', request));

      const held = sqlCalls.find((c) => c.text.includes('station_ack_at IS NOT NULL'));
      expect(held?.values).toEqual(['sta-1', 9]);
      expect(mockMatchesStoredHold).toHaveBeenCalledWith('rsv_1', request);
      expect(mockResendStoredHold).toHaveBeenCalledTimes(1);
    });

    it('an Accepted that matches the stored hold (a confirmed edit) re-sends nothing', async () => {
      route = acked;
      mockMatchesStoredHold.mockResolvedValueOnce(true);
      await projectReserveNowResult(deps, reserveNow('Accepted'));
      expect(mockResendStoredHold).not.toHaveBeenCalled();
    });

    it('the first Accepted of a hold records the ack and compares nothing', async () => {
      route = (text) => (text.includes('station_ack_at IS NULL') ? [{ id: 'rsv_1' }] : []);
      await projectReserveNowResult(deps, reserveNow('Accepted'));
      expect(mockMatchesStoredHold).not.toHaveBeenCalled();
      expect(mockResendStoredHold).not.toHaveBeenCalled();
    });
  });

  it('TC-RES-22: a rejection cancels the unacknowledged hold as system with a station_rejected audit, the SSE, and a notice', async () => {
    route = (text) => (text.includes('station_ack_at IS NULL') ? [holdRow] : []);

    await projectReserveNowResult(deps, reserveNow('Occupied'));

    expect(sqlCalls[0]?.text).toContain('station_ack_at IS NULL');
    expect(mockApplyReservationCancellation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationDbId: 'rsv_1',
        siteId: 'site-1',
        driverId: 'drv_1',
        actor: 'system',
        reason: 'station_rejected_occupied',
        auditAction: 'station_rejected',
        chargeFee: false,
        // The helper publishes reservation.changed on the OCPP pub/sub client.
        pubsub,
      }),
    );
    expect(mockNotifyReservationDriver).toHaveBeenCalledWith(
      'reservation.Cancelled',
      expect.objectContaining({
        reservationDbId: 'rsv_1',
        reservationOcppId: 42,
        stationOcppId: 'CS-1',
        driverId: 'drv_1',
      }),
      { cancellationFeeFormatted: '' },
      { pubsub, templatesDirs: ['/ocpp/templates', '/api/templates'], logger },
    );
  });

  it('TC-RES-22: any other refusal cancels with station_rejected_other', async () => {
    route = (text) => (text.includes('station_ack_at IS NULL') ? [holdRow] : []);

    await projectReserveNowResult(deps, reserveNow('Rejected'));

    expect(mockApplyReservationCancellation).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'station_rejected_other',
        auditAction: 'station_rejected',
      }),
    );
  });

  it('TC-RES-22: a refused edit re-send leaves the hold the station already accepted', async () => {
    // The lookup requires station_ack_at IS NULL, so an acknowledged hold is not found.
    route = () => [];

    await projectReserveNowResult(deps, reserveNow('Rejected'));

    expect(mockApplyReservationCancellation).not.toHaveBeenCalled();
    expect(mockNotifyReservationDriver).not.toHaveBeenCalled();
  });

  it('TC-RES-22: a cancel that lost the race sends no notice', async () => {
    route = (text) => (text.includes('station_ack_at IS NULL') ? [holdRow] : []);
    mockApplyReservationCancellation.mockResolvedValue({ ...won, cancelled: false });

    await projectReserveNowResult(deps, reserveNow('Faulted'));

    expect(mockNotifyReservationDriver).not.toHaveBeenCalled();
  });

  it('ignores a ReserveNow without a reply or a reservation id', async () => {
    await projectReserveNowResult(deps, event('command.ReserveNow', { request: { id: 1 } }));
    await projectReserveNowResult(deps, reserveNow('Rejected', {}));

    expect(sqlCalls).toHaveLength(0);
  });
});

describe('ocpp.ReservationStatusUpdate', () => {
  it('TC-RES-12: Expired hands the reporting station and OCPP id to the shared expiry', async () => {
    await projectReservationStatusUpdate(
      deps,
      event('ocpp.ReservationStatusUpdate', {
        reservationId: 42,
        reservationUpdateStatus: 'Expired',
      }),
    );

    expect(mockExpireStationReportedReservation).toHaveBeenCalledWith(
      {
        pubsub,
        payments: { ...payments, actor: { actor: 'ocpp', actorLabel: 'reservation-projection' } },
        logger,
        templatesDirs: ['/ocpp/templates', '/api/templates'],
      },
      { stationUuid: 'sta-1', reservationOcppId: 42 },
    );
    expect(sqlCalls).toHaveLength(0);
  });

  it('Removed cancels the reporting station hold as system_cleanup and tells the driver', async () => {
    route = (text) => (text.includes("status IN ('active', 'scheduled')") ? [holdRow] : []);

    await projectReservationStatusUpdate(
      deps,
      event('ocpp.ReservationStatusUpdate', {
        reservationId: 42,
        reservationUpdateStatus: 'Removed',
      }),
    );

    expect(sqlCalls[0]?.values).toEqual(['sta-1', 42]);
    expect(mockApplyReservationCancellation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationDbId: 'rsv_1',
        actor: 'system',
        reason: 'system_cleanup',
        note: 'station-reported removal',
        chargeFee: false,
        pubsub,
      }),
    );
    expect(mockNotifyReservationDriver).toHaveBeenCalledWith(
      'reservation.Cancelled',
      expect.objectContaining({ reservationOcppId: 42, driverId: 'drv_1' }),
      { cancellationFeeFormatted: '' },
      expect.anything(),
    );
  });

  it('ignores another update status', async () => {
    await projectReservationStatusUpdate(
      deps,
      event('ocpp.ReservationStatusUpdate', { reservationId: 1, reservationUpdateStatus: 'X' }),
    );

    expect(mockExpireStationReportedReservation).not.toHaveBeenCalled();
    expect(mockApplyReservationCancellation).not.toHaveBeenCalled();
  });
});

describe('station outage during a hold', () => {
  it('TC-RES-21: an offline station cancels its active holds without a fee and tells in_use drivers', async () => {
    route = (text) =>
      text.includes("status = 'in_use'")
        ? [{ id: 'rsv_2', reservation_id: 7, driver_id: 'drv_2', expires_at: null }]
        : [];

    await projectStationOutageHolds(deps, {
      stationUuid: 'sta-1',
      stationOcppId: 'CS-1',
      cause: 'offline',
    });

    expect(mockNotifyReservationDriver).toHaveBeenCalledWith(
      'reservation.StationFaulted',
      {
        reservationDbId: 'rsv_2',
        reservationOcppId: 7,
        stationOcppId: 'CS-1',
        driverId: 'drv_2',
        expiresAt: null,
      },
      {},
      expect.anything(),
    );
    expect(mockCancelHoldsForStationOutage).toHaveBeenCalledWith(
      expect.objectContaining({
        pubsub,
        payments: { ...payments, actor: { actor: 'ocpp', actorLabel: 'reservation-projection' } },
      }),
      {
        stationUuid: 'sta-1',
        stationOcppId: 'CS-1',
        siteId: 'site-1',
        cause: 'offline',
        evseUuid: null,
      },
    );
  });

  it('TC-RES-21: a faulted EVSE cancels the holds of that EVSE only', async () => {
    await projectStationOutageHolds(deps, {
      stationUuid: 'sta-1',
      stationOcppId: 'CS-1',
      cause: 'faulted',
      evseUuid: 'evse-1',
    });

    expect(sqlCalls).toHaveLength(0);
    expect(mockNotifyReservationDriver).not.toHaveBeenCalled();
    expect(mockCancelHoldsForStationOutage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cause: 'faulted', evseUuid: 'evse-1' }),
    );
  });

  it('TC-RES-21: a failed in_use notice still cancels the active holds (fail-open)', async () => {
    route = () => {
      throw new Error('db down');
    };

    await projectStationOutageHolds(deps, {
      stationUuid: 'sta-1',
      stationOcppId: 'CS-1',
      cause: 'offline',
    });

    expect(logger.warn).toHaveBeenCalled();
    expect(mockCancelHoldsForStationOutage).toHaveBeenCalledTimes(1);
  });
});
