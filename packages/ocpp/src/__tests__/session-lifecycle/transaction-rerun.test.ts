// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DomainEvent, EventBus, Logger, PubSubClient } from '@evtivity/lib';
import type { PaymentContext } from '@evtivity/payments';
import type postgres from 'postgres';

// The TransactionEvent projection (Started, Updated, Ended) run again after a
// lost database connection, the way runProjectionWithRetry reruns it: each
// effect happens once, and the rerun decides from what the first run saw.

const sqlCalls: string[] = [];
const sqlValues: unknown[][] = [];
// Rejects the next statement whose text includes `match`.
let failOn: { match: string; code: string; left: number } | null = null;

// What the mocked database holds for the session under test.
const db = {
  driverId: null as string | null,
  tokenRow: null as Record<string, unknown> | null,
  guestReads: 0,
  reservationStatus: 'active' as 'active' | 'in_use',
  sessionReservationId: null as string | null,
  endedEnergyWh: 10000,
  endedStatus: 'completed',
  // Prepaid ceiling claim (stopped_reason): null while unclaimed.
  prepaidClaim: null as 'open' | 'claimed' | null,
  // End notice claims taken (completed_notified_at, receipt_notified_at).
  claimedNotices: new Set<string>(),
  // The session the Started gate left waiting for its idToken (the late
  // link's eligibility read), or null when it has a token already.
  firstToken: null as Record<string, unknown> | null,
  // What the token's other sessions reserve from its prepaid balance.
  reservedCents: 0,
  // The anonymous stop claim of a session charging without authorization.
  unauthorizedClaimOpen: false,
  // The transaction_events rows the session holds (eventRowKey): the resend
  // check (finding JB-6) finds the row a first run wrote.
  eventRows: new Set<string>(),
};

function connectionError(code: string): Error {
  return Object.assign(new Error(`write ${code} localhost:5433`), { code });
}

function eventRowKey(eventType: string, seqNo: number, timestamp: string): string {
  return `${eventType}:${String(seqNo)}:${timestamp}`;
}

function route(text: string, values: unknown[]): unknown[] {
  // The resend check of TransactionProjector (event type is its third value).
  // Values: station, transaction, event type, seqNo, timestamp, triggerReason.
  if (text.includes('AND te.seq_no = ?')) {
    const key = eventRowKey(values[2] as string, values[3] as number, values[4] as string);
    return db.eventRows.has(key) ? [{ session_id: 'session-1' }] : [];
  }
  // Values: session, seqNo, timestamp, triggerReason, payload.
  const eventRow = /INSERT INTO transaction_events[\s\S]*VALUES \(\?, '(\w+)'/.exec(text);
  if (eventRow != null) {
    db.eventRows.add(eventRowKey(eventRow[1] as string, values[1] as number, values[2] as string));
  }
  if (text.includes('SELECT cs.reservation_id, cs.started_at')) {
    return db.firstToken != null ? [db.firstToken] : [];
  }
  if (text.includes('AS reserved_cents')) return [{ reserved_cents: db.reservedCents }];
  if (
    db.firstToken != null &&
    text.includes("AND status = 'active'") &&
    text.includes('SELECT id FROM charging_sessions')
  ) {
    return [{ id: 'session-1' }];
  }
  // The session's tariff snapshot (loadSessionPricing): a priced tariff.
  if (text.includes('SELECT s.id, s.started_at, s.tariff_id')) {
    return [
      {
        id: 'session-1',
        started_at: '2026-10-07T10:00:00.000Z',
        tariff_id: 'tariff-1',
        tax_basis: 'net',
        tariff_price_per_kwh: '0.30',
        idle_minutes: 0,
      },
    ];
  }
  if (text.includes("SET stopped_reason = 'AnonymousSession'")) {
    if (!db.unauthorizedClaimOpen) return [];
    db.unauthorizedClaimOpen = false;
    return [{ id: 'session-1' }];
  }
  if (text.includes('WITH claimed AS') && text.includes('SET stopped_reason')) {
    if (db.prepaidClaim !== 'open') return [];
    db.prepaidClaim = 'claimed';
    return [
      {
        driver_id: 'drv-1',
        id_token: 'PREPAID-1',
        cost_ceiling_cents: 500,
        currency: 'USD',
        site_name: 'Site 1',
      },
    ];
  }
  if (db.prepaidClaim != null && text.trim().startsWith('SELECT id FROM charging_sessions')) {
    return [{ id: 'session-1' }];
  }
  if (text.includes('SELECT id FROM charging_stations WHERE station_id')) return [{ id: 'sta-1' }];
  if (text.includes('SELECT site_id FROM charging_stations')) return [{ site_id: 'site-1' }];
  if (text.includes('SELECT s.name FROM sites')) return [{ name: 'Site 1' }];
  if (text.includes('ocpp_protocol FROM charging_stations')) return [{ ocpp_protocol: 'ocpp2.1' }];
  if (text.includes('INSERT INTO charging_sessions')) return [{ id: 'session-1' }];
  if (text.includes('SELECT is_roaming')) return [{ is_roaming: false }];
  if (text.includes('SELECT driver_id FROM charging_sessions')) return [{ driver_id: db.driverId }];
  if (text.includes('FROM driver_tokens')) return db.tokenRow != null ? [db.tokenRow] : [];
  if (text.includes('UPDATE charging_sessions SET driver_id')) return [];
  if (text.includes('FROM guest_sessions')) {
    // TransactionStarted moves the guest session to charging, so a second
    // read after the first run sees charging.
    db.guestReads++;
    return [
      {
        status: db.guestReads === 1 ? 'payment_authorized' : 'charging',
        guest_email: 'guest@example.com',
        pre_auth_amount_cents: 5000,
        provider_payment_id: 'pi_guest',
      },
    ];
  }
  if (text.includes('token_id FROM reservations')) {
    // The active reservation, or the one the session is already linked to
    // when the statement matches that too.
    const linkedMatch = text.includes('r.id = (SELECT cs.reservation_id');
    const found =
      db.reservationStatus === 'active' || (linkedMatch && db.sessionReservationId === 'res-1');
    return found ? [{ id: 'res-1', token_id: 'tok-1' }] : [];
  }
  if (text.includes('UPDATE charging_sessions SET reservation_id')) {
    db.sessionReservationId = 'res-1';
    return [];
  }
  if (text.includes("UPDATE reservations SET status = 'in_use'")) {
    if (db.reservationStatus !== 'active') return [];
    db.reservationStatus = 'in_use';
    return [{ id: 'res-1', driver_id: 'drv-1' }];
  }
  if (text.includes('SELECT token_id FROM charging_sessions')) return [{ token_id: 'tok-1' }];
  if (text.includes('SELECT reservation_id FROM charging_sessions')) {
    return [{ reservation_id: db.sessionReservationId }];
  }
  // Settlement.
  if (text.includes('SELECT cs.id, cs.final_cost_cents')) {
    return [
      {
        id: 'session-1',
        final_cost_cents: 1500,
        station_uuid: 'sta-1',
        currency: 'USD',
        station_ocpp_id: 'CS-1',
        site_id: 'site-1',
      },
    ];
  }
  if (text.includes('SELECT cs.driver_id, cs.energy_delivered_wh, cs.final_cost_cents')) {
    return [
      {
        driver_id: 'drv-1',
        energy_delivered_wh: 10000,
        final_cost_cents: 1500,
        started_at: '2026-10-07T10:00:00.000Z',
        ended_at: '2026-10-07T11:00:00.000Z',
        status: 'completed',
        tariff_tax_rate: null,
        currency: 'USD',
      },
    ];
  }
  if (text.includes('SELECT status, failure_reason FROM payment_records')) {
    return [{ status: 'captured', failure_reason: null }];
  }
  // Updated and Ended.
  if (text.includes('SELECT id, evse_id, status FROM charging_sessions')) {
    return [{ id: 'session-1', evse_id: 'evse-1', status: 'active' }];
  }
  // The end notice claims: the first claim of each notice wins.
  const noticeClaim = /SET (completed_notified_at|receipt_notified_at) = now\(\)/.exec(text);
  if (noticeClaim != null) {
    const column = noticeClaim[1] as string;
    if (db.claimedNotices.has(column)) return [];
    db.claimedNotices.add(column);
    return [{ id: 'session-1' }];
  }
  if (text.includes('SET last_update_notified_at = now()')) {
    return [
      {
        driver_id: 'drv-1',
        energy_delivered_wh: 5000,
        current_cost_cents: 150,
        started_at: '2026-10-07T10:00:00.000Z',
        tariff_tax_rate: null,
        currency: 'USD',
      },
    ];
  }
  if (text.includes('SELECT id, evse_id, status, tariff_id')) {
    return [
      {
        id: 'session-1',
        evse_id: 'evse-1',
        status: db.endedStatus,
        tariff_id: 'tariff-1',
        current_cost_cents: 1400,
        started_at: '2026-10-07T10:00:00.000Z',
        ended_at: '2026-10-07T11:00:00.000Z',
        energy_delivered_wh: db.endedEnergyWh,
        currency: 'USD',
        tariff_tax_rate: null,
        idle_started_at: null,
        idle_minutes: 0,
        reservation_id: 'res-1',
      },
    ];
  }
  return [];
}

const sql = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
  const text = strings.join('?');
  sqlCalls.push(text);
  sqlValues.push(values);
  if (failOn != null && failOn.left > 0 && text.includes(failOn.match)) {
    failOn.left--;
    return Promise.reject(connectionError(failOn.code));
  }
  return Promise.resolve(route(text, values));
}) as unknown as postgres.Sql;
(sql as unknown as { json: (v: unknown) => unknown }).json = (v) => v;
(sql as unknown as { begin: (fn: (tx: unknown) => unknown) => unknown }).begin = (fn) => fn(sql);

const TARIFF = {
  id: 'tariff-1',
  pricePerKwh: '0.30',
  pricePerMinute: null,
  pricePerSession: null,
  idleFeePricePerMinute: null,
  reservationFeePerMinute: '0.10',
  taxRate: null,
};

vi.mock('../../../../database/src/lib/idling-setting.js', () => ({
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../../../database/src/lib/pricing-settings.js', () => ({
  isSplitBillingEnabled: vi.fn().mockResolvedValue(false),
}));

const mockWriteReservationAudit = vi.fn().mockResolvedValue(undefined);
const mockReprice = vi.fn().mockResolvedValue(false);
const mockFreeVend = vi.fn().mockResolvedValue(false);
const mockElectricityPeriods = vi.fn().mockResolvedValue([]);
vi.mock('@evtivity/database', async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../../database/src/lib/session-end-request.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../../database/src/lib/station-status.js',
  )),
  // The real snapshot writes (session UPDATE, then the segment INSERT).
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../../database/src/lib/session-pricing.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>('../../../../database/src/lib/pg-errors.js')),
  resolveStationTariff: vi.fn(() => Promise.resolve(TARIFF)),
  repriceSessionForDriver: (...args: unknown[]) => mockReprice(...args) as unknown,
  // Every ended session costs 15.00 (net, no tax).
  priceSessionAt: vi.fn(() =>
    Promise.resolve({
      basis: 'net',
      netCents: 1500,
      taxCents: 0,
      grossCents: 1500,
      taxLines: [{ taxRate: 0, netCents: 1500, taxCents: 0 }],
      components: null,
    }),
  ),
  getElectricityRatePeriodsForSite: (...args: unknown[]) =>
    mockElectricityPeriods(...args) as unknown,
  getCompanyTaxBasis: vi.fn().mockResolvedValue('net'),
  isRoamingEnabled: vi.fn().mockResolvedValue(false),
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(0),
  isSiteFreeVendEnabledByStation: (...args: unknown[]) => mockFreeVend(...args) as unknown,
  getCompanyCurrency: vi.fn().mockResolvedValue('USD'),
  getCompanyPriceDisplay: vi.fn().mockResolvedValue('net'),
  writeReservationAudit: (...args: unknown[]) => mockWriteReservationAudit(...args) as unknown,
  // Driver sessions pay by card (no fleet account billing) unless a test says so.
  stampSessionBilling: vi.fn().mockResolvedValue({ mode: 'card', fleetId: null, fleetName: null }),
}));

const mockDispatchDriver = vi.fn().mockResolvedValue(undefined);
vi.mock('../../server/notification-dispatcher.js', () => ({
  dispatchOcppNotification: vi.fn().mockResolvedValue(undefined),
  dispatchDriverNotification: (...args: unknown[]) => mockDispatchDriver(...args) as unknown,
  dispatchSystemNotification: vi.fn().mockResolvedValue(undefined),
  ALL_TEMPLATES_DIRS: ['/mock/templates'],
}));

const mockAuthorizeSessionHold = vi.fn();
const mockSettleSessionPayment = vi.fn();
vi.mock('@evtivity/payments', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authorizeSessionHold: (...args: unknown[]) => mockAuthorizeSessionHold(...args) as unknown,
  settleSessionPayment: (...args: unknown[]) => mockSettleSessionPayment(...args) as unknown,
}));
vi.mock('../../lib/payments.js', () => ({
  paymentRegistry: {},
  paymentContext: () => ({ registry: {}, logger: {} }),
  activePaymentProvider: () => Promise.resolve({ id: 'stripe' }),
}));

// The real gate, observed: its input and its decision.
const gateSpy = vi.fn();
vi.mock('../../server/session-lifecycle/payment-gate.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../server/session-lifecycle/payment-gate.js')>();
  return {
    ...actual,
    runPaymentGate: async (...args: Parameters<typeof actual.runPaymentGate>) => {
      gateSpy(args[1]);
      return actual.runPaymentGate(...args);
    },
  };
});

const { TransactionProjector } =
  await import('../../server/session-lifecycle/transaction-projector.js');
const { runProjectionWithRetry } = await import('../../server/projection-retry.js');
const { settleTransactionEnded } = await import('../../server/session-lifecycle/settlement.js');
const { createProjectionLookups } = await import('../../server/projection-support/lookups.js');
const { createProjectionNotifier } = await import('../../server/projection-support/notify.js');

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

const publish = vi.fn().mockResolvedValue(undefined);
const pubsub: PubSubClient = {
  publish,
  subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
  close: vi.fn().mockResolvedValue(undefined),
};
const eventBus = {
  publish: vi.fn(),
  track: <T>(work: Promise<T>) => work,
} as unknown as EventBus;

// The buffered-event drain, run once per attempt after the Started step.
const drain = vi.fn(() => []);

function createDeps() {
  const lookups = createProjectionLookups(sql);
  const notify = createProjectionNotifier({ sql, eventBus, pubsub, logger });
  return { sql, eventBus, pubsub, logger, payments: {} as PaymentContext, lookups, notify };
}

function createProjector(): InstanceType<typeof TransactionProjector> {
  const state = {
    txBuffer: { drain, add: vi.fn() },
    projectionQueue: { signal: vi.fn(), settled: vi.fn().mockResolvedValue(undefined) },
    costUpdated: { forget: vi.fn() },
  };
  return new TransactionProjector(createDeps(), state as never);
}

function startedEvent(extra: Record<string, unknown> = {}): DomainEvent {
  return {
    eventType: 'ocpp.TransactionEvent',
    aggregateType: 'ChargingStation',
    aggregateId: 'CS-1',
    payload: {
      stationId: 'CS-1',
      transactionId: 'tx-1',
      eventType: 'Started',
      seqNo: 0,
      triggerReason: 'Authorized',
      timestamp: '2026-10-07T10:00:00.000Z',
      idToken: 'TOKEN1',
      evseId: 1,
      ...extra,
    },
    occurredAt: new Date(),
  };
}

async function projectWithRetry(event: DomainEvent): Promise<void> {
  const projector = createProjector();
  await runProjectionWithRetry((attempt) => projector.project(event, attempt), {
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
  });
}

function countCalls(fragment: string): number {
  return sqlCalls.filter((text) => text.includes(fragment)).length;
}

function csmsEvents(type: string): unknown[] {
  return publish.mock.calls.filter(
    (call) =>
      call[0] === 'csms_events' &&
      (JSON.parse(call[1] as string) as { type?: string }).type === type,
  );
}

function driverNotifications(eventType: string): unknown[] {
  return mockDispatchDriver.mock.calls.filter((call) => call[1] === eventType);
}

function transactionEvent(eventType: 'Updated' | 'Ended', extra: Record<string, unknown> = {}) {
  return startedEvent({ eventType, seqNo: eventType === 'Updated' ? 1 : 2, ...extra });
}

beforeEach(() => {
  sqlCalls.length = 0;
  sqlValues.length = 0;
  failOn = null;
  db.driverId = null;
  db.tokenRow = null;
  db.guestReads = 0;
  db.reservationStatus = 'active';
  db.sessionReservationId = null;
  db.endedEnergyWh = 10000;
  db.endedStatus = 'completed';
  db.prepaidClaim = null;
  db.claimedNotices.clear();
  db.firstToken = null;
  db.reservedCents = 0;
  db.unauthorizedClaimOpen = false;
  db.eventRows.clear();
  vi.clearAllMocks();
  mockFreeVend.mockResolvedValue(false);
  mockElectricityPeriods.mockResolvedValue([]);
  mockAuthorizeSessionHold.mockResolvedValue({
    outcome: 'authorized',
    paymentRecordId: 1,
    paymentId: 'pi_test',
  });
});

describe('TransactionEvent Started run again after a lost connection', () => {
  it('keeps the reservation link and writes each effect once when the reservation step fails', async () => {
    db.tokenRow = { id: 'tok-1', driver_id: 'drv-1', prepaid_balance_cents: null };
    // The reservation token check runs after the transaction event, the
    // tariff segment and the reservation moving to in_use.
    failOn = { match: 'SELECT token_id FROM charging_sessions', code: 'CONNECT_TIMEOUT', left: 1 };

    await projectWithRetry(startedEvent({ reservationId: 7 }));

    expect(countCalls('SELECT token_id FROM charging_sessions')).toBe(2);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(countCalls('INSERT INTO session_tariff_segments')).toBe(1);
    expect(mockWriteReservationAudit).toHaveBeenCalledTimes(1);
    expect(driverNotifications('session.Started')).toHaveLength(1);
    expect(csmsEvents('TransactionStarted')).toHaveLength(1);
    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(gateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reserved: true, driverId: 'drv-1' }),
    );
  });

  it('allows a paid guest the rerun would read as charging', async () => {
    // The site lookup after the context fails, so the whole step runs again.
    failOn = { match: 'SELECT site_id FROM charging_stations', code: 'CONNECT_TIMEOUT', left: 1 };

    await projectWithRetry(startedEvent({ idToken: 'GUEST-TOKEN' }));

    expect(countCalls('SELECT site_id FROM charging_stations')).toBe(2);
    expect(db.guestReads).toBe(1);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(countCalls('INSERT INTO session_tariff_segments')).toBe(1);
    expect(csmsEvents('TransactionStarted')).toHaveLength(1);
    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(gateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ guestStatus: 'payment_authorized' }),
    );
    expect(countCalls("status = 'faulted'")).toBe(0);
  });

  it('runs the gate again after a connect timeout with the same hold, and notifies once', async () => {
    db.tokenRow = { id: 'tok-1', driver_id: 'drv-1', prepaid_balance_cents: null };
    mockAuthorizeSessionHold
      .mockRejectedValueOnce(connectionError('CONNECT_TIMEOUT'))
      .mockResolvedValueOnce({ outcome: 'authorized', paymentRecordId: 1, paymentId: 'pi_test' });

    await projectWithRetry(startedEvent());

    // The hold key is preauth_<sessionId>: both calls name the same session,
    // so the provider places one hold.
    expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(2);
    const sessionIds = mockAuthorizeSessionHold.mock.calls.map(
      (call) => (call[0] as { sessionId: string }).sessionId,
    );
    expect(sessionIds).toEqual(['session-1', 'session-1']);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(countCalls('INSERT INTO session_tariff_segments')).toBe(1);
    expect(driverNotifications('session.Started')).toHaveLength(1);
    expect(csmsEvents('TransactionStarted')).toHaveLength(1);
    expect(countCalls("status = 'faulted'")).toBe(0);
  });

  it('runs once when nothing fails', async () => {
    db.tokenRow = { id: 'tok-1', driver_id: 'drv-1', prepaid_balance_cents: null };

    await projectWithRetry(startedEvent({ reservationId: 7 }));

    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(countCalls('INSERT INTO session_tariff_segments')).toBe(1);
    expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(1);
    expect(gateSpy).toHaveBeenCalledWith(expect.objectContaining({ reserved: true }));
  });

  it('goes on to the gate and the drain when the transaction event insert was interrupted', async () => {
    db.tokenRow = { id: 'tok-1', driver_id: 'drv-1', prepaid_balance_cents: null };
    // The INSERT may have committed, so the projection is not retried: it
    // must still gate the session.
    failOn = { match: 'INSERT INTO transaction_events', code: 'ECONNRESET', left: 1 };

    await projectWithRetry(startedEvent());

    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(countCalls('ocpp_protocol FROM charging_stations')).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      'Failed to insert transaction_event (session may have been deleted)',
    );
  });

  it('retries a transaction event insert that never reached the server', async () => {
    db.tokenRow = { id: 'tok-1', driver_id: 'drv-1', prepaid_balance_cents: null };
    failOn = { match: 'INSERT INTO transaction_events', code: 'CONNECT_TIMEOUT', left: 1 };

    await projectWithRetry(startedEvent());

    expect(countCalls('INSERT INTO transaction_events')).toBe(2);
    expect(countCalls('INSERT INTO session_tariff_segments')).toBe(1);
    expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(1);
  });

  it('retries the roaming lookup instead of starting a roaming session as non-roaming', async () => {
    db.tokenRow = { id: 'tok-1', driver_id: 'drv-1', prepaid_balance_cents: null };
    failOn = { match: 'FROM ocpi_external_tokens', code: 'CONNECT_TIMEOUT', left: 1 };

    await projectWithRetry(startedEvent());

    expect(countCalls('FROM ocpi_external_tokens')).toBe(2);
    expect(countCalls('INSERT INTO charging_sessions')).toBe(1);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
  });

  it('marks a free vend session once and never gates it on a rerun', async () => {
    mockFreeVend.mockResolvedValue(true);
    failOn = { match: 'SELECT site_id FROM charging_stations', code: 'CONNECT_TIMEOUT', left: 1 };

    await projectWithRetry(startedEvent());

    expect(countCalls('SET free_vend = true')).toBe(1);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(csmsEvents('TransactionStarted')).toHaveLength(1);
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it('drains and refreshes the station screen on each run when the gate fails', async () => {
    db.tokenRow = { id: 'tok-1', driver_id: 'drv-1', prepaid_balance_cents: null };
    mockAuthorizeSessionHold.mockRejectedValueOnce(connectionError('CONNECT_TIMEOUT'));

    await projectWithRetry(startedEvent());

    expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(2);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(countCalls('ocpp_protocol FROM charging_stations')).toBe(2);
  });

  it('reads the site name again after an interrupted read and notifies once', async () => {
    db.tokenRow = { id: 'tok-1', driver_id: 'drv-1', prepaid_balance_cents: null };
    // An interrupted read outside a once step is retried.
    failOn = { match: 'SELECT s.name FROM sites', code: 'ECONNRESET', left: 1 };

    await projectWithRetry(startedEvent());

    expect(countCalls('SELECT s.name FROM sites')).toBe(2);
    expect(driverNotifications('session.Started')).toHaveLength(1);
    expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(1);
    expect(countCalls('INSERT INTO session_tariff_segments')).toBe(1);
  });

  it('retries an interrupted tariff snapshot and opens one segment', async () => {
    db.tokenRow = { id: 'tok-1', driver_id: 'drv-1', prepaid_balance_cents: null };
    failOn = { match: 'SET tariff_id', code: 'ECONNRESET', left: 1 };

    await projectWithRetry(startedEvent());

    expect(countCalls('SET tariff_id')).toBe(2);
    expect(countCalls('INSERT INTO session_tariff_segments')).toBe(1);
    expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(1);
  });

  it('goes on to the gate when the first tariff segment insert was interrupted', async () => {
    db.tokenRow = { id: 'tok-1', driver_id: 'drv-1', prepaid_balance_cents: null };
    failOn = { match: 'INSERT INTO session_tariff_segments', code: 'ECONNRESET', left: 1 };

    await projectWithRetry(startedEvent());

    expect(countCalls('INSERT INTO session_tariff_segments')).toBe(1);
    expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      'First tariff segment insert interrupted; continuing to the payment gate',
    );
  });

  it('gates the session on the last run when the reservation link keeps failing', async () => {
    db.tokenRow = { id: 'tok-1', driver_id: 'drv-1', prepaid_balance_cents: null };
    failOn = { match: 'SELECT token_id FROM charging_sessions', code: 'CONNECT_TIMEOUT', left: 3 };

    await projectWithRetry(startedEvent({ reservationId: 7 }));

    expect(countCalls('SELECT token_id FROM charging_sessions')).toBe(3);
    expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('starts the session as non-roaming on the last run when the roaming lookup keeps failing', async () => {
    db.tokenRow = { id: 'tok-1', driver_id: 'drv-1', prepaid_balance_cents: null };
    failOn = { match: 'FROM ocpi_external_tokens', code: 'CONNECT_TIMEOUT', left: 3 };

    await projectWithRetry(startedEvent());

    expect(countCalls('FROM ocpi_external_tokens')).toBe(3);
    expect(countCalls('INSERT INTO charging_sessions')).toBe(1);
    expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(1);
  });
});

// Finding JB-6: a station resends an event under a new message id (after a
// reconnect, or for a lost response). The first delivery wrote its
// transaction_events row; the resend is skipped. A rerun of the first
// delivery keeps the first answer of the check (memo), although its own row
// now exists.
describe('A resent TransactionEvent (finding JB-6)', () => {
  it('skips a resent Started and still signals the handler', async () => {
    db.tokenRow = { id: 'tok-1', driver_id: 'drv-1', prepaid_balance_cents: null };
    await projectWithRetry(startedEvent());
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    sqlCalls.length = 0;
    vi.clearAllMocks();

    const projector = createProjector();
    await runProjectionWithRetry((attempt) => projector.project(startedEvent(), attempt), {
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });

    expect(countCalls('INSERT INTO transaction_events')).toBe(0);
    expect(countCalls('INSERT INTO session_tariff_segments')).toBe(0);
    expect(gateSpy).not.toHaveBeenCalled();
    expect(driverNotifications('session.Started')).toHaveLength(0);
    const state = (projector as unknown as { state: { projectionQueue: { signal: unknown } } })
      .state;
    expect(state.projectionQueue.signal).toHaveBeenCalledTimes(2);
  });

  it('skips a resent Updated: no row, idle change or notice', async () => {
    db.eventRows.add(eventRowKey('updated', 1, '2026-10-07T10:00:00.000Z'));
    await projectWithRetry(transactionEvent('Updated', { chargingState: 'SuspendedEV' }));

    expect(countCalls('INSERT INTO transaction_events')).toBe(0);
    expect(countCalls('UPDATE charging_sessions')).toBe(0);
    expect(countCalls('SET last_update_notified_at = now()')).toBe(0);
  });

  it('skips a resent Ended: no row, end update or final cost', async () => {
    db.eventRows.add(eventRowKey('ended', 2, '2026-10-07T10:00:00.000Z'));
    await projectWithRetry(transactionEvent('Ended'));

    expect(countCalls('INSERT INTO transaction_events')).toBe(0);
    expect(countCalls('ended_at =')).toBe(0);
    expect(countCalls('final_cost_cents')).toBe(0);
  });

  it('projects the first delivery fully when its rerun finds its own row', async () => {
    // The throttle claim after the row insert fails once: the rerun's check
    // would find the row the first run wrote, but keeps the first answer.
    failOn = { match: 'SET last_update_notified_at', code: 'CONNECT_TIMEOUT', left: 1 };
    await projectWithRetry(transactionEvent('Updated', { chargingState: 'SuspendedEV' }));

    expect(countCalls('AND te.seq_no = ?')).toBe(1);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(countCalls('SET last_update_notified_at')).toBe(2);
    expect(countCalls('SET idle_started_at')).toBe(2);
  });
});

describe('TransactionEvent Updated run again after a lost connection', () => {
  it('records the event once and sends the claimed notice once when the throttle update fails', async () => {
    failOn = { match: 'SET last_update_notified_at', code: 'CONNECT_TIMEOUT', left: 1 };

    await projectWithRetry(transactionEvent('Updated', { chargingState: 'Charging' }));

    expect(countCalls('SET last_update_notified_at')).toBe(2);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(driverNotifications('session.Updated')).toHaveLength(1);
  });

  it('keeps the notice claim when a later step fails', async () => {
    failOn = { match: 'SELECT s.name FROM sites', code: 'CONNECT_TIMEOUT', left: 1 };

    await projectWithRetry(transactionEvent('Updated'));

    // The claim is not run again (a second claim would find the notice
    // already claimed and skip it).
    expect(countCalls('SET last_update_notified_at')).toBe(1);
    expect(countCalls('SELECT s.name FROM sites')).toBe(2);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(driverNotifications('session.Updated')).toHaveLength(1);
  });

  it('goes on when the transaction event insert was interrupted', async () => {
    failOn = { match: 'INSERT INTO transaction_events', code: 'ECONNRESET', left: 1 };

    await projectWithRetry(transactionEvent('Updated'));

    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(driverNotifications('session.Updated')).toHaveLength(1);
  });

  describe('CostLimitReached on a prepaid session', () => {
    beforeEach(() => {
      db.prepaidClaim = 'open';
    });

    it('claims the session and sends prepaid.CreditExhausted once, without a stop', async () => {
      await projectWithRetry(
        transactionEvent('Updated', {
          triggerReason: 'CostLimitReached',
          chargingState: 'SuspendedEVSE',
        }),
      );
      expect(countCalls('SET stopped_reason =')).toBe(1);
      expect(driverNotifications('prepaid.CreditExhausted')).toHaveLength(1);
      expect(
        publish.mock.calls.filter(
          (call) =>
            call[0] === 'ocpp_commands' && String(call[1]).includes('RequestStopTransaction'),
        ),
      ).toHaveLength(0);

      // The station repeats the report: the session is claimed, nothing more.
      await projectWithRetry(
        transactionEvent('Updated', { triggerReason: 'CostLimitReached', seqNo: 2 }),
      );
      expect(driverNotifications('prepaid.CreditExhausted')).toHaveLength(1);
    });

    it('does not claim again on a rerun after a later step failed', async () => {
      failOn = { match: 'SELECT s.name FROM sites', code: 'CONNECT_TIMEOUT', left: 1 };
      await projectWithRetry(transactionEvent('Updated', { triggerReason: 'CostLimitReached' }));
      expect(countCalls('SET stopped_reason =')).toBe(1);
      expect(driverNotifications('prepaid.CreditExhausted')).toHaveLength(1);
    });

    it('retries a claim that never reached the server and notifies once', async () => {
      failOn = { match: 'SET stopped_reason =', code: 'CONNECT_TIMEOUT', left: 1 };
      await projectWithRetry(transactionEvent('Updated', { triggerReason: 'CostLimitReached' }));
      expect(countCalls('SET stopped_reason =')).toBe(2);
      expect(driverNotifications('prepaid.CreditExhausted')).toHaveLength(1);
    });

    it('warns and goes on when the claim was interrupted (it may have committed)', async () => {
      failOn = { match: 'SET stopped_reason =', code: 'ECONNRESET', left: 1 };
      await projectWithRetry(transactionEvent('Updated', { triggerReason: 'CostLimitReached' }));
      expect(countCalls('SET stopped_reason =')).toBe(1);
      expect(driverNotifications('prepaid.CreditExhausted')).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1' }),
        'Prepaid cost limit notice failed; continuing',
      );
      expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    });

    it('notifies when the station ends the transaction at the limit', async () => {
      await projectWithRetry(transactionEvent('Ended', { triggerReason: 'CostLimitReached' }));
      expect(countCalls('SET stopped_reason =')).toBe(1);
      expect(driverNotifications('prepaid.CreditExhausted')).toHaveLength(1);
      // The claim runs before the Ended update keeps it (COALESCE).
      const claimAt = sqlCalls.findIndex((text) => text.includes('SET stopped_reason ='));
      const endAt = sqlCalls.findIndex((text) =>
        text.includes('stopped_reason = COALESCE(stopped_reason'),
      );
      expect(claimAt).toBeLessThan(endAt);
    });
  });

  describe('CostLimitReached on an account session (plan S8)', () => {
    beforeEach(() => {
      // Neither claim matches a row: only the claim attempts are counted.
      db.prepaidClaim = 'claimed';
    });

    it('tries the prepaid and the account claim when the ceiling was not raised', async () => {
      await projectWithRetry(transactionEvent('Updated', { triggerReason: 'CostLimitReached' }));
      expect(countCalls('SET stopped_reason =')).toBe(2);
    });

    it('skips the account claim when the handler raised the ceiling at the report', async () => {
      await projectWithRetry(
        transactionEvent('Updated', {
          triggerReason: 'CostLimitReached',
          accountCeilingRaised: true,
        }),
      );
      expect(countCalls('SET stopped_reason =')).toBe(1);
    });

    it('claims an Ended transaction at the limit (E16.FR.06) whatever the payload says', async () => {
      await projectWithRetry(
        transactionEvent('Ended', {
          triggerReason: 'CostLimitReached',
          accountCeilingRaised: true,
        }),
      );
      expect(countCalls('SET stopped_reason =')).toBe(2);
    });
  });
});

describe('TransactionEvent Ended run again after a lost connection', () => {
  function finalCosts(): unknown[] {
    return sqlCalls.flatMap((text, i) =>
      text.includes('SET final_cost_cents') ? [sqlValues[i]?.[0]] : [],
    );
  }

  it('stores the final cost and writes each effect once when storing the cost fails', async () => {
    failOn = { match: 'SET final_cost_cents', code: 'CONNECT_TIMEOUT', left: 1 };

    await projectWithRetry(transactionEvent('Ended', { stoppedReason: 'Local' }));

    expect(finalCosts()).toEqual([1500, 1500]);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    // Closing the open segment again is a no-op (ended_at IS NULL guard).
    expect(countCalls('UPDATE session_tariff_segments')).toBe(2);
    expect(csmsEvents('TransactionEnded')).toHaveLength(1);
    expect(countCalls("UPDATE reservations SET status = 'used'")).toBe(1);
  });

  it('retries a lost connection on the reservation update instead of logging it', async () => {
    failOn = { match: "UPDATE reservations SET status = 'used'", code: 'CONNECT_TIMEOUT', left: 1 };

    await projectWithRetry(transactionEvent('Ended'));

    expect(countCalls("UPDATE reservations SET status = 'used'")).toBe(2);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(csmsEvents('TransactionEnded')).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('writes the reservation fault audit once for a timeout end', async () => {
    // An EVConnectTimeout with no energy fails the session; the projection
    // then fails after the audit (the carbon lookup) and runs again.
    failOn = { match: 'carbon_intensity_kg_per_kwh', code: 'CONNECT_TIMEOUT', left: 1 };
    db.sessionReservationId = 'res-1';
    db.endedEnergyWh = 0;

    await projectWithRetry(
      transactionEvent('Ended', { triggerReason: 'EVConnectTimeout', stoppedReason: 'Timeout' }),
    );

    expect(countCalls('carbon_intensity_kg_per_kwh')).toBe(2);
    expect(mockWriteReservationAudit).toHaveBeenCalledTimes(1);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
  });

  it('retries an interrupted final cost write and stores the same cost', async () => {
    failOn = { match: 'SET final_cost_cents', code: 'ECONNRESET', left: 1 };

    await projectWithRetry(transactionEvent('Ended'));

    expect(finalCosts()).toEqual([1500, 1500]);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(csmsEvents('TransactionEnded')).toHaveLength(1);
  });

  it('retries an interrupted carbon lookup', async () => {
    failOn = { match: 'carbon_intensity_kg_per_kwh', code: 'ECONNRESET', left: 1 };

    await projectWithRetry(transactionEvent('Ended'));

    expect(countCalls('carbon_intensity_kg_per_kwh')).toBe(2);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(csmsEvents('TransactionEnded')).toHaveLength(1);
  });

  it('retries a lost connection in the electricity cost step', async () => {
    mockElectricityPeriods.mockRejectedValueOnce(connectionError('CONNECT_TIMEOUT'));

    await projectWithRetry(transactionEvent('Ended'));

    expect(mockElectricityPeriods).toHaveBeenCalledTimes(2);
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
    expect(csmsEvents('TransactionEnded')).toHaveLength(1);
  });

  it('finishes the end on the last run when a fail-open step keeps failing', async () => {
    failOn = { match: 'carbon_intensity_kg_per_kwh', code: 'CONNECT_TIMEOUT', left: 3 };

    await projectWithRetry(transactionEvent('Ended'));

    expect(countCalls('carbon_intensity_kg_per_kwh')).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      'Failed to compute CO2 avoided',
    );
    // The steps after it ran on the last run: the session ended SSE, the
    // guest finalization publish and the station screen.
    expect(csmsEvents('TransactionEnded')).toHaveLength(1);
    expect(
      publish.mock.calls.filter(
        (call) =>
          call[0] === 'csms_events' &&
          (JSON.parse(call[1] as string) as { eventType?: string }).eventType === 'session.ended',
      ),
    ).toHaveLength(1);
    expect(countCalls('ocpp_protocol FROM charging_stations')).toBe(1);
  });

  it('keeps a session the gate faulted: no final cost, no status regression', async () => {
    db.endedStatus = 'faulted';
    failOn = { match: 'carbon_intensity_kg_per_kwh', code: 'CONNECT_TIMEOUT', left: 1 };

    await projectWithRetry(transactionEvent('Ended'));

    expect(finalCosts()).toEqual([]);
    const endUpdates = sqlCalls.filter((text) => text.includes('ended_at = ?'));
    expect(endUpdates).toHaveLength(2);
    for (const text of endUpdates) {
      expect(text).toContain("WHEN status IN ('faulted', 'failed') THEN status");
    }
    expect(countCalls('INSERT INTO transaction_events')).toBe(1);
  });
});

describe('Settlement run again after a lost connection', () => {
  async function settleWithRetry(event: DomainEvent): Promise<void> {
    const deps = createDeps();
    await runProjectionWithRetry(
      async (attempt) => {
        await settleTransactionEnded(deps, event, attempt);
      },
      { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    );
  }

  it('captures once and sends each notice once when the site name read fails after the capture', async () => {
    mockSettleSessionPayment.mockResolvedValue({
      mode: 'card',
      status: 'captured',
      recorded: true,
      driverId: 'drv-1',
      capturedCents: 1500,
    });
    failOn = { match: 'SELECT s.name FROM sites', code: 'CONNECT_TIMEOUT', left: 1 };

    await settleWithRetry(transactionEvent('Ended'));

    expect(countCalls('SELECT s.name FROM sites')).toBe(2);
    expect(mockSettleSessionPayment).toHaveBeenCalledTimes(1);
    expect(driverNotifications('session.Completed')).toHaveLength(1);
    expect(driverNotifications('session.Receipt')).toHaveLength(1);
    expect(driverNotifications('session.PaymentReceived')).toHaveLength(1);
  });

  it('settles again after the settlement itself lost its connection', async () => {
    mockSettleSessionPayment
      .mockRejectedValueOnce(connectionError('CONNECT_TIMEOUT'))
      .mockResolvedValueOnce({
        mode: 'card',
        status: 'failed',
        driverId: 'drv-1',
        reason: 'card declined',
      });

    await settleWithRetry(transactionEvent('Ended'));

    expect(mockSettleSessionPayment).toHaveBeenCalledTimes(2);
    expect(driverNotifications('payment.CaptureFailed')).toHaveLength(1);
    expect(driverNotifications('session.Completed')).toHaveLength(1);
  });

  it('publishes token.changed once for a prepaid debit', async () => {
    mockSettleSessionPayment.mockResolvedValue({
      mode: 'prepaid',
      tokenId: 'tok-1',
      debitedCents: 1500,
    });
    failOn = {
      match: 'SELECT status, failure_reason FROM payment_records',
      code: 'ECONNRESET',
      left: 1,
    };

    await settleWithRetry(transactionEvent('Ended'));

    expect(mockSettleSessionPayment).toHaveBeenCalledTimes(1);
    expect(
      publish.mock.calls.filter(
        (call) =>
          call[0] === 'csms_events' &&
          (JSON.parse(call[1] as string) as { eventType?: string }).eventType === 'token.changed',
      ),
    ).toHaveLength(1);
    expect(driverNotifications('session.Completed')).toHaveLength(1);
  });

  it('gives up the session end notices on the last run and still sends the payment notice', async () => {
    mockSettleSessionPayment.mockResolvedValue({
      mode: 'card',
      status: 'captured',
      recorded: true,
      driverId: 'drv-1',
      capturedCents: 1500,
    });
    failOn = {
      match: 'SELECT cs.driver_id, cs.energy_delivered_wh, cs.final_cost_cents',
      code: 'CONNECT_TIMEOUT',
      left: 3,
    };

    await settleWithRetry(transactionEvent('Ended'));

    expect(mockSettleSessionPayment).toHaveBeenCalledTimes(1);
    expect(driverNotifications('session.Completed')).toHaveLength(0);
    expect(driverNotifications('session.PaymentReceived')).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      'Session end notifications failed; continuing',
    );
  });
});

describe('An idToken first presented after the transaction started (E02, E03)', () => {
  const prepaidToken = {
    reservation_id: null,
    started_at: '2026-10-07T10:00:00.000Z',
    token_id: 'tok-p',
    token_driver_id: 'drv-1',
    prepaid: true,
    roaming: false,
  };

  function ocppStops(): unknown[] {
    return publish.mock.calls.filter(
      (call) =>
        call[0] === 'ocpp_commands' &&
        (JSON.parse(call[1] as string) as { action?: string }).action === 'RequestStopTransaction',
    );
  }

  function tokenLinks(): unknown[][] {
    return sqlValues.filter((_, i) => sqlCalls[i]?.includes('SET token_id ='));
  }

  it('leaves a Started without an idToken waiting for its authorization', async () => {
    await projectWithRetry(
      startedEvent({
        idToken: undefined,
        triggerReason: 'CablePluggedIn',
        chargingState: 'EVConnected',
      }),
    );

    expect(gateSpy).not.toHaveBeenCalled();
    expect(ocppStops()).toHaveLength(0);
    expect(countCalls("SET stopped_reason = 'AnonymousSession'")).toBe(0);
  });

  it('stops a Started without an idToken that already charges, once', async () => {
    db.unauthorizedClaimOpen = true;

    await projectWithRetry(startedEvent({ idToken: undefined, chargingState: 'Charging' }));

    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(gateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ driverId: null, idToken: undefined, prepaidBalanceCents: null }),
    );
    expect(ocppStops()).toHaveLength(1);
  });

  it('stops an unauthorized session once it charges, and not again on the next Charging', async () => {
    db.unauthorizedClaimOpen = true;
    const charging = transactionEvent('Updated', {
      idToken: undefined,
      triggerReason: 'ChargingStateChanged',
      chargingState: 'Charging',
    });

    await projectWithRetry(charging);
    // The next Charging report is a new event (a resend of the first is skipped).
    await projectWithRetry(
      transactionEvent('Updated', {
        idToken: undefined,
        triggerReason: 'ChargingStateChanged',
        chargingState: 'Charging',
        seqNo: 2,
        timestamp: '2026-10-07T10:05:00.000Z',
      }),
    );

    expect(countCalls("SET stopped_reason = 'AnonymousSession'")).toBe(2);
    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(ocppStops()).toHaveLength(1);
  });

  it('links a prepaid token on Updated with its reserved credit, notifies and gates once', async () => {
    db.firstToken = prepaidToken;
    db.tokenRow = { prepaid_balance_cents: 5000 };
    db.reservedCents = 1500;

    await projectWithRetry(transactionEvent('Updated', { idToken: 'PREPAID-1' }));

    const links = tokenLinks();
    expect(links).toHaveLength(1);
    // The credit is the balance minus what the token's other sessions reserve.
    expect(links[0]).toEqual(['tok-p', 3500, 'session-1']);
    expect(countCalls('UPDATE charging_sessions SET driver_id')).toBe(1);
    expect(driverNotifications('session.Started')).toHaveLength(1);
    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(gateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        driverId: 'drv-1',
        idToken: 'PREPAID-1',
        prepaidBalanceCents: 3500,
        transactionEnded: false,
      }),
    );
    expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
    expect(ocppStops()).toHaveLength(0);
  });

  it('runs the link again after a lost connection but notifies and gates once', async () => {
    db.firstToken = prepaidToken;
    db.tokenRow = { prepaid_balance_cents: 5000 };
    failOn = { match: 'SET last_update_notified_at', code: 'CONNECT_TIMEOUT', left: 1 };

    await projectWithRetry(transactionEvent('Updated', { idToken: 'PREPAID-1' }));

    // The eligibility read is memoized, so the rerun links the same token.
    expect(countCalls('SELECT cs.reservation_id, cs.started_at')).toBe(1);
    expect(tokenLinks()).toHaveLength(2);
    expect(tokenLinks()[1]).toEqual(['tok-p', 5000, 'session-1']);
    expect(driverNotifications('session.Started')).toHaveLength(1);
    expect(gateSpy).toHaveBeenCalledTimes(1);
  });

  it('stops a prepaid session whose token has no credit left', async () => {
    db.firstToken = prepaidToken;
    db.tokenRow = { prepaid_balance_cents: 1000 };
    db.reservedCents = 1000;

    await projectWithRetry(transactionEvent('Updated', { idToken: 'PREPAID-1' }));

    expect(tokenLinks()[0]).toEqual(['tok-p', 0, 'session-1']);
    expect(gateSpy).toHaveBeenCalledWith(expect.objectContaining({ prepaidBalanceCents: 0 }));
    expect(ocppStops()).toHaveLength(1);
  });

  it('places the card hold for a postpaid token', async () => {
    db.firstToken = { ...prepaidToken, token_id: 'tok-c', prepaid: false };

    await projectWithRetry(transactionEvent('Updated', { idToken: 'CARD-1' }));

    expect(countCalls('SET token_id =')).toBe(1);
    expect(countCalls('SELECT prepaid_balance_cents FROM driver_tokens')).toBe(0);
    expect(gateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ driverId: 'drv-1', prepaidBalanceCents: null }),
    );
    expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(1);
  });

  it('reprices the session for the linked driver before the gate', async () => {
    db.firstToken = { ...prepaidToken, token_id: 'tok-c', prepaid: false };
    let repricedBeforeGate = false;
    mockReprice.mockImplementationOnce(() => {
      repricedBeforeGate = gateSpy.mock.calls.length === 0;
      return Promise.resolve(true);
    });

    await projectWithRetry(transactionEvent('Updated', { idToken: 'CARD-1' }));

    expect(mockReprice).toHaveBeenCalledWith(expect.anything(), {
      sessionId: 'session-1',
      stationUuid: 'sta-1',
      driverUuid: 'drv-1',
      basis: 'net',
    });
    expect(repricedBeforeGate).toBe(true);
  });

  it('does not reprice a guest session', async () => {
    db.firstToken = { ...prepaidToken, token_id: null, token_driver_id: null, prepaid: false };

    await projectWithRetry(transactionEvent('Updated', { idToken: 'GUEST-1' }));

    expect(mockReprice).not.toHaveBeenCalled();
  });

  it('links a portal remote start that took over the waiting transaction (F01)', async () => {
    db.firstToken = {
      ...prepaidToken,
      remote_start_driver_id: 'drv-portal',
      token_id: null,
      token_driver_id: null,
      prepaid: false,
    };

    await projectWithRetry(
      transactionEvent('Updated', {
        idToken: 'drv-portal',
        tokenType: 'Central',
        triggerReason: 'RemoteStart',
        remoteStartId: 42,
      }),
    );

    // The eligibility read matches the remote start by its id.
    const readIndex = sqlCalls.findIndex((t) =>
      t.includes('SELECT cs.reservation_id, cs.started_at'),
    );
    expect(sqlValues[readIndex]).toContain(42);
    // The driver comes from the remote start: no token or driver write.
    expect(countCalls('SET token_id =')).toBe(0);
    expect(countCalls('UPDATE charging_sessions SET driver_id')).toBe(0);
    expect(driverNotifications('session.Started')).toHaveLength(1);
    expect(mockReprice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ driverUuid: 'drv-portal' }),
    );
    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(gateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ driverId: 'drv-portal', idToken: 'drv-portal' }),
    );
  });

  it('links a remote start by its remoteStartId on an Ended without an idToken', async () => {
    db.firstToken = {
      ...prepaidToken,
      remote_start_driver_id: 'drv-portal',
      token_id: null,
      token_driver_id: null,
      prepaid: false,
    };

    await projectWithRetry(transactionEvent('Ended', { idToken: undefined, remoteStartId: 42 }));

    expect(gateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        driverId: 'drv-portal',
        idToken: undefined,
        transactionEnded: true,
      }),
    );
  });

  it('changes nothing for a session that already has its token', async () => {
    db.firstToken = null;

    await projectWithRetry(transactionEvent('Updated', { idToken: 'PREPAID-1' }));

    expect(countCalls('SELECT cs.reservation_id, cs.started_at')).toBe(1);
    expect(countCalls('SET token_id =')).toBe(0);
    expect(driverNotifications('session.Started')).toHaveLength(0);
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it('links the token on Ended before the end, without a session.Started notice or a stop', async () => {
    db.firstToken = prepaidToken;
    db.tokenRow = { prepaid_balance_cents: 1000 };
    db.reservedCents = 1000;

    await projectWithRetry(transactionEvent('Ended', { idToken: 'PREPAID-1' }));

    const linkIndex = sqlCalls.findIndex((text) => text.includes('SET token_id ='));
    const endIndex = sqlCalls.findIndex((text) => text.includes('ended_at = ?'));
    expect(linkIndex).toBeGreaterThanOrEqual(0);
    expect(linkIndex).toBeLessThan(endIndex);
    expect(driverNotifications('session.Started')).toHaveLength(0);
    expect(gateSpy).toHaveBeenCalledWith(expect.objectContaining({ transactionEnded: true }));
    // No credit: the gate faults the session, but the transaction is over.
    expect(ocppStops()).toHaveLength(0);
  });
});
