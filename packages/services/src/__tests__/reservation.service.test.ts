// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every database call is logged in order, so tests can check what ran inside
// the transaction and in which order (lock, conflict check, write).
interface DbEvent {
  kind: 'lock' | 'nextval' | 'select' | 'insert' | 'update';
  table?: string;
  inTx: boolean;
  where?: unknown;
  set?: Record<string, unknown>;
  values?: Record<string, unknown>;
  orderBy?: unknown;
}

const h = vi.hoisted(() => {
  class MockAppError extends Error {
    constructor(
      message: string,
      public statusCode: number,
      public code: string,
    ) {
      super(message);
    }
  }
  return {
    MockAppError,
    events: [] as DbEvent[],
    selectQueues: new Map<string, unknown[][]>(),
    updateQueue: [] as unknown[][],
    settings: { enabled: true, maxHours: 24, activeSessionCheckHours: 0 },
    publish: vi.fn(async (..._args: unknown[]) => undefined),
    publishOcppCommand: vi.fn(async (..._args: unknown[]) => undefined),
    sendOcppCommandAndWait: vi.fn(),
    applyCancel: vi.fn(),
    maintenanceCheck: vi.fn(async (..._args: unknown[]) => undefined),
    writeAudit: vi.fn(async (..._args: unknown[]) => undefined),
    feeTerms: vi.fn(async () => ({ feePerMinute: '0.50' })),
    notify: vi.fn(async (..._args: unknown[]) => undefined),
  };
});

vi.mock('drizzle-orm', () => {
  const op =
    (name: string) =>
    (...args: unknown[]) => ({ __op: name, args });
  const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    __sqlText: strings.join('?'),
    values,
  });
  return {
    and: op('and'),
    or: op('or'),
    eq: op('eq'),
    ne: op('ne'),
    gt: op('gt'),
    inArray: op('inArray'),
    isNull: op('isNull'),
    desc: op('desc'),
    sql: Object.assign(sqlTag, { raw: vi.fn(), join: vi.fn() }),
  };
});

vi.mock('@evtivity/database', () => {
  // Tables: any column reads as "<table>.<column>".
  const table = (name: string) => {
    const target: Record<string | symbol, unknown> = { __table: name };
    return new Proxy(target, {
      get: (t, prop) => (prop in t ? t[prop] : `${name}.${String(prop)}`),
    });
  };

  const makeDb = (inTx: boolean): Record<string, unknown> => {
    const select = () => {
      const ev: DbEvent = { kind: 'select', inTx };
      const chain: Record<string, unknown> = {
        from: (tbl: { __table: string }) => {
          ev.table = tbl.__table;
          return chain;
        },
        innerJoin: () => chain,
        where: (w: unknown) => {
          ev.where = w;
          return chain;
        },
        orderBy: (o: unknown) => {
          ev.orderBy = o;
          return chain;
        },
        limit: () => chain,
        then: (resolve: (v: unknown) => unknown) => {
          h.events.push(ev);
          const queue = h.selectQueues.get(ev.table ?? '');
          return Promise.resolve(queue?.shift() ?? []).then(resolve);
        },
      };
      return chain;
    };
    const insert = (tbl: { __table: string }) => {
      const ev: DbEvent = { kind: 'insert', table: tbl.__table, inTx };
      const chain = {
        values: (v: Record<string, unknown>) => {
          ev.values = v;
          return chain;
        },
        returning: () => {
          h.events.push(ev);
          return Promise.resolve([
            {
              id: 'rsv_new',
              createdAt: new Date(),
              updatedAt: new Date(),
              stationAckAt: null,
              ...ev.values,
            },
          ]);
        },
      };
      return chain;
    };
    const update = (tbl: { __table: string }) => {
      const ev: DbEvent = { kind: 'update', table: tbl.__table, inTx };
      const chain: Record<string, unknown> = {
        set: (s: Record<string, unknown>) => {
          ev.set = s;
          return chain;
        },
        where: (w: unknown) => {
          ev.where = w;
          return chain;
        },
        returning: () => {
          h.events.push(ev);
          return Promise.resolve(h.updateQueue.shift() ?? []);
        },
        then: (resolve: (v: unknown) => unknown) => {
          h.events.push(ev);
          return Promise.resolve(undefined).then(resolve);
        },
      };
      return chain;
    };
    const execute = (q: { __sqlText: string; values: unknown[] }) => {
      if (q.__sqlText.includes('pg_advisory_xact_lock')) {
        h.events.push({ kind: 'lock', inTx, values: { key: q.values[0] } });
        return Promise.resolve([]);
      }
      if (q.__sqlText.includes('nextval')) {
        h.events.push({ kind: 'nextval', inTx });
        return Promise.resolve([{ next_val: '42' }]);
      }
      return Promise.resolve([]);
    };
    return { select, insert, update, execute };
  };

  const db = {
    ...makeDb(false),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeDb(true)),
  };

  return {
    db,
    chargingStations: table('chargingStations'),
    connectors: table('connectors'),
    driverPaymentMethods: table('driverPaymentMethods'),
    drivers: table('drivers'),
    driverTokens: table('driverTokens'),
    evses: table('evses'),
    fleetDrivers: table('fleetDrivers'),
    reservations: table('reservations'),
    sites: table('sites'),
    getReservationSettings: async () => h.settings,
    isStationLevelUnavailable: (s: {
      disabledReason: string | null;
      firmwareState: string | null;
      reportedStatus: string | null;
    }) =>
      s.disabledReason != null ||
      s.firmwareState != null ||
      s.reportedStatus === 'unavailable' ||
      s.reportedStatus === 'faulted',
    snapshotReservationFeeTerms: h.feeTerms,
    writeReservationAudit: h.writeAudit,
  };
});

vi.mock('@evtivity/lib', () => ({
  AppError: h.MockAppError,
  publishOcppCommand: h.publishOcppCommand,
  OCPP_VERSION_MISMATCH: 'OCPP_VERSION_MISMATCH',
}));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish: h.publish }) }));
vi.mock('../ocpp-command.js', () => ({ sendOcppCommandAndWait: h.sendOcppCommandAndWait }));
vi.mock('../reservation-cancel.js', () => ({ applyReservationCancellation: h.applyCancel }));
vi.mock('../maintenance-check.js', () => ({ assertNoMaintenanceConflict: h.maintenanceCheck }));
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
  cancelReservationWithStation,
  createReservation,
  dispatchReservation,
  reassignReservation,
  reserveNowPayload,
  reserveNowToken,
  updateReservation,
  reserveNowMatchesStoredHold,
  reserveNowTerms,
} from '../reservation.service.js';
import type { ReservationRow, ReservationStation } from '../reservation.service.js';

const HOUR = 3_600_000;

const station: ReservationStation = {
  id: 'sta_1',
  stationId: 'CS-1',
  siteId: 'sit_1',
  isOnline: true,
  reservationsEnabled: true,
  disabledReason: null,
  firmwareState: null,
  reportedStatus: null,
};

const operator = { kind: 'operator', userId: 'usr_1' } as const;

function queue(table: string, ...results: unknown[][]): void {
  const q = h.selectQueues.get(table) ?? [];
  q.push(...results);
  h.selectQueues.set(table, q);
}

/** The selects a create with a driver and an EVSE runs before the transaction. */
function queueCreateLookups(opts: { latestToken?: string | null } = {}): void {
  queue('sites', [{ reservationsEnabled: true }]);
  queue('evses', [{ id: 'evs_1' }]);
  queue('drivers', [{ id: 'drv_1' }]);
  queue('driverPaymentMethods', [{ id: 'pm_1' }]);
  queue('driverTokens', opts.latestToken === null ? [] : [{ id: opts.latestToken ?? 'tok_9' }]);
}

function row(overrides: Partial<ReservationRow> = {}): ReservationRow {
  return {
    id: 'rsv_1',
    reservationId: 42,
    stationId: 'sta_1',
    evseId: 'evs_1',
    driverId: 'drv_1',
    tokenId: 'tok_1',
    status: 'active',
    startsAt: null,
    expiresAt: new Date(Date.now() + HOUR),
    createdAt: new Date(Date.now() - 60_000),
    updatedAt: new Date(),
    stationAckAt: new Date(),
    fleetReservationId: null,
    ...overrides,
  } as ReservationRow;
}

function flatten(cond: unknown): string {
  return JSON.stringify(cond);
}

const cancelled = {
  cancelled: true,
  statusBefore: 'active',
  feeChargedCents: 0,
  feeChargeFailed: false,
  feeCurrency: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.events.length = 0;
  h.selectQueues.clear();
  h.updateQueue.length = 0;
  h.settings.enabled = true;
  h.settings.maxHours = 24;
  h.settings.activeSessionCheckHours = 0;
  h.applyCancel.mockResolvedValue(cancelled);
});

// ---------------------------------------------------------------------------

describe('createReservation', () => {
  it('TC-RES-01: takes the per-station advisory lock, then checks overlap and inserts in the same transaction', async () => {
    queueCreateLookups();
    const created = await createReservation({
      station,
      evseOcppId: 1,
      driverId: 'drv_1',
      expiresAt: new Date(Date.now() + HOUR),
      actor: operator,
    });
    const tx = h.events.filter((e) => e.inTx);
    expect(tx.map((e) => `${e.kind}${e.table != null ? `:${e.table}` : ''}`)).toEqual([
      'lock',
      'select:reservations',
      'nextval',
      'insert:reservations',
    ]);
    expect(tx[0]?.values).toEqual({ key: 'reservation:sta_1' });
    expect(created.status).toBe('active');
    expect(created.reservationId).toBe(42);
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'created', actor: 'operator', actorUserId: 'usr_1' }),
      // After the commit, on the pool: a failed audit insert cannot abort the create.
      undefined,
      undefined,
    );
    expect(h.publish).toHaveBeenCalledWith(
      'csms_events',
      expect.stringContaining('reservation.changed'),
    );
  });

  it('TC-RES-01: the overlap check counts scheduled and station-wide holds of the station', async () => {
    queueCreateLookups();
    await createReservation({
      station,
      evseOcppId: 1,
      driverId: 'drv_1',
      expiresAt: new Date(Date.now() + HOUR),
      actor: operator,
    });
    const check = h.events.find((e) => e.inTx && e.kind === 'select');
    const where = flatten(check?.where);
    expect(where).toContain('["reservations.status",["active","scheduled"]]');
    expect(where).toContain('"__op":"isNull","args":["reservations.evseId"]');
    expect(where).toContain('"reservations.stationId","sta_1"');
  });

  it('TC-RES-01: an overlapping hold answers 409 RESERVATION_CONFLICT and inserts nothing', async () => {
    queueCreateLookups();
    queue('reservations', [{ id: 'rsv_other' }]);
    await expect(
      createReservation({
        station,
        evseOcppId: 1,
        driverId: 'drv_1',
        expiresAt: new Date(Date.now() + HOUR),
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'RESERVATION_CONFLICT' });
    expect(h.events.some((e) => e.kind === 'insert')).toBe(false);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('TC-RES-01: a future start is scheduled, and may target an offline station', async () => {
    queueCreateLookups();
    const startsAt = new Date(Date.now() + 2 * HOUR);
    const created = await createReservation({
      station: { ...station, isOnline: false },
      evseOcppId: 1,
      driverId: 'drv_1',
      startsAt,
      expiresAt: new Date(Date.now() + 3 * HOUR),
      actor: operator,
    });
    expect(created.status).toBe('scheduled');
    expect(created.startsAt).toEqual(startsAt);
  });

  it('TC-RES-01: an immediate hold on an offline station answers 400 STATION_OFFLINE', async () => {
    await expect(
      createReservation({
        station: { ...station, isOnline: false },
        driverId: null,
        expiresAt: new Date(Date.now() + HOUR),
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'STATION_OFFLINE' });
  });

  it('TC-RES-01: the window rules run before any write', async () => {
    await expect(
      createReservation({
        station,
        driverId: null,
        expiresAt: new Date(Date.now() + 30_000),
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'RESERVATION_WINDOW_TOO_SHORT' });
    await expect(
      createReservation({
        station,
        driverId: null,
        expiresAt: new Date(Date.now() + 30 * HOUR),
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'RESERVATION_TOO_LONG' });
    expect(h.events.some((e) => e.inTx)).toBe(false);
  });

  it('TC-RES-01: a driver without a default payment method answers 400 PAYMENT_METHOD_REQUIRED', async () => {
    queue('sites', [{ reservationsEnabled: true }]);
    queue('drivers', [{ id: 'drv_1' }]);
    queue('driverPaymentMethods', []);
    await expect(
      createReservation({
        station,
        driverId: 'drv_1',
        expiresAt: new Date(Date.now() + HOUR),
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'PAYMENT_METHOD_REQUIRED' });
  });

  it('TC-RES-01: a fleet slot requires fleet membership', async () => {
    queue('sites', [{ reservationsEnabled: true }]);
    queue('drivers', [{ id: 'drv_1' }]);
    queue('fleetDrivers', []);
    await expect(
      createReservation({
        station,
        driverId: 'drv_1',
        expiresAt: new Date(Date.now() + HOUR),
        actor: operator,
        fleet: { fleetId: 'flt_1', fleetReservationId: 'frs_1' },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it('TC-RES-02: binds the driver latest active token when no token is given', async () => {
    queueCreateLookups({ latestToken: 'tok_latest' });
    const created = await createReservation({
      station,
      evseOcppId: 1,
      driverId: 'drv_1',
      expiresAt: new Date(Date.now() + HOUR),
      actor: operator,
    });
    expect(created.tokenId).toBe('tok_latest');
    const tokenSelect = h.events.find((e) => e.table === 'driverTokens');
    expect(flatten(tokenSelect?.where)).toContain('["driverTokens.isActive",true]');
    expect(tokenSelect?.orderBy).toEqual({ __op: 'desc', args: ['driverTokens.updatedAt'] });
  });

  it('TC-RES-02: tokenId null binds no token; a driver without tokens binds none', async () => {
    queue('sites', [{ reservationsEnabled: true }]);
    queue('drivers', [{ id: 'drv_1' }]);
    queue('driverPaymentMethods', [{ id: 'pm_1' }]);
    const explicitNone = await createReservation({
      station,
      driverId: 'drv_1',
      tokenId: null,
      expiresAt: new Date(Date.now() + HOUR),
      actor: operator,
    });
    expect(explicitNone.tokenId).toBeNull();
    expect(h.events.some((e) => e.table === 'driverTokens')).toBe(false);

    queueCreateLookups({ latestToken: null });
    const noTokens = await createReservation({
      station,
      evseOcppId: 1,
      driverId: 'drv_1',
      expiresAt: new Date(Date.now() + HOUR),
      actor: operator,
    });
    expect(noTokens.tokenId).toBeNull();
  });

  it('TC-RES-02: an explicit token of another driver answers 400 VALIDATION_ERROR', async () => {
    queue('sites', [{ reservationsEnabled: true }]);
    queue('drivers', [{ id: 'drv_1' }]);
    queue('driverPaymentMethods', [{ id: 'pm_1' }]);
    queue('driverTokens', [{ id: 'tok_x', driverId: 'drv_other' }]);
    await expect(
      createReservation({
        station,
        driverId: 'drv_1',
        tokenId: 'tok_x',
        expiresAt: new Date(Date.now() + HOUR),
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });
});

// ---------------------------------------------------------------------------

describe('reserveNowToken and reserveNowPayload', () => {
  it('TC-RES-02: a bound token is sent with its own idToken and type', async () => {
    queue('driverTokens', [{ idToken: '04A1B2C3', type: 'ISO14443' }]);
    await expect(reserveNowToken({ tokenId: 'tok_1', driverId: 'drv_1' })).resolves.toEqual({
      idToken: { idToken: '04A1B2C3', type: 'ISO14443' },
    });
  });

  it('TC-RES-02: a driver without a token gets the driver id as a Central token', async () => {
    await expect(reserveNowToken({ tokenId: null, driverId: 'drv_1' })).resolves.toEqual({
      idToken: { idToken: 'drv_1', type: 'Central' },
    });
  });

  it('TC-RES-02: a hold without a driver gets the operator Central token', async () => {
    await expect(reserveNowToken({ tokenId: null, driverId: null })).resolves.toEqual({
      idToken: { idToken: 'operator', type: 'Central' },
    });
  });

  it('TC-RES-02: the payload carries the OCPP id, expiry, bound token and EVSE number', async () => {
    const expiresAt = new Date('2026-10-11T12:00:00Z');
    queue('driverTokens', [{ idToken: '04A1B2C3', type: 'ISO14443' }]);
    queue('evses', [{ evseId: 2 }]);
    await expect(
      reserveNowPayload({
        reservationId: 42,
        expiresAt,
        evseId: 'evs_1',
        tokenId: 'tok_1',
        driverId: 'drv_1',
      }),
    ).resolves.toEqual({
      id: 42,
      expiryDateTime: '2026-10-11T12:00:00.000Z',
      idToken: { idToken: '04A1B2C3', type: 'ISO14443' },
      evseId: 2,
    });
  });
});

// ---------------------------------------------------------------------------

describe('dispatchReservation', () => {
  const opts = { stationOcppId: 'CS-1', siteId: 'sit_1', notifyCreated: true };

  it('TC-RES-04: a ReserveNow timeout cancels in the database first (station_no_response), then publishes CancelReservation', async () => {
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      error: 'No response within 35s',
      timedOut: true,
    });
    const outcome = await dispatchReservation(row(), opts);
    expect(outcome).toEqual({ kind: 'no_response', error: 'No response within 35s' });
    expect(h.applyCancel).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationDbId: 'rsv_1',
        actor: 'system',
        reason: 'station_no_response',
        auditAction: 'station_rejected',
        chargeFee: false,
        note: 'No response within 35s',
      }),
    );
    expect(h.publishOcppCommand).toHaveBeenCalledWith(expect.anything(), {
      stationId: 'CS-1',
      action: 'CancelReservation',
      payload: { reservationId: 42 },
    });
    expect(h.applyCancel.mock.invocationCallOrder[0]).toBeLessThan(
      h.publishOcppCommand.mock.invocationCallOrder[0] as number,
    );
    expect(h.notify).toHaveBeenCalledWith(
      'reservation.Cancelled',
      expect.objectContaining({ reservationOcppId: 42, stationOcppId: 'CS-1' }),
      { cancellationFeeFormatted: '', stationNoResponse: true },
      opts,
    );
    expect(h.events.some((e) => e.kind === 'update')).toBe(false);
  });

  it('TC-RES-04: a command queued for an offline station counts as no response', async () => {
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      error: 'Station offline, command queued',
      queued: true,
    });
    const outcome = await dispatchReservation(row(), opts);
    expect(outcome.kind).toBe('no_response');
    expect(h.applyCancel).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'station_no_response' }),
    );
    expect(h.publishOcppCommand).toHaveBeenCalledTimes(1);
  });

  it('TC-RES-04: the OCPP server timeout (timedOut) is no answer, not a station failure', async () => {
    const error = 'Timeout waiting for response to ReserveNow (m1)';
    h.sendOcppCommandAndWait.mockResolvedValueOnce({ commandId: 'c1', error, timedOut: true });
    const outcome = await dispatchReservation(row(), opts);
    expect(outcome).toEqual({ kind: 'no_response', error });
  });

  it('TC-RES-04: a send error without timedOut is a failure', async () => {
    h.sendOcppCommandAndWait.mockResolvedValueOnce({ commandId: 'c1', error: 'CALLERROR x' });
    const outcome = await dispatchReservation(row(), opts);
    expect(outcome).toMatchObject({ kind: 'failed', error: 'CALLERROR x' });
  });

  it('TC-RES-04: a rollback another path already won sends no driver notice', async () => {
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      error: 'No response within 35s',
      timedOut: true,
    });
    h.applyCancel.mockResolvedValueOnce({ ...cancelled, cancelled: false, statusBefore: null });
    await dispatchReservation(row(), opts);
    expect(h.publishOcppCommand).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('TC-RES-05: Accepted records the station ack and notifies reservation.Created', async () => {
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Accepted' },
    });
    const outcome = await dispatchReservation(row(), opts);
    expect(outcome).toEqual({ kind: 'accepted' });
    const ack = h.events.find((e) => e.kind === 'update');
    expect(ack?.set).toEqual({ stationAckAt: expect.any(Date), updatedAt: expect.any(Date) });
    expect(flatten(ack?.where)).toContain('["reservations.status","active"]');
    expect(h.notify).toHaveBeenCalledWith(
      'reservation.Created',
      expect.objectContaining({ reservationDbId: 'rsv_1', reservationOcppId: 42 }),
      {},
      opts,
    );
    expect(h.applyCancel).not.toHaveBeenCalled();
  });

  it('TC-RES-05: the ReserveNow carries the bound token', async () => {
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Accepted' },
    });
    queue('driverTokens', [{ idToken: '04A1B2C3', type: 'ISO14443' }]);
    queue('evses', [{ evseId: 1 }]);
    await dispatchReservation(row(), opts);
    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith(
      'CS-1',
      'ReserveNow',
      expect.objectContaining({
        id: 42,
        idToken: { idToken: '04A1B2C3', type: 'ISO14443' },
        evseId: 1,
      }),
    );
  });

  it('TC-RES-05: Occupied cancels as station_rejected_occupied without a fee or a CancelReservation', async () => {
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Occupied' },
    });
    const outcome = await dispatchReservation(row(), opts);
    expect(outcome).toEqual({
      kind: 'rejected',
      status: 'Occupied',
      reason: 'station_rejected_occupied',
    });
    expect(h.applyCancel).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'station_rejected_occupied',
        auditAction: 'station_rejected',
        chargeFee: false,
        actor: 'system',
      }),
    );
    expect(h.applyCancel.mock.calls[0]?.[0]).not.toHaveProperty('note');
    expect(h.publishOcppCommand).not.toHaveBeenCalled();
    expect(h.events.some((e) => e.kind === 'update')).toBe(false);
    expect(h.notify).toHaveBeenCalledWith(
      'reservation.Cancelled',
      expect.anything(),
      { cancellationFeeFormatted: '' },
      opts,
    );
  });

  it('TC-RES-05: Rejected or Faulted cancel as station_rejected_other', async () => {
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Faulted' },
    });
    const outcome = await dispatchReservation(row(), opts);
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'station_rejected_other' });
  });

  it('TC-RES-05: a send error that is not a timeout cancels as station_no_response and still sends CancelReservation', async () => {
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      error: 'CALLERROR: InternalError',
    });
    const outcome = await dispatchReservation(row(), opts);
    expect(outcome).toEqual({ kind: 'failed', error: 'CALLERROR: InternalError' });
    expect(h.applyCancel).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'station_no_response' }),
    );
    expect(h.publishOcppCommand).toHaveBeenCalledTimes(1);
  });

  it('a ReserveNow refused for OCPP 2.0.1 cancels as a rejection and sends no CancelReservation', async () => {
    const error =
      'ReserveNow cannot be sent to an OCPP 2.0.1 station: idToken.type DirectPayment is not an OCPP 2.0.1 token type';
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      error,
      code: 'OCPP_VERSION_MISMATCH',
    });
    const outcome = await dispatchReservation(row(), opts);
    expect(outcome).toEqual({ kind: 'failed', error });
    expect(h.applyCancel).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'station_rejected_other', note: error }),
    );
    // Nothing reached the station, so there is no hold to cancel there.
    expect(h.publishOcppCommand).not.toHaveBeenCalled();
  });

  it('TC-RES-05: a scheduled reservation publishes reservation_schedule with its delay and sends no ReserveNow', async () => {
    const startsAt = new Date(Date.now() + HOUR);
    const outcome = await dispatchReservation(row({ status: 'scheduled', startsAt }), opts);
    expect(outcome).toEqual({ kind: 'scheduled' });
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    const [channel, message] = h.publish.mock.calls[0] as [string, string];
    expect(channel).toBe('reservation_schedule');
    const parsed = JSON.parse(message) as { reservationDbId: string; delayMs: number };
    expect(parsed.reservationDbId).toBe('rsv_1');
    expect(parsed.delayMs).toBeGreaterThan(HOUR - 5_000);
    expect(parsed.delayMs).toBeLessThanOrEqual(HOUR);
    expect(h.notify).toHaveBeenCalledWith('reservation.Created', expect.anything(), {}, opts);
  });

  it('TC-RES-05: a failed reservation_schedule publish is logged, not thrown (the cron activates it)', async () => {
    h.publish.mockRejectedValueOnce(new Error('redis down'));
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const outcome = await dispatchReservation(
      row({ status: 'scheduled', startsAt: new Date(Date.now() + HOUR) }),
      { ...opts, logger },
    );
    expect(outcome).toEqual({ kind: 'scheduled' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'rsv_1' }),
      expect.stringContaining('reservation_schedule publish failed'),
    );
  });

  it('TC-RES-05: notifyCreated false sends no Created notice', async () => {
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Accepted' },
    });
    await dispatchReservation(row(), { ...opts, notifyCreated: false });
    expect(h.notify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('cancelReservationWithStation', () => {
  const base = {
    reservationDbId: 'rsv_1',
    siteId: 'sit_1',
    driverId: 'drv_1',
    startsAt: new Date(),
    createdAt: new Date(),
    actor: 'operator' as const,
    reason: 'operator_manual' as const,
    chargeFee: false as const,
    stationOcppId: 'CS-1',
    reservationOcppId: 42,
  };

  it('TC-RES-09: cancels in the database before sending CancelReservation', async () => {
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Accepted' },
    });
    const result = await cancelReservationWithStation({ ...base, waitForStation: true });
    expect(result).toEqual(cancelled);
    expect(h.applyCancel).toHaveBeenCalledWith(
      expect.not.objectContaining({ stationOcppId: expect.anything() }),
    );
    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-1', 'CancelReservation', {
      reservationId: 42,
    });
    expect(h.applyCancel.mock.invocationCallOrder[0]).toBeLessThan(
      h.sendOcppCommandAndWait.mock.invocationCallOrder[0] as number,
    );
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('TC-RES-09: a scheduled hold never reached the station and sends nothing', async () => {
    h.applyCancel.mockResolvedValueOnce({ ...cancelled, statusBefore: 'scheduled' });
    await cancelReservationWithStation({ ...base, waitForStation: true });
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(h.publishOcppCommand).not.toHaveBeenCalled();
  });

  it('TC-RES-09: a lost cancel (another path won) sends nothing', async () => {
    h.applyCancel.mockResolvedValueOnce({ ...cancelled, cancelled: false, statusBefore: null });
    const result = await cancelReservationWithStation({ ...base, waitForStation: false });
    expect(result.cancelled).toBe(false);
    expect(h.publishOcppCommand).not.toHaveBeenCalled();
  });

  it('TC-RES-09: without waiting, the winner of an active hold publishes CancelReservation', async () => {
    await cancelReservationWithStation({ ...base, waitForStation: false });
    expect(h.publishOcppCommand).toHaveBeenCalledWith(expect.anything(), {
      stationId: 'CS-1',
      action: 'CancelReservation',
      payload: { reservationId: 42 },
    });
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
  });

  it.each([
    [
      { response: { status: 'Rejected' } },
      'station_rejected',
      'CancelReservation answered Rejected',
    ],
    [{ error: 'No response within 35s' }, 'station_no_response', 'No response within 35s'],
    [
      { error: 'Station offline, command queued', queued: true },
      'station_offline',
      'Station offline, command queued',
    ],
  ])(
    'TC-RES-10: a %j answer audits station_cancel_failed (%s) and returns a warning',
    async (answer, reason, notes) => {
      h.sendOcppCommandAndWait.mockResolvedValueOnce({ commandId: 'c1', ...answer });
      const result = await cancelReservationWithStation({ ...base, waitForStation: true });
      expect(result).toEqual({ ...cancelled, warning: 'station_cancel_failed' });
      expect(h.writeAudit).toHaveBeenCalledWith(
        {
          reservationId: 'rsv_1',
          action: 'station_cancel_failed',
          actor: 'system',
          reason,
          notes,
        },
        undefined,
        undefined,
      );
    },
  );
});

// ---------------------------------------------------------------------------

function loaded(r: ReservationRow) {
  return [{ reservation: r, stationOcppId: 'CS-1', siteId: 'sit_1' }];
}

describe('updateReservation', () => {
  it('TC-RES-18: validates a new expiry like create', async () => {
    queue('reservations', loaded(row()));
    await expect(
      updateReservation({
        reservationDbId: 'rsv_1',
        changes: { expiresAt: new Date(Date.now() + 20_000) },
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'RESERVATION_EXPIRES_TOO_SOON' });
    queue('reservations', loaded(row()));
    await expect(
      updateReservation({
        reservationDbId: 'rsv_1',
        changes: { expiresAt: new Date(Date.now() + 48 * HOUR) },
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'RESERVATION_TOO_LONG' });
    expect(h.events.some((e) => e.kind === 'update')).toBe(false);
  });

  it('TC-RES-18: a terminal reservation answers 400 RESERVATION_NOT_ACTIVE, an unknown one 404', async () => {
    queue('reservations', loaded(row({ status: 'expired' })));
    await expect(
      updateReservation({ reservationDbId: 'rsv_1', changes: {}, actor: operator }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'RESERVATION_NOT_ACTIVE' });
    await expect(
      updateReservation({ reservationDbId: 'rsv_x', changes: {}, actor: operator }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'RESERVATION_NOT_FOUND' });
  });

  it('TC-RES-18: checks scheduled and station-wide conflicts under the station lock, excluding itself', async () => {
    queue('reservations', loaded(row()), [{ id: 'rsv_other' }]);
    await expect(
      updateReservation({
        reservationDbId: 'rsv_1',
        changes: { expiresAt: new Date(Date.now() + 2 * HOUR) },
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'RESERVATION_CONFLICT' });
    const tx = h.events.filter((e) => e.inTx);
    expect(tx.map((e) => e.kind)).toEqual(['lock', 'select']);
    expect(tx[0]?.values).toEqual({ key: 'reservation:sta_1' });
    const where = flatten(tx[1]?.where);
    expect(where).toContain('["reservations.status",["active","scheduled"]]');
    expect(where).toContain('"__op":"isNull","args":["reservations.evseId"]');
    expect(where).toContain('"__op":"ne","args":["reservations.id","rsv_1"]');
  });

  it('TC-RES-18: a row cancelled meanwhile (the guarded UPDATE matches nothing) answers 409 RESERVATION_NOT_ACTIVE', async () => {
    queue('reservations', loaded(row()));
    h.updateQueue.push([]);
    await expect(
      updateReservation({
        reservationDbId: 'rsv_1',
        changes: { expiresAt: new Date(Date.now() + 2 * HOUR) },
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'RESERVATION_NOT_ACTIVE' });
    const update = h.events.find((e) => e.kind === 'update');
    expect(flatten(update?.where)).toContain('["reservations.status",["active","scheduled"]]');
    // A concurrent reassign moved it: the edit's EVSE belongs to the old station.
    expect(flatten(update?.where)).toContain('["reservations.stationId","sta_1"]');
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
  });

  it('TC-RES-18: an active edit re-sends ReserveNow with the same id and audits the change', async () => {
    const existing = row();
    const newExpiry = new Date(Date.now() + 2 * HOUR);
    queue('reservations', loaded(existing));
    h.updateQueue.push([{ ...existing, expiresAt: newExpiry }]);
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Accepted' },
    });
    const updated = await updateReservation({
      reservationDbId: 'rsv_1',
      changes: { expiresAt: newExpiry },
      actor: operator,
    });
    expect(updated.expiresAt).toEqual(newExpiry);
    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith(
      'CS-1',
      'ReserveNow',
      expect.objectContaining({ id: 42, expiryDateTime: newExpiry.toISOString() }),
    );
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'updated',
        expiresAtBefore: existing.expiresAt,
        expiresAtAfter: newExpiry,
        statusBefore: 'active',
        statusAfter: 'active',
      }),
      undefined,
      undefined,
    );
    expect(h.publish).toHaveBeenCalledWith(
      'csms_events',
      expect.stringContaining('reservation.changed'),
    );
  });

  it('TC-RES-18: a station refusal restores the previous values and answers 502', async () => {
    const existing = row();
    const newExpiry = new Date(Date.now() + 2 * HOUR);
    queue('reservations', loaded(existing));
    h.updateQueue.push([{ ...existing, expiresAt: newExpiry }], [existing]);
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Rejected' },
    });
    await expect(
      updateReservation({
        reservationDbId: 'rsv_1',
        changes: { expiresAt: newExpiry },
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 502, code: 'RESERVATION_REJECTED' });
    const updates = h.events.filter((e) => e.kind === 'update');
    expect(updates).toHaveLength(2);
    expect(updates[1]?.set).toMatchObject({
      driverId: existing.driverId,
      tokenId: existing.tokenId,
      evseId: existing.evseId,
      expiresAt: existing.expiresAt,
    });
    expect(flatten(updates[1]?.where)).toContain('["reservations.status","active"]');
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('TC-RES-18: no station answer restores the row and answers 504 RESERVATION_TIMEOUT', async () => {
    const existing = row();
    queue('reservations', loaded(existing));
    h.updateQueue.push([{ ...existing, evseId: 'evs_2' }], [existing]);
    queue('evses', [{ id: 'evs_2' }]);
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      error: 'No response within 35s',
      timedOut: true,
    });
    await expect(
      updateReservation({ reservationDbId: 'rsv_1', changes: { evseOcppId: 2 }, actor: operator }),
    ).rejects.toMatchObject({ statusCode: 504, code: 'RESERVATION_TIMEOUT' });
    expect(h.events.filter((e) => e.kind === 'update')).toHaveLength(2);
  });

  it('TC-RES-18: an edit without an answer re-sends the stored hold after the rollback, audited', async () => {
    const existing = row();
    // The load, the two conflict checks (edit, rollback), then the re-send's read.
    queue('reservations', loaded(existing), [], [], [existing]);
    h.updateQueue.push([{ ...existing, evseId: 'evs_2' }], [existing]);
    // resolveEvse, the edit payload, then the re-sent stored payload.
    queue('evses', [{ id: 'evs_2' }], [{ evseId: 2 }], [{ evseId: 1 }]);
    queue(
      'driverTokens',
      [{ idToken: 'RFID-1', type: 'ISO14443' }],
      [{ idToken: 'RFID-1', type: 'ISO14443' }],
    );
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      error: 'No response within 35s',
      timedOut: true,
    });
    await expect(
      updateReservation({ reservationDbId: 'rsv_1', changes: { evseOcppId: 2 }, actor: operator }),
    ).rejects.toMatchObject({ statusCode: 504 });
    expect(h.publishOcppCommand).toHaveBeenCalledWith(expect.anything(), {
      stationId: 'CS-1',
      action: 'ReserveNow',
      payload: {
        id: 42,
        expiryDateTime: existing.expiresAt.toISOString(),
        idToken: { idToken: 'RFID-1', type: 'ISO14443' },
        evseId: 1,
      },
    });
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'rsv_1',
        action: 'updated',
        actor: 'system',
        notes: expect.stringContaining('ReserveNow re-sent with the stored values'),
      }),
      undefined,
      undefined,
    );
  });

  it('TC-RES-18: an edit the station refused re-sends nothing (it keeps its hold)', async () => {
    const existing = row();
    queue('reservations', loaded(existing));
    h.updateQueue.push([{ ...existing, evseId: 'evs_2' }], [existing]);
    queue('evses', [{ id: 'evs_2' }]);
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Rejected' },
    });
    await expect(
      updateReservation({ reservationDbId: 'rsv_1', changes: { evseOcppId: 2 }, actor: operator }),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(h.publishOcppCommand).not.toHaveBeenCalled();
  });

  it('TC-RES-18: reserveNowMatchesStoredHold compares a 2.1 or 1.6 request with the stored hold', async () => {
    const stored = row({ evseId: 'evs_1' });
    const expiry = stored.expiresAt.toISOString();
    const lookups = (): void => {
      queue('reservations', [stored]);
      queue('driverTokens', [{ idToken: 'RFID-1', type: 'ISO14443' }]);
      queue('evses', [{ evseId: 1 }]);
    };
    lookups();
    expect(
      await reserveNowMatchesStoredHold('rsv_1', {
        id: 42,
        expiryDateTime: expiry,
        evseId: 1,
        idToken: { idToken: 'RFID-1', type: 'ISO14443' },
      }),
    ).toBe(true);
    lookups();
    expect(
      await reserveNowMatchesStoredHold('rsv_1', {
        reservationId: 42,
        expiryDate: new Date(stored.expiresAt.getTime() + HOUR).toISOString(),
        connectorId: 1,
        idTag: 'RFID-1',
      }),
    ).toBe(false);
    lookups();
    expect(
      await reserveNowMatchesStoredHold('rsv_1', {
        reservationId: 42,
        expiryDate: expiry,
        connectorId: 2,
        idTag: 'RFID-1',
      }),
    ).toBe(false);
  });

  it('reserveNowTerms reads the 2.1 and the 1.6 form alike', () => {
    const expiry = '2026-10-11T12:00:00.000Z';
    expect(
      reserveNowTerms({ id: 1, expiryDateTime: expiry, evseId: 2, idToken: { idToken: 'A' } }),
    ).toEqual({ expiresAtMs: Date.parse(expiry), evseId: 2, idToken: 'A' });
    expect(
      reserveNowTerms({ reservationId: 1, expiryDate: expiry, connectorId: 2, idTag: 'A' }),
    ).toEqual({ expiresAtMs: Date.parse(expiry), evseId: 2, idToken: 'A' });
    // Any EVSE: absent in 2.1, connector 0 in 1.6.
    expect(reserveNowTerms({ connectorId: 0 }).evseId).toBeNull();
  });

  it('TC-RES-18: a scheduled edit is a database update only', async () => {
    const existing = row({ status: 'scheduled', startsAt: new Date(Date.now() + HOUR) });
    const newExpiry = new Date(Date.now() + 3 * HOUR);
    queue('reservations', loaded(existing));
    h.updateQueue.push([{ ...existing, expiresAt: newExpiry }]);
    await updateReservation({
      reservationDbId: 'rsv_1',
      changes: { expiresAt: newExpiry },
      actor: operator,
    });
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(h.writeAudit).toHaveBeenCalledTimes(1);
  });

  it('TC-RES-18: a new driver never keeps the previous driver card', async () => {
    const existing = row();
    queue('reservations', loaded(existing));
    queue('driverTokens', [{ id: 'tok_new' }]);
    queue('drivers', [{ id: 'drv_2' }]);
    queue('driverPaymentMethods', [{ id: 'pm_2' }]);
    h.updateQueue.push([{ ...existing, driverId: 'drv_2', tokenId: 'tok_new' }]);
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Accepted' },
    });
    await updateReservation({
      reservationDbId: 'rsv_1',
      changes: { driverId: 'drv_2' },
      actor: operator,
    });
    const update = h.events.find((e) => e.kind === 'update');
    expect(update?.set).toMatchObject({ driverId: 'drv_2', tokenId: 'tok_new' });
  });
});

// ---------------------------------------------------------------------------

describe('reassignReservation', () => {
  const newStation: ReservationStation = {
    ...station,
    id: 'sta_2',
    stationId: 'CS-2',
    siteId: 'sit_2',
  };

  function cancelTargets(): string[] {
    return h.publishOcppCommand.mock.calls
      .map((c) => c[1] as { stationId: string; action: string })
      .filter((c) => c.action === 'CancelReservation')
      .map((c) => c.stationId);
  }

  it('TC-RES-19: an active hold gets ReserveNow on the new station, moves under its lock, then CancelReservation on the old station', async () => {
    const existing = row();
    queue('reservations', loaded(existing));
    queue('sites', [{ reservationsEnabled: true }]);
    queue('evses', [{ id: 'evs_9' }]);
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Accepted' },
    });
    h.updateQueue.push([{ ...existing, stationId: 'sta_2', evseId: 'evs_9' }]);
    const result = await reassignReservation({
      reservationDbId: 'rsv_1',
      newStation,
      newEvseOcppId: 1,
      actor: operator,
    });
    expect(result.previousStationOcppId).toBe('CS-1');
    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith(
      'CS-2',
      'ReserveNow',
      expect.objectContaining({ id: 42 }),
    );
    const tx = h.events.filter((e) => e.inTx);
    expect(tx.map((e) => e.kind)).toEqual(['lock', 'select', 'update']);
    expect(tx[0]?.values).toEqual({ key: 'reservation:sta_2' });
    expect(tx[2]?.set).toMatchObject({
      stationId: 'sta_2',
      evseId: 'evs_9',
      stationAckAt: expect.any(Date),
    });
    expect(flatten(tx[2]?.where)).toContain('["reservations.status","active"]');
    expect(flatten(tx[2]?.where)).toContain('["reservations.stationId","sta_1"]');
    expect(cancelTargets()).toEqual(['CS-1']);
    const changed = h.publish.mock.calls.filter((c) => c[0] === 'csms_events');
    expect(changed).toHaveLength(2);
  });

  it('TC-RES-19: when the guard loses (cancelled meanwhile) the new station gets CancelReservation and it answers 409', async () => {
    const existing = row();
    queue('reservations', loaded(existing));
    queue('sites', [{ reservationsEnabled: true }]);
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Accepted' },
    });
    h.updateQueue.push([]);
    await expect(
      reassignReservation({ reservationDbId: 'rsv_1', newStation, actor: operator }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'RESERVATION_NOT_ACTIVE' });
    expect(cancelTargets()).toEqual(['CS-2']);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('TC-RES-19: a conflict on the new station cancels the new hold and answers 409 RESERVATION_CONFLICT', async () => {
    const existing = row();
    queue('reservations', loaded(existing), [{ id: 'rsv_other' }]);
    queue('sites', [{ reservationsEnabled: true }]);
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Accepted' },
    });
    await expect(
      reassignReservation({ reservationDbId: 'rsv_1', newStation, actor: operator }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'RESERVATION_CONFLICT' });
    expect(h.events.some((e) => e.kind === 'update')).toBe(false);
    expect(cancelTargets()).toEqual(['CS-2']);
  });

  it('TC-RES-19: a refused ReserveNow answers 400 RESERVATION_REJECTED and moves nothing', async () => {
    queue('reservations', loaded(row()));
    queue('sites', [{ reservationsEnabled: true }]);
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Occupied' },
    });
    await expect(
      reassignReservation({ reservationDbId: 'rsv_1', newStation, actor: operator }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'RESERVATION_REJECTED' });
    expect(h.events.some((e) => e.kind === 'update')).toBe(false);
    expect(cancelTargets()).toEqual([]);
  });

  it('TC-RES-19: an unanswered ReserveNow sends CancelReservation to the new station (a late Accepted)', async () => {
    queue('reservations', loaded(row()));
    queue('sites', [{ reservationsEnabled: true }]);
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      error: 'No response within 35s',
      timedOut: true,
    });
    await expect(
      reassignReservation({ reservationDbId: 'rsv_1', newStation, actor: operator }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'RESERVATION_REJECTED' });
    expect(cancelTargets()).toEqual(['CS-2']);
  });

  it('TC-RES-19: refuses a move within the same station (an EVSE edit goes through PATCH)', async () => {
    queue('reservations', loaded(row()));
    await expect(
      reassignReservation({
        reservationDbId: 'rsv_1',
        newStation: station,
        newEvseOcppId: 2,
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(cancelTargets()).toEqual([]);
  });

  it('TC-RES-19: a scheduled hold moves with a guarded update and no OCPP command', async () => {
    const existing = row({ status: 'scheduled', startsAt: new Date(Date.now() + HOUR) });
    queue('reservations', loaded(existing));
    queue('sites', [{ reservationsEnabled: true }]);
    h.updateQueue.push([{ ...existing, stationId: 'sta_2' }]);
    await reassignReservation({
      reservationDbId: 'rsv_1',
      newStation: { ...newStation, isOnline: false },
      actor: operator,
    });
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(cancelTargets()).toEqual([]);
    const update = h.events.find((e) => e.kind === 'update');
    expect(update?.set).not.toHaveProperty('stationAckAt');
    expect(flatten(update?.where)).toContain('["reservations.status","scheduled"]');
  });

  it('TC-RES-19: an active hold cannot move to an offline station', async () => {
    queue('reservations', loaded(row()));
    await expect(
      reassignReservation({
        reservationDbId: 'rsv_1',
        newStation: { ...newStation, isOnline: false },
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'STATION_OFFLINE' });
  });

  it('TC-RES-19: a busy EVSE on the new station answers 409 EVSE_IN_USE', async () => {
    h.settings.activeSessionCheckHours = 2;
    queue('reservations', loaded(row()));
    queue('sites', [{ reservationsEnabled: true }]);
    queue('evses', [{ id: 'evs_9' }]);
    queue('connectors', [{ status: 'occupied' }]);
    await expect(
      reassignReservation({
        reservationDbId: 'rsv_1',
        newStation,
        newEvseOcppId: 1,
        actor: operator,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'EVSE_IN_USE' });
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
  });
});
