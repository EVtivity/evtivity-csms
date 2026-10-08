// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectionDeps } from '../../server/projection-support/context.js';

const {
  mockExtendFleetSessionCeiling,
  mockFleetCreditNoticesClaimed,
  mockReadFleetCreditLimit,
  mockDispatchFleetCreditLimitNotices,
  mockGetFleetCreditReservationCents,
} = vi.hoisted(() => ({
  mockGetFleetCreditReservationCents: vi.fn(),
  mockExtendFleetSessionCeiling: vi.fn(),
  mockFleetCreditNoticesClaimed: vi.fn(),
  mockReadFleetCreditLimit: vi.fn(),
  mockDispatchFleetCreditLimitNotices: vi.fn(),
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  extendFleetSessionCeiling: mockExtendFleetSessionCeiling,
  fleetCreditNoticesClaimed: mockFleetCreditNoticesClaimed,
  readFleetCreditLimit: mockReadFleetCreditLimit,
  getFleetCreditReservationCents: mockGetFleetCreditReservationCents,
}));

vi.mock('@evtivity/payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/payments')>()),
  dispatchFleetCreditLimitNotices: mockDispatchFleetCreditLimitNotices,
}));

vi.mock('../../server/notification-dispatcher.js', () => ({
  dispatchDriverNotification: vi.fn(),
  dispatchSystemNotification: vi.fn(),
  ALL_TEMPLATES_DIRS: [],
}));

vi.mock('../../lib/payments.js', () => ({ activePaymentProvider: vi.fn() }));
vi.mock('../../server/session-lifecycle/payment-stop.js', () => ({
  stopSessionForPayment: vi.fn(),
}));

const { growAccountCeiling } = await import('../../server/session-lifecycle/account-ceiling.js');
const { trackRunningFleetCreditNotices } =
  await import('../../server/session-lifecycle/payment-gate.js');
const { FleetCreditThrottle } = await import('../../server/session-lifecycle/state.js');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const tracked: Array<Promise<unknown>> = [];
const deps = {
  sql: {},
  logger,
  eventBus: {
    track: (p: Promise<unknown>) => {
      tracked.push(p);
      return p;
    },
  },
} as unknown as ProjectionDeps;

// Slice 5000: the extension is due once less than 1000 (20 % of the slice)
// is left under the ceiling, or less than twice the last reading's cost.
const input = {
  sessionId: 'ses_1',
  fleetId: 'flt_1',
  ceilingCents: 5000,
  pricedCents: 4001,
  lastReadingCents: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  tracked.length = 0;
  mockFleetCreditNoticesClaimed.mockResolvedValue(false);
  mockReadFleetCreditLimit.mockResolvedValue(null);
  mockGetFleetCreditReservationCents.mockResolvedValue(5000);
});

describe('FleetCreditThrottle', () => {
  it('is due once per interval per kind and fleet', () => {
    const throttle = new FleetCreditThrottle(60_000);
    expect(throttle.due('notices', 'flt_1', 1000)).toBe(true);
    throttle.mark('notices', 'flt_1', 1000);
    expect(throttle.due('notices', 'flt_1', 60_999)).toBe(false);
    expect(throttle.due('notices', 'flt_2', 60_999)).toBe(true);
    expect(throttle.due('no_credit', 'flt_1', 60_999)).toBe(true);
    expect(throttle.due('notices', 'flt_1', 61_000)).toBe(true);
    throttle.mark('no_credit', 'flt_1', 1000);
    throttle.clear('no_credit', 'flt_1');
    expect(throttle.due('no_credit', 'flt_1', 1001)).toBe(true);
  });
});

describe('growAccountCeiling', () => {
  it('extends nothing while the headroom is at least 20 % of the slice and twice the last reading', async () => {
    const throttle = new FleetCreditThrottle(60_000);
    const ceiling = await growAccountCeiling(deps, throttle, { ...input, pricedCents: 4000 });
    expect(ceiling).toBe(5000);
    // 2000 left, the last reading added 1000: twice that is not more than the headroom.
    await growAccountCeiling(deps, throttle, {
      ...input,
      pricedCents: 3000,
      lastReadingCents: 1000,
    });
    expect(mockExtendFleetSessionCeiling).not.toHaveBeenCalled();
  });

  it('grows early when the last reading added more than half the headroom', async () => {
    mockExtendFleetSessionCeiling.mockResolvedValue({
      previousCents: 5000,
      ceilingCents: 10_000,
      grown: true,
    });
    const throttle = new FleetCreditThrottle(60_000);
    const ceiling = await growAccountCeiling(deps, throttle, {
      ...input,
      pricedCents: 3000,
      lastReadingCents: 1001,
    });
    expect(ceiling).toBe(10_000);
    expect(mockExtendFleetSessionCeiling).toHaveBeenCalledWith({}, 'flt_1', 'ses_1', {
      pricedCents: 3000,
      sliceCents: 5000,
      lastReadingCents: 1001,
    });
  });

  it('grows the ceiling under the fleet lock once the headroom is below 20 % of the slice', async () => {
    mockExtendFleetSessionCeiling.mockResolvedValue({
      previousCents: 5000,
      ceilingCents: 10_000,
      grown: true,
    });
    const throttle = new FleetCreditThrottle(60_000);
    const ceiling = await growAccountCeiling(deps, throttle, input);
    expect(ceiling).toBe(10_000);
    expect(mockExtendFleetSessionCeiling).toHaveBeenCalledWith({}, 'flt_1', 'ses_1', {
      pricedCents: 4001,
      sliceCents: 5000,
      lastReadingCents: 100,
    });
  });

  it('marks the fleet without credit and skips its extensions below the ceiling for an interval', async () => {
    mockExtendFleetSessionCeiling.mockResolvedValue({
      previousCents: 5000,
      ceilingCents: 5000,
      grown: false,
    });
    const throttle = new FleetCreditThrottle(60_000);
    expect(await growAccountCeiling(deps, throttle, input, 1000)).toBe(5000);
    expect(await growAccountCeiling(deps, throttle, input, 2000)).toBe(5000);
    // Another session of the same fleet below its ceiling waits too.
    expect(await growAccountCeiling(deps, throttle, { ...input, sessionId: 'ses_2' }, 3000)).toBe(
      5000,
    );
    expect(mockExtendFleetSessionCeiling).toHaveBeenCalledTimes(1);
    // After the interval it tries again.
    await growAccountCeiling(deps, throttle, input, 61_000);
    expect(mockExtendFleetSessionCeiling).toHaveBeenCalledTimes(2);
  });

  it('never skips an extension at the ceiling, even for a fleet marked without credit', async () => {
    mockExtendFleetSessionCeiling
      .mockResolvedValueOnce({ previousCents: 5000, ceilingCents: 5000, grown: false })
      .mockResolvedValueOnce({ previousCents: 5000, ceilingCents: 9000, grown: true });
    const throttle = new FleetCreditThrottle(60_000);
    await growAccountCeiling(deps, throttle, input, 1000);
    // Credit came free (a session ended): the session at its ceiling grows instead of stopping.
    const ceiling = await growAccountCeiling(deps, throttle, { ...input, pricedCents: 5000 }, 2000);
    expect(ceiling).toBe(9000);
    expect(throttle.due('no_credit', 'flt_1', 2001)).toBe(true);
  });

  it('keeps the ceiling when the session is no longer a running account session', async () => {
    mockExtendFleetSessionCeiling.mockResolvedValue(null);
    const throttle = new FleetCreditThrottle(60_000);
    expect(await growAccountCeiling(deps, throttle, input)).toBe(5000);
  });

  it('logs a failed slice read below the ceiling and keeps the ceiling', async () => {
    mockGetFleetCreditReservationCents.mockRejectedValue(new Error('db down'));
    const throttle = new FleetCreditThrottle(60_000);
    expect(await growAccountCeiling(deps, throttle, input)).toBe(5000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(mockExtendFleetSessionCeiling).not.toHaveBeenCalled();
  });

  it('logs a failed extension below the ceiling and keeps the ceiling', async () => {
    mockExtendFleetSessionCeiling.mockRejectedValue(new Error('db down'));
    const throttle = new FleetCreditThrottle(60_000);
    expect(await growAccountCeiling(deps, throttle, input)).toBe(5000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('throws a failed extension at the ceiling, so the reading does not stop the session', async () => {
    mockExtendFleetSessionCeiling.mockRejectedValue(new Error('db down'));
    const throttle = new FleetCreditThrottle(60_000);
    await expect(
      growAccountCeiling(deps, throttle, { ...input, pricedCents: 5000 }),
    ).rejects.toThrow('db down');
  });
});

describe('trackRunningFleetCreditNotices', () => {
  const warning = { fleetId: 'flt_1', level: 'warning' };

  it('checks a fleet at most once per interval', async () => {
    mockReadFleetCreditLimit.mockResolvedValue(warning);
    const throttle = new FleetCreditThrottle(60_000);
    trackRunningFleetCreditNotices(deps, 'flt_1', throttle, 1000);
    trackRunningFleetCreditNotices(deps, 'flt_1', throttle, 2000);
    trackRunningFleetCreditNotices(deps, 'flt_2', throttle, 2000);
    await Promise.all(tracked);
    expect(mockReadFleetCreditLimit).toHaveBeenCalledTimes(2);
    expect(mockDispatchFleetCreditLimitNotices).toHaveBeenCalledTimes(2);

    trackRunningFleetCreditNotices(deps, 'flt_1', throttle, 61_000);
    await Promise.all(tracked);
    expect(mockReadFleetCreditLimit).toHaveBeenCalledTimes(3);
  });

  it('skips the exposure aggregate when both notices of the month are claimed', async () => {
    mockFleetCreditNoticesClaimed.mockResolvedValue(true);
    const throttle = new FleetCreditThrottle(60_000);
    trackRunningFleetCreditNotices(deps, 'flt_1', throttle, 1000);
    await Promise.all(tracked);
    expect(mockFleetCreditNoticesClaimed).toHaveBeenCalledWith({}, 'flt_1');
    expect(mockReadFleetCreditLimit).not.toHaveBeenCalled();
    expect(mockDispatchFleetCreditLimitNotices).not.toHaveBeenCalled();
  });

  it('sends nothing at the ok level and logs a failed check (fail-open)', async () => {
    mockReadFleetCreditLimit.mockResolvedValueOnce({ fleetId: 'flt_1', level: 'ok' });
    const throttle = new FleetCreditThrottle(60_000);
    trackRunningFleetCreditNotices(deps, 'flt_1', throttle, 1000);
    await Promise.all(tracked);
    expect(mockDispatchFleetCreditLimitNotices).not.toHaveBeenCalled();

    mockReadFleetCreditLimit.mockRejectedValueOnce(new Error('db down'));
    trackRunningFleetCreditNotices(deps, 'flt_2', throttle, 1000);
    await Promise.all(tracked);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
