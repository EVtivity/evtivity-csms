// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Ad hoc payments (OCPP 2.1 C24, C25): the station checks, the idempotent
// replay by pspRef (P7), the terminal CSMS token, the RequestStartTransaction
// payload, the audit row without card data, and the payment dropped when the
// station does not start.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';
import { sqlParams, opArgs } from './helpers/fake-db.js';

const h = vi.hoisted(() => ({
  fake: undefined as unknown as FakeDb,
  audits: [] as Record<string, unknown>[],
  send: vi.fn(),
  maintenance: vi.fn(),
}));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake, {
    PG_UNIQUE_VIOLATION: '23505',
    pgErrorCode: (err: unknown) => (err as { code?: string }).code,
    writeAudit: (_cfg: unknown, args: Record<string, unknown>) => {
      h.audits.push(args);
      return Promise.resolve();
    },
  });
});
vi.mock('../ocpp-command.js', () => ({ sendOcppCommandAndWait: h.send }));
vi.mock('../maintenance.service.js', () => ({ getActiveMaintenanceForStation: h.maintenance }));

const { startAdHocPayment } = await import('../ad-hoc-payment.service.js');

const warn = vi.fn();
const access = {
  siteAllowed: (siteId: string | null) => siteId !== 'sit_other',
  actor: {
    actor: 'operator' as const,
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  },
  logger: { warn },
};

const station = { id: 'sta_db', siteId: 'sit_1', isOnline: true, ocppProtocol: 'ocpp2.1' };
const input = {
  stationId: 'CS-1',
  evseId: 1,
  pspRef: 'psp_1',
  cardLast4Digits: '4242',
  cardBin: '424242',
  maxCostCents: 5000,
  email: 'd@example.com',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.fake.reset();
  h.audits.length = 0;
  h.maintenance.mockResolvedValue(null);
  h.send.mockResolvedValue({ response: { status: 'Accepted' } });
});

/** Queues the station and EVSE reads of a happy path. */
function queueStation(s: Record<string, unknown> = station): void {
  h.fake.queue('select:charging_stations', [s]);
  h.fake.queue('select:evses', [{ id: 'evs_1' }]);
}

describe('station checks', () => {
  it('answers not found for an unknown station or one outside the sites', async () => {
    expect(await startAdHocPayment(input, access)).toMatchObject({
      ok: false,
      status: 404,
      code: 'STATION_NOT_FOUND',
    });
    h.fake.queue('select:charging_stations', [{ ...station, siteId: 'sit_other' }]);
    expect(await startAdHocPayment(input, access)).toMatchObject({ code: 'STATION_NOT_FOUND' });
  });

  it('refuses an offline station', async () => {
    h.fake.queue('select:charging_stations', [{ ...station, isOnline: false }]);
    expect(await startAdHocPayment(input, access)).toMatchObject({
      status: 400,
      code: 'STATION_OFFLINE',
    });
  });

  it('refuses a 1.6 station without a terminal token', async () => {
    h.fake.queue('select:charging_stations', [{ ...station, ocppProtocol: 'ocpp1.6' }]);
    expect(await startAdHocPayment(input, access)).toMatchObject({
      code: 'OCPP_VERSION_MISMATCH',
    });
  });

  it('refuses during maintenance', async () => {
    h.fake.queue('select:charging_stations', [station]);
    h.maintenance.mockResolvedValue({ id: 'mnt_1' });
    expect(await startAdHocPayment(input, access)).toMatchObject({
      status: 409,
      code: 'MAINTENANCE_ACTIVE',
    });
    expect(h.maintenance).toHaveBeenCalledWith('sta_db');
  });

  it('refuses an unknown EVSE and a busy one', async () => {
    h.fake.queue('select:charging_stations', [station]);
    expect(await startAdHocPayment(input, access)).toMatchObject({
      status: 404,
      code: 'EVSE_NOT_FOUND',
    });
    queueStation();
    h.fake.queue('select:charging_sessions', [{ id: 'ses_1' }]);
    expect(await startAdHocPayment(input, access)).toMatchObject({
      status: 409,
      code: 'EVSE_IN_USE',
    });
    expect(h.fake.find('insert')).toHaveLength(0);
  });
});

describe('replay', () => {
  it('replays a stored payment for the same EVSE without a second start', async () => {
    queueStation();
    h.fake.queue('select:guest_sessions', [
      { id: 7, stationOcppId: 'CS-1', evseId: 1, sessionToken: 'psp_1' },
    ]);
    expect(await startAdHocPayment(input, access)).toEqual({
      ok: true,
      replayed: true,
      guestSessionId: 7,
      token: 'psp_1',
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('refuses the same reference for another EVSE', async () => {
    queueStation();
    h.fake.queue('select:guest_sessions', [
      { id: 7, stationOcppId: 'CS-1', evseId: 2, sessionToken: 'psp_1' },
    ]);
    expect(await startAdHocPayment(input, access)).toMatchObject({
      status: 409,
      code: 'TOKEN_DUPLICATE',
    });
  });

  it('replays when a concurrent request won the insert', async () => {
    queueStation();
    h.fake.fail('insert:guest_sessions', Object.assign(new Error('dup'), { code: '23505' }));
    h.fake.queue(
      (c) =>
        c.kind === 'select' && c.table === 'guest_sessions' && h.fake.find('insert').length > 0,
      [{ id: 8, stationOcppId: 'CS-1', evseId: 1, sessionToken: 'psp_1' }],
    );
    expect(await startAdHocPayment(input, access)).toMatchObject({
      ok: true,
      replayed: true,
      guestSessionId: 8,
    });
  });

  it('rethrows a unique violation with no stored payment, and any other error', async () => {
    queueStation();
    const dup = Object.assign(new Error('dup'), { code: '23505' });
    h.fake.fail('insert:guest_sessions', dup);
    await expect(startAdHocPayment(input, access)).rejects.toBe(dup);
    queueStation();
    const other = new Error('boom');
    h.fake.fail('insert:guest_sessions', other);
    await expect(startAdHocPayment(input, access)).rejects.toBe(other);
  });

  it('throws when the insert returns no row', async () => {
    queueStation();
    await expect(startAdHocPayment(input, access)).rejects.toThrow(
      'Guest session insert returned no row',
    );
  });
});

describe('start', () => {
  it('stores the payment and sends a DirectPayment start with the card details', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-12T10:00:00Z') });
    try {
      queueStation();
      h.fake.queue('insert:guest_sessions', [{ id: 9 }]);
      const out = await startAdHocPayment(input, access);
      expect(out).toEqual({ ok: true, replayed: false, guestSessionId: 9, token: 'psp_1' });
      expect(h.fake.find('insert', 'guest_sessions')[0]!.values).toEqual({
        stationOcppId: 'CS-1',
        evseId: 1,
        guestEmail: 'd@example.com',
        status: 'payment_authorized',
        paymentTerminal: true,
        sessionToken: 'psp_1',
        expiresAt: new Date('2026-11-12T10:15:00Z'),
        maxCostCents: 5000,
        maxEnergyWh: null,
        maxTimeSeconds: null,
      });
    } finally {
      vi.useRealTimers();
    }
    const [stationId, action, payload] = h.send.mock.calls[0]! as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(stationId).toBe('CS-1');
    expect(action).toBe('RequestStartTransaction');
    expect(payload['evseId']).toBe(1);
    expect(payload['remoteStartId']).toEqual(expect.any(Number));
    expect(payload['idToken']).toEqual({
      idToken: 'psp_1',
      type: 'DirectPayment',
      additionalInfo: [
        { additionalIdToken: '4242', type: 'CardLast4Digits' },
        { additionalIdToken: '424242', type: 'CardBin' },
      ],
    });
    expect(h.audits[0]).toMatchObject({
      entityId: 'sta_db',
      action: 'command_dispatched',
      actor: 'operator',
      notes: 'RequestStartTransaction for ad hoc payment (Accepted)',
      after: {
        action: 'RequestStartTransaction',
        evseId: 1,
        pspRef: 'psp_1',
        maxCostCents: 5000,
        outcome: 'Accepted',
      },
    });
    expect(JSON.stringify(h.audits[0])).not.toContain('4242');
    expect(h.fake.find('delete')).toHaveLength(0);
  });

  it('starts station-wide on a 1.6 station with a Central CSMS token', async () => {
    h.fake.queue('select:charging_stations', [{ ...station, ocppProtocol: 'ocpp1.6' }]);
    h.fake.queue('insert:guest_sessions', [{ id: 10 }]);
    const out = await startAdHocPayment(
      { stationId: 'CS-1', evseId: 0, pspRef: 'ref_t' },
      { ...access, terminalToken: true },
    );
    expect(out).toMatchObject({ ok: true, replayed: false, guestSessionId: 10 });
    const token = (out as { token: string }).token;
    expect(token).toMatch(/^[0-9a-f]{20}$/);
    expect(h.fake.find('select', 'evses')).toHaveLength(0);
    expect(h.fake.find('select', 'charging_sessions')).toHaveLength(0);
    const payload = h.send.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('evseId');
    expect(payload['idToken']).toEqual({ idToken: token, type: 'Central' });
    expect(h.fake.find('insert', 'guest_sessions')[0]!.values).toMatchObject({
      guestEmail: '',
      maxCostCents: null,
    });
    expect(h.audits[0]!['after']).toMatchObject({ evseId: null, maxCostCents: null });
  });

  it('sends a DirectPayment token without additionalInfo when no card details came', async () => {
    queueStation();
    h.fake.queue('insert:guest_sessions', [{ id: 11 }]);
    await startAdHocPayment(
      { stationId: 'CS-1', evseId: 1, pspRef: 'psp_2', maxEnergyWh: 1000, maxTimeSeconds: 60 },
      access,
    );
    expect((h.send.mock.calls[0]![2] as Record<string, unknown>)['idToken']).toEqual({
      idToken: 'psp_2',
      type: 'DirectPayment',
    });
    expect(h.fake.find('insert', 'guest_sessions')[0]!.values).toMatchObject({
      maxEnergyWh: 1000,
      maxTimeSeconds: 60,
    });
  });

  it('drops an unlinked payment and answers 504 when the station does not respond', async () => {
    queueStation();
    h.fake.queue('insert:guest_sessions', [{ id: 12 }]);
    h.send.mockResolvedValue({ error: 'timeout' });
    expect(await startAdHocPayment(input, access)).toMatchObject({
      ok: false,
      status: 504,
      code: 'STATION_TIMEOUT',
    });
    const [del] = h.fake.find('delete', 'guest_sessions');
    expect(await sqlParams(opArgs(del, 'where')?.[0])).toContain(12);
    expect(h.audits[0]).toMatchObject({
      notes: 'RequestStartTransaction for ad hoc payment (Timeout)',
      after: expect.objectContaining({ outcome: 'Timeout' }),
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'CS-1', error: 'timeout' }),
      'Ad hoc payment start failed',
    );
  });

  it('answers 502 when the station rejects or answers without a status', async () => {
    queueStation();
    h.fake.queue('insert:guest_sessions', [{ id: 13 }]);
    h.send.mockResolvedValue({ response: { status: 'Rejected' } });
    expect(await startAdHocPayment(input, access)).toMatchObject({
      status: 502,
      code: 'STATION_REJECTED',
      error: 'Station rejected start: Rejected',
    });
    queueStation();
    h.fake.queue('insert:guest_sessions', [{ id: 14 }]);
    h.send.mockResolvedValue({});
    expect(await startAdHocPayment(input, access)).toMatchObject({
      error: 'Station rejected start: Unknown',
    });
    expect(h.audits[1]!['notes']).toBe('RequestStartTransaction for ad hoc payment (Unknown)');
    expect(h.fake.find('delete', 'guest_sessions')).toHaveLength(2);
  });
});
