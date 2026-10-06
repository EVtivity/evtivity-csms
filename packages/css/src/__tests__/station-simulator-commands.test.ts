// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeHarness, priv, silenceConsole, stubSql, type Harness } from './sim-harness.js';

function activeTxSql(transactionId: string): ReturnType<typeof stubSql> {
  return stubSql((q) =>
    q.includes('transaction_id') && q.includes("status = 'active'")
      ? [{ transaction_id: transactionId, meter_start_wh: 0, id_token: 'TAG' }]
      : undefined,
  );
}

function profiles(h: Harness): Map<number, Record<string, unknown>> {
  return priv(h, 'chargingProfilesCache') as Map<number, Record<string, unknown>>;
}

function powerLimit(h: Harness, evseId: number): number | null | undefined {
  return (priv(h, 'evsePowerLimits') as Map<number, number | null>).get(evseId);
}

function txDefaultProfile(id: number, limit: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    stackLevel: 0,
    chargingProfilePurpose: 'TxDefaultProfile',
    chargingProfileKind: 'Absolute',
    chargingSchedule: [
      {
        id: 1,
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [{ startPeriod: 0, limit }],
      },
    ],
    ...extra,
  };
}

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('SetChargingProfile (K01)', () => {
  it('2.1: stores the profile and applies its first period as the EVSE power limit', async () => {
    const h = await makeHarness();
    const res = await h.invoke('SetChargingProfile', {
      evseId: 1,
      chargingProfile: txDefaultProfile(10, 7400),
    });
    expect(res).toEqual({ status: 'Accepted' });
    expect(powerLimit(h, 1)).toBe(7400);
    expect(profiles(h).get(10)).toMatchObject({ _evseId: 1, _chargingLimitSource: 'CSO' });
  });

  it('2.1: stamps external constraints as EMS', async () => {
    const h = await makeHarness();
    await h.invoke('SetChargingProfile', {
      evseId: 0,
      chargingProfile: txDefaultProfile(11, 5000, {
        chargingProfilePurpose: 'ChargingStationExternalConstraints',
      }),
    });
    expect(profiles(h).get(11)?.['_chargingLimitSource']).toBe('EMS');
  });

  it.each([
    [{ evseId: 5, chargingProfile: txDefaultProfile(1, 1) }, 'UnknownEVSE'],
    [
      {
        evseId: 1,
        chargingProfile: txDefaultProfile(1, 1, { chargingProfilePurpose: 'PriorityCharging' }),
      },
      'UnsupportedPurpose',
    ],
    [
      {
        evseId: 1,
        chargingProfile: txDefaultProfile(1, 1, {
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'X',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 1 }],
            },
          ],
        }),
      },
      'UnsupportedRateUnit',
    ],
    [
      {
        evseId: 1,
        chargingProfile: txDefaultProfile(1, 1, {
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              randomizedDelay: 10,
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 1 }],
            },
          ],
        }),
      },
      'InvalidSchedule',
    ],
  ])('2.1: rejects %# with %s', async (payload, reasonCode) => {
    const h = await makeHarness();
    h.sim.setConfigValue('SmartChargingCtrlr.SupportsFeature#RandomizedDelay', 'false');
    const res = await h.invoke('SetChargingProfile', payload);
    expect(res).toEqual({ status: 'Rejected', statusInfo: { reasonCode } });
    expect(profiles(h).size).toBe(0);
  });

  it('2.1: a TxProfile needs an active transaction with the same id', async () => {
    const none = await makeHarness();
    const txProfile = txDefaultProfile(3, 1000, {
      chargingProfilePurpose: 'TxProfile',
      transactionId: 'tx-1',
    });
    expect(
      await none.invoke('SetChargingProfile', { evseId: 1, chargingProfile: txProfile }),
    ).toEqual({ status: 'Rejected' });
    const other = await makeHarness({ sql: activeTxSql('tx-2') });
    expect(
      await other.invoke('SetChargingProfile', { evseId: 1, chargingProfile: txProfile }),
    ).toEqual({ status: 'Rejected' });
    const same = await makeHarness({ sql: activeTxSql('tx-1') });
    expect(
      await same.invoke('SetChargingProfile', { evseId: 1, chargingProfile: txProfile }),
    ).toEqual({ status: 'Accepted' });
    expect(
      await same.invoke('SetChargingProfile', { evseId: 0, chargingProfile: txProfile }),
    ).toEqual({ status: 'Rejected' });
  });

  it('1.6: TxProfile transactionId must match the running transaction', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6', sql: activeTxSql('77') });
    const profile = {
      chargingProfileId: 4,
      stackLevel: 0,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: [
        { chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }] },
      ],
    };
    expect(
      await h.invoke('SetChargingProfile', {
        connectorId: 1,
        csChargingProfiles: { ...profile, transactionId: 78 },
      }),
    ).toEqual({ status: 'Rejected' });
    expect(
      await h.invoke('SetChargingProfile', {
        connectorId: 1,
        csChargingProfiles: { ...profile, transactionId: 77 },
      }),
    ).toEqual({ status: 'Accepted' });
    expect(powerLimit(h, 1)).toBe(16);
    expect(profiles(h).get(4)).toMatchObject({ _evseId: 1 });
  });
});

describe('ClearChargingProfile (K10)', () => {
  it('2.1: clears by id, by criteria, or all, and answers Unknown when nothing matched', async () => {
    const h = await makeHarness();
    await h.invoke('SetChargingProfile', { evseId: 1, chargingProfile: txDefaultProfile(1, 1000) });
    await h.invoke('SetChargingProfile', {
      evseId: 1,
      chargingProfile: txDefaultProfile(2, 2000, { stackLevel: 1 }),
    });
    await h.invoke('SetChargingProfile', {
      evseId: 0,
      chargingProfile: txDefaultProfile(3, 3000, {
        chargingProfilePurpose: 'ChargingStationMaxProfile',
      }),
    });
    expect(await h.invoke('ClearChargingProfile', { chargingProfileId: 99 })).toEqual({
      status: 'Unknown',
    });
    expect(await h.invoke('ClearChargingProfile', { chargingProfileId: 1 })).toEqual({
      status: 'Accepted',
    });
    expect(Array.from(profiles(h).keys())).toEqual([2, 3]);
    expect(powerLimit(h, 1)).toBeNull();
    expect(
      await h.invoke('ClearChargingProfile', {
        chargingProfileCriteria: { chargingProfilePurpose: 'TxDefaultProfile', stackLevel: 1 },
      }),
    ).toEqual({ status: 'Accepted' });
    expect(Array.from(profiles(h).keys())).toEqual([3]);
    expect(await h.invoke('ClearChargingProfile', {})).toEqual({ status: 'Accepted' });
    expect(profiles(h).size).toBe(0);
    expect(await h.invoke('ClearChargingProfile', {})).toEqual({ status: 'Unknown' });
  });

  it('1.6: clears every profile and limit', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    await h.invoke('SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 8,
        stackLevel: 0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: [
          { chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: 10 }] },
        ],
      },
    });
    expect(await h.invoke('ClearChargingProfile', { id: 8 })).toEqual({ status: 'Accepted' });
    expect(profiles(h).size).toBe(0);
    expect(powerLimit(h, 1)).toBeNull();
  });
});

describe('GetChargingProfiles (K09)', () => {
  it('answers NoProfiles when nothing matches', async () => {
    const h = await makeHarness();
    expect(await h.invoke('GetChargingProfiles', { requestId: 1, chargingProfile: {} })).toEqual({
      status: 'NoProfiles',
    });
  });

  it('reports one ReportChargingProfiles per EVSE and source, without internal stamps', async () => {
    const h = await makeHarness();
    await h.invoke('SetChargingProfile', { evseId: 1, chargingProfile: txDefaultProfile(1, 1000) });
    await h.invoke('SetChargingProfile', {
      evseId: 0,
      chargingProfile: txDefaultProfile(2, 2000, {
        chargingProfilePurpose: 'ChargingStationExternalConstraints',
      }),
    });
    const res = await h.invoke('GetChargingProfiles', { requestId: 5, chargingProfile: {} });
    expect(res).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(200);
    const reports = h.sent('ReportChargingProfiles');
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r['tbc'])).toEqual([true, false]);
    const byEvse = new Map(reports.map((r) => [r['evseId'], r]));
    expect(byEvse.get(1)).toMatchObject({ requestId: 5, chargingLimitSource: 'CSO' });
    expect(byEvse.get(0)).toMatchObject({ chargingLimitSource: 'EMS' });
    const reported = (byEvse.get(1)?.['chargingProfile'] as Array<Record<string, unknown>>)[0];
    expect(reported).toEqual(txDefaultProfile(1, 1000));
  });

  it('filters by evseId, profile id, purpose, stack level and source', async () => {
    const h = await makeHarness();
    await h.invoke('SetChargingProfile', { evseId: 1, chargingProfile: txDefaultProfile(1, 1000) });
    await h.invoke('SetChargingProfile', {
      evseId: 1,
      chargingProfile: txDefaultProfile(2, 2000, { stackLevel: 2 }),
    });
    const ask = async (payload: Record<string, unknown>): Promise<number[]> => {
      h.sendCall.mockClear();
      const res = await h.invoke('GetChargingProfiles', { requestId: 1, ...payload });
      if (res['status'] !== 'Accepted') return [];
      await vi.advanceTimersByTimeAsync(200);
      return h
        .sent('ReportChargingProfiles')
        .flatMap((r) => (r['chargingProfile'] as Array<{ id: number }>).map((p) => p.id));
    };
    expect(await ask({ evseId: 1, chargingProfile: {} })).toEqual([1, 2]);
    expect(await ask({ evseId: 0, chargingProfile: {} })).toEqual([]);
    expect(await ask({ chargingProfile: { chargingProfileId: [2] } })).toEqual([2]);
    expect(await ask({ chargingProfile: { chargingProfileId: 1 } })).toEqual([1]);
    expect(await ask({ chargingProfile: { stackLevel: 2 } })).toEqual([2]);
    expect(await ask({ chargingProfile: { chargingProfilePurpose: 'TxProfile' } })).toEqual([]);
    expect(await ask({ chargingProfile: { chargingLimitSource: ['EMS'] } })).toEqual([]);
    expect(await ask({ chargingProfile: { chargingLimitSource: 'CSO' } })).toEqual([1, 2]);
  });
});

describe('GetCompositeSchedule (K08)', () => {
  it('2.1: returns the hardware limit without profiles, in W and A', async () => {
    const h = await makeHarness();
    const w = await h.invoke('GetCompositeSchedule', {
      evseId: 1,
      duration: 3600,
      chargingRateUnit: 'W',
    });
    expect(w['status']).toBe('Accepted');
    const sched = w['schedule'] as Record<string, unknown>;
    expect(sched).toMatchObject({ evseId: 1, duration: 3600, chargingRateUnit: 'W' });
    const periods = sched['chargingSchedulePeriod'] as Array<Record<string, unknown>>;
    expect(periods[0]).toMatchObject({ startPeriod: 0, limit: 22000 });
    const a = await h.invoke('GetCompositeSchedule', {
      evseId: 1,
      duration: 60,
      chargingRateUnit: 'A',
    });
    const aPeriods = (a['schedule'] as Record<string, unknown>)['chargingSchedulePeriod'] as Array<
      Record<string, unknown>
    >;
    expect(aPeriods[0]?.['limit']).toBe(32);
  });

  it('2.1: applies a stored profile limit', async () => {
    const h = await makeHarness();
    await h.invoke('SetChargingProfile', {
      evseId: 1,
      chargingProfile: txDefaultProfile(1, 7000, {
        chargingProfileKind: 'Relative',
      }),
    });
    const res = await h.invoke('GetCompositeSchedule', {
      evseId: 1,
      duration: 600,
      chargingRateUnit: 'W',
    });
    const periods = (res['schedule'] as Record<string, unknown>)['chargingSchedulePeriod'] as Array<
      Record<string, unknown>
    >;
    expect(periods[0]?.['limit']).toBe(7000);
  });

  it('2.1: rejects an unsupported rate unit and an unknown EVSE', async () => {
    const h = await makeHarness();
    h.sim.setConfigValue('SmartChargingCtrlr.RateUnit', 'W');
    expect(
      await h.invoke('GetCompositeSchedule', { evseId: 1, duration: 60, chargingRateUnit: 'A' }),
    ).toEqual({ status: 'Rejected', statusInfo: { reasonCode: 'UnsupportedRateUnit' } });
    expect(
      await h.invoke('GetCompositeSchedule', { evseId: 4, duration: 60, chargingRateUnit: 'W' }),
    ).toEqual({ status: 'Rejected', statusInfo: { reasonCode: 'UnknownEVSE' } });
  });

  it('1.6: answers with the 1.6 shape', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const res = await h.invoke('GetCompositeSchedule', { connectorId: 1, duration: 300 });
    expect(res).toMatchObject({
      status: 'Accepted',
      connectorId: 1,
      chargingSchedule: { chargingRateUnit: 'A', duration: 300 },
    });
  });
});

describe('tariffs (I07-I12)', () => {
  const energyTariff = (tariffId: string, extra: Record<string, unknown> = {}) => ({
    tariffId,
    currency: 'EUR',
    energy: { prices: [{ priceKwh: 0.3 }], taxRates: [] },
    ...extra,
  });

  it('SetDefaultTariff validates, stores and replaces, GetTariffs reports, ClearTariffs removes', async () => {
    const h = await makeHarness({
      config: {
        evses: [
          {
            evseId: 1,
            connectorId: 1,
            connectorType: 'ac_type2',
            maxPowerW: 22000,
            phases: 3,
            voltage: 230,
          },
          {
            evseId: 2,
            connectorId: 1,
            connectorType: 'ac_type2',
            maxPowerW: 22000,
            phases: 3,
            voltage: 230,
          },
        ],
      },
    });
    expect(await h.invoke('GetTariffs', { evseId: 0 })).toEqual({ status: 'NoTariff' });
    expect(await h.invoke('SetDefaultTariff', { evseId: 9, tariff: energyTariff('T0') })).toEqual({
      status: 'Rejected',
      statusInfo: { reasonCode: 'UnknownEVSE' },
    });
    expect(
      await h.invoke('SetDefaultTariff', { evseId: 0, tariff: { tariffId: 'X', currency: 'EUR' } }),
    ).toEqual({ status: 'Rejected', statusInfo: { reasonCode: 'InvalidValue' } });
    expect(
      await h.invoke('SetDefaultTariff', {
        evseId: 0,
        tariff: energyTariff('C', {
          energy: { prices: [{ priceKwh: 0.3, conditions: { minEnergy: 1 } }] },
        }),
      }),
    ).toEqual({ status: 'ConditionNotSupported' });
    h.sim.setConfigValue('TariffCostCtrlr.MaxElements#Tariff', '1');
    expect(
      await h.invoke('SetDefaultTariff', {
        evseId: 0,
        tariff: energyTariff('M', { energy: { prices: [{ priceKwh: 1 }, { priceKwh: 2 }] } }),
      }),
    ).toEqual({ status: 'TooManyElements' });

    expect(await h.invoke('SetDefaultTariff', { evseId: 0, tariff: energyTariff('S') })).toEqual({
      status: 'Accepted',
    });
    expect(await h.invoke('SetDefaultTariff', { evseId: 0, tariff: energyTariff('S') })).toEqual({
      status: 'DuplicateTariffId',
    });
    expect(await h.invoke('SetDefaultTariff', { evseId: 2, tariff: energyTariff('E2') })).toEqual({
      status: 'Accepted',
    });
    const all = await h.invoke('GetTariffs', { evseId: 0 });
    expect(all).toEqual({
      status: 'Accepted',
      tariffAssignments: [
        { tariffId: 'E2', tariffKind: 'DefaultTariff', evseIds: [2] },
        { tariffId: 'S', tariffKind: 'DefaultTariff', evseIds: [1] },
      ],
    });
    const evse2 = await h.invoke('GetTariffs', { evseId: 2 });
    expect(evse2['tariffAssignments']).toEqual([
      { tariffId: 'E2', tariffKind: 'DefaultTariff', evseIds: [2] },
    ]);
    // A new station-wide tariff with the same validFrom replaces S.
    await h.invoke('SetDefaultTariff', { evseId: 0, tariff: energyTariff('S2') });
    const ids = (
      (await h.invoke('GetTariffs', { evseId: 0 }))['tariffAssignments'] as Array<{
        tariffId: string;
      }>
    ).map((a) => a.tariffId);
    expect(ids).toEqual(['S2', 'E2']);

    expect(await h.invoke('ClearTariffs', { tariffIds: ['E2', 'nope'] })).toEqual({
      clearTariffsResult: [
        { tariffId: 'E2', status: 'Accepted' },
        { tariffId: 'nope', status: 'Unknown' },
      ],
    });
    expect(await h.invoke('ClearTariffs', {})).toEqual({
      clearTariffsResult: [{ tariffId: 'S2', status: 'Accepted' }],
    });
    expect(await h.invoke('GetTariffs', {})).toEqual({ status: 'NoTariff' });
  });

  it('1.6 rejects the 2.1 tariff messages', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    expect(await h.invoke('SetDefaultTariff', { evseId: 0, tariff: energyTariff('A') })).toEqual({
      status: 'Rejected',
    });
    expect(await h.invoke('GetTariffs', {})).toEqual({ status: 'Rejected' });
    expect(await h.invoke('ClearTariffs', {})).toEqual({
      clearTariffsResult: [{ status: 'Rejected' }],
    });
    expect(await h.invoke('ChangeTransactionTariff', {})).toEqual({ status: 'Rejected' });
  });

  it('ChangeTransactionTariff validates and sends a TariffChanged TransactionEvent', async () => {
    const h = await makeHarness();
    const tariff = energyTariff('T-NEW');
    expect(await h.invoke('ChangeTransactionTariff', { transactionId: 'tx-x', tariff })).toEqual({
      status: 'TxNotFound',
    });
    h.sim.setConfigValue('_seedTestTransaction', 'true');
    expect(
      await h.invoke('ChangeTransactionTariff', {
        transactionId: 'test-tx',
        tariff: { ...tariff, currency: 'USD' },
      }),
    ).toEqual({ status: 'NoCurrencyChange' });
    expect(
      await h.invoke('ChangeTransactionTariff', {
        transactionId: 'test-tx',
        tariff: energyTariff('T', {
          energy: { prices: [{ priceKwh: 1, conditions: { minPower: 3 } }] },
        }),
      }),
    ).toEqual({ status: 'ConditionNotSupported' });
    h.sim.setConfigValue('TariffCostCtrlr.MaxElements#Tariff', '1');
    expect(
      await h.invoke('ChangeTransactionTariff', {
        transactionId: 'test-tx',
        tariff: energyTariff('T', { fixedFee: { prices: [{ priceFixed: 1 }] } }),
      }),
    ).toEqual({ status: 'TooManyElements' });
    h.sim.setConfigValue('TariffCostCtrlr.MaxElements#Tariff', '10');
    expect(await h.invoke('ChangeTransactionTariff', { transactionId: 'test-tx', tariff })).toEqual(
      {
        status: 'Accepted',
      },
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(h.sent('TransactionEvent').at(-1)).toMatchObject({
      eventType: 'Updated',
      triggerReason: 'TariffChanged',
      transactionInfo: { transactionId: 'test-tx', tariffId: 'T-NEW' },
    });
  });

  it('ChangeTransactionTariff is a CALLERROR when local cost is not supported', async () => {
    const h = await makeHarness();
    h.sim.setConfigValue('TariffCostCtrlr.LocalCostSupported', 'false');
    await expect(
      h.invoke('ChangeTransactionTariff', { transactionId: 'x', tariff: energyTariff('T') }),
    ).rejects.toThrow('NotSupported');
  });
});

describe('display messages (O01-O06)', () => {
  const msg = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    priority: 'NormalCycle',
    message: { format: 'UTF8', content: `Message ${String(id)}`, language: 'en' },
    ...extra,
  });

  it('validates priority, state, format and language', async () => {
    const h = await makeHarness();
    h.sim.setConfigValue('DisplayMessageCtrlr.SupportedPriorities', 'NormalCycle');
    h.sim.setConfigValue('DisplayMessageCtrlr.SupportedStates', 'Idle');
    h.sim.setConfigValue('DisplayMessageCtrlr.SupportedFormats', 'UTF8');
    expect(
      await h.invoke('SetDisplayMessage', { message: msg(1, { priority: 'InFront' }) }),
    ).toEqual({
      status: 'NotSupportedPriority',
    });
    expect(await h.invoke('SetDisplayMessage', { message: msg(1, { state: 'Charging' }) })).toEqual(
      {
        status: 'NotSupportedState',
      },
    );
    expect(
      await h.invoke('SetDisplayMessage', {
        message: msg(1, { message: { format: 'HTML', content: '<b>x</b>' } }),
      }),
    ).toEqual({ status: 'NotSupportedMessageFormat' });
    expect(
      await h.invoke('SetDisplayMessage', {
        message: msg(1, { message: { format: 'UTF8', content: 'x', language: 'tlh' } }),
      }),
    ).toEqual({ status: 'LanguageNotSupported' });
    expect(
      await h.invoke('SetDisplayMessage', { message: msg(1, { transactionId: 'tx-1' }) }),
    ).toEqual({ status: 'UnknownTransaction' });
  });

  it('stores, filters, reports and clears messages; a new AlwaysFront replaces the old one', async () => {
    const h = await makeHarness();
    await h.invoke('SetDisplayMessage', { message: msg(1) });
    await h.invoke('SetDisplayMessage', { message: msg(2, { priority: 'AlwaysFront' }) });
    await h.invoke('SetDisplayMessage', {
      message: msg(3, { priority: 'AlwaysFront', state: 'Idle' }),
    });
    const cache = priv(h, 'displayMessagesCache') as Map<number, unknown>;
    expect(Array.from(cache.keys())).toEqual([1, 3]);

    expect(await h.invoke('GetDisplayMessages', { requestId: 4, priority: 'InFront' })).toEqual({
      status: 'Unknown',
    });
    expect(
      await h.invoke('GetDisplayMessages', { requestId: 5, id: [1], state: undefined }),
    ).toEqual({
      status: 'Accepted',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent('NotifyDisplayMessages').at(-1)).toEqual({
      requestId: 5,
      messageInfo: [msg(1)],
      tbc: false,
    });
    await h.invoke('GetDisplayMessages', { requestId: 6, state: 'Idle' });
    expect(
      (h.sent('NotifyDisplayMessages').at(-1)?.['messageInfo'] as Array<{ id: number }>).map(
        (m) => m.id,
      ),
    ).toEqual([3]);

    expect(await h.invoke('ClearDisplayMessage', { id: 3 })).toEqual({ status: 'Accepted' });
    expect(await h.invoke('ClearDisplayMessage', { id: 3 })).toEqual({ status: 'Unknown' });
  });

  it('displayedMessage picks the highest priority message that applies, in the driver language', async () => {
    const h = await makeHarness();
    expect(h.sim.displayedMessage(1)).toBeNull();
    await h.invoke('SetDisplayMessage', { message: msg(1) });
    await h.invoke('SetDisplayMessage', {
      message: msg(2, {
        priority: 'InFront',
        message: { format: 'UTF8', content: 'Hello', language: 'en' },
        messageExtra: [{ format: 'UTF8', content: 'Hallo', language: 'de' }],
      }),
    });
    await h.invoke('SetDisplayMessage', {
      message: msg(3, { priority: 'AlwaysFront', state: 'Faulted' }),
    });
    await h.invoke('SetDisplayMessage', {
      message: msg(4, {
        priority: 'InFront',
        startDateTime: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    expect(h.sim.displayedMessage(1)).toEqual({ id: 2, content: 'Hello', language: 'en' });
    (priv(h, 'evseDriverLanguage') as Map<number, string>).set(1, 'de');
    expect(h.sim.displayedMessage(1)).toEqual({ id: 2, content: 'Hallo', language: 'de' });
    (priv(h, 'evseConnectorStatus') as Map<number, string>).set(1, 'Faulted');
    expect(h.sim.displayedMessage(1)?.id).toBe(3);
    const h16 = await makeHarness({ protocol: 'ocpp1.6' });
    expect(h16.sim.displayedMessage(1)).toBeNull();
  });
});

describe('CustomerInformation (N09/N10)', () => {
  it('requires an identifier', async () => {
    const h = await makeHarness();
    expect(
      await h.invoke('CustomerInformation', { requestId: 1, report: true, clear: false }),
    ).toEqual({
      status: 'Invalid',
    });
  });

  it('reports the stored data and clears it on request', async () => {
    const h = await makeHarness({ boot: true });
    const res = await h.invoke('CustomerInformation', {
      requestId: 3,
      report: true,
      clear: true,
      idToken: { idToken: 'TEST_TOKEN', type: 'ISO14443' },
    });
    expect(res).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.sent('NotifyCustomerInformation').at(-1)).toMatchObject({
      requestId: 3,
      data: 'Customer: Test User, Email: test@example.com',
      tbc: false,
    });
    expect((priv(h, 'customerDataStore') as Map<string, string>).has('TEST_TOKEN')).toBe(false);

    await h.invoke('CustomerInformation', {
      requestId: 4,
      report: true,
      clear: false,
      customerIdentifier: 'CUST-001',
    });
    await h.invoke('CustomerInformation', {
      requestId: 5,
      report: true,
      clear: false,
      customerCertificate: { serialNumber: 'abc' },
    });
    await vi.advanceTimersByTimeAsync(200);
    const notes = h.sent('NotifyCustomerInformation');
    expect(notes.find((n) => n['requestId'] === 4)?.['data']).toBe(
      'Customer: CUST-001, Account: Active',
    );
    expect(notes.find((n) => n['requestId'] === 5)?.['data']).toBe('');
  });
});

describe('GetTransactionStatus (E14)', () => {
  it('reports ongoing and queued messages', async () => {
    const h = await makeHarness({ connected: false });
    (priv(h, 'activeTransactionIds') as Map<number, string>).set(1, 'tx-5');
    expect(await h.invoke('GetTransactionStatus', { transactionId: 'tx-5' })).toEqual({
      messagesInQueue: false,
      ongoingIndicator: true,
    });
    expect(await h.invoke('GetTransactionStatus', { transactionId: 'tx-6' })).toEqual({
      messagesInQueue: false,
      ongoingIndicator: false,
    });
    await h.sim.sendTransactionEvent(1, 'Updated', {
      triggerReason: 'MeterValuePeriodic',
      transactionId: 'tx-5',
    });
    expect(await h.invoke('GetTransactionStatus', { transactionId: 'tx-5' })).toMatchObject({
      messagesInQueue: true,
    });
    expect(await h.invoke('GetTransactionStatus', {})).toEqual({ messagesInQueue: true });
  });
});

describe('simple CSMS requests', () => {
  it.each([
    ['PublishFirmware', { status: 'Accepted' }],
    ['UnpublishFirmware', { status: 'Unpublished' }],
    ['DataTransfer', { status: 'UnknownVendorId' }],
    ['UsePriorityCharging', { status: 'Accepted' }],
    ['UpdateDynamicSchedule', { status: 'Accepted' }],
    ['AFRRSignal', { status: 'Accepted' }],
    ['ClosePeriodicEventStream', {}],
    ['OpenPeriodicEventStream', { status: 'Accepted' }],
    ['ClearDERControl', { status: 'Accepted' }],
    ['GetDERControl', { status: 'Accepted' }],
    ['SetDERControl', { status: 'Accepted' }],
    ['RequestBatterySwap', { status: 'Accepted' }],
    ['NotifyWebPaymentStarted', {}],
  ])('%s answers %j', async (action, expected) => {
    const h = await makeHarness();
    expect(await h.invoke(action, { evseId: 1, timeout: 60 })).toEqual(expected);
  });

  it('VatNumberValidation echoes the VAT number with a company', async () => {
    const h = await makeHarness();
    const res = await h.invoke('VatNumberValidation', { vatNumber: 'NL123', evseId: 2 });
    expect(res).toMatchObject({ status: 'Accepted', vatNumber: 'NL123', evseId: 2 });
    expect(res['company']).toMatchObject({ country: 'Netherlands' });
  });

  it('ClearCache is rejected when the auth cache is disabled', async () => {
    const h = await makeHarness();
    h.sim.setConfigValue('AuthCacheCtrlr.Enabled', 'false');
    expect(await h.invoke('ClearCache', {})).toEqual({ status: 'Rejected' });
    h.sim.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    h.sim.addToAuthCache('TAG-1', 'Accepted');
    expect((priv(h, 'authCache') as Map<string, unknown>).size).toBe(1);
    expect(await h.invoke('ClearCache', {})).toEqual({ status: 'Accepted' });
    expect((priv(h, 'authCache') as Map<string, unknown>).size).toBe(0);
  });

  it('GetBaseReport sends a NotifyReport on 2.1 only', async () => {
    const h = await makeHarness();
    expect(await h.invoke('GetBaseReport', { requestId: 9, reportBase: 'FullInventory' })).toEqual({
      status: 'Accepted',
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.sent('NotifyReport')[0]?.['requestId']).toBe(9);
    const h16 = await makeHarness({ protocol: 'ocpp1.6' });
    await h16.invoke('GetBaseReport', { requestId: 9 });
    await vi.advanceTimersByTimeAsync(200);
    expect(h16.sent('NotifyReport')).toHaveLength(0);
  });

  it('GetReport validates criteria and answers EmptyResultSet without matches', async () => {
    const h = await makeHarness();
    expect(await h.invoke('GetReport', { requestId: 1, componentCriteria: ['Bogus'] })).toEqual({
      status: 'NotSupported',
    });
    expect(
      await h.invoke('GetReport', {
        requestId: 1,
        componentVariable: [{ component: { name: 'NoSuch' }, variable: { name: 'X' } }],
      }),
    ).toEqual({ status: 'EmptyResultSet' });
    expect(
      await h.invoke('GetReport', {
        requestId: 2,
        componentVariable: [
          { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } },
        ],
      }),
    ).toEqual({ status: 'Accepted' });
    await vi.advanceTimersByTimeAsync(200);
    const report = h.sent('NotifyReport').at(-1);
    expect(report?.['requestId']).toBe(2);
    expect(report?.['reportData']).toEqual([
      {
        component: { name: 'OCPPCommCtrlr' },
        variable: { name: 'HeartbeatInterval' },
        variableAttribute: [{ type: 'Actual', mutability: 'ReadWrite', value: '300' }],
        variableCharacteristics: { dataType: 'string', supportsMonitoring: false },
      },
    ]);
  });

  it('GetLog starts an upload and a second request cancels the first', async () => {
    const h = await makeHarness();
    const first = await h.invoke('GetLog', {
      requestId: 1,
      logType: 'DiagnosticsLog',
      log: { remoteLocation: 'ftp://x' },
    });
    expect(first['status']).toBe('Accepted');
    expect(String(first['filename'])).toMatch(/^diagnostics-TEST-SIM-\d+\.log$/);
    const second = await h.invoke('GetLog', {
      requestId: 2,
      logType: 'SecurityLog',
      log: { remoteLocation: 'ftp://x' },
    });
    expect(second['status']).toBe('AcceptedCanceled');
    expect(String(second['filename'])).toMatch(/^security-/);
    await vi.advanceTimersByTimeAsync(10_000);
    const statuses = h.sent('LogStatusNotification');
    expect(statuses.some((s) => s['requestId'] === 2 && s['status'] === 'Uploaded')).toBe(true);
  });

  it('rejects an unknown action with NotImplemented, which the client sends as a CALLERROR', async () => {
    const h = await makeHarness();
    await expect(h.invoke('NoSuchAction', {})).rejects.toThrow('NotImplemented');
  });
});

describe('boot state guards', () => {
  it('a Rejected 2.1 station answers CSMS calls with SecurityError, except a BootNotification trigger', async () => {
    const h = await makeHarness();
    h.p['bootStatus'] = 'Rejected';
    await expect(h.invoke('GetVariables', { getVariableData: [] })).rejects.toThrow(
      'SecurityError',
    );
    const trig = await h.invoke('TriggerMessage', { requestedMessage: 'BootNotification' });
    expect(trig).toEqual({ status: 'Accepted' });
  });

  it('a Rejected 1.6 station rejects every call', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    h.p['bootStatus'] = 'Rejected';
    expect(await h.invoke('Reset', { type: 'Soft' })).toEqual({ status: 'Rejected' });
  });

  it('a Pending station rejects remote starts', async () => {
    const h = await makeHarness();
    h.p['bootStatus'] = 'Pending';
    expect(
      await h.invoke('RequestStartTransaction', {
        idToken: { idToken: 'A', type: 'ISO14443' },
        remoteStartId: 1,
      }),
    ).toEqual({ status: 'Rejected', statusInfo: { reasonCode: 'BootPending' } });
  });
});
