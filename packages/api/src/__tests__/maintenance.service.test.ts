// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state. Everything referenced inside a vi.mock factory must be
// created via vi.hoisted() so it exists before the mocked module is imported.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  // AppError stand-in carrying statusCode + code so tests can assert on them.
  class MockAppError extends Error {
    statusCode: number;
    code: string;
    constructor(message: string, statusCode: number, code: string) {
      super(message);
      this.name = 'AppError';
      this.statusCode = statusCode;
      this.code = code;
    }
  }

  // Table marker objects. The select chain inspects the `__table` field of the
  // argument passed to `.from()` to decide which result set to return.
  const table = (name: string): { __table: string } => ({ __table: name });

  return {
    MockAppError,
    table,
    // ---- routing state, reset in beforeEach ----
    // Per-table queue of result sets. When more than one set is queued for a
    // table, each .from(table) consumes the next one in order; the last set
    // sticks for any further reads. This lets a single service call read the
    // same table multiple times with different rows without a brittle
    // spy-on-Map hack.
    selectResults: new Map<string, unknown[][]>(),
    executeHandler: { fn: (_sqlText: string) => [] as unknown[] },
    insertReturning: { rows: [] as unknown[] },
    insertCalls: [] as Array<{ table: string | null; values: unknown }>,
    updateReturning: { rows: [] as unknown[] },
    // ---- spies ----
    writeAudit: vi.fn(
      async (_config: unknown, _args: { action?: string } & Record<string, unknown>) => {},
    ),
    sendOcppCommandAndWait: vi.fn(
      async (
        _stationId: string,
        _action: string,
        _payload: Record<string, unknown>,
        _version?: string,
      ): Promise<Record<string, unknown>> => ({ commandId: 'c1' }),
    ),
    pushStationMessageSlot: vi.fn(async () => {}),
    clearStationMessageSlot: vi.fn(async () => {}),
    applyReservationCancellation: vi.fn(
      async (
        _input: Record<string, unknown>,
      ): Promise<{ cancelled: boolean; feeChargedCents: number; feeChargeFailed: boolean }> => ({
        cancelled: true,
        feeChargedCents: 0,
        feeChargeFailed: false,
      }),
    ),
    invalidateMaintenanceCheckCache: vi.fn(() => {}),
    dispatchDriverNotification: vi.fn(
      async (
        _client: unknown,
        _eventType: string,
        _driverId: string,
        _vars: Record<string, unknown>,
        _dirs: string[],
        _pubsub: unknown,
      ) => {},
    ),
    renderMaintenanceMessage: vi.fn(async () => 'MAINT MSG'),
    publish: vi.fn(async (_channel: string, _payload: string) => {}),
  };
});

// ---------------------------------------------------------------------------
// drizzle-orm: capture the SQL text from the tagged template so db.execute can
// route on it. The condition helpers are inert pass-throughs.
// ---------------------------------------------------------------------------
vi.mock('drizzle-orm', () => {
  const sqlTag = (strings: TemplateStringsArray, ..._values: unknown[]): { __sqlText: string } => ({
    __sqlText: strings.join(' '),
  });
  return {
    and: (...args: unknown[]) => ({ __op: 'and', args }),
    or: (...args: unknown[]) => ({ __op: 'or', args }),
    eq: (...args: unknown[]) => ({ __op: 'eq', args }),
    inArray: (...args: unknown[]) => ({ __op: 'inArray', args }),
    isNull: (...args: unknown[]) => ({ __op: 'isNull', args }),
    lt: (...args: unknown[]) => ({ __op: 'lt', args }),
    gt: (...args: unknown[]) => ({ __op: 'gt', args }),
    sql: Object.assign(sqlTag, { raw: vi.fn(), join: vi.fn() }),
  };
});

// ---------------------------------------------------------------------------
// @evtivity/database: db.select routes on the table passed to .from(),
// db.execute routes on SQL text, db.insert/update use returning queues.
// ---------------------------------------------------------------------------
vi.mock('@evtivity/database', () => {
  const makeSelectChain = (): Record<string, unknown> => {
    let selectedTable: string | null = null;
    const chain: Record<string, unknown> = {
      from: (tbl: { __table?: string } | undefined) => {
        selectedTable = tbl?.__table ?? null;
        return chain;
      },
      where: () => chain,
      // Make the chain awaitable (thenable). Resolves to the next queued
      // result set for whichever table was selected.
      then: (resolve: (v: unknown[]) => unknown) => {
        let result: unknown[] = [];
        if (selectedTable != null) {
          const queue = h.selectResults.get(selectedTable);
          if (queue != null && queue.length > 0) {
            result = queue.length > 1 ? (queue.shift() as unknown[]) : (queue[0] as unknown[]);
          }
        }
        return Promise.resolve(result).then(resolve);
      },
    };
    return chain;
  };

  const makeInsertChain = (tbl: { __table?: string } | undefined): Record<string, unknown> => {
    const chain: Record<string, unknown> = {
      values: (v: unknown) => {
        h.insertCalls.push({ table: tbl?.__table ?? null, values: v });
        return chain;
      },
      returning: () => Promise.resolve(h.insertReturning.rows),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
    };
    return chain;
  };

  const updateChain = {
    set: () => updateChain,
    where: () => updateChain,
    returning: () => Promise.resolve(h.updateReturning.rows),
    // bare update (no returning) is awaited directly
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
  };

  const db = {
    select: () => makeSelectChain(),
    insert: (tbl: { __table?: string } | undefined) => makeInsertChain(tbl),
    update: () => updateChain,
    execute: (arg: { __sqlText?: string } | undefined) => {
      const text = arg?.__sqlText ?? '';
      return Promise.resolve(h.executeHandler.fn(text));
    },
  };

  return {
    db,
    client: { __client: true },
    maintenanceEvents: h.table('maintenanceEvents'),
    maintenanceEventAuditLog: h.table('maintenanceEventAuditLog'),
    chargingStations: h.table('chargingStations'),
    chargingSessions: h.table('chargingSessions'),
    sites: h.table('sites'),
    reservations: h.table('reservations'),
    maintenanceEventStations: h.table('maintenanceEventStations'),
    writeAudit: h.writeAudit,
  };
});

vi.mock('@evtivity/lib', () => ({
  AppError: h.MockAppError,
  dispatchDriverNotification: h.dispatchDriverNotification,
  renderMaintenanceMessage: h.renderMaintenanceMessage,
}));

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: () => ({ publish: h.publish }),
}));

vi.mock('../lib/ocpp-command.js', () => ({
  sendOcppCommandAndWait: h.sendOcppCommandAndWait,
}));

vi.mock('../lib/reservation-cancel.js', () => ({
  applyReservationCancellation: h.applyReservationCancellation,
}));

vi.mock('../lib/maintenance-check.js', () => ({
  invalidateMaintenanceCheckCache: h.invalidateMaintenanceCheckCache,
}));

vi.mock('../services/station-message.service.js', () => ({
  pushStationMessageSlot: h.pushStationMessageSlot,
  clearStationMessageSlot: h.clearStationMessageSlot,
  STATION_MESSAGE_SLOT_UNAVAILABLE: 9005,
}));

vi.mock('../lib/template-dirs.js', () => ({
  ALL_TEMPLATES_DIRS: ['/tpl/ocpp', '/tpl/api'],
}));

// The status-after settle is a real 5s wait in production; tests resolve it
// immediately so runner tests stay fast.
vi.mock('../lib/sleep.js', () => ({
  sleep: vi.fn(async () => {}),
}));

import {
  createEvent,
  updateEvent,
  addStationsToMaintenance,
  removeStationsFromMaintenance,
  cancelEvent,
  enterMaintenance,
  exitMaintenance,
  runMaintenanceFanout,
  getActiveMaintenanceForStation,
  getActiveMaintenanceForSite,
  type MaintenanceEventRow,
  type UpdateEventInput,
} from '../services/maintenance.service.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEventRow(overrides: Partial<MaintenanceEventRow> = {}): MaintenanceEventRow {
  return {
    id: 'mne_1',
    siteId: 'sit_1',
    eventType: 'one_off',
    status: 'scheduled',
    plannedStartAt: new Date('2026-06-10T10:00:00Z'),
    plannedEndAt: new Date('2026-06-10T12:00:00Z'),
    startedAt: null,
    endedAt: null,
    affectedStationIds: null,
    activeSessionPolicy: 'ignore',
    customMessage: null,
    reason: 'test reason',
    reservationsCancelledCount: 0,
    sessionsStoppedCount: 0,
    createdByUserId: 'usr_1',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

// Set a single (sticky) result set for a table.
function setSelect(table: string, rows: unknown[]): void {
  h.selectResults.set(table, [rows]);
}

// Queue an ordered list of result sets for a table. Each successive read
// consumes the next set; the last set sticks for any further reads.
function queueSelect(table: string, sets: unknown[][]): void {
  h.selectResults.set(table, sets);
}

const OPERATOR_ACTOR = { type: 'operator' as const, userId: 'usr_1' };
const SYSTEM_ACTOR = { type: 'system' as const };

beforeEach(() => {
  vi.clearAllMocks();
  h.selectResults.clear();
  h.executeHandler.fn = () => [];
  h.insertReturning.rows = [];
  h.insertCalls.length = 0;
  h.updateReturning.rows = [];
  // Sensible defaults so awaited chains never throw.
  setSelect('maintenanceEvents', []);
  setSelect('chargingStations', []);
  setSelect('chargingSessions', []);
  setSelect('sites', []);
  setSelect('reservations', []);
  h.renderMaintenanceMessage.mockResolvedValue('MAINT MSG');
  h.sendOcppCommandAndWait.mockResolvedValue({ commandId: 'c1' });
  h.applyReservationCancellation.mockResolvedValue({
    cancelled: true,
    feeChargedCents: 0,
    feeChargeFailed: false,
  });
});

type AuditArgs = { action?: string } & Record<string, unknown>;

// Find writeAudit calls whose args carry the given action. Returns the audit
// args object (second positional arg) for each matching call.
function auditCallsByAction(action: string): AuditArgs[] {
  return h.writeAudit.mock.calls
    .map((c): AuditArgs => c[1])
    .filter((args) => args.action === action);
}

// ===========================================================================
// createEvent
// ===========================================================================
describe('createEvent', () => {
  it('throws MAINTENANCE_INVALID_RANGE when end <= start', async () => {
    await expect(
      createEvent({
        siteId: 'sit_1',
        eventType: 'one_off',
        plannedStartAt: new Date('2026-06-10T12:00:00Z'),
        plannedEndAt: new Date('2026-06-10T12:00:00Z'),
        activeSessionPolicy: 'ignore',
        actor: OPERATOR_ACTOR,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'MAINTENANCE_INVALID_RANGE' });
  });

  it('throws MAINTENANCE_OVERLAPS_EXISTING when an overlapping event exists', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ id: 'mne_other' })]);

    await expect(
      createEvent({
        siteId: 'sit_1',
        eventType: 'one_off',
        plannedStartAt: new Date('2026-06-10T10:00:00Z'),
        plannedEndAt: new Date('2026-06-10T12:00:00Z'),
        activeSessionPolicy: 'ignore',
        actor: OPERATOR_ACTOR,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'MAINTENANCE_OVERLAPS_EXISTING' });
  });

  it('creates a scheduled one_off event in the future without entering maintenance', async () => {
    const future = makeEventRow({
      status: 'scheduled',
      plannedStartAt: new Date(Date.now() + 3600_000),
      plannedEndAt: new Date(Date.now() + 7200_000),
    });
    h.insertReturning.rows = [future];

    const result = await createEvent({
      siteId: 'sit_1',
      eventType: 'one_off',
      plannedStartAt: future.plannedStartAt,
      plannedEndAt: future.plannedEndAt,
      activeSessionPolicy: 'ignore',
      actor: OPERATOR_ACTOR,
    });

    expect(result.id).toBe('mne_1');
    // created audit written
    expect(auditCallsByAction('created')).toHaveLength(1);
    expect(auditCallsByAction('created')[0]).toMatchObject({
      action: 'created',
      actor: 'operator',
      actorUserId: 'usr_1',
      before: null,
    });
    // cache invalidated + SSE published
    expect(h.invalidateMaintenanceCheckCache).toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({ eventType: 'maintenance.changed', siteId: 'sit_1', eventId: 'mne_1' }),
    );
    // No ChangeAvailability since it stays scheduled
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
  });

  it('records a null createdByUserId for a system actor', async () => {
    const future = makeEventRow({
      status: 'scheduled',
      createdByUserId: null,
      plannedStartAt: new Date(Date.now() + 3600_000),
      plannedEndAt: new Date(Date.now() + 7200_000),
    });
    h.insertReturning.rows = [future];

    await createEvent({
      siteId: 'sit_1',
      eventType: 'one_off',
      plannedStartAt: future.plannedStartAt,
      plannedEndAt: future.plannedEndAt,
      activeSessionPolicy: 'ignore',
      actor: SYSTEM_ACTOR,
    });

    expect(auditCallsByAction('created')[0]).toMatchObject({
      actor: 'system',
      actorUserId: null,
    });
  });

  it('throws INTERNAL_ERROR when insert returns nothing', async () => {
    h.insertReturning.rows = [];
    await expect(
      createEvent({
        siteId: 'sit_1',
        eventType: 'one_off',
        plannedStartAt: new Date(Date.now() + 3600_000),
        plannedEndAt: new Date(Date.now() + 7200_000),
        activeSessionPolicy: 'ignore',
        actor: OPERATOR_ACTOR,
      }),
    ).rejects.toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
  });

  it('immediate event enters maintenance and returns the refreshed row', async () => {
    const inserted = makeEventRow({
      eventType: 'immediate',
      status: 'scheduled',
      affectedStationIds: null,
    });
    h.insertReturning.rows = [inserted];

    // enterMaintenance: the activation UPDATE returns one row.
    h.executeHandler.fn = (text) => {
      if (text.includes("status = 'active'")) return [{ id: 'mne_1' }];
      return [];
    };

    // maintenanceEvents reads: (1) overlap check before insert -> empty,
    // (2) loadEventById after activation -> active row,
    // (3) final refresh -> active row (sticky).
    const activeRow = makeEventRow({
      eventType: 'immediate',
      status: 'active',
      startedAt: new Date(),
    });
    queueSelect('maintenanceEvents', [[], [activeRow]]);
    setSelect('sites', [{ name: 'Site One' }]);
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }]);

    const result = await createEvent({
      siteId: 'sit_1',
      eventType: 'immediate',
      plannedStartAt: inserted.plannedStartAt,
      plannedEndAt: inserted.plannedEndAt,
      activeSessionPolicy: 'ignore',
      actor: OPERATOR_ACTOR,
    });

    expect(result.status).toBe('active');
    // ChangeAvailability Inoperative pushed to the station
    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
    // slot 9005 pushed
    expect(h.pushStationMessageSlot).toHaveBeenCalledWith(
      'CS-001',
      'ocpp2.1',
      9005,
      'Unavailable',
      'MAINT MSG',
    );
    // started audit written
    expect(auditCallsByAction('started')).toHaveLength(1);
  });

  it('falls back to the created row when the post-activation refresh returns null', async () => {
    const inserted = makeEventRow({ eventType: 'immediate', status: 'scheduled' });
    h.insertReturning.rows = [inserted];
    // enterMaintenance activation UPDATE returns a row, but its own
    // loadEventById and the final refresh both find nothing.
    h.executeHandler.fn = (text) => (text.includes("status = 'active'") ? [{ id: 'mne_1' }] : []);
    // maintenanceEvents reads: overlap (empty), then everything empty.
    queueSelect('maintenanceEvents', [[]]);

    const result = await createEvent({
      siteId: 'sit_1',
      eventType: 'immediate',
      plannedStartAt: inserted.plannedStartAt,
      plannedEndAt: inserted.plannedEndAt,
      activeSessionPolicy: 'ignore',
      actor: OPERATOR_ACTOR,
    });

    // enterMaintenance no-opped (loadEventById null), createEvent returns the
    // originally created row.
    expect(result.id).toBe('mne_1');
    expect(result.status).toBe('scheduled');
  });
});

// ===========================================================================
// enterMaintenance
// ===========================================================================
describe('enterMaintenance', () => {
  it('no-ops when the activation UPDATE matches no row', async () => {
    h.executeHandler.fn = () => []; // no rows returned
    const logger = { info: vi.fn(), warn: vi.fn() } as never;

    await enterMaintenance('mne_1', SYSTEM_ACTOR, logger);

    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('returns early when event vanishes after activation', async () => {
    h.executeHandler.fn = (text) => (text.includes("status = 'active'") ? [{ id: 'mne_1' }] : []);
    setSelect('maintenanceEvents', []); // loadEventById returns null

    await enterMaintenance('mne_1', SYSTEM_ACTOR);

    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('Inoperative + slot push per station, cancels reservations, stops sessions, writes audits', async () => {
    h.executeHandler.fn = (text) => (text.includes("status = 'active'") ? [{ id: 'mne_1' }] : []);
    const active = makeEventRow({
      status: 'active',
      startedAt: new Date(),
      activeSessionPolicy: 'stop_graceful',
      affectedStationIds: ['sta_1'],
    });
    setSelect('maintenanceEvents', [active]);
    setSelect('sites', [{ name: 'Site One' }]);
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }]);
    setSelect('reservations', [
      {
        id: 'rsv_1',
        stationId: 'sta_1',
        driverId: 'drv_1',
        startsAt: new Date('2026-06-10T10:30:00Z'),
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
    ]);
    setSelect('chargingSessions', [
      { id: 'ses_1', driverId: 'drv_2', transactionId: 'tx_1', stationDbId: 'sta_1' },
    ]);

    await enterMaintenance('mne_1', SYSTEM_ACTOR);

    // ChangeAvailability Inoperative
    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
    // RequestStopTransaction for the active session
    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'RequestStopTransaction', {
      transactionId: 'tx_1',
    });
    // reservation cancelled via helper, with system actor + maintenance note
    expect(h.applyReservationCancellation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationDbId: 'rsv_1',
        actor: 'system',
        reason: 'system_cleanup',
        note: 'Cancelled by maintenance event mne_1',
        chargeFee: false,
      }),
    );
    // driver notifications for both the reservation and the stopped session
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      { __client: true },
      'reservation.CancelledForMaintenance',
      'drv_1',
      expect.objectContaining({ maintenanceEventId: 'mne_1' }),
      ['/tpl/ocpp', '/tpl/api'],
      expect.anything(),
    );
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      { __client: true },
      'maintenance.SessionStopped',
      'drv_2',
      expect.objectContaining({ maintenanceEventId: 'mne_1', sessionId: 'ses_1' }),
      ['/tpl/ocpp', '/tpl/api'],
      expect.anything(),
    );
    // audit rows: started + reservations_cancelled + sessions_stopped
    expect(auditCallsByAction('started')).toHaveLength(1);
    expect(auditCallsByAction('reservations_cancelled')).toHaveLength(1);
    expect(auditCallsByAction('sessions_stopped')).toHaveLength(1);
    // counters updated, cache invalidated, SSE published
    expect(h.invalidateMaintenanceCheckCache).toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({ eventType: 'maintenance.changed', siteId: 'sit_1', eventId: 'mne_1' }),
    );
  });

  it('ignore policy skips session stop and writes only the started audit', async () => {
    h.executeHandler.fn = (text) => (text.includes("status = 'active'") ? [{ id: 'mne_1' }] : []);
    const active = makeEventRow({
      status: 'active',
      startedAt: new Date(),
      activeSessionPolicy: 'ignore',
      affectedStationIds: ['sta_1'],
    });
    setSelect('maintenanceEvents', [active]);
    setSelect('sites', [{ name: 'Site One' }]);
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp1.6' }]);
    // no overlapping reservations, no sessions
    setSelect('reservations', []);
    setSelect('chargingSessions', [
      { id: 'ses_x', driverId: 'd', transactionId: 't', stationDbId: 'sta_1' },
    ]);

    await enterMaintenance('mne_1', SYSTEM_ACTOR);

    // No RequestStopTransaction because policy is ignore
    const stopCalls = h.sendOcppCommandAndWait.mock.calls.filter(
      (c) => c[1] === 'RequestStopTransaction',
    );
    expect(stopCalls).toHaveLength(0);
    expect(auditCallsByAction('started')).toHaveLength(1);
    expect(auditCallsByAction('reservations_cancelled')).toHaveLength(0);
    expect(auditCallsByAction('sessions_stopped')).toHaveLength(0);
  });

  it('continues when ChangeAvailability and slot push throw (fail-open, logged)', async () => {
    h.executeHandler.fn = (text) => (text.includes("status = 'active'") ? [{ id: 'mne_1' }] : []);
    const active = makeEventRow({
      status: 'active',
      startedAt: new Date(),
      affectedStationIds: ['sta_1'],
    });
    setSelect('maintenanceEvents', [active]);
    setSelect('sites', [{ name: 'Site One' }]);
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }]);
    setSelect('reservations', []);

    h.sendOcppCommandAndWait.mockRejectedValueOnce(new Error('boom'));
    h.pushStationMessageSlot.mockRejectedValueOnce(new Error('slot boom'));
    const logger = { info: vi.fn(), warn: vi.fn() } as never;

    await enterMaintenance('mne_1', SYSTEM_ACTOR, logger);

    // Still wrote the started audit despite the failures
    expect(auditCallsByAction('started')).toHaveLength(1);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });

  // Helper-internal branches exercised through enterMaintenance.

  function activeEnterSetup(
    overrides: {
      reservations?: unknown[];
      sessions?: unknown[];
      stations?: unknown[];
      siteRows?: unknown[];
      policy?: 'ignore' | 'stop_graceful';
      reason?: string | null;
    } = {},
  ): void {
    h.executeHandler.fn = (text) => (text.includes("status = 'active'") ? [{ id: 'mne_1' }] : []);
    setSelect('maintenanceEvents', [
      makeEventRow({
        status: 'active',
        startedAt: new Date(),
        affectedStationIds: ['sta_1'],
        activeSessionPolicy: overrides.policy ?? 'stop_graceful',
        reason: overrides.reason === undefined ? 'test reason' : overrides.reason,
      }),
    ]);
    setSelect('sites', overrides.siteRows ?? [{ name: 'Site One' }]);
    setSelect(
      'chargingStations',
      overrides.stations ?? [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }],
    );
    setSelect('reservations', overrides.reservations ?? []);
    setSelect('chargingSessions', overrides.sessions ?? []);
  }

  it('does not count a reservation when the cancel helper reports cancelled:false', async () => {
    activeEnterSetup({
      reservations: [
        {
          id: 'rsv_1',
          stationId: 'sta_1',
          driverId: 'drv_1',
          startsAt: null, // exercises startsAt ?? createdAt fallback
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      ],
    });
    h.applyReservationCancellation.mockResolvedValue({
      cancelled: false,
      feeChargedCents: 0,
      feeChargeFailed: false,
    });

    await enterMaintenance('mne_1', SYSTEM_ACTOR);

    // helper called with the createdAt fallback for startsAt
    expect(h.applyReservationCancellation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationDbId: 'rsv_1',
        startsAt: new Date('2026-06-01T00:00:00Z'),
      }),
    );
    // no notification and no reservations_cancelled audit when not cancelled
    expect(h.dispatchDriverNotification).not.toHaveBeenCalled();
    expect(auditCallsByAction('reservations_cancelled')).toHaveLength(0);
  });

  it('skips reservation notification when the reservation has no driver', async () => {
    activeEnterSetup({
      policy: 'ignore',
      reservations: [
        {
          id: 'rsv_1',
          stationId: 'sta_1',
          driverId: null,
          startsAt: new Date('2026-06-10T10:30:00Z'),
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      ],
    });

    await enterMaintenance('mne_1', SYSTEM_ACTOR);

    expect(h.applyReservationCancellation).toHaveBeenCalledWith(
      expect.objectContaining({ reservationDbId: 'rsv_1', driverId: null }),
    );
    expect(h.dispatchDriverNotification).not.toHaveBeenCalled();
    // still counted as cancelled
    expect(auditCallsByAction('reservations_cancelled')).toHaveLength(1);
  });

  it('counts the reservation even when its driver notification throws', async () => {
    activeEnterSetup({
      policy: 'ignore',
      reservations: [
        {
          id: 'rsv_1',
          stationId: 'sta_1',
          driverId: 'drv_1',
          startsAt: new Date('2026-06-10T10:30:00Z'),
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      ],
    });
    h.dispatchDriverNotification.mockRejectedValueOnce(new Error('notify fail'));
    const logger = { info: vi.fn(), warn: vi.fn() } as never;

    await enterMaintenance('mne_1', SYSTEM_ACTOR, logger);

    expect(auditCallsByAction('reservations_cancelled')).toHaveLength(1);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });

  it('does not count a reservation when the cancel helper throws', async () => {
    activeEnterSetup({
      policy: 'ignore',
      reservations: [
        {
          id: 'rsv_1',
          stationId: 'sta_1',
          driverId: 'drv_1',
          startsAt: new Date('2026-06-10T10:30:00Z'),
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      ],
    });
    h.applyReservationCancellation.mockRejectedValueOnce(new Error('cancel boom'));
    const logger = { info: vi.fn(), warn: vi.fn() } as never;

    await enterMaintenance('mne_1', SYSTEM_ACTOR, logger);

    expect(auditCallsByAction('reservations_cancelled')).toHaveLength(0);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });

  it('skips a session whose station is not in the active set', async () => {
    activeEnterSetup({
      sessions: [
        { id: 'ses_orphan', driverId: 'drv_2', transactionId: 'tx_1', stationDbId: 'sta_unknown' },
      ],
    });

    await enterMaintenance('mne_1', SYSTEM_ACTOR);

    const stopCalls = h.sendOcppCommandAndWait.mock.calls.filter(
      (c) => c[1] === 'RequestStopTransaction',
    );
    expect(stopCalls).toHaveLength(0);
    expect(auditCallsByAction('sessions_stopped')).toHaveLength(0);
  });

  it('does not count a session when the stop command returns an error', async () => {
    activeEnterSetup({
      sessions: [{ id: 'ses_1', driverId: 'drv_2', transactionId: 'tx_1', stationDbId: 'sta_1' }],
    });
    // ChangeAvailability resolves OK, RequestStopTransaction returns error.
    h.sendOcppCommandAndWait.mockImplementation(async (_st, action) =>
      action === 'RequestStopTransaction'
        ? { commandId: 'c', error: 'station rejected' }
        : { commandId: 'c' },
    );

    await enterMaintenance('mne_1', SYSTEM_ACTOR);

    expect(h.dispatchDriverNotification).not.toHaveBeenCalled();
    expect(auditCallsByAction('sessions_stopped')).toHaveLength(0);
  });

  it('stops a session with no driver without dispatching a notification', async () => {
    activeEnterSetup({
      sessions: [{ id: 'ses_1', driverId: null, transactionId: 'tx_1', stationDbId: 'sta_1' }],
    });

    await enterMaintenance('mne_1', SYSTEM_ACTOR);

    const stopNotify = h.dispatchDriverNotification.mock.calls.filter(
      (c) => c[1] === 'maintenance.SessionStopped',
    );
    expect(stopNotify).toHaveLength(0);
    expect(auditCallsByAction('sessions_stopped')).toHaveLength(1);
  });

  it('counts a stopped session even when its notification throws', async () => {
    activeEnterSetup({
      sessions: [{ id: 'ses_1', driverId: 'drv_2', transactionId: 'tx_1', stationDbId: 'sta_1' }],
    });
    h.dispatchDriverNotification.mockRejectedValueOnce(new Error('notify boom'));
    const logger = { info: vi.fn(), warn: vi.fn() } as never;

    await enterMaintenance('mne_1', SYSTEM_ACTOR, logger);

    expect(auditCallsByAction('sessions_stopped')).toHaveLength(1);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });

  it('does not count a session when the stop command throws', async () => {
    activeEnterSetup({
      sessions: [{ id: 'ses_1', driverId: 'drv_2', transactionId: 'tx_1', stationDbId: 'sta_1' }],
    });
    h.sendOcppCommandAndWait.mockImplementation(async (_st, action) => {
      if (action === 'RequestStopTransaction') throw new Error('stop boom');
      return { commandId: 'c' };
    });
    const logger = { info: vi.fn(), warn: vi.fn() } as never;

    await enterMaintenance('mne_1', SYSTEM_ACTOR, logger);

    expect(auditCallsByAction('sessions_stopped')).toHaveLength(0);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });

  it('renders with an empty site name when the site row is missing', async () => {
    activeEnterSetup({ policy: 'ignore', siteRows: [] });

    await enterMaintenance('mne_1', SYSTEM_ACTOR);

    // renderMaintenanceMessage receives the event and the '' site-name fallback
    expect(h.renderMaintenanceMessage).toHaveBeenCalledWith(
      { __client: true },
      expect.objectContaining({ id: 'mne_1' }),
      '',
    );
  });

  it('passes undefined protocol to OCPP when the station has a null protocol', async () => {
    activeEnterSetup({
      policy: 'ignore',
      stations: [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: null }],
    });

    await enterMaintenance('mne_1', SYSTEM_ACTOR);

    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
  });

  it('uses empty reason and undefined protocol when stopping a session on a null-reason event', async () => {
    activeEnterSetup({
      reason: null,
      stations: [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: null }],
      reservations: [
        {
          id: 'rsv_1',
          stationId: 'sta_1',
          driverId: 'drv_1',
          startsAt: new Date('2026-06-10T10:30:00Z'),
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      ],
      sessions: [{ id: 'ses_1', driverId: 'drv_2', transactionId: 'tx_1', stationDbId: 'sta_1' }],
    });

    await enterMaintenance('mne_1', SYSTEM_ACTOR);

    // RequestStopTransaction sent with undefined protocol
    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'RequestStopTransaction', {
      transactionId: 'tx_1',
    });
    // reservation notify uses '' reason fallback
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      { __client: true },
      'reservation.CancelledForMaintenance',
      'drv_1',
      expect.objectContaining({ reason: '' }),
      ['/tpl/ocpp', '/tpl/api'],
      expect.anything(),
    );
    // session notify uses '' reason fallback
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      { __client: true },
      'maintenance.SessionStopped',
      'drv_2',
      expect.objectContaining({ reason: '' }),
      ['/tpl/ocpp', '/tpl/api'],
      expect.anything(),
    );
  });
});

// ===========================================================================
// Detached side effects (HTTP-route mode -> maintenance_fanout publish)
// ===========================================================================
describe('detached side effects', () => {
  it('enterMaintenance publishes the fan-out instead of running it when detached', async () => {
    h.executeHandler.fn = (text) => (text.includes("status = 'active'") ? [{ id: 'mne_1' }] : []);
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'active', startedAt: new Date(), affectedStationIds: ['sta_1'] }),
    ]);
    setSelect('sites', [{ name: 'Site One' }]);
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }]);
    setSelect('reservations', []);

    await enterMaintenance('mne_1', OPERATOR_ACTOR, undefined, { detachSideEffects: true });

    // The activation UPDATE + first SSE landed but the fan-out was handed to the
    // worker: no slot push, no started audit, no OCPP command in-process.
    expect(h.pushStationMessageSlot).not.toHaveBeenCalled();
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(auditCallsByAction('started')).toHaveLength(0);
    // First SSE (sync state change) + fan-out publish.
    expect(h.publish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({ eventType: 'maintenance.changed', siteId: 'sit_1', eventId: 'mne_1' }),
    );
    expect(h.publish).toHaveBeenCalledWith(
      'maintenance_fanout',
      JSON.stringify({
        eventId: 'mne_1',
        phase: 'enter',
        actor: { type: 'operator', userId: 'usr_1', label: null },
      }),
    );
  });

  it('cancelEvent publishes a release fan-out for an active event when detached', async () => {
    h.executeHandler.fn = (text) =>
      text.includes('WITH old') ? [{ id: 'mne_1', status_before: 'active' }] : [];
    queueSelect('maintenanceEvents', [
      [makeEventRow({ status: 'active', affectedStationIds: ['sta_1'] })],
      [makeEventRow({ status: 'cancelled', affectedStationIds: ['sta_1'] })],
    ]);

    await cancelEvent('mne_1', OPERATOR_ACTOR, undefined, { detachSideEffects: true });

    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledWith(
      'maintenance_fanout',
      JSON.stringify({
        eventId: 'mne_1',
        phase: 'release',
        actor: { type: 'operator', userId: 'usr_1', label: null },
      }),
    );
  });

  it('addStationsToMaintenance publishes an add fan-out for an active event when detached', async () => {
    const before = makeEventRow({ status: 'active', affectedStationIds: ['sta_1'] });
    const after = makeEventRow({ status: 'active', affectedStationIds: ['sta_1', 'sta_2'] });
    setSelect('maintenanceEvents', [before]);
    h.updateReturning.rows = [after];
    setSelect('chargingStations', [{ id: 'sta_2' }]); // ownership ok

    await addStationsToMaintenance('mne_1', ['sta_2'], OPERATOR_ACTOR, undefined, {
      detachSideEffects: true,
    });

    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledWith(
      'maintenance_fanout',
      JSON.stringify({
        eventId: 'mne_1',
        phase: 'add',
        stationDbIds: ['sta_2'],
        actor: { type: 'operator', userId: 'usr_1', label: null },
      }),
    );
  });

  it('removeStationsFromMaintenance publishes a remove fan-out when detached', async () => {
    const before = makeEventRow({ status: 'active', affectedStationIds: ['sta_1', 'sta_2'] });
    const after = makeEventRow({ status: 'active', affectedStationIds: ['sta_1'] });
    setSelect('maintenanceEvents', [before]);
    h.updateReturning.rows = [after];

    await removeStationsFromMaintenance('mne_1', ['sta_2'], OPERATOR_ACTOR, undefined, {
      detachSideEffects: true,
    });

    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledWith(
      'maintenance_fanout',
      JSON.stringify({
        eventId: 'mne_1',
        phase: 'remove',
        stationDbIds: ['sta_2'],
        actor: { type: 'operator', userId: 'usr_1', label: null },
      }),
    );
  });

  it('logs at error when the fan-out publish fails but still returns', async () => {
    h.executeHandler.fn = (text) => (text.includes("status = 'active'") ? [{ id: 'mne_1' }] : []);
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'active', startedAt: new Date(), affectedStationIds: ['sta_1'] }),
    ]);
    // First publish (sync SSE) succeeds, second publish (fan-out) rejects.
    h.publish.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('redis down'));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

    await enterMaintenance('mne_1', SYSTEM_ACTOR, logger, { detachSideEffects: true });

    expect((logger as unknown as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalled();
  });

  it('enterMaintenance awaits the fan-out when not detached (worker mode)', async () => {
    h.executeHandler.fn = (text) => (text.includes("status = 'active'") ? [{ id: 'mne_1' }] : []);
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'active', startedAt: new Date(), affectedStationIds: ['sta_1'] }),
    ]);
    setSelect('sites', [{ name: 'Site One' }]);
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }]);
    setSelect('reservations', []);

    await enterMaintenance('mne_1', SYSTEM_ACTOR);

    // Worker path awaits: by the time the call resolves the fan-out is done and
    // no maintenance_fanout publish was made.
    expect(h.pushStationMessageSlot).toHaveBeenCalled();
    expect(auditCallsByAction('started')).toHaveLength(1);
    expect(h.publish).toHaveBeenCalledTimes(2);
    const fanoutPublishes = h.publish.mock.calls.filter((c) => c[0] === 'maintenance_fanout');
    expect(fanoutPublishes).toHaveLength(0);
  });
});

// ===========================================================================
// runMaintenanceFanout (worker entrypoint)
// ===========================================================================
describe('runMaintenanceFanout', () => {
  it('no-ops when the event vanished', async () => {
    setSelect('maintenanceEvents', []);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

    await runMaintenanceFanout({ eventId: 'mne_gone', phase: 'enter' }, logger);

    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect((logger as unknown as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalled();
  });

  it('enter phase runs the full activation fan-out', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'active', startedAt: new Date(), affectedStationIds: ['sta_1'] }),
    ]);
    setSelect('sites', [{ name: 'Site One' }]);
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }]);
    setSelect('reservations', []);

    await runMaintenanceFanout({
      eventId: 'mne_1',
      phase: 'enter',
      actor: { type: 'operator', userId: 'usr_1', label: null },
    });

    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
    expect(auditCallsByAction('started')).toHaveLength(1);
  });

  it('release phase sends Operative + clears slot for affected stations', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'cancelled', affectedStationIds: ['sta_1'] }),
    ]);
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }]);

    await runMaintenanceFanout({ eventId: 'mne_1', phase: 'release' });

    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'ChangeAvailability', {
      operationalStatus: 'Operative',
    });
    expect(h.clearStationMessageSlot).toHaveBeenCalledWith('CS-001', 'ocpp2.1', 9005);
  });

  it('add phase runs the add-station fan-out on the given station ids', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({
        status: 'active',
        affectedStationIds: ['sta_1', 'sta_2'],
        activeSessionPolicy: 'ignore',
      }),
    ]);
    setSelect('chargingStations', [{ id: 'sta_2', stationId: 'CS-002', ocppProtocol: 'ocpp2.1' }]);
    setSelect('sites', [{ name: 'Site One' }]);
    setSelect('reservations', []);

    await runMaintenanceFanout({
      eventId: 'mne_1',
      phase: 'add',
      stationDbIds: ['sta_2'],
      actor: { type: 'system' },
    });

    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-002', 'ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
  });

  it('remove phase releases the given station ids', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'active', affectedStationIds: ['sta_1'] }),
    ]);
    setSelect('chargingStations', [{ id: 'sta_2', stationId: 'CS-002', ocppProtocol: 'ocpp2.1' }]);

    await runMaintenanceFanout({ eventId: 'mne_1', phase: 'remove', stationDbIds: ['sta_2'] });

    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-002', 'ChangeAvailability', {
      operationalStatus: 'Operative',
    });
    expect(h.clearStationMessageSlot).toHaveBeenCalledWith('CS-002', 'ocpp2.1', 9005);
  });

  it('reassert phase re-sends Inoperative + slot message for the reconnected station', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'active', affectedStationIds: ['sta_1', 'sta_2'] }),
    ]);
    setSelect('sites', [{ name: 'Site One' }]);
    setSelect('chargingStations', [{ id: 'sta_2', stationId: 'CS-002', ocppProtocol: 'ocpp2.1' }]);

    await runMaintenanceFanout({
      eventId: 'mne_1',
      phase: 'reassert',
      stationDbIds: ['sta_2'],
      nonce: 'abc123',
    });

    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-002', 'ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
    expect(h.pushStationMessageSlot).toHaveBeenCalledWith(
      'CS-002',
      'ocpp2.1',
      9005,
      'Unavailable',
      expect.any(String),
    );
  });

  it('reassert phase skips when the event is no longer active', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'cancelled', affectedStationIds: ['sta_2'] }),
    ]);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

    await runMaintenanceFanout(
      { eventId: 'mne_1', phase: 'reassert', stationDbIds: ['sta_2'] },
      logger,
    );

    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(h.pushStationMessageSlot).not.toHaveBeenCalled();
  });

  it('records one tracking row per station with the classified command outcome', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'active', affectedStationIds: ['sta_1'] }),
    ]);
    setSelect('sites', [{ name: 'Site One' }]);
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp1.6' }]);
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      response: { status: 'Accepted' },
    });

    await runMaintenanceFanout({
      eventId: 'mne_1',
      phase: 'reassert',
      stationDbIds: ['sta_1'],
    });

    const tracking = h.insertCalls.filter((c) => c.table === 'maintenanceEventStations');
    expect(tracking).toHaveLength(1);
    const rows = tracking[0]?.values as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventId: 'mne_1',
      stationId: 'sta_1',
      stationOcppId: 'CS-001',
      phase: 'reassert',
      command: 'ChangeAvailability(Inoperative)',
      commandStatus: 'accepted',
      error: null,
    });
  });

  it('classifies a not-connected command error as offline in the tracking row', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'active', affectedStationIds: ['sta_1'] }),
    ]);
    setSelect('sites', [{ name: 'Site One' }]);
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }]);
    h.sendOcppCommandAndWait.mockResolvedValueOnce({
      commandId: 'c1',
      error: 'Station CS-001 is not connected',
    });

    await runMaintenanceFanout({
      eventId: 'mne_1',
      phase: 'reassert',
      stationDbIds: ['sta_1'],
    });

    const tracking = h.insertCalls.filter((c) => c.table === 'maintenanceEventStations');
    const rows = tracking[0]?.values as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      commandStatus: 'offline',
      error: 'Station CS-001 is not connected',
    });
  });

  it('reassert phase skips stations the event does not cover', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'active', affectedStationIds: ['sta_1'] }),
    ]);
    setSelect('sites', [{ name: 'Site One' }]);
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }]);

    await runMaintenanceFanout({
      eventId: 'mne_1',
      phase: 'reassert',
      stationDbIds: ['sta_99'],
    });

    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// exitMaintenance
// ===========================================================================
describe('exitMaintenance', () => {
  it('returns early when the event is missing', async () => {
    setSelect('maintenanceEvents', []);
    await exitMaintenance('mne_1', SYSTEM_ACTOR);
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
  });

  it('skips when event is not active', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ status: 'scheduled' })]);
    const logger = { info: vi.fn(), warn: vi.fn() } as never;
    await exitMaintenance('mne_1', SYSTEM_ACTOR, logger);
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('skips a non-active event when no logger is supplied', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ status: 'completed' })]);
    await exitMaintenance('mne_1', SYSTEM_ACTOR);
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('no-ops when the completing UPDATE matches no row (lost race)', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ status: 'active' })]);
    h.executeHandler.fn = () => []; // UPDATE returns no rows
    await exitMaintenance('mne_1', SYSTEM_ACTOR);
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('sends Operative + clears slot per station and writes the ended audit', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'active', affectedStationIds: ['sta_1'] }),
    ]);
    h.executeHandler.fn = (text) =>
      text.includes("status = 'completed'") ? [{ id: 'mne_1' }] : [];
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }]);

    await exitMaintenance('mne_1', OPERATOR_ACTOR);

    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'ChangeAvailability', {
      operationalStatus: 'Operative',
    });
    expect(h.clearStationMessageSlot).toHaveBeenCalledWith('CS-001', 'ocpp2.1', 9005);
    expect(auditCallsByAction('ended')).toHaveLength(1);
    expect(auditCallsByAction('ended')[0]).toMatchObject({ actor: 'operator' });
    expect(h.invalidateMaintenanceCheckCache).toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalled();
  });

  it('continues when Operative and slot clear throw (fail-open, null protocol)', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'active', affectedStationIds: ['sta_1'] }),
    ]);
    h.executeHandler.fn = (text) =>
      text.includes("status = 'completed'") ? [{ id: 'mne_1' }] : [];
    // null protocol exercises the undefined-protocol fallback on exit.
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: null }]);
    h.sendOcppCommandAndWait.mockRejectedValueOnce(new Error('x'));
    h.clearStationMessageSlot.mockRejectedValueOnce(new Error('y'));
    const logger = { info: vi.fn(), warn: vi.fn() } as never;

    await exitMaintenance('mne_1', SYSTEM_ACTOR, logger);

    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'ChangeAvailability', {
      operationalStatus: 'Operative',
    });
    expect(auditCallsByAction('ended')).toHaveLength(1);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });
});

// ===========================================================================
// updateEvent
// ===========================================================================
describe('updateEvent', () => {
  it('throws MAINTENANCE_NOT_FOUND when the event does not exist', async () => {
    setSelect('maintenanceEvents', []);
    await expect(updateEvent('mne_1', { reason: 'x' }, OPERATOR_ACTOR)).rejects.toMatchObject({
      statusCode: 404,
      code: 'MAINTENANCE_NOT_FOUND',
    });
  });

  it('throws MAINTENANCE_ALREADY_ACTIVE for completed events', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ status: 'completed' })]);
    await expect(updateEvent('mne_1', { reason: 'x' }, OPERATOR_ACTOR)).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAINTENANCE_ALREADY_ACTIVE',
    });
  });

  it('rejects editing an immutable field on an active event', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ status: 'active' })]);
    await expect(
      updateEvent('mne_1', { affectedStationIds: ['sta_1'] }, OPERATOR_ACTOR),
    ).rejects.toMatchObject({ statusCode: 409, code: 'MAINTENANCE_ALREADY_ACTIVE' });
  });

  it('allows editing whitelisted fields on an active event, skipping undefined keys', async () => {
    const before = makeEventRow({ status: 'active' });
    setSelect('maintenanceEvents', [before]);
    const after = makeEventRow({ status: 'active', reason: 'updated', customMessage: 'note' });
    h.updateReturning.rows = [after];

    // plannedStartAt is explicitly undefined: the active-event whitelist loop
    // must skip it (continue) rather than reject the whole edit.
    // The key is present with value undefined so the whitelist loop's
    // `changes[key] === undefined` continue branch is exercised.
    const changes: UpdateEventInput = {
      plannedEndAt: new Date('2026-06-10T15:00:00Z'),
      reason: 'updated',
      customMessage: 'note',
    };
    (changes as Record<string, unknown>)['plannedStartAt'] = undefined;

    const result = await updateEvent('mne_1', changes, OPERATOR_ACTOR);

    expect(result.reason).toBe('updated');
    expect(auditCallsByAction('updated')).toHaveLength(1);
  });

  it('persists affectedStationIds on a scheduled event update', async () => {
    const before = makeEventRow({ status: 'scheduled', affectedStationIds: ['sta_1'] });
    setSelect('maintenanceEvents', [before]);
    const after = makeEventRow({ status: 'scheduled', affectedStationIds: ['sta_1', 'sta_2'] });
    h.updateReturning.rows = [after];

    const result = await updateEvent(
      'mne_1',
      { affectedStationIds: ['sta_1', 'sta_2'] },
      OPERATOR_ACTOR,
    );

    expect(result.affectedStationIds).toEqual(['sta_1', 'sta_2']);
    expect(auditCallsByAction('updated')).toHaveLength(1);
  });

  it('throws MAINTENANCE_INVALID_RANGE when resulting end <= start', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ status: 'scheduled' })]);
    await expect(
      updateEvent(
        'mne_1',
        {
          plannedStartAt: new Date('2026-06-10T12:00:00Z'),
          plannedEndAt: new Date('2026-06-10T11:00:00Z'),
        },
        OPERATOR_ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'MAINTENANCE_INVALID_RANGE' });
  });

  it('throws MAINTENANCE_OVERLAPS_EXISTING on a scheduled window change that conflicts', async () => {
    // loadEventById reads maintenanceEvents first, then the overlap query reads
    // it again. Queue: the event, then a conflicting event.
    queueSelect('maintenanceEvents', [
      [makeEventRow({ status: 'scheduled' })],
      [makeEventRow({ id: 'mne_other' })],
    ]);

    await expect(
      updateEvent(
        'mne_1',
        {
          plannedStartAt: new Date('2026-06-11T10:00:00Z'),
          plannedEndAt: new Date('2026-06-11T12:00:00Z'),
        },
        OPERATOR_ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'MAINTENANCE_OVERLAPS_EXISTING' });
  });

  it('updates a scheduled event (all fields) and writes the updated audit', async () => {
    const before = makeEventRow({ status: 'scheduled' });
    setSelect('maintenanceEvents', [before]);
    const after = makeEventRow({ status: 'scheduled', reason: 'new reason', customMessage: 'hi' });
    h.updateReturning.rows = [after];

    const result = await updateEvent(
      'mne_1',
      { reason: 'new reason', customMessage: 'hi', activeSessionPolicy: 'stop_graceful' },
      OPERATOR_ACTOR,
    );

    expect(result.reason).toBe('new reason');
    expect(auditCallsByAction('updated')).toHaveLength(1);
    expect(auditCallsByAction('updated')[0]).toMatchObject({
      action: 'updated',
      before,
      after,
    });
    expect(h.invalidateMaintenanceCheckCache).toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalled();
  });

  it('throws MAINTENANCE_ALREADY_ACTIVE when the guarded UPDATE matches no row (race)', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ status: 'scheduled' })]);
    h.updateReturning.rows = []; // status guard lost the race

    await expect(updateEvent('mne_1', { reason: 'x' }, OPERATOR_ACTOR)).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAINTENANCE_ALREADY_ACTIVE',
    });
  });

  it('cancels reservations falling inside the new window and writes reservations_cancelled audit', async () => {
    const before = makeEventRow({ status: 'scheduled', affectedStationIds: ['sta_1'] });
    const after = makeEventRow({ status: 'scheduled', affectedStationIds: ['sta_1'] });
    // loadEventById -> before; updated -> after
    setSelect('maintenanceEvents', [before]);
    h.updateReturning.rows = [after];
    // loadSiteStations -> stations; cancelOverlappingReservations -> candidate
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }]);
    setSelect('reservations', [
      {
        id: 'rsv_9',
        stationId: 'sta_1',
        driverId: 'drv_9',
        startsAt: new Date('2026-06-10T10:30:00Z'),
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
    ]);

    await updateEvent('mne_1', { plannedEndAt: new Date('2026-06-10T14:00:00Z') }, OPERATOR_ACTOR);

    expect(h.applyReservationCancellation).toHaveBeenCalledWith(
      expect.objectContaining({ reservationDbId: 'rsv_9', actor: 'system' }),
    );
    expect(auditCallsByAction('reservations_cancelled')).toHaveLength(1);
    expect(auditCallsByAction('reservations_cancelled')[0]).toMatchObject({
      notes: 'Cancelled 1 reservation(s) after window change',
    });
  });

  it('skips reservation cancellation on a window change when the site has no stations', async () => {
    const before = makeEventRow({ status: 'scheduled' });
    const after = makeEventRow({ status: 'scheduled' });
    setSelect('maintenanceEvents', [before]);
    h.updateReturning.rows = [after];
    setSelect('chargingStations', []); // no stations -> stationIds empty

    await updateEvent('mne_1', { plannedEndAt: new Date('2026-06-10T14:00:00Z') }, OPERATOR_ACTOR);

    expect(h.applyReservationCancellation).not.toHaveBeenCalled();
    expect(auditCallsByAction('reservations_cancelled')).toHaveLength(0);
    expect(auditCallsByAction('updated')).toHaveLength(1);
  });
});

// ===========================================================================
// addStationsToMaintenance
// ===========================================================================
describe('addStationsToMaintenance', () => {
  it('throws MAINTENANCE_NOT_FOUND when missing', async () => {
    setSelect('maintenanceEvents', []);
    await expect(
      addStationsToMaintenance('mne_1', ['sta_1'], OPERATOR_ACTOR),
    ).rejects.toMatchObject({ statusCode: 404, code: 'MAINTENANCE_NOT_FOUND' });
  });

  it('returns the event unchanged when no station ids are given', async () => {
    const ev = makeEventRow({ status: 'scheduled' });
    setSelect('maintenanceEvents', [ev]);
    const result = await addStationsToMaintenance('mne_1', [], OPERATOR_ACTOR);
    expect(result.id).toBe('mne_1');
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('throws MAINTENANCE_ALREADY_ACTIVE for a completed event', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ status: 'completed' })]);
    await expect(
      addStationsToMaintenance('mne_1', ['sta_1'], OPERATOR_ACTOR),
    ).rejects.toMatchObject({ statusCode: 409, code: 'MAINTENANCE_ALREADY_ACTIVE' });
  });

  it('throws STATION_NOT_FOUND when a station does not belong to the site', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ status: 'scheduled' })]);
    // ownership check returns fewer rows than requested
    setSelect('chargingStations', []);
    await expect(
      addStationsToMaintenance('mne_1', ['sta_1'], OPERATOR_ACTOR),
    ).rejects.toMatchObject({ statusCode: 400, code: 'STATION_NOT_FOUND' });
  });

  it('returns unchanged when all added stations are already on the list', async () => {
    const ev = makeEventRow({ status: 'scheduled', affectedStationIds: ['sta_1'] });
    setSelect('maintenanceEvents', [ev]);
    setSelect('chargingStations', [{ id: 'sta_1' }]); // ownership ok
    const result = await addStationsToMaintenance('mne_1', ['sta_1'], OPERATOR_ACTOR);
    expect(result.id).toBe('mne_1');
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('materializes all-stations list, dedupes, and updates a scheduled event', async () => {
    const before = makeEventRow({ status: 'scheduled', affectedStationIds: null });
    const after = makeEventRow({ status: 'scheduled', affectedStationIds: ['sta_1', 'sta_2'] });
    setSelect('maintenanceEvents', [before]);
    // chargingStations is read twice: ownership check (sta_2) then the
    // materialize-all-stations query (existing full-site list).
    queueSelect('chargingStations', [
      [{ id: 'sta_2' }], // ownership for sta_2
      [{ id: 'sta_1' }], // existing full-site list (all stations)
    ]);
    h.updateReturning.rows = [after];

    const result = await addStationsToMaintenance('mne_1', ['sta_2'], OPERATOR_ACTOR);

    expect(result.affectedStationIds).toEqual(['sta_1', 'sta_2']);
    // scheduled event: no OCPP side effects
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(auditCallsByAction('updated')).toHaveLength(1);
    expect(auditCallsByAction('updated')[0]).toMatchObject({
      notes: 'Added 1 station(s) to event',
    });
  });

  it('throws MAINTENANCE_ALREADY_ACTIVE when the guarded UPDATE loses the race', async () => {
    const before = makeEventRow({ status: 'scheduled', affectedStationIds: ['sta_1'] });
    setSelect('maintenanceEvents', [before]);
    setSelect('chargingStations', [{ id: 'sta_2' }]); // ownership ok
    h.updateReturning.rows = []; // race lost

    await expect(
      addStationsToMaintenance('mne_1', ['sta_2'], OPERATOR_ACTOR),
    ).rejects.toMatchObject({ statusCode: 409, code: 'MAINTENANCE_ALREADY_ACTIVE' });
  });

  it('runs activation side effects on NEW stations only for an active event', async () => {
    const before = makeEventRow({
      status: 'active',
      affectedStationIds: ['sta_1'],
      activeSessionPolicy: 'stop_graceful',
    });
    const after = makeEventRow({
      status: 'active',
      affectedStationIds: ['sta_1', 'sta_2'],
      activeSessionPolicy: 'stop_graceful',
    });
    setSelect('maintenanceEvents', [before]);
    h.updateReturning.rows = [after];

    // chargingStations is read twice: ownership check, then newStations detail.
    queueSelect('chargingStations', [
      [{ id: 'sta_2' }],
      [{ id: 'sta_2', stationId: 'CS-002', ocppProtocol: 'ocpp2.1' }],
    ]);
    setSelect('sites', [{ name: 'Site One' }]);
    setSelect('reservations', [
      {
        id: 'rsv_2',
        stationId: 'sta_2',
        driverId: 'drv_2',
        startsAt: new Date('2026-06-10T10:30:00Z'),
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
    ]);
    setSelect('chargingSessions', [
      { id: 'ses_2', driverId: 'drv_3', transactionId: 'tx_2', stationDbId: 'sta_2' },
    ]);

    const result = await addStationsToMaintenance('mne_1', ['sta_2'], OPERATOR_ACTOR);

    expect(result.affectedStationIds).toEqual(['sta_1', 'sta_2']);
    // Inoperative + stop only for CS-002 (the new station)
    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-002', 'ChangeAvailability', {
      operationalStatus: 'Inoperative',
    });
    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-002', 'RequestStopTransaction', {
      transactionId: 'tx_2',
    });
    // never touches CS-001 (already on the list)
    const touchedCs001 = h.sendOcppCommandAndWait.mock.calls.some((c) => c[0] === 'CS-001');
    expect(touchedCs001).toBe(false);
    // audits: updated + reservations_cancelled + sessions_stopped
    expect(auditCallsByAction('updated')).toHaveLength(1);
    expect(auditCallsByAction('reservations_cancelled')).toHaveLength(1);
    expect(auditCallsByAction('sessions_stopped')).toHaveLength(1);
  });

  it('logs and continues when active-add ChangeAvailability and slot push fail', async () => {
    // null reason + empty site row + null protocol new station also exercise
    // the '' site-name fallback and the undefined-protocol fallback.
    const before = makeEventRow({
      status: 'active',
      affectedStationIds: ['sta_1'],
      activeSessionPolicy: 'ignore',
      reason: null,
    });
    const after = makeEventRow({
      status: 'active',
      affectedStationIds: ['sta_1', 'sta_2'],
      activeSessionPolicy: 'ignore',
      reason: null,
    });
    setSelect('maintenanceEvents', [before]);
    h.updateReturning.rows = [after];
    queueSelect('chargingStations', [
      [{ id: 'sta_2' }],
      [{ id: 'sta_2', stationId: 'CS-002', ocppProtocol: null }],
    ]);
    setSelect('sites', []); // missing site row -> '' name fallback
    setSelect('reservations', []);

    h.sendOcppCommandAndWait.mockRejectedValueOnce(new Error('boom'));
    h.pushStationMessageSlot.mockRejectedValueOnce(new Error('slot boom'));
    const logger = { info: vi.fn(), warn: vi.fn() } as never;

    const result = await addStationsToMaintenance('mne_1', ['sta_2'], OPERATOR_ACTOR, logger);

    expect(result.affectedStationIds).toEqual(['sta_1', 'sta_2']);
    expect(auditCallsByAction('updated')).toHaveLength(1);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });
});

// ===========================================================================
// removeStationsFromMaintenance
// ===========================================================================
describe('removeStationsFromMaintenance', () => {
  it('throws MAINTENANCE_NOT_FOUND when missing', async () => {
    setSelect('maintenanceEvents', []);
    await expect(
      removeStationsFromMaintenance('mne_1', ['sta_1'], OPERATOR_ACTOR),
    ).rejects.toMatchObject({ statusCode: 404, code: 'MAINTENANCE_NOT_FOUND' });
  });

  it('returns unchanged when no ids are given', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ status: 'scheduled' })]);
    const result = await removeStationsFromMaintenance('mne_1', [], OPERATOR_ACTOR);
    expect(result.id).toBe('mne_1');
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('throws MAINTENANCE_ALREADY_ACTIVE for completed events', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ status: 'completed' })]);
    await expect(
      removeStationsFromMaintenance('mne_1', ['sta_1'], OPERATOR_ACTOR),
    ).rejects.toMatchObject({ statusCode: 409, code: 'MAINTENANCE_ALREADY_ACTIVE' });
  });

  it('returns unchanged when the removal does not shrink the list', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'scheduled', affectedStationIds: ['sta_1', 'sta_2'] }),
    ]);
    const result = await removeStationsFromMaintenance('mne_1', ['sta_99'], OPERATOR_ACTOR);
    expect(result.affectedStationIds).toEqual(['sta_1', 'sta_2']);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('refuses to remove the last station', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'scheduled', affectedStationIds: ['sta_1'] }),
    ]);
    await expect(
      removeStationsFromMaintenance('mne_1', ['sta_1'], OPERATOR_ACTOR),
    ).rejects.toMatchObject({ statusCode: 400, code: 'MAINTENANCE_INVALID_RANGE' });
  });

  it('removes a station from a scheduled event without OCPP side effects', async () => {
    const before = makeEventRow({ status: 'scheduled', affectedStationIds: ['sta_1', 'sta_2'] });
    const after = makeEventRow({ status: 'scheduled', affectedStationIds: ['sta_1'] });
    setSelect('maintenanceEvents', [before]);
    h.updateReturning.rows = [after];

    const result = await removeStationsFromMaintenance('mne_1', ['sta_2'], OPERATOR_ACTOR);

    expect(result.affectedStationIds).toEqual(['sta_1']);
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(auditCallsByAction('updated')).toHaveLength(1);
    expect(auditCallsByAction('updated')[0]).toMatchObject({
      notes: 'Removed 1 station(s) from event',
    });
  });

  it('materializes all-stations then removes, fires Operative + clear for active event', async () => {
    const before = makeEventRow({ status: 'active', affectedStationIds: null });
    const after = makeEventRow({ status: 'active', affectedStationIds: ['sta_1'] });
    setSelect('maintenanceEvents', [before]);
    // chargingStations: materialize-all (sta_1, sta_2) then released-detail (sta_2)
    queueSelect('chargingStations', [
      [{ id: 'sta_1' }, { id: 'sta_2' }],
      [{ id: 'sta_2', stationId: 'CS-002', ocppProtocol: 'ocpp2.1' }],
    ]);
    h.updateReturning.rows = [after];

    const result = await removeStationsFromMaintenance('mne_1', ['sta_2'], OPERATOR_ACTOR);

    expect(result.affectedStationIds).toEqual(['sta_1']);
    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-002', 'ChangeAvailability', {
      operationalStatus: 'Operative',
    });
    expect(h.clearStationMessageSlot).toHaveBeenCalledWith('CS-002', 'ocpp2.1', 9005);
    expect(auditCallsByAction('updated')).toHaveLength(1);
  });

  it('logs and continues when active release Operative and slot clear fail', async () => {
    const before = makeEventRow({ status: 'active', affectedStationIds: ['sta_1', 'sta_2'] });
    const after = makeEventRow({ status: 'active', affectedStationIds: ['sta_1'] });
    setSelect('maintenanceEvents', [before]);
    // null protocol exercises the undefined-protocol fallback on release.
    setSelect('chargingStations', [{ id: 'sta_2', stationId: 'CS-002', ocppProtocol: null }]);
    h.updateReturning.rows = [after];
    h.sendOcppCommandAndWait.mockRejectedValueOnce(new Error('x'));
    h.clearStationMessageSlot.mockRejectedValueOnce(new Error('y'));
    const logger = { info: vi.fn(), warn: vi.fn() } as never;

    const result = await removeStationsFromMaintenance('mne_1', ['sta_2'], OPERATOR_ACTOR, logger);

    expect(result.affectedStationIds).toEqual(['sta_1']);
    expect(auditCallsByAction('updated')).toHaveLength(1);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });

  it('throws MAINTENANCE_ALREADY_ACTIVE when the guarded UPDATE loses the race', async () => {
    setSelect('maintenanceEvents', [
      makeEventRow({ status: 'scheduled', affectedStationIds: ['sta_1', 'sta_2'] }),
    ]);
    h.updateReturning.rows = [];
    await expect(
      removeStationsFromMaintenance('mne_1', ['sta_2'], OPERATOR_ACTOR),
    ).rejects.toMatchObject({ statusCode: 409, code: 'MAINTENANCE_ALREADY_ACTIVE' });
  });
});

// ===========================================================================
// cancelEvent
// ===========================================================================
describe('cancelEvent', () => {
  it('throws MAINTENANCE_NOT_FOUND when missing', async () => {
    setSelect('maintenanceEvents', []);
    await expect(cancelEvent('mne_1', OPERATOR_ACTOR)).rejects.toMatchObject({
      statusCode: 404,
      code: 'MAINTENANCE_NOT_FOUND',
    });
  });

  it('returns the event unchanged when already completed', async () => {
    const ev = makeEventRow({ status: 'completed' });
    setSelect('maintenanceEvents', [ev]);
    const result = await cancelEvent('mne_1', OPERATOR_ACTOR);
    expect(result.status).toBe('completed');
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('returns unchanged when the CTE UPDATE matches no row', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ status: 'scheduled' })]);
    h.executeHandler.fn = () => []; // CTE returns nothing
    const result = await cancelEvent('mne_1', OPERATOR_ACTOR);
    expect(result.status).toBe('scheduled');
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('cancels a scheduled event without Operative side effects', async () => {
    h.executeHandler.fn = (text) =>
      text.includes('WITH old') ? [{ id: 'mne_1', status_before: 'scheduled' }] : [];
    // loadEventById is called twice (initial + refresh after cancel).
    queueSelect('maintenanceEvents', [
      [makeEventRow({ status: 'scheduled' })],
      [makeEventRow({ status: 'cancelled' })],
    ]);

    const result = await cancelEvent('mne_1', OPERATOR_ACTOR);

    expect(result.status).toBe('cancelled');
    expect(h.sendOcppCommandAndWait).not.toHaveBeenCalled();
    expect(auditCallsByAction('cancelled')).toHaveLength(1);
  });

  it('returns the pre-cancel event when the post-cancel refresh returns null', async () => {
    h.executeHandler.fn = (text) =>
      text.includes('WITH old') ? [{ id: 'mne_1', status_before: 'scheduled' }] : [];
    // initial loadEventById -> scheduled; refresh -> null
    queueSelect('maintenanceEvents', [[makeEventRow({ status: 'scheduled' })], []]);

    const result = await cancelEvent('mne_1', OPERATOR_ACTOR);

    // refreshed was null so the original (pre-cancel) snapshot is returned
    expect(result.id).toBe('mne_1');
    expect(auditCallsByAction('cancelled')).toHaveLength(1);
  });

  it('cancels an active event, sends Operative + clears slot via status_before guard', async () => {
    h.executeHandler.fn = (text) =>
      text.includes('WITH old') ? [{ id: 'mne_1', status_before: 'active' }] : [];
    // initial loadEventById -> active; refresh -> cancelled.
    queueSelect('maintenanceEvents', [
      [makeEventRow({ status: 'active', affectedStationIds: ['sta_1'] })],
      [makeEventRow({ status: 'cancelled', affectedStationIds: ['sta_1'] })],
    ]);
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }]);

    const result = await cancelEvent('mne_1', SYSTEM_ACTOR);

    expect(result.status).toBe('cancelled');
    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'ChangeAvailability', {
      operationalStatus: 'Operative',
    });
    expect(h.clearStationMessageSlot).toHaveBeenCalledWith('CS-001', 'ocpp2.1', 9005);
    expect(auditCallsByAction('cancelled')).toHaveLength(1);
    expect(h.invalidateMaintenanceCheckCache).toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalled();
  });

  it('logs and continues when active-cancel Operative and slot clear fail', async () => {
    h.executeHandler.fn = (text) =>
      text.includes('WITH old') ? [{ id: 'mne_1', status_before: 'active' }] : [];
    queueSelect('maintenanceEvents', [
      [makeEventRow({ status: 'active', affectedStationIds: ['sta_1'] })],
      [makeEventRow({ status: 'cancelled', affectedStationIds: ['sta_1'] })],
    ]);
    setSelect('chargingStations', [{ id: 'sta_1', stationId: 'CS-001', ocppProtocol: null }]);
    h.sendOcppCommandAndWait.mockRejectedValueOnce(new Error('op boom'));
    h.clearStationMessageSlot.mockRejectedValueOnce(new Error('clear boom'));
    const logger = { info: vi.fn(), warn: vi.fn() } as never;

    const result = await cancelEvent('mne_1', OPERATOR_ACTOR, logger);

    expect(result.status).toBe('cancelled');
    // null protocol passed through as undefined to OCPP
    expect(h.sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'ChangeAvailability', {
      operationalStatus: 'Operative',
    });
    expect(auditCallsByAction('cancelled')).toHaveLength(1);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });
});

// ===========================================================================
// getActiveMaintenanceForStation / getActiveMaintenanceForSite
// ===========================================================================
describe('getActiveMaintenanceForStation', () => {
  it('returns null when the station is not found', async () => {
    setSelect('chargingStations', []);
    const result = await getActiveMaintenanceForStation('sta_x');
    expect(result).toBeNull();
  });

  it('returns null when the station has no site', async () => {
    setSelect('chargingStations', [{ siteId: null }]);
    const result = await getActiveMaintenanceForStation('sta_x');
    expect(result).toBeNull();
  });

  it('returns the active maintenance row for the station site', async () => {
    setSelect('chargingStations', [{ siteId: 'sit_1' }]);
    setSelect('maintenanceEvents', [makeEventRow({ status: 'active' })]);
    const result = await getActiveMaintenanceForStation('sta_1');
    expect(result?.id).toBe('mne_1');
    expect(result?.status).toBe('active');
  });

  it('returns null when no active maintenance matches', async () => {
    setSelect('chargingStations', [{ siteId: 'sit_1' }]);
    setSelect('maintenanceEvents', []);
    const result = await getActiveMaintenanceForStation('sta_1');
    expect(result).toBeNull();
  });
});

describe('getActiveMaintenanceForSite', () => {
  it('returns the active maintenance row', async () => {
    setSelect('maintenanceEvents', [makeEventRow({ status: 'active', siteId: 'sit_2' })]);
    const result = await getActiveMaintenanceForSite('sit_2');
    expect(result?.id).toBe('mne_1');
    expect(result?.siteId).toBe('sit_2');
  });

  it('returns null when no active maintenance exists', async () => {
    setSelect('maintenanceEvents', []);
    const result = await getActiveMaintenanceForSite('sit_2');
    expect(result).toBeNull();
  });

  it('coalesces missing nullable fields to null/0 in the mapped row', async () => {
    // A raw row with the nullable columns absent exercises the ?? null / ?? 0
    // fallbacks in rowFromDb.
    setSelect('maintenanceEvents', [
      {
        id: 'mne_min',
        siteId: 'sit_3',
        eventType: 'one_off',
        status: 'active',
        plannedStartAt: new Date('2026-06-10T10:00:00Z'),
        plannedEndAt: new Date('2026-06-10T12:00:00Z'),
        activeSessionPolicy: 'ignore',
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
        // startedAt, endedAt, affectedStationIds, customMessage, reason,
        // reservationsCancelledCount, sessionsStoppedCount, createdByUserId omitted
      },
    ]);

    const result = await getActiveMaintenanceForSite('sit_3');

    expect(result).toMatchObject({
      id: 'mne_min',
      startedAt: null,
      endedAt: null,
      affectedStationIds: null,
      customMessage: null,
      reason: null,
      reservationsCancelledCount: 0,
      sessionsStoppedCount: 0,
      createdByUserId: null,
    });
  });
});
