// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { verifyTotpV1 } from '@evtivity/lib';
import { StationSimulator } from '../station-simulator.js';
import type { PersistedCache } from '../lib/persisted-cache.js';
import { makeConfig } from './sim-test-helpers.js';

function noopSql(): postgres.Sql {
  const fn = ((..._args: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn;
}

interface Internals {
  handleCsmsCommand(
    id: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  seedDefaultConfigVariables(): void;
  authCache: PersistedCache<string, Record<string, unknown>>;
  activeTransactionIds: Map<number, string>;
  evseTransactionLimits: Map<number, { maxCost?: number }>;
  defaultTariffs: Map<string, { evseId: number; tariff: Record<string, unknown> }>;
}

function makeSimulator(
  authorizeResponse: Record<string, unknown> = {},
  configOverrides: Record<string, string> = {},
): { sim: StationSimulator; internals: Internals; sendCall: ReturnType<typeof vi.fn> } {
  const sim = new StationSimulator(makeConfig({ configOverrides }), noopSql());
  const sendCall = vi.fn(async () => authorizeResponse);
  Object.defineProperty(sim.client, 'sendCall', { value: sendCall, writable: true });
  Object.defineProperty(sim.client, 'isConnected', { get: () => true });
  const internals = sim as unknown as Internals;
  internals.seedDefaultConfigVariables();
  return { sim, internals, sendCall };
}

async function invoke(
  internals: Internals,
  action: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return internals.handleCsmsCommand.call(internals, 'm1', action, payload);
}

const nextTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('Authorization Cache expiry (C10.FR.13, C17 prepaid tokens)', () => {
  it('does not cache an idTokenInfo whose cacheExpiryDateTime is now', async () => {
    const { sim, internals } = makeSimulator({
      idTokenInfo: { status: 'Accepted', cacheExpiryDateTime: new Date().toISOString() },
    });
    await sim.sendAuthorize('PREPAID-1', 'ISO14443');
    expect(internals.authCache.get('PREPAID-1')).toBeUndefined();
  });

  it('removes an already cached token when the new cacheExpiryDateTime has passed', async () => {
    const { sim, internals } = makeSimulator({
      idTokenInfo: { status: 'NoCredit', cacheExpiryDateTime: new Date().toISOString() },
    });
    internals.authCache.set('PREPAID-1', { status: 'Accepted' });
    await sim.sendAuthorize('PREPAID-1', 'ISO14443');
    expect(internals.authCache.get('PREPAID-1')).toBeUndefined();
  });

  it('caches an idTokenInfo with a future cacheExpiryDateTime', async () => {
    const expiry = new Date(Date.now() + 3_600_000).toISOString();
    const { sim, internals } = makeSimulator({
      idTokenInfo: { status: 'Accepted', cacheExpiryDateTime: expiry },
    });
    await sim.sendAuthorize('TOKEN-1', 'ISO14443');
    expect(internals.authCache.get('TOKEN-1')?.['cacheExpiryDateTime']).toBe(expiry);
  });

  it('a NoCredit token does not authorize the EVSE (C17.FR.05)', async () => {
    const { sim } = makeSimulator({
      idTokenInfo: { status: 'NoCredit', cacheExpiryDateTime: new Date().toISOString() },
    });
    const startSpy = vi.spyOn(sim, 'sendTransactionEvent');
    await sim.plugIn(1).catch(() => {});
    const result = await sim.authorize(1, 'PREPAID-2', 'ISO14443');
    expect((result['idTokenInfo'] as Record<string, unknown>)['status']).toBe('NoCredit');
    expect(startSpy.mock.calls.some((c) => c[1] === 'Started')).toBe(false);
  });
});

describe('Cost limit source (E16.FR.15, E16.FR.16)', () => {
  function withTransaction(internals: Internals): void {
    internals.activeTransactionIds.set(1, 'tx-1');
    internals.evseTransactionLimits.set(1, { maxCost: 10 });
  }

  it('CostUpdated from CSMS reaching maxCost suspends with CostLimitReached', async () => {
    const { sim, internals } = makeSimulator();
    withTransaction(internals);
    const txSpy = vi.spyOn(sim, 'sendTransactionEvent').mockResolvedValue({});
    vi.spyOn(sim, 'sendStatusNotification').mockResolvedValue(undefined);

    expect(
      await invoke(internals, 'CostUpdated', { totalCost: 12, transactionId: 'tx-1' }),
    ).toEqual({});
    await nextTick();
    await nextTick();

    const call = txSpy.mock.calls.find((c) => c[2].triggerReason === 'CostLimitReached');
    expect(call?.[1]).toBe('Updated');
    expect(call?.[2].chargingState).toBe('SuspendedEVSE');
  });

  it('ignores CostUpdated while a default tariff gives local cost calculation', async () => {
    const { sim, internals } = makeSimulator();
    withTransaction(internals);
    internals.defaultTariffs.set('T1', { evseId: 0, tariff: { tariffId: 'T1' } });
    const txSpy = vi.spyOn(sim, 'sendTransactionEvent').mockResolvedValue({});

    await invoke(internals, 'CostUpdated', { totalCost: 12, transactionId: 'tx-1' });
    await nextTick();
    await nextTick();

    expect(txSpy.mock.calls.some((c) => c[2].triggerReason === 'CostLimitReached')).toBe(false);
  });
});

describe('WebPaymentsCtrlr (C25 dynamic QR codes)', () => {
  const qrConfig = {
    'WebPaymentsCtrlr.Enabled': 'true',
    'WebPaymentsCtrlr.URLTemplate':
      'https://qr.example.com/{chargingstationid}/{evse}/{totp}/{version}',
    'WebPaymentsCtrlr.SharedSecret': '12345678',
    'WebPaymentsCtrlr.ValidityTime': '120',
    'WebPaymentsCtrlr.Length': '8',
  };

  it('shows no QR code while WebPaymentsCtrlr is disabled', () => {
    const { sim } = makeSimulator();
    expect(sim.webPaymentQrUrl(1)).toBeNull();
  });

  it('builds the URL from the template with a valid TOTP v1 (C25.FR.01, C25.FR.50-52)', () => {
    const { sim } = makeSimulator({}, qrConfig);
    const url = sim.webPaymentQrUrl(1);
    const match = /^https:\/\/qr\.example\.com\/TEST-SIM\/1\/([0-9A-Za-z]{8})\/v1$/.exec(url ?? '');
    expect(match).not.toBeNull();
    expect(
      verifyTotpV1(match?.[1] ?? '', { sharedSecret: '12345678', validitySeconds: 120, length: 8 }),
    ).toBe(true);
  });

  it('adds the limits the EV driver entered as query parameters (C25.FR.04-06)', () => {
    const { sim } = makeSimulator({}, qrConfig);
    sim.enterWebPaymentLimits(1, { maxTime: 300, maxCost: 50 });
    expect(sim.webPaymentQrUrl(1)).toMatch(/\/v1\?maxtime=300&maxcost=50$/);
  });

  it('refuses a limit that is not in URLParameters (C25.FR.03)', () => {
    const { sim } = makeSimulator({}, { ...qrConfig, 'WebPaymentsCtrlr.URLParameters': 'maxtime' });
    expect(() => {
      sim.enterWebPaymentLimits(1, { maxEnergy: 20000 });
    }).toThrow(/maxenergy/);
  });

  it('rejects reading the WriteOnly SharedSecret (B06.FR.09)', async () => {
    const { internals } = makeSimulator({}, qrConfig);
    const res = await invoke(internals, 'GetVariables', {
      getVariableData: [
        { component: { name: 'WebPaymentsCtrlr' }, variable: { name: 'SharedSecret' } },
      ],
    });
    const results = res['getVariableResult'] as Array<Record<string, unknown>>;
    expect(results[0]?.['attributeStatus']).toBe('Rejected');
    expect(results[0]?.['attributeValue']).toBeUndefined();
  });

  it('rejects out-of-range ValidityTime and Length, accepts valid values', async () => {
    const { internals } = makeSimulator();
    const res = await invoke(internals, 'SetVariables', {
      setVariableData: [
        {
          component: { name: 'WebPaymentsCtrlr' },
          variable: { name: 'ValidityTime' },
          attributeValue: '5',
        },
        {
          component: { name: 'WebPaymentsCtrlr' },
          variable: { name: 'Length' },
          attributeValue: '5',
        },
        {
          component: { name: 'WebPaymentsCtrlr' },
          variable: { name: 'ValidityTime' },
          attributeValue: '120',
        },
        {
          component: { name: 'WebPaymentsCtrlr' },
          variable: { name: 'SharedSecret' },
          attributeValue: '12345678',
        },
      ],
    });
    const statuses = (res['setVariableResult'] as Array<Record<string, unknown>>).map(
      (r) => r['attributeStatus'],
    );
    expect(statuses).toEqual(['Rejected', 'Rejected', 'Accepted', 'Accepted']);
  });

  it('answers NotifyWebPaymentStarted without parameters (C25.FR.27)', async () => {
    const { internals } = makeSimulator();
    expect(await invoke(internals, 'NotifyWebPaymentStarted', { evseId: 1, timeout: 5 })).toEqual(
      {},
    );
  });
});
