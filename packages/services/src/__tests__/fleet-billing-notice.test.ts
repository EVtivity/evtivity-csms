// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BillingMembership } from '@evtivity/database';

const { isFleetEnabled, loadBillingMemberships, dispatchDriverNotification, add, jobQueue } =
  vi.hoisted(() => {
    const addFn = vi.fn();
    return {
      isFleetEnabled: vi.fn(),
      loadBillingMemberships: vi.fn(),
      dispatchDriverNotification: vi.fn(),
      add: addFn,
      jobQueue: vi.fn(() => ({ add: addFn, addBulk: vi.fn() })),
    };
  });

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
vi.mock('@evtivity/lib/job-queues', () => ({ jobQueue }));
vi.mock('../template-dirs.js', () => ({ ALL_TEMPLATES_DIRS: ['templates'] }));

const {
  fanoutChange,
  membershipsAround,
  notifyAccountBillingChange,
  fleetBillingFanoutJobId,
  enqueueFleetBillingFanout,
  runFleetBillingFanout,
  FLEET_BILLING_FANOUT_JOB_NAME,
} = await import('../fleet-billing-notice.js');
const { FLEET_BILLING_FANOUT_JOB_OPTIONS, FLEET_BILLING_FANOUT_QUEUE } =
  await import('@evtivity/lib/worker-queues');

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const sql = vi.fn() as never;

function m(
  id: number,
  fleet: string,
  options: Partial<
    Pick<BillingMembership, 'accountBillingEnabled' | 'optOut' | 'invoiceRecipient'>
  > & {
    day?: number;
  } = {},
): BillingMembership {
  return {
    membershipId: id,
    fleetId: `flt_${fleet}`,
    fleetName: fleet,
    accountBillingEnabled: options.accountBillingEnabled ?? true,
    invoiceRecipient: options.invoiceRecipient ?? 'fleet',
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

  it('pins the invoice recipient (and a switch set in the same write) in after', () => {
    const current = [m(1, 'A', { invoiceRecipient: 'member', accountBillingEnabled: false })];
    const only = membershipsAround(current, {
      kind: 'recipient',
      fleetId: 'flt_A',
      recipient: 'member',
    });
    expect(only.before[0]).toMatchObject({
      invoiceRecipient: 'fleet',
      accountBillingEnabled: false,
    });
    expect(only.after[0]).toMatchObject({
      invoiceRecipient: 'member',
      accountBillingEnabled: false,
    });
    const both = membershipsAround(current, {
      kind: 'recipient',
      fleetId: 'flt_A',
      recipient: 'member',
      enabled: true,
    });
    expect(both.before[0]).toMatchObject({
      invoiceRecipient: 'fleet',
      accountBillingEnabled: false,
    });
    expect(both.after[0]).toMatchObject({
      invoiceRecipient: 'member',
      accountBillingEnabled: true,
    });
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
      {
        fleetName: 'A',
        billedTo: 'A',
        accountBilling: true,
        invoicedTo: 'fleet',
        invoicedToMember: false,
      },
      ['templates'],
    );
  });

  it('tells a member their sessions are now invoiced to them (invoicedTo)', async () => {
    loadBillingMemberships.mockResolvedValue([m(1, 'A', { invoiceRecipient: 'member' })]);
    expect(
      await notifyAccountBillingChange(
        sql,
        'drv_1',
        { kind: 'recipient', fleetId: 'flt_A', recipient: 'member' },
        log,
      ),
    ).toBe(true);
    expect(dispatchDriverNotification.mock.calls[0]?.[3]).toEqual({
      fleetName: 'A',
      billedTo: 'A',
      accountBilling: true,
      invoicedTo: 'member',
      invoicedToMember: true,
    });
  });

  it('notifies nothing on a recipient change for a member billed elsewhere or by card', async () => {
    loadBillingMemberships.mockResolvedValue([m(1, 'Old'), m(2, 'A')]);
    const change = { kind: 'recipient' as const, fleetId: 'flt_A', recipient: 'member' as const };
    expect(await notifyAccountBillingChange(sql, 'drv_1', change, log)).toBe(false);
    loadBillingMemberships.mockResolvedValue([m(1, 'A', { optOut: true })]);
    expect(await notifyAccountBillingChange(sql, 'drv_1', change, log)).toBe(false);
    expect(dispatchDriverNotification).not.toHaveBeenCalled();
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
      {
        fleetName: 'Old',
        billedTo: 'New',
        accountBilling: true,
        invoicedTo: 'fleet',
        invoicedToMember: false,
      },
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
      {
        fleetName: 'A',
        billedTo: '',
        accountBilling: false,
        invoicedTo: '',
        invoicedToMember: false,
      },
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

  it('gives a recipient change its own job id and member-level change', () => {
    const recipientJob = { ...job, recipient: 'member' as const };
    expect(fleetBillingFanoutJobId(recipientJob)).toBe(
      `fbf.flt_A.on.member.${String(Date.parse(job.changedAt))}`,
    );
    expect(fanoutChange(job)).toEqual({ kind: 'fleet', fleetId: 'flt_A', enabled: true });
    expect(fanoutChange(recipientJob)).toEqual({
      kind: 'recipient',
      fleetId: 'flt_A',
      recipient: 'member',
    });
    expect(fanoutChange({ ...recipientJob, enabledChanged: true })).toEqual({
      kind: 'recipient',
      fleetId: 'flt_A',
      recipient: 'member',
      enabled: true,
    });
  });

  it('adds the job to the worker queue under its change id and logs a failed add (fail-open)', async () => {
    add.mockResolvedValueOnce(undefined);
    await enqueueFleetBillingFanout(job, log);
    expect(jobQueue).toHaveBeenCalledWith(
      FLEET_BILLING_FANOUT_QUEUE,
      FLEET_BILLING_FANOUT_JOB_OPTIONS,
    );
    expect(add).toHaveBeenCalledWith(FLEET_BILLING_FANOUT_JOB_NAME, job, {
      jobId: fleetBillingFanoutJobId(job),
    });
    add.mockRejectedValueOnce(new Error('redis down'));
    await expect(enqueueFleetBillingFanout(job, log)).resolves.toBeUndefined();
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
