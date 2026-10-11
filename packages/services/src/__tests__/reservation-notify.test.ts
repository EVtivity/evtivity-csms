// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dispatch: vi.fn(async (..._args: unknown[]) => undefined),
  publish: vi.fn(async () => undefined),
}));

vi.mock('@evtivity/lib', () => ({ dispatchDriverNotification: h.dispatch }));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish: h.publish }) }));
vi.mock('@evtivity/database', () => ({
  client: { __client: true },
  toDate: (v: Date | string) => (v instanceof Date ? v : new Date(v)),
}));
vi.mock('../template-dirs.js', () => ({ ALL_TEMPLATES_DIRS: ['/tpl/ocpp', '/tpl/api'] }));

import {
  cancelReasonNoticeFlags,
  notifyReservationDriver,
  reservationNoticeVariables,
} from '../reservation-notify.js';

const target = {
  reservationDbId: 'rsv_1',
  reservationOcppId: 42,
  stationOcppId: 'CS-1',
  driverId: 'drv_1',
  expiresAt: new Date('2026-10-11T12:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reservationNoticeVariables', () => {
  it('TC-RES-23: one variable set, the OCPP id as reservationId and the station OCPP id', () => {
    expect(reservationNoticeVariables(target)).toEqual({
      reservationId: 42,
      reservationDbId: 'rsv_1',
      stationId: 'CS-1',
      expiresAt: '2026-10-11T12:00:00.000Z',
    });
  });

  it('TC-RES-23: expiresAt as a string is normalized to ISO 8601, and left out when unknown', () => {
    expect(
      reservationNoticeVariables({ ...target, expiresAt: '2026-10-11 12:00:00+00' })['expiresAt'],
    ).toBe('2026-10-11T12:00:00.000Z');
    const vars = reservationNoticeVariables({ ...target, expiresAt: null });
    expect(vars).not.toHaveProperty('expiresAt');
    expect(reservationNoticeVariables({ ...target, expiresAt: undefined })).not.toHaveProperty(
      'expiresAt',
    );
  });

  it('TC-RES-23: extra variables are merged after the base set', () => {
    expect(
      reservationNoticeVariables(target, {
        cancellationFeeFormatted: '$5.00',
        stationNoResponse: true,
      }),
    ).toEqual(
      expect.objectContaining({
        reservationId: 42,
        cancellationFeeFormatted: '$5.00',
        stationNoResponse: true,
      }),
    );
  });
});

describe('notifyReservationDriver', () => {
  it('TC-RES-23: dispatches the event to the driver with the one variable set and the default templates', async () => {
    await notifyReservationDriver('reservation.Expired', target);
    expect(h.dispatch).toHaveBeenCalledWith(
      { __client: true },
      'reservation.Expired',
      'drv_1',
      reservationNoticeVariables(target),
      ['/tpl/ocpp', '/tpl/api'],
      expect.objectContaining({ publish: h.publish }),
    );
  });

  it('TC-RES-23: uses the caller pub/sub client and template folders', async () => {
    const pubsub = { publish: vi.fn(), subscribe: vi.fn() } as never;
    await notifyReservationDriver(
      'reservation.Created',
      target,
      {},
      {
        pubsub,
        templatesDirs: ['/own'],
      },
    );
    expect(h.dispatch.mock.calls[0]?.[4]).toEqual(['/own']);
    expect(h.dispatch.mock.calls[0]?.[5]).toBe(pubsub);
  });

  it('TC-RES-23: sends nothing for a reservation without a driver', async () => {
    await notifyReservationDriver('reservation.Created', { ...target, driverId: null });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('TC-RES-23: a failed dispatch is logged and does not throw (fail-open)', async () => {
    h.dispatch.mockRejectedValueOnce(new Error('smtp down'));
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await expect(
      notifyReservationDriver('reservation.Cancelled', target, {}, { logger }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'reservation.Cancelled', reservationId: 'rsv_1' }),
      'Reservation driver notice failed',
    );
  });
});

describe('cancelReasonNoticeFlags', () => {
  it('TC-RES-23: flags the station outage and no-response reasons only', () => {
    expect(cancelReasonNoticeFlags('station_unavailable_during_hold')).toEqual({
      stationUnavailable: true,
    });
    expect(cancelReasonNoticeFlags('station_no_response')).toEqual({ stationNoResponse: true });
    expect(cancelReasonNoticeFlags('driver_initiated')).toEqual({});
    expect(cancelReasonNoticeFlags('station_rejected_occupied')).toEqual({});
  });
});
