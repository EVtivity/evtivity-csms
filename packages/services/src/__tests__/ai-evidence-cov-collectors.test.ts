// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The evidence collectors' database reads: the subject fingerprints and
// condition checks (`state.ts`), and the row loaders of the driver, station,
// session, reservation, authorization, site and concurrent session packs.
// Each test queues the rows a query returns and checks what the collector
// builds from them, what it skips and which scope it binds.

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';

const h = vi.hoisted(() => ({
  fake: undefined as unknown as FakeDb,
  settingsFail: false,
  scopeInputs: [] as unknown[],
}));

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { createFakeDb } = await import('./helpers/fake-db.js');
  h.fake = createFakeDb();
  return {
    ...actual,
    client: h.fake.client,
    db: h.fake.db,
    getAiWorkerSettings: () =>
      h.settingsFail
        ? Promise.reject(new Error('settings down'))
        : Promise.resolve({ stuckSessionsIdleMinutes: 30, stuckSessionsOfflineEndAfterHours: 2 }),
    computeInsightScopeCounts: (input: unknown) => {
      h.scopeInputs.push(input);
      return Promise.resolve({ site: { stations: 3 } });
    },
  };
});

const state = await import('../ai-evidence/state.js');
const driver = await import('../ai-evidence/driver.js');
const station = await import('../ai-evidence/station.js');
const session = await import('../ai-evidence/session.js');
const reservation = await import('../ai-evidence/reservation.js');
const authorization = await import('../ai-evidence/authorization.js');
const site = await import('../ai-evidence/site.js');
const concurrent = await import('../ai-evidence/concurrent-session.js');
const scope = await import('../ai-evidence/scope.js');
const pack = await import('../ai-evidence/pack.js');

const hash = (parts: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

const STATION_STATE = 'FROM charging_stations cs WHERE cs.id = ANY';

function stationState(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    is_online: true,
    availability: 'available',
    status_reason: null,
    last_status_id: 7,
    ...over,
  };
}

beforeEach(() => {
  h.fake.reset();
  h.settingsFail = false;
  h.scopeInputs.length = 0;
});

describe('currentFingerprints', () => {
  it('reads nothing for no refs', async () => {
    expect((await state.currentFingerprints([])).size).toBe(0);
    expect(h.fake.calls).toHaveLength(0);
  });

  it('fingerprints each kind from its own state and null for gone subjects', async () => {
    h.fake.queue(`client:${STATION_STATE}`, [stationState('sta_1')]);
    h.fake.queue('client:FROM charging_sessions', [
      { id: 'ses_1', status: 'failed', updated_at: '2026-11-01T00:00:00Z' },
    ]);
    h.fake.queue('client:FROM reservations', [
      { id: 'res_1', status: 'expired', updated_at: new Date('2026-11-02T00:00:00Z') },
    ]);
    h.fake.queue('client:FROM authorize_attempts a WHERE a.id', [{ last_id: 55 }]);
    h.fake.queue('client:FROM ai_insights', [{ station_id: 'sta_2' }, { station_id: 'sta_3' }]);
    h.fake.queue(`client:${STATION_STATE}`, [
      stationState('sta_3', { is_online: false }),
      stationState('sta_2'),
    ]);
    const base = { sessionId: null, authorizeAttemptId: null, stationId: null };
    const out = await state.currentFingerprints([
      { ...base, id: 'i1', kind: 'station_offline', stationId: 'sta_1' },
      { ...base, id: 'i2', kind: 'station_faulted', stationId: 'sta_gone' },
      { ...base, id: 'i3', kind: 'session_failed', sessionId: 'ses_1' },
      { ...base, id: 'i4', kind: 'reservation_no_show', reservationId: 'res_1' },
      { ...base, id: 'i5', kind: 'reservation_rejected', reservationId: null },
      { ...base, id: 'i6', kind: 'authorization_refused', authorizeAttemptId: 9 },
      { ...base, id: 'i7', kind: 'site_incident' },
      { ...base, id: 'i8', kind: 'site_summary' },
      { ...base, id: 'i9', kind: 'session_failed', sessionId: 'ses_gone' },
    ]);
    expect(out.get('i1')).toBe(hash([true, 'available', null, 7]));
    expect(out.get('i2')).toBeNull();
    expect(out.get('i3')).toBe(hash(['failed', '2026-11-01T00:00:00.000Z']));
    expect(out.get('i4')).toBe(hash(['expired', '2026-11-02T00:00:00.000Z']));
    expect(out.get('i5')).toBeNull();
    expect(out.get('i6')).toBe(hash([55]));
    // Incident members sorted by id.
    expect(out.get('i7')).toBe(
      hash([
        ['sta_2', true, 'available'],
        ['sta_3', false, 'available'],
      ]),
    );
    expect(out.get('i8')).toBeNull();
    expect(out.get('i9')).toBeNull();
    // The station query binds only the station-kind ids.
    const [first] = h.fake.find('client', STATION_STATE);
    expect(first!.params).toContainEqual(['sta_1', 'sta_gone']);
  });

  it('answers null for a gone attempt and an incident without members', async () => {
    const base = { sessionId: null, authorizeAttemptId: null, stationId: null };
    expect(
      await state.currentFingerprint({
        ...base,
        id: 'a',
        kind: 'authorization_refused',
        authorizeAttemptId: 1,
      }),
    ).toBeNull();
    expect(await state.currentFingerprint({ ...base, id: 'b', kind: 'site_incident' })).toBeNull();
  });
});

describe('conditionCleared', () => {
  const base = { sessionId: null, authorizeAttemptId: null, stationId: null };

  it('clears an offline station once it is online, and a gone station', async () => {
    h.fake.queue(`client:${STATION_STATE}`, [stationState('sta_1')]);
    expect(
      await state.conditionCleared({
        ...base,
        id: 'i',
        kind: 'station_offline',
        stationId: 'sta_1',
      }),
    ).toBe(true);
    h.fake.queue(`client:${STATION_STATE}`, [stationState('sta_1', { is_online: false })]);
    expect(
      await state.conditionCleared({
        ...base,
        id: 'i',
        kind: 'station_offline',
        stationId: 'sta_1',
      }),
    ).toBe(false);
    expect(
      await state.conditionCleared({
        ...base,
        id: 'i',
        kind: 'station_faulted',
        stationId: 'sta_x',
      }),
    ).toBe(true);
    expect(await state.conditionCleared({ ...base, id: 'i', kind: 'station_offline' })).toBe(false);
  });

  it('clears a faulted station once it is no longer faulted', async () => {
    h.fake.queue(`client:${STATION_STATE}`, [stationState('sta_1', { availability: 'faulted' })]);
    expect(
      await state.conditionCleared({
        ...base,
        id: 'i',
        kind: 'station_faulted',
        stationId: 'sta_1',
      }),
    ).toBe(false);
    h.fake.queue(`client:${STATION_STATE}`, [stationState('sta_1', { is_online: false })]);
    expect(
      await state.conditionCleared({
        ...base,
        id: 'i',
        kind: 'station_faulted',
        stationId: 'sta_1',
      }),
    ).toBe(true);
  });

  it('clears a reservation station fault when the station is online and not faulted', async () => {
    const ref = {
      ...base,
      id: 'i',
      kind: 'reservation_station_faulted' as const,
      stationId: 'sta_1',
    };
    expect(await state.conditionCleared({ ...ref, stationId: null })).toBe(false);
    expect(await state.conditionCleared(ref)).toBe(true);
    h.fake.queue(`client:${STATION_STATE}`, [stationState('sta_1', { availability: 'faulted' })]);
    expect(await state.conditionCleared(ref)).toBe(false);
    h.fake.queue(`client:${STATION_STATE}`, [stationState('sta_1')]);
    expect(await state.conditionCleared(ref)).toBe(true);
  });

  it('clears a failed reservation fee only once a fee was captured', async () => {
    const ref = {
      ...base,
      id: 'i',
      kind: 'reservation_fee_failed' as const,
      reservationId: 'res_1',
    };
    expect(await state.conditionCleared({ ...ref, reservationId: null })).toBe(false);
    expect(await state.conditionCleared(ref)).toBe(false);
    h.fake.queue('client:FROM payment_records', [{ captured: true }]);
    expect(await state.conditionCleared(ref)).toBe(true);
    const call = h.fake.find('client', 'FROM payment_records').at(-1);
    expect(call!.params).toEqual(['res_1']);
  });

  it('clears an incident only when every member recovered', async () => {
    const ref = { ...base, id: 'inc', kind: 'site_incident' as const };
    expect(await state.conditionCleared(ref)).toBe(false);
    h.fake.queue('client:FROM ai_insights', [{ station_id: 'a' }, { station_id: 'b' }]);
    h.fake.queue(`client:${STATION_STATE}`, [stationState('a'), stationState('b')]);
    expect(await state.conditionCleared(ref)).toBe(true);
    h.fake.queue('client:FROM ai_insights', [{ station_id: 'a' }]);
    h.fake.queue(`client:${STATION_STATE}`, [stationState('a', { availability: 'faulted' })]);
    expect(await state.conditionCleared(ref)).toBe(false);
  });

  it('clears a concurrent refusal once the session it names ended', async () => {
    const ref = { ...base, id: 'i', kind: 'authorization_refused' as const, authorizeAttemptId: 4 };
    h.fake.queue('client:FROM authorize_attempts WHERE id', [
      { outcome: 'concurrent_tx', reason: 'concurrent_session ses_9' },
    ]);
    h.fake.queue('client:FROM charging_sessions s', [
      {
        id: 'ses_9',
        status: 'completed',
        station_id: 'sta_1',
        station_ocpp_id: 'CS-1',
        is_online: true,
        started_at: '2026-11-01T00:00:00Z',
        last_activity_at: '2026-11-01T01:00:00Z',
        connector_status: 'available',
        offline_since: null,
      },
    ]);
    expect(await state.conditionCleared(ref)).toBe(true);
    // A refusal for another reason never clears.
    h.fake.queue('client:FROM authorize_attempts WHERE id', [{ outcome: 'blocked', reason: null }]);
    expect(await state.conditionCleared(ref)).toBe(false);
    // Events never clear.
    expect(
      await state.conditionCleared({ ...base, id: 'i', kind: 'station_alert', stationId: 's' }),
    ).toBe(false);
  });
});

describe('concurrent session state', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const row = {
    id: 'ses_9',
    status: 'active',
    station_id: 'sta_1',
    station_ocpp_id: 'CS-1',
    is_online: false,
    started_at: null,
    last_activity_at: '2026-11-01T08:00:00Z',
    connector_status: 'charging',
    offline_since: '2026-11-01T09:00:00Z',
  };

  it('reads the state and the step with the configured thresholds', async () => {
    h.fake.queue('client:FROM charging_sessions s', [row]);
    const s = await concurrent.loadConcurrentSessionState('ses_9', now);
    expect(s).toMatchObject({
      sessionId: 'ses_9',
      stationOcppId: 'CS-1',
      active: true,
      stationOnline: false,
      startedAt: null,
      // Offline 3 hours past a 2 hour limit.
      step: 'end',
    });
    expect(s?.stationOfflineSince?.toISOString()).toBe('2026-11-01T09:00:00.000Z');
  });

  it('falls back to the default thresholds when settings cannot be read', async () => {
    h.settingsFail = true;
    h.fake.queue('client:FROM charging_sessions s', [row]);
    const s = await concurrent.loadConcurrentSessionState('ses_9', now);
    // The default offline limit is longer than 3 hours: restore, not end.
    expect(s?.step).toBe('restore');
  });

  it('answers null for an unknown session or attempt, and an attempt without a session', async () => {
    expect(await concurrent.loadConcurrentSessionState('ses_x', now)).toBeNull();
    expect(await concurrent.concurrentSessionOfAttempt(1, now)).toBeNull();
    h.fake.queue('client:FROM authorize_attempts', [{ outcome: 'concurrent_tx', reason: 'other' }]);
    expect(await concurrent.concurrentSessionOfAttempt(1, now)).toBeNull();
  });
});

describe('driver evidence', () => {
  const supportCase = {
    id: 'cas_1',
    driver_id: 'drv_1',
    station_id: 'sta_1',
    category: 'billing',
    subject: 'Charged twice',
    description: 'Please refund',
    created_at: '2026-11-01T00:00:00Z',
  };

  it('returns null for a gone case or a case without a driver', async () => {
    expect(await driver.collectDriverSupportEvidence('cas_x')).toBeNull();
    h.fake.queue('client:FROM support_cases', [{ ...supportCase, driver_id: null }]);
    expect(await driver.collectDriverSupportEvidence('cas_1')).toBeNull();
    expect(h.fake.calls).toHaveLength(2);
  });

  it('reads the driver rows scoped to the case driver and the stations they used', async () => {
    h.fake.queue('client:FROM support_cases', [supportCase]);
    h.fake.queue('client:WITH picked AS', [
      {
        id: 'ses_1',
        linked: true,
        station_id: 'sta_1',
        station_identity: 'CS-1',
        site_name: 'Depot',
        evse_number: 1,
        connector_type: 'CCS1',
        status: 'completed',
        stopped_reason: null,
        started_at: '2026-11-01T00:00:00Z',
        ended_at: null,
        energy_delivered_wh: '1000',
        final_cost_cents: null,
        current_cost_cents: 250,
        currency: 'USD',
        payment_status: 'captured',
      },
    ]);
    h.fake.queue('client:FROM driver_tokens', [
      {
        id: 'tok_1',
        token_type: 'ISO14443',
        id_token: 'AB-CD-1234',
        is_active: true,
        prepaid_balance_cents: null,
      },
    ]);
    h.fake.queue('client:COALESCE(captured_amount_cents', [
      {
        id: 3,
        charge_type: 'session',
        amount_cents: 250,
        currency: 'USD',
        status: 'failed',
        failure_reason: ' card declined ',
        created_at: null,
      },
    ]);
    h.fake.queue('client:FROM reservations', [
      {
        id: 'res_1',
        station_id: 'sta_2',
        status: 'expired',
        cancel_reason: null,
        starts_at: null,
        expires_at: null,
        cancellation_fee_cents: 100,
      },
    ]);
    h.fake.queue('client:last_fault_at', [
      {
        id: 'sta_1',
        station_identity: 'CS-1',
        site_name: 'Depot',
        availability: 'available',
        last_fault_at: null,
      },
      {
        id: 'sta_2',
        station_identity: 'CS-2',
        site_name: null,
        availability: 'faulted',
        last_fault_at: '2026-10-31T00:00:00Z',
      },
    ]);
    const out = await driver.collectDriverSupportEvidence('cas_1');
    expect(out?.facts).toEqual({
      category: 'billing',
      openedAt: '2026-11-01T00:00:00.000Z',
      station: 'CS-1',
      linkedSessions: ['session:ses_1'],
    });
    const card = out?.items.find((i) => i.id === 'card:tok_1');
    expect(card?.data).toMatchObject({ lastFour: '****1234' });
    const res = out?.items.find((i) => i.id === 'reservation:res_1');
    expect(res?.data).toMatchObject({ station: 'CS-2', feeCents: 100 });
    expect(out?.untrusted.map((u) => u.source)).toEqual([
      'driver_case_subject',
      'driver_case_description',
      'payment_failure_reason',
    ]);
    // Every driver query binds the case driver.
    for (const text of ['WITH picked AS', 'FROM driver_tokens', 'FROM reservations']) {
      expect(h.fake.find('client', text)[0]!.params).toContain('drv_1');
    }
    expect(h.fake.find('client', 'last_fault_at')[0]!.params).toContainEqual(['sta_1', 'sta_2']);
  });

  it('reads no stations when the driver has no sessions or reservations', async () => {
    h.fake.queue('client:FROM support_cases', [
      { ...supportCase, subject: ' ', description: 'Help' },
    ]);
    const rows = await driver.loadDriverEvidenceRows('cas_1');
    expect(rows?.stations).toEqual([]);
    expect(h.fake.find('client', 'last_fault_at')).toHaveLength(0);
    const built = driver.buildDriverEvidence(rows!);
    expect(built.facts['station']).toBeNull();
    expect(built.untrusted.map((u) => u.source)).toEqual(['driver_case_description']);
  });
});

const stationFacts = {
  id: 'sta_1',
  station_id: 'CS-1',
  site_id: 'sit_1',
  vendor_name: 'Acme',
  model: 'X',
  firmware_version: '1.0',
  ocpp_protocol: 'ocpp2.1',
  is_online: true,
  last_heartbeat: null,
  availability: 'faulted',
  status_reason: null,
  reported_status: null,
  firmware_state: null,
  disabled_reason: null,
  last_boot_at: null,
  last_boot_reason: null,
};

describe('station evidence', () => {
  it('returns null for a gone station', async () => {
    expect(await station.collectStationEvidence('sta_x')).toBeNull();
  });

  it('reads the station rows and reports the latest error code', async () => {
    h.fake.queue('client:boot.created_at', [stationFacts]);
    h.fake.queue("client:payload ->> 'errorCode' AS error_code", [
      {
        id: 2,
        connector_id: 1,
        status: 'Faulted',
        error_code: 'GroundFailure',
        vendor_error_code: null,
        info: null,
        created_at: '2026-11-01T00:00:00Z',
      },
      {
        id: 1,
        connector_id: 1,
        status: 'Faulted',
        error_code: 'OverVoltage',
        vendor_error_code: null,
        info: null,
        created_at: '2026-10-31T00:00:00Z',
      },
    ]);
    const out = await station.collectStationEvidence('sta_1', new Date('2026-11-01T01:00:00Z'));
    expect(out?.errorCode).toBe('GroundFailure');
    expect(out?.pack.subject).toMatchObject({ type: 'station', id: 'sta_1', siteId: 'sit_1' });
    for (const text of ['FROM port_status_log', 'FROM connection_logs', 'FROM event_alerts']) {
      expect(h.fake.find('client', text)[0]!.params).toContain('sta_1');
    }
  });

  it('reports no error code without errors', () => {
    expect(
      station.latestErrorCode({
        station: stationFacts,
        transitions: [],
        connections: [],
        alerts: [],
        errors: [],
      }),
    ).toBeNull();
  });
});

describe('session evidence', () => {
  const facts = {
    id: 'ses_1',
    station_id: 'sta_1',
    site_id: 'sit_1',
    status: 'failed',
    stopped_reason: 'EVDisconnected',
    started_at: '2026-11-01T10:00:00Z',
    ended_at: null,
    energy_delivered_wh: '0',
    final_cost_cents: null,
    current_cost_cents: null,
    station_cost_cents: null,
    station_cost_difference_cents: null,
    currency: 'USD',
    is_roaming: false,
    token_id: 'tok_1',
    updated_at: null,
  };

  it('returns null for a gone session', async () => {
    expect(await session.collectSessionEvidence('ses_x')).toBeNull();
  });

  it('reads the linked attempt of a session with a token', async () => {
    h.fake.queue('client:FROM charging_sessions s', [facts]);
    h.fake.queue('client:FROM payment_records', [
      {
        id: 8,
        status: 'failed',
        payment_source: 'card',
        pre_auth_amount_cents: 500,
        captured_amount_cents: null,
        failure_reason: 'declined',
      },
    ]);
    h.fake.queue('client:ORDER BY timestamp ASC', [
      { id: 1, value: '0', unit: 'Wh', timestamp: null },
    ]);
    h.fake.queue('client:ORDER BY timestamp DESC, id DESC LIMIT 1', [
      { id: 2, value: '10', unit: 'Wh', timestamp: null },
    ]);
    h.fake.queue('client:matched_token_id', [
      { id: 5, outcome: 'accepted', reason: null, token_type: 'ISO14443', created_at: null },
    ]);
    const out = await session.collectSessionEvidence('ses_1');
    expect(out).toMatchObject({ stoppedReason: 'EVDisconnected', stationId: 'sta_1' });
    const kinds = out!.pack.items.map((i) => i.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'payment_record',
        'first_energy_reading',
        'last_energy_reading',
        'authorize_attempt',
      ]),
    );
    expect(out!.pack.untrusted.map((u) => u.source)).toContain('payment_failure_reason');
    expect(h.fake.find('client', 'matched_token_id')[0]!.params).toEqual(
      expect.arrayContaining(['sta_1', 'tok_1', '2026-11-01T10:00:00.000Z']),
    );
  });

  it('skips the attempt query for a session without a token', async () => {
    h.fake.queue('client:FROM charging_sessions s', [{ ...facts, token_id: null }]);
    const rows = await session.loadSessionEvidenceRows('ses_1');
    expect(rows).toMatchObject({
      payment: null,
      firstReading: null,
      lastReading: null,
      authorize: null,
    });
    expect(h.fake.find('client', 'matched_token_id')).toHaveLength(0);
  });
});

describe('reservation evidence', () => {
  const r = {
    id: 'res_1',
    reservation_id: 42,
    station_id: 'sta_1',
    site_id: 'sit_1',
    evse_ocpp_id: 2,
    driver_id: 'drv_1',
    has_token: true,
    status: 'no_show',
    starts_at: '2026-11-01T10:00:00Z',
    expires_at: '2026-11-01T10:30:00Z',
    created_at: '2026-11-01T09:00:00Z',
    updated_at: '2026-11-01T10:31:00Z',
    cancelled_by: null,
    cancel_reason: null,
    station_ack_at: null,
    no_show_fee_state: 'due',
    cancellation_fee_cents: 500,
  };

  it('returns null for a gone reservation', async () => {
    expect(await reservation.collectReservationEvidence('res_x', 'secret')).toBeNull();
  });

  it('merges the reservation calls and status notifications newest first', async () => {
    h.fake.queue('client:FROM reservations r', [r]);
    h.fake.queue('client:WITH calls AS', [
      {
        id: 10,
        action: 'ReserveNow',
        direction: 'outbound',
        message_type: 2,
        status: null,
        error_code: null,
        created_at: '2026-11-01T09:00:00Z',
      },
    ]);
    h.fake.queue("client:l.action = 'StatusNotification'", [
      {
        id: 11,
        action: 'StatusNotification',
        direction: 'inbound',
        message_type: 2,
        status: 'Reserved',
        error_code: null,
        created_at: '2026-11-01T09:01:00Z',
      },
      {
        id: 9,
        action: 'StatusNotification',
        direction: 'inbound',
        message_type: 2,
        status: 'Available',
        error_code: null,
        created_at: '2026-11-01T09:00:00Z',
      },
    ]);
    const rows = await reservation.loadReservationEvidenceRows('res_1');
    expect(rows?.messages.map((m) => m.id)).toEqual([11, 10, 9]);
    expect(rows?.station).toBeNull();
    expect(h.fake.find('client', "l.action = 'StatusNotification'")[0]!.params).toContain('2');
    h.fake.queue('client:FROM reservations r', [{ ...r, evse_ocpp_id: null }]);
    const out = await reservation.collectReservationEvidence(
      'res_1',
      'secret',
      new Date('2026-11-01T11:00:00Z'),
    );
    expect(out?.stationId).toBe('sta_1');
    expect(h.fake.find('client', "l.action = 'StatusNotification'")[1]!.params).toContain(null);
  });
});

describe('authorization evidence', () => {
  const attempt = {
    id: 1,
    id_token: 'TOK',
    token_type: 'ISO14443',
    outcome: 'concurrent_tx',
    reason: 'concurrent_session ses_9',
    ocpp_version: '2.1',
    created_at: '2026-11-01T10:20:00Z',
  };

  it('returns null for a gone attempt or station', async () => {
    expect(await authorization.collectAttemptAuthorizationEvidence(1, 'sta_1', 'subj')).toBeNull();
    h.fake.queue('client:FROM authorize_attempts WHERE id', [
      { id_token: 'TOK', created_at: '2026-11-01T10:20:00Z' },
    ]);
    expect(await authorization.collectAttemptAuthorizationEvidence(1, 'sta_1', 'subj')).toBeNull();
  });

  it('reads the hour bucket of the attempt and the concurrent session it names', async () => {
    h.fake.queue('client:FROM authorize_attempts WHERE id', [
      { id_token: 'TOK', created_at: '2026-11-01T10:20:30Z' },
    ]);
    h.fake.queue('client:FROM charging_stations WHERE id', [
      { station_id: 'CS-1', site_id: 'sit_1' },
    ]);
    h.fake.queue("client:outcome <> 'accepted'", [attempt]);
    h.fake.queue('client:FROM driver_tokens t', [
      {
        token_type: 'ISO14443',
        is_active: true,
        expired: false,
        revoked: false,
        prepaid: false,
        prepaid_credit_left: null,
        driver_active: true,
        fleet_credit_limited: false,
      },
    ]);
    h.fake.queue('client:FROM station_local_auth_entries', [
      { auth_status: 'Accepted', pushed: true },
    ]);
    h.fake.queue('client:FROM charging_sessions s', [
      {
        id: 'ses_9',
        status: 'active',
        station_id: 'sta_2',
        station_ocpp_id: 'CS-2',
        is_online: true,
        started_at: null,
        last_activity_at: new Date().toISOString(),
        connector_status: 'charging',
        offline_since: null,
      },
    ]);
    const out = await authorization.collectAttemptAuthorizationEvidence(1, 'sta_1', 'subj');
    expect(out?.outcome).toBe('concurrent_tx');
    expect(out?.pack.subject).toMatchObject({ siteId: 'sit_1' });
    const params = h.fake.find('client', "outcome <> 'accepted'")[0]!.params!;
    const dates = params.filter((p): p is Date => p instanceof Date).map((d) => d.toISOString());
    expect(dates).toEqual(['2026-11-01T10:00:00.000Z', '2026-11-01T11:00:00.000Z']);
  });

  it('reports no outcome and no concurrent session without refusals', async () => {
    h.fake.queue('client:FROM charging_stations WHERE id', [{ station_id: 'CS-1', site_id: null }]);
    const rows = await authorization.loadAuthorizationEvidenceRows({
      stationDbId: 'sta_1',
      idToken: 'TOK',
      since: new Date('2026-11-01T10:00:00Z'),
      until: new Date('2026-11-01T11:00:00Z'),
    });
    expect(rows).toMatchObject({
      token: null,
      localList: null,
      concurrentSession: null,
      attempts: [],
    });
  });
});

describe('site evidence and scope', () => {
  it('builds the site pack with member stations and station text untrusted', async () => {
    h.fake.queue('client:LEFT JOIN vendors v', [
      {
        id: 'sta_1',
        station_id: 'CS-1',
        vendor_name: 'Acme',
        model: 'X',
        firmware_version: ' ',
        ocpp_protocol: 'ocpp1.6',
        is_online: false,
        availability: 'offline',
        status_reason: null,
        last_heartbeat: null,
        member: true,
      },
      {
        id: 'sta_2',
        station_id: 'CS-2',
        vendor_name: null,
        model: null,
        firmware_version: '2.0',
        ocpp_protocol: 'ocpp2.1',
        is_online: true,
        availability: 'available',
        status_reason: null,
        last_heartbeat: null,
        member: false,
      },
    ]);
    h.fake.queue('client:FROM connection_logs l', [
      {
        id: 4,
        station_id: 'CS-1',
        event: 'disconnected',
        reason: 'timeout',
        created_at: '2026-11-01T00:00:00Z',
      },
    ]);
    const { pack: p } = await site.collectSiteEvidence('sit_1', ['sta_1'], 'sit_1');
    expect(p.subject).toEqual({ type: 'site', id: 'sit_1', siteId: 'sit_1' });
    expect(p.facts).toEqual({ stationsListed: 2, incidentStations: 1 });
    expect(p.items.map((i) => i.kind)).toEqual([
      'incident_station',
      'site_station',
      'connection_event',
    ]);
    expect(p.untrusted.map((u) => `${u.id}:${u.source}`)).toEqual([
      'station:sta_1:station_model',
      'station:sta_2:station_firmware_version',
    ]);
    expect(h.fake.find('client', 'LEFT JOIN vendors v')[0]!.params).toContain('sit_1');
  });

  it('delegates the scope counts to the shared query', async () => {
    const input = { siteId: 'sit_1' } as unknown as Parameters<typeof scope.computeInsightScope>[0];
    expect(await scope.computeInsightScope(input)).toEqual({ site: { stations: 3 } });
    expect(h.scopeInputs).toEqual([input]);
  });
});

describe('pack helpers', () => {
  it('picks only the listed keys that the row has', () => {
    const row: Record<string, unknown> = { a: 1, b: 2 };
    expect(pack.pick(row, ['a', 'c'])).toEqual({ a: 1 });
  });

  it('drops untrusted strings before items while they are at least as many', () => {
    const p = {
      subject: { type: 'station' as const, id: 's', siteId: null },
      facts: {},
      items: [{ id: 'i1', kind: 'k', data: {} }],
      untrusted: [
        { id: 'u1', source: 'src', text: 'x'.repeat(400) },
        { id: 'u2', source: 'src', text: 'y'.repeat(400) },
      ],
    };
    const { pack: kept } = pack.renderEvidencePack(p, 700);
    expect(kept.items).toHaveLength(1);
    expect(kept.untrusted.map((u) => u.id)).toEqual(['u1']);
  });
});

describe('pack builders with sparse rows', () => {
  const now = new Date('2026-11-01T12:00:00Z');

  it('frames only the station text that is present', () => {
    const built = station.buildStationEvidence(
      {
        station: { ...stationFacts, model: null, firmware_version: null },
        transitions: [],
        connections: [],
        alerts: [
          {
            id: 1,
            component: 'Connector',
            variable: null,
            severity: 1,
            trigger: 'Alerting',
            actual_value: null,
            tech_info: 'hot',
            acknowledged: false,
            created_at: null,
          },
          {
            id: 2,
            component: null,
            variable: 'Temp',
            severity: 0,
            trigger: 'Delta',
            actual_value: '90',
            tech_info: null,
            acknowledged: true,
            created_at: null,
          },
        ],
        errors: [
          {
            id: 3,
            connector_id: 1,
            status: 'Faulted',
            error_code: 'X',
            vendor_error_code: null,
            info: 'note',
            created_at: null,
          },
          {
            id: 4,
            connector_id: 2,
            status: 'Faulted',
            error_code: 'Y',
            vendor_error_code: 'V1',
            info: null,
            created_at: null,
          },
        ],
      },
      now,
    );
    expect(built.untrusted.map((u) => `${u.id}:${u.source}`)).toEqual([
      'alert:1:station_alert_component',
      'alert:1:station_alert_tech_info',
      'alert:2:station_alert_variable',
      'alert:2:station_alert_actual_value',
      'error:3:station_status_info',
      'error:4:station_vendor_error_code',
    ]);
  });

  it('names result and error messages and leaves out missing reservation text', () => {
    const built = reservation.buildReservationEvidence(
      {
        reservation: {
          id: 'res_1',
          reservation_id: 1,
          station_id: 'sta_1',
          site_id: null,
          evse_ocpp_id: null,
          driver_id: null,
          has_token: false,
          status: 'cancelled',
          starts_at: null,
          expires_at: null,
          created_at: null,
          updated_at: null,
          cancelled_by: 'driver',
          cancel_reason: null,
          station_ack_at: null,
          no_show_fee_state: 'none',
          cancellation_fee_cents: 0,
        },
        audit: [
          {
            id: 1,
            action: 'cancelled',
            actor: 'driver',
            after: null,
            notes: null,
            created_at: null,
          },
        ],
        messages: [
          {
            id: 2,
            action: 'CancelReservation',
            direction: 'inbound',
            message_type: 3,
            status: null,
            error_code: null,
            created_at: null,
          },
          {
            id: 3,
            action: 'ReserveNow',
            direction: 'inbound',
            message_type: 4,
            status: 'Rejected',
            error_code: 'GenericError',
            created_at: null,
          },
        ],
        payments: [
          {
            id: 4,
            charge_type: 'reservation_fee',
            status: 'captured',
            currency: 'USD',
            pre_auth_amount_cents: null,
            captured_amount_cents: 100,
            failure_reason: null,
          },
        ],
        station: null,
      },
      now,
      'secret',
    );
    const kinds = built.items
      .filter((i) => i.kind === 'ocpp_message')
      .map((i) => (i.data as { messageType: string }).messageType);
    expect(kinds).toEqual(['result', 'error']);
    expect(built.facts).toMatchObject({ driverRef: null, station: null });
    expect(built.untrusted.map((u) => u.source)).toEqual(['station_reported_status']);
  });

  it('builds a driver pack with no case text and an unknown reservation station', () => {
    const built = driver.buildDriverEvidence({
      supportCase: {
        id: 'cas_1',
        driver_id: 'drv_1',
        station_id: 'sta_9',
        category: 'other',
        subject: '',
        description: '',
        created_at: null,
      },
      sessions: [],
      tokens: [],
      payments: [
        {
          id: 1,
          charge_type: null,
          amount_cents: null,
          currency: 'USD',
          status: 'pending',
          failure_reason: null,
          created_at: null,
        },
      ],
      reservations: [
        {
          id: 'r',
          station_id: 'sta_9',
          status: 'active',
          cancel_reason: null,
          starts_at: null,
          expires_at: null,
          cancellation_fee_cents: null,
        },
      ],
      stations: [],
    });
    expect(built.untrusted).toEqual([]);
    expect(built.facts['station']).toBeNull();
    expect(built.items.find((i) => i.id === 'reservation:r')?.data).toMatchObject({
      station: null,
    });
  });
});
