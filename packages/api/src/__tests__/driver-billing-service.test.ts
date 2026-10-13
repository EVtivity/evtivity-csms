// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state, writeAuditMock } = vi.hoisted(() => ({
  state: {
    selectResults: [] as unknown[][],
    updates: [] as Record<string, unknown>[],
    locked: 0,
  },
  writeAuditMock: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('@evtivity/database', () => {
  const selectChain: Record<string, unknown> = {};
  for (const m of ['from', 'where']) selectChain[m] = () => selectChain;
  selectChain['for'] = () => {
    state.locked += 1;
    return selectChain;
  };
  selectChain['then'] = (resolve: (v: unknown) => void) => {
    resolve(state.selectResults.shift() ?? []);
  };
  const updateChain = {
    set: (v: Record<string, unknown>) => {
      state.updates.push(v);
      return updateChain;
    },
    where: () => Promise.resolve(undefined),
  };
  const db = {
    select: () => selectChain,
    update: () => updateChain,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return {
    db,
    drivers: {},
    driverAuditLog: {},
    writeAudit: writeAuditMock,
  };
});

import {
  diffBillingAddress,
  getDriverBillingAddress,
  mergeBillingAddress,
  updateDriverBillingAddress,
  type DriverBillingAddress,
} from '../services/driver-billing.service.js';

const EMPTY: DriverBillingAddress = {
  billingName: null,
  billingStreet: null,
  billingCity: null,
  billingState: null,
  billingZip: null,
  billingCountry: null,
};

const STORED: DriverBillingAddress = {
  ...EMPTY,
  billingStreet: 'Hauptstrasse 1',
  billingCity: 'Berlin',
  billingZip: '10115',
  billingCountry: 'Germany',
};

const ctx = {
  actor: {
    actor: 'driver' as const,
    actorUserId: null,
    actorDriverId: 'drv_1',
    actorApiKeyId: null,
    actorLabel: null,
  },
  log: { warn: vi.fn() },
};

beforeEach(() => {
  state.selectResults.length = 0;
  state.updates.length = 0;
  state.locked = 0;
  writeAuditMock.mockClear();
});

describe('mergeBillingAddress', () => {
  it('trims values, clears blank and null, keeps keys left out', () => {
    const next = mergeBillingAddress(STORED, {
      billingName: '  Erika Muster  ',
      billingCity: '   ',
      billingZip: null,
    });
    expect(next).toEqual({
      ...STORED,
      billingName: 'Erika Muster',
      billingCity: null,
      billingZip: null,
    });
  });
});

describe('diffBillingAddress', () => {
  it('returns only the changed keys', () => {
    const diff = diffBillingAddress(STORED, { ...STORED, billingCity: 'Hamburg' });
    expect(diff).toEqual({ before: { billingCity: 'Berlin' }, after: { billingCity: 'Hamburg' } });
  });

  it('returns null when nothing changed', () => {
    expect(diffBillingAddress(STORED, { ...STORED })).toBeNull();
  });
});

describe('getDriverBillingAddress', () => {
  it('returns the stored address', async () => {
    state.selectResults.push([STORED]);
    await expect(getDriverBillingAddress('drv_1')).resolves.toEqual(STORED);
  });

  it('throws DRIVER_NOT_FOUND for an unknown driver', async () => {
    state.selectResults.push([]);
    await expect(getDriverBillingAddress('drv_x')).rejects.toMatchObject({
      statusCode: 404,
      code: 'DRIVER_NOT_FOUND',
    });
  });
});

describe('updateDriverBillingAddress', () => {
  it('locks the row, writes and audits only the changed keys', async () => {
    state.selectResults.push([STORED]);
    const result = await updateDriverBillingAddress(
      'drv_1',
      { billingCity: ' Hamburg ', billingZip: '10115', billingName: '' },
      ctx,
    );

    expect(result).toEqual({ ...STORED, billingCity: 'Hamburg' });
    expect(state.locked).toBe(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ billingCity: 'Hamburg' });
    expect(state.updates[0]).not.toHaveProperty('billingZip');
    expect(state.updates[0]).not.toHaveProperty('billingName');
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityId: 'drv_1',
        action: 'billing_address_updated',
        actor: 'driver',
        actorDriverId: 'drv_1',
        before: { billingCity: 'Berlin' },
        after: { billingCity: 'Hamburg' },
      }),
      expect.anything(),
      ctx.log,
    );
  });

  it('writes and audits nothing for a repeated request', async () => {
    state.selectResults.push([STORED]);
    const result = await updateDriverBillingAddress('drv_1', { billingCity: 'Berlin' }, ctx);
    expect(result).toEqual(STORED);
    expect(state.updates).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('throws DRIVER_NOT_FOUND for an unknown driver and writes nothing', async () => {
    state.selectResults.push([]);
    await expect(
      updateDriverBillingAddress('drv_x', { billingCity: 'Berlin' }, ctx),
    ).rejects.toMatchObject({ statusCode: 404, code: 'DRIVER_NOT_FOUND' });
    expect(state.updates).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});
