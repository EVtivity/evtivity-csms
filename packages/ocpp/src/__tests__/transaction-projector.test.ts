// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The reservation steps of the TransactionProjector: the link at Started
// (linkStartedReservation) and the end of the hold at Ended
// (markReservationUsed), both in reservation-projections.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { Logger, PubSubClient } from '@evtivity/lib';
import type { ProjectionDeps } from '../server/projection-support/context.js';

const mockWriteReservationAudit = vi.fn();
const mockNotifyReservationDriver = vi.fn();
vi.mock('@evtivity/database', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../database/src/lib/raw-timestamp.js')),
  ...(await vi.importActual<Record<string, unknown>>('../../../database/src/lib/pg-errors.js')),
  writeReservationAudit: (...args: unknown[]) => mockWriteReservationAudit(...args) as unknown,
}));
vi.mock('@evtivity/services/reservation-cancel', () => ({ applyReservationCancellation: vi.fn() }));
vi.mock('@evtivity/services/reservation-expiry', () => ({
  expireStationReportedReservation: vi.fn(),
  cancelHoldsForStationOutage: vi.fn(),
}));
vi.mock('@evtivity/services/reservation-notify', () => ({
  cancelReasonNoticeFlags: () => ({}),
  notifyReservationDriver: (...args: unknown[]) => mockNotifyReservationDriver(...args) as unknown,
}));
vi.mock('../server/notification-dispatcher.js', () => ({
  ALL_TEMPLATES_DIRS: ['/ocpp/templates'],
}));

const { linkStartedReservation, markReservationUsed } =
  await import('../server/reservation-projections.js');
const { runProjectionWithRetry } = await import('../server/projection-retry.js');
type ProjectionAttempt = import('../server/projection-retry.js').ProjectionAttempt;

// The mocked database: the reservation rows the link query returns, and the
// state the guarded updates move.
interface HoldRow {
  id: string;
  reservation_id: number;
  driver_id: string | null;
  token_id: string | null;
  evse_id: string | null;
  status: 'active' | 'in_use';
  no_show_fee_state: 'none' | 'waived';
}
let holds: HoldRow[] = [];
// The session's own columns and the idToken's token row.
let session = {
  driver_id: null as string | null,
  token_id: null as string | null,
  evse_id: 'evse-1' as string | null,
  reservation_id: null as string | null,
};
let idTokenRow: { id: string; driver_id: string | null } | null = null;
const sqlCalls: Array<{ text: string; values: unknown[] }> = [];

function candidateRow(h: HoldRow) {
  return {
    ...h,
    expires_at: '2030-01-01 00:00:00+00',
    session_driver_id: session.driver_id,
    session_token_id: session.token_id,
    session_evse_id: session.evse_id,
    session_reservation_id: session.reservation_id,
    id_token_id: idTokenRow?.id ?? null,
    id_token_driver_id: idTokenRow?.driver_id ?? null,
  };
}

function route(text: string, values: unknown[]): unknown[] {
  if (text.includes('JOIN reservations r ON r.station_id = cs.station_id')) {
    if (text.includes('AND r.reservation_id = ?')) {
      const ocppId = values[3] as number;
      return holds
        .filter(
          (h) =>
            h.reservation_id === ocppId &&
            (h.status === 'active' || h.id === session.reservation_id),
        )
        .slice(0, 1)
        .map(candidateRow);
    }
    // In window: the session's EVSE or a station-wide hold.
    return holds
      .filter(
        (h) =>
          h.id === session.reservation_id ||
          (h.status === 'active' && (h.evse_id == null || h.evse_id === session.evse_id)),
      )
      .sort((a, b) => Number(a.evse_id == null) - Number(b.evse_id == null))
      .map(candidateRow);
  }
  if (text.includes('UPDATE charging_sessions SET reservation_id')) {
    session.reservation_id = values[0] as string;
    return [];
  }
  if (text.includes("SET status = 'in_use'")) {
    // values[1]: a rerun also takes a hold already in_use (the only other status).
    const h = holds.find(
      (r) => r.id === values[0] && (r.status === 'active' || values[1] === true),
    );
    if (h == null) return [];
    h.status = 'in_use';
    return [{ id: h.id }];
  }
  if (text.includes("SET no_show_fee_state = 'waived'")) {
    const h = holds.find(
      (r) => r.id === values[0] && r.status === 'active' && r.no_show_fee_state === 'none',
    );
    if (h == null) return [];
    h.no_show_fee_state = 'waived';
    return [{ id: h.id }];
  }
  if (text.includes("SET status = 'used'")) {
    const h = holds.find((r) => r.id === values[0] && r.status === 'in_use');
    if (h == null) return [];
    return [{ driver_id: h.driver_id }];
  }
  return [];
}

const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join('?');
  sqlCalls.push({ text, values });
  return Promise.resolve(route(text, values));
}) as unknown as postgres.Sql;

const notifyChange = vi.fn();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const deps = {
  sql,
  pubsub: { publish: vi.fn() } as unknown as PubSubClient,
  logger: logger as unknown as Logger,
  payments: {},
  eventBus: {},
  lookups: { resolveSiteId: vi.fn().mockResolvedValue('site-1') },
  notify: { notifyChange },
} as unknown as ProjectionDeps;

function hold(overrides: Partial<HoldRow> = {}): HoldRow {
  return {
    id: 'rsv_1',
    reservation_id: 42,
    driver_id: 'drv-holder',
    token_id: 'tok-holder',
    evse_id: 'evse-1',
    status: 'active',
    no_show_fee_state: 'none',
    ...overrides,
  };
}

function start(
  ocppReservationId: number | null,
  idToken: string | null = null,
  attempt?: ProjectionAttempt,
) {
  return linkStartedReservation(deps, {
    sessionId: 'session-1',
    stationUuid: 'sta-1',
    stationOcppId: 'CS-1',
    ocppReservationId,
    idToken,
    ...(attempt != null ? { attempt } : {}),
  });
}

/** A projection run without the retry bookkeeping. */
function run(number: number): ProjectionAttempt {
  return {
    number,
    isLast: false,
    once: (_key, step) => step(),
    memo: (_key, step) => step(),
  };
}

function connectionError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function auditActions(): string[] {
  return mockWriteReservationAudit.mock.calls.map((c) => (c[0] as { action: string }).action);
}

beforeEach(() => {
  holds = [];
  session = { driver_id: null, token_id: null, evse_id: 'evse-1', reservation_id: null };
  idTokenRow = null;
  sqlCalls.length = 0;
  vi.clearAllMocks();
});

describe('TransactionProjector Started: reservation link', () => {
  it('links the echoed reservation of its holder and moves it to in_use', async () => {
    holds = [hold()];
    session.driver_id = 'drv-holder';
    session.token_id = 'tok-holder';

    expect(await start(42, 'RFID-HOLDER')).toBe('rsv_1');

    expect(holds[0]?.status).toBe('in_use');
    expect(session.reservation_id).toBe('rsv_1');
    expect(mockWriteReservationAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'rsv_1',
        action: 'used',
        statusBefore: 'active',
        statusAfter: 'in_use',
        notes: 'session session-1',
      }),
      undefined,
      logger,
    );
    expect(sqlCalls.some((c) => c.text.includes('reservationTokenMismatch'))).toBe(false);
  });

  it('keeps the token mismatch marker for a holder who started with another of their cards', async () => {
    holds = [hold()];
    session.driver_id = 'drv-holder';
    session.token_id = 'tok-second-card';

    expect(await start(42)).toBe('rsv_1');

    const marker = sqlCalls.find((c) => c.text.includes('reservationTokenMismatch'));
    expect(marker?.values).toEqual(['tok-holder', 'tok-second-card', 'session-1']);
  });

  it('recognizes the holder by the idToken on a free vend session without a driver', async () => {
    holds = [hold()];
    idTokenRow = { id: 'tok-holder', driver_id: 'drv-holder' };

    expect(await start(42, 'RFID-HOLDER')).toBe('rsv_1');
    expect(holds[0]?.status).toBe('in_use');
  });

  it('TC-RES-16: links the holder start without an echoed reservation id', async () => {
    holds = [hold()];
    session.driver_id = 'drv-holder';

    expect(await start(null)).toBe('rsv_1');

    expect(holds[0]?.status).toBe('in_use');
    expect(auditActions()).toEqual(['used']);
  });

  it('TC-RES-16: links a station-wide hold of the holder', async () => {
    holds = [hold({ evse_id: null })];
    session.token_id = 'tok-holder';

    expect(await start(null)).toBe('rsv_1');
    expect(holds[0]?.status).toBe('in_use');
  });

  it('TC-RES-16: a rerun keeps the link and audits once', async () => {
    holds = [hold()];
    session.driver_id = 'drv-holder';

    await start(null);
    await start(null);

    expect(auditActions()).toEqual(['used']);
    expect(session.reservation_id).toBe('rsv_1');
  });

  it('TC-RES-17: a start by someone else with the echoed id leaves the hold active, waives the fee, audits and notifies the holder', async () => {
    holds = [hold()];
    session.driver_id = 'drv-other';
    session.token_id = 'tok-other';

    expect(await start(42, 'RFID-OTHER')).toBeNull();

    expect(holds[0]?.status).toBe('active');
    expect(holds[0]?.no_show_fee_state).toBe('waived');
    expect(session.reservation_id).toBeNull();
    expect(mockWriteReservationAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'rsv_1',
        action: 'taken_by_other',
        actor: 'system',
        statusBefore: 'active',
        statusAfter: 'active',
        notes: 'session session-1',
      }),
      undefined,
      logger,
    );
    expect(mockNotifyReservationDriver).toHaveBeenCalledWith(
      'reservation.TakenByOther',
      expect.objectContaining({
        reservationDbId: 'rsv_1',
        reservationOcppId: 42,
        stationOcppId: 'CS-1',
        driverId: 'drv-holder',
      }),
      {},
      expect.objectContaining({ templatesDirs: ['/ocpp/templates'] }),
    );
    expect(notifyChange).toHaveBeenCalledWith(
      'reservation.changed',
      'sta-1',
      'site-1',
      'session-1',
    );
  });

  it('TC-RES-17: an echoed id with a starter the CSMS cannot resolve links the hold', async () => {
    // The station enforced the hold (OCPP H01); a roaming or unknown token is
    // not evidence of another driver.
    holds = [hold()];

    expect(await start(42, 'ROAMING-1')).toBe('rsv_1');

    expect(holds[0]?.status).toBe('in_use');
    expect(holds[0]?.no_show_fee_state).toBe('none');
    expect(auditActions()).toEqual(['used']);
  });

  it('TC-RES-17: a start by someone else without an echoed id takes the hold of that EVSE', async () => {
    holds = [hold()];

    expect(await start(null)).toBeNull();

    expect(holds[0]?.no_show_fee_state).toBe('waived');
    expect(auditActions()).toEqual(['taken_by_other']);
  });

  it('TC-RES-17: a start on another EVSE does not take a station-wide hold', async () => {
    holds = [hold({ evse_id: null })];
    session.driver_id = 'drv-other';

    expect(await start(null)).toBeNull();

    expect(holds[0]?.no_show_fee_state).toBe('none');
    expect(mockWriteReservationAudit).not.toHaveBeenCalled();
    expect(mockNotifyReservationDriver).not.toHaveBeenCalled();
  });

  it('TC-RES-17: a resent Started audits and notifies the taken hold once', async () => {
    holds = [hold()];
    session.driver_id = 'drv-other';

    await start(42);
    await start(42);

    expect(auditActions()).toEqual(['taken_by_other']);
    expect(mockNotifyReservationDriver).toHaveBeenCalledTimes(1);
  });

  it('links an operator hold without a driver to the echoed start', async () => {
    holds = [hold({ driver_id: null, token_id: null })];

    expect(await start(42)).toBe('rsv_1');
    expect(holds[0]?.status).toBe('in_use');
  });

  it('finds nothing to link on a station without holds', async () => {
    expect(await start(null)).toBeNull();
    expect(sqlCalls).toHaveLength(1);
  });
});

describe('TransactionProjector Started: reservation link on a projection retry', () => {
  it('a rerun whose first in_use write committed without an answer still audits used', async () => {
    // The first run's flip committed but its answer was lost: the hold is
    // in_use and linked to this session, and no audit row was written.
    holds = [hold({ status: 'in_use' })];
    session.driver_id = 'drv-holder';
    session.reservation_id = 'rsv_1';

    expect(await start(null, null, run(2))).toBe('rsv_1');

    expect(auditActions()).toEqual(['used']);
    expect(notifyChange).toHaveBeenCalledWith(
      'reservation.changed',
      'sta-1',
      'site-1',
      'session-1',
    );
  });

  it('a first run never takes a hold already in_use as moved', async () => {
    holds = [hold({ status: 'in_use' })];
    session.driver_id = 'drv-holder';
    session.reservation_id = 'rsv_1';

    expect(await start(null, null, run(1))).toBe('rsv_1');

    expect(auditActions()).toEqual([]);
    expect(notifyChange).not.toHaveBeenCalled();
  });

  it('a step after the in_use write that lost its connection is rerun: one used audit', async () => {
    holds = [hold()];
    session.driver_id = 'drv-holder';
    mockWriteReservationAudit.mockRejectedValueOnce(connectionError('CONNECT_TIMEOUT'));

    await runProjectionWithRetry(
      async (attempt) => {
        await start(null, null, attempt);
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    );

    expect(holds[0]?.status).toBe('in_use');
    // The failed first audit, then the rerun's one; the flip ran once.
    expect(auditActions()).toEqual(['used', 'used']);
    expect(sqlCalls.filter((c) => c.text.includes("SET status = 'in_use'"))).toHaveLength(1);
    expect(notifyChange).toHaveBeenCalledTimes(1);
  });

  it('a taken hold whose audit lost its connection is audited and its holder told once', async () => {
    holds = [hold()];
    session.driver_id = 'drv-other';
    mockWriteReservationAudit.mockRejectedValueOnce(connectionError('CONNECT_TIMEOUT'));

    await runProjectionWithRetry(
      async (attempt) => {
        await start(42, null, attempt);
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    );

    expect(holds[0]?.no_show_fee_state).toBe('waived');
    expect(auditActions()).toEqual(['taken_by_other', 'taken_by_other']);
    expect(mockNotifyReservationDriver).toHaveBeenCalledTimes(1);
  });
});

describe('TransactionProjector Ended: reservation used', () => {
  it('TC-RES-22: in_use to used writes the used audit with the session id', async () => {
    holds = [hold({ status: 'in_use' })];

    await markReservationUsed(deps, {
      reservationDbId: 'rsv_1',
      sessionId: 'session-1',
      stationUuid: 'sta-1',
      siteId: 'site-1',
    });

    expect(mockWriteReservationAudit).toHaveBeenCalledWith(
      {
        reservationId: 'rsv_1',
        action: 'used',
        actor: 'system',
        driverIdBefore: 'drv-holder',
        driverIdAfter: 'drv-holder',
        statusBefore: 'in_use',
        statusAfter: 'used',
        notes: 'session session-1',
      },
      undefined,
      logger,
    );
    expect(notifyChange).toHaveBeenCalledWith(
      'reservation.changed',
      'sta-1',
      'site-1',
      'session-1',
    );
  });

  it('TC-RES-22: a hold no longer in use writes no audit', async () => {
    holds = [hold({ status: 'active' })];

    await markReservationUsed(deps, {
      reservationDbId: 'rsv_1',
      sessionId: 'session-1',
      stationUuid: 'sta-1',
      siteId: null,
    });

    expect(mockWriteReservationAudit).not.toHaveBeenCalled();
    expect(notifyChange).not.toHaveBeenCalled();
  });
});
