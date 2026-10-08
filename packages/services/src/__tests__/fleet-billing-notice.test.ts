// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BillingMembership } from '@evtivity/database';

const { isFleetEnabled, loadBillingMemberships, dispatchDriverNotification, publish } = vi.hoisted(
  () => ({
    isFleetEnabled: vi.fn(),
    loadBillingMemberships: vi.fn(),
    dispatchDriverNotification: vi.fn(),
    publish: vi.fn(),
  }),
);

vi.mock('@evtivity/database', async () => {
  const actual = await vi.importActual<typeof import('../../../database/src/lib/fleet-billing.js')>(
    '../../../database/src/lib/fleet-billing.js',
  );
  return {
    isFleetEnabled,
    loadBillingMemberships,
    pickAccountBilling: actual.pickAccountBilling,
  };
});
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  dispatchDriverNotification,
}));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish }) }));
vi.mock('../template-dirs.js', () => ({ ALL_TEMPLATES_DIRS: ['templates'] }));

const {
  membershipsAround,
  notifyAccountBillingChange,
  fleetBillingFanoutJobId,
  publishFleetBillingFanout,
  runFleetBillingFanout,
  FLEET_BILLING_FANOUT_CHANNEL,
} = await import('../fleet-billing-notice.js');

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const sql = vi.fn() as never;

function m(
  id: number,
  fleet: string,
  options: Partial<Pick<BillingMembership, 'accountBillingEnabled' | 'optOut'>> & {
    day?: number;
  } = {},
): BillingMembership {
  return {
    membershipId: id,
    fleetId: `flt_${fleet}`,
    fleetName: fleet,
    accountBillingEnabled: options.accountBillingEnabled ?? true,
    optOut: options.optOut ?? false,
    createdAt: new Date(Date.UTC(2026, 0, options.day ?? id)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isFleetEnabled.mockResolvedValue(true);
  dispatchDriverNotification.mockResolvedValue(undefined);
});

describe('membershipsAround', () => {
  it('pins the fleet switch in after and reverts it in before', () => {
    const current = [m(1, 'A', { accountBillingEnabled: false })];
    const { before, after } = membershipsAround(current, {
      kind: 'fleet',
      fleetId: 'flt_A',
      enabled: true,
    });
    expect(before[0]?.accountBillingEnabled).toBe(false);
    expect(after[0]?.accountBillingEnabled).toBe(true);
  });

  it('adds back a membership that was removed', () => {
    const removed = m(1, 'A');
    const { before, after } = membershipsAround([], { kind: 'left', membership: removed });
    expect(before).toEqual([removed]);
    expect(after).toEqual([]);
  });

  it('leaves out a membership that was added', () => {
    const { before, after } = membershipsAround([m(1, 'A')], { kind: 'joined', fleetId: 'flt_A' });
    expect(before).toEqual([]);
    expect(after).toHaveLength(1);
  });
});

describe('notifyAccountBillingChange', () => {
  it('notifies a driver the switch moved from card to account', async () => {
    loadBillingMemberships.mockResolvedValue([m(1, 'A')]);
    expect(
      await notifyAccountBillingChange(
        sql,
        'drv_1',
        { kind: 'fleet', fleetId: 'flt_A', enabled: true },
        log,
      ),
    ).toBe(true);
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      sql,
      'fleet.AccountBillingChanged',
      'drv_1',
      { fleetName: 'A', billedTo: 'A', accountBilling: true },
      ['templates'],
    );
  });

  it('notifies nothing when an older membership still wins (billing unchanged)', async () => {
    loadBillingMemberships.mockResolvedValue([m(1, 'Old'), m(2, 'New')]);
    expect(
      await notifyAccountBillingChange(
        sql,
        'drv_1',
        { kind: 'fleet', fleetId: 'flt_New', enabled: true },
        log,
      ),
    ).toBe(false);
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('notifies nothing for an opted-out member of a switched fleet', async () => {
    loadBillingMemberships.mockResolvedValue([m(1, 'A', { optOut: true })]);
    expect(
      await notifyAccountBillingChange(
        sql,
        'drv_1',
        { kind: 'fleet', fleetId: 'flt_A', enabled: false },
        log,
      ),
    ).toBe(false);
  });

  it('tells a driver who moves to another account fleet where they are billed now', async () => {
    // Leaving Old (the oldest) moves the driver to New.
    loadBillingMemberships.mockResolvedValue([m(2, 'New')]);
    await notifyAccountBillingChange(sql, 'drv_1', { kind: 'left', membership: m(1, 'Old') }, log);
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      sql,
      'fleet.AccountBillingChanged',
      'drv_1',
      { fleetName: 'Old', billedTo: 'New', accountBilling: true },
      ['templates'],
    );
  });

  it('tells an opted-out member they pay by card', async () => {
    loadBillingMemberships.mockResolvedValue([m(1, 'A', { optOut: true })]);
    await notifyAccountBillingChange(
      sql,
      'drv_1',
      { kind: 'optOut', fleetId: 'flt_A', optOut: true },
      log,
    );
    expect(dispatchDriverNotification).toHaveBeenCalledWith(
      sql,
      'fleet.AccountBillingChanged',
      'drv_1',
      { fleetName: 'A', billedTo: '', accountBilling: false },
      ['templates'],
    );
  });

  it('notifies nothing while fleets are turned off', async () => {
    isFleetEnabled.mockResolvedValue(false);
    expect(
      await notifyAccountBillingChange(sql, 'drv_1', { kind: 'joined', fleetId: 'flt_A' }, log),
    ).toBe(false);
    expect(loadBillingMemberships).not.toHaveBeenCalled();
  });

  it('is fail-open: a failure is logged and returns false', async () => {
    loadBillingMemberships.mockRejectedValue(new Error('db down'));
    expect(
      await notifyAccountBillingChange(sql, 'drv_1', { kind: 'joined', fleetId: 'flt_A' }, log),
    ).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('fleet switch fan-out', () => {
  const job = { fleetId: 'flt_A', enabled: true, changedAt: '2026-10-07T12:00:00.000Z' };

  it('gives one job id per fleet and change, without colons', () => {
    expect(fleetBillingFanoutJobId(job)).toBe(`fbf.flt_A.on.${String(Date.parse(job.changedAt))}`);
    expect(fleetBillingFanoutJobId({ ...job, enabled: false })).not.toBe(
      fleetBillingFanoutJobId(job),
    );
    expect(fleetBillingFanoutJobId(job)).not.toContain(':');
  });

  it('publishes the job and logs a lost publish (fail-open)', async () => {
    publish.mockResolvedValueOnce(undefined);
    await publishFleetBillingFanout(job, log);
    expect(publish).toHaveBeenCalledWith(FLEET_BILLING_FANOUT_CHANNEL, JSON.stringify(job));
    publish.mockRejectedValueOnce(new Error('redis down'));
    await expect(publishFleetBillingFanout(job, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });

  it('notifies each member whose billing moved and counts them', async () => {
    const memberSql = vi.fn(() =>
      Promise.resolve([{ driver_id: 'drv_1' }, { driver_id: 'drv_2' }]),
    );
    loadBillingMemberships
      .mockResolvedValueOnce([m(1, 'A')])
      .mockResolvedValueOnce([m(1, 'Old'), m(2, 'A')]);
    expect(await runFleetBillingFanout(memberSql as never, job, log)).toEqual({
      members: 2,
      notified: 1,
    });
  });
});
