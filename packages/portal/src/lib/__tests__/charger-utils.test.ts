// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError } from '../api';
import { checkGuestConnectorStatus, qrTransactionLimits } from '../charger-utils';

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkGuestConnectorStatus', () => {
  it('returns the refreshed connector status', async () => {
    mockFetch(200, { connectorStatus: 'preparing' });
    await expect(checkGuestConnectorStatus('CS-1', '1')).resolves.toEqual({
      connectorStatus: 'preparing',
    });
  });

  it('throws an ApiError carrying the error code on a failed check', async () => {
    const body = { error: 'Station is offline', code: 'STATION_OFFLINE' };
    mockFetch(400, body);
    const err = await checkGuestConnectorStatus('CS-1', '1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).body).toEqual(body);
  });

  it('throws an ApiError with a null body when the response is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
      }),
    );
    const err = await checkGuestConnectorStatus('CS-1', '1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).body).toBeNull();
  });
});

describe('qrTransactionLimits', () => {
  it('reads maxenergy, maxtime, and maxcost (major units to cents)', () => {
    const params = new URLSearchParams('maxenergy=20000&maxtime=3600&maxcost=12.34');
    expect(qrTransactionLimits(params)).toEqual({
      maxEnergyWh: 20000,
      maxTimeSeconds: 3600,
      maxCostCents: 1234,
    });
  });

  it('returns an empty object without limit parameters', () => {
    expect(qrTransactionLimits(new URLSearchParams(''))).toEqual({});
  });

  it('leaves out invalid, zero, and negative values', () => {
    const params = new URLSearchParams('maxenergy=abc&maxtime=0&maxcost=-5');
    expect(qrTransactionLimits(params)).toEqual({});
  });
});
