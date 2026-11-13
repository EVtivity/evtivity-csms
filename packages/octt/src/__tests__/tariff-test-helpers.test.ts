// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  conditionsOf,
  idleGraceSeconds,
  reportLocalCostSupport,
  tariffPrices,
  waitForSession,
} from '../tariff-test-helpers.js';
import { CSMS_STATE_TIMEOUT_MS } from '../security-test-helpers.js';
import type { TestContext } from '../types.js';

type Answer = { status: number; body: Record<string, unknown> };

function makeContext(answer: (method: string, path: string) => Answer, withApi = true) {
  const callApi = vi.fn((method: string, path: string) => Promise.resolve(answer(method, path)));
  const sendCall = vi.fn(() => Promise.resolve({}));
  const ctx: TestContext = {
    client: { sendCall } as unknown as TestContext['client'],
    version: 'ocpp2.1',
    stationId: 'OCTT-I-tariff-test',
    tokens: {} as TestContext['tokens'],
    stationDbId: 'sta_test',
    logger: pino({ level: 'silent' }),
    config: { serverUrl: 'ws://localhost:7103' },
    ...(withApi ? { callApi: callApi } : {}),
  };
  return { ctx, callApi, sendCall };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('idleGraceSeconds', () => {
  it('reads the setting in minutes and answers seconds', async () => {
    const { ctx } = makeContext(() => ({ status: 200, body: { value: 2.5 } }));
    expect(await idleGraceSeconds(ctx)).toBe(150);
  });

  it('uses the 30 minute default without an API, a number or a 200', async () => {
    expect(await idleGraceSeconds(makeContext(() => ({ status: 200, body: {} }), false).ctx)).toBe(
      1800,
    );
    expect(
      await idleGraceSeconds(makeContext(() => ({ status: 404, body: { value: 5 } })).ctx),
    ).toBe(1800);
    expect(
      await idleGraceSeconds(makeContext(() => ({ status: 200, body: { value: -1 } })).ctx),
    ).toBe(1800);
    expect(
      await idleGraceSeconds(makeContext(() => ({ status: 200, body: { value: '5' } })).ctx),
    ).toBe(1800);
  });
});

describe('reportLocalCostSupport', () => {
  it('reports both TariffCostCtrlr variables and waits until the CSMS stored them', async () => {
    let reads = 0;
    const { ctx, sendCall, callApi } = makeContext(() => {
      reads++;
      return {
        status: 200,
        body: { data: reads >= 3 ? [{ component: 'TariffCostCtrlr' }] : [{ component: 'Other' }] },
      };
    });
    const wait = reportLocalCostSupport(ctx, false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await wait).toBeNull();
    expect(callApi).toHaveBeenCalledTimes(3);
    const [action, payload] = sendCall.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(action).toBe('NotifyReport');
    expect(payload['reportData']).toEqual([
      expect.objectContaining({ variableAttribute: [{ type: 'Actual', value: 'true' }] }),
      expect.objectContaining({
        variable: { name: 'ConditionsSupported', instance: 'Tariff' },
        variableAttribute: [{ type: 'Actual', value: 'false' }],
      }),
    ]);
  });

  it('does not wait without an API and reports a CSMS that never stored it', async () => {
    const noApi = makeContext(() => ({ status: 200, body: {} }), false);
    expect(await reportLocalCostSupport(noApi.ctx, true)).toBeNull();
    expect(noApi.sendCall).toHaveBeenCalledTimes(1);

    const never = makeContext(() => ({ status: 200, body: {} }));
    const wait = reportLocalCostSupport(never.ctx, true);
    await vi.advanceTimersByTimeAsync(CSMS_STATE_TIMEOUT_MS + 500);
    expect(await wait).toBe('TariffCostCtrlr not stored by the CSMS in time');
  });
});

describe('waitForSession', () => {
  it('finds the session of the transaction and polls its detail until ready', async () => {
    let detailReads = 0;
    const { ctx } = makeContext((_m, path) => {
      if (path.startsWith('/stations/')) {
        return { status: 200, body: { data: [{ id: 'ses_9', transactionId: 'tx-1' }] } };
      }
      detailReads++;
      return {
        status: 200,
        body: { id: 'ses_9', status: detailReads >= 2 ? 'completed' : 'active' },
      };
    });
    const wait = waitForSession(ctx, 'tx-1', (s) => s['status'] === 'completed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await wait).toMatchObject({ id: 'ses_9', status: 'completed' });
  });

  it('answers null without an API or when the session never gets ready', async () => {
    const noApi = makeContext(() => ({ status: 200, body: {} }), false);
    expect(await waitForSession(noApi.ctx, 'tx-1', () => true)).toBeNull();

    const missing = makeContext(() => ({ status: 200, body: {} }));
    const wait = waitForSession(missing.ctx, 'tx-1', () => true);
    await vi.advanceTimersByTimeAsync(CSMS_STATE_TIMEOUT_MS + 500);
    expect(await wait).toBeNull();
  });
});

describe('tariff readers', () => {
  it('reads the prices of a tariff field and the conditions of a price', () => {
    const tariff = { energy: { prices: [{ priceKwh: 0.3, conditions: { minPower: 1 } }] } };
    expect(tariffPrices(tariff, 'energy')).toHaveLength(1);
    expect(tariffPrices(tariff, 'chargingTime')).toEqual([]);
    expect(tariffPrices(undefined, 'energy')).toEqual([]);
    expect(conditionsOf(tariffPrices(tariff, 'energy')[0])).toEqual({ minPower: 1 });
    expect(conditionsOf(undefined)).toEqual({});
  });
});
