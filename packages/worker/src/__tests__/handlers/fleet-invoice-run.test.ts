// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@evtivity/lib';

vi.mock('@evtivity/database', () => ({
  getCompanyCurrency: vi.fn(),
  getFleetInvoiceRunDay: vi.fn(),
  getSystemTimezone: vi.fn(),
}));

// scheduledRunPeriod is tested in @evtivity/services; here the UTC day decides.
vi.mock('@evtivity/services/fleet-invoice-run', () => ({
  scheduledRunPeriod: (now: Date, _timeZone: string, runDay: number) =>
    now.getUTCDate() >= runDay ? '2026-09' : null,
  loadFleetsToInvoice: vi.fn(),
  sendFleetInvoiceOverdueNotices: vi.fn(),
  sendFleetInvoiceRunFailureDigests: vi.fn(),
}));

vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: ['/templates'] }));

vi.mock('../../fleet-invoice-worker.js', () => ({ enqueueFleetInvoice: vi.fn() }));

const { runFleetInvoiceCron } = await import('../../handlers/fleet-invoice-run.js');
type Deps = Parameters<typeof runFleetInvoiceCron>[1];

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function deps(overrides: Partial<NonNullable<Deps>> = {}): NonNullable<Deps> {
  return {
    now: () => new Date('2026-10-01T06:00:00Z'),
    timeZone: () => Promise.resolve('Europe/Berlin'),
    runDay: () => Promise.resolve(1),
    currency: () => Promise.resolve('EUR'),
    loadFleets: vi.fn(() =>
      Promise.resolve([
        // flt_1 missed the August run: its oldest month comes first.
        { fleetId: 'flt_1', period: '2026-08' },
        { fleetId: 'flt_2', period: '2026-09' },
        { fleetId: 'flt_3', period: '2026-09' },
      ]),
    ),
    enqueue: vi.fn(() => Promise.resolve()),
    sendFailureDigests: vi.fn(() => Promise.resolve({ periods: 0, fleets: 0 })),
    sendOverdue: vi.fn(() => Promise.resolve({ sent: 0, noContacts: 0, failed: 0 })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runFleetInvoiceCron', () => {
  it('enqueues one job per fleet for its oldest month to bill, from the run day', async () => {
    const d = deps();
    const summary = await runFleetInvoiceCron(log, d);
    expect(d.loadFleets).toHaveBeenCalledWith('2026-09', 'Europe/Berlin', 'EUR');
    expect(d.enqueue).toHaveBeenCalledTimes(3);
    expect(d.enqueue).toHaveBeenCalledWith({ fleetId: 'flt_1', period: '2026-08' });
    expect(d.enqueue).toHaveBeenCalledWith({ fleetId: 'flt_2', period: '2026-09' });
    expect(summary).toMatchObject({ period: '2026-09', enqueued: 3, enqueueFailed: 0 });
  });

  it('enqueues nothing before the run day but still sends the digest and overdue notices', async () => {
    const d = deps({ runDay: () => Promise.resolve(5) });
    const summary = await runFleetInvoiceCron(log, d);
    expect(d.loadFleets).not.toHaveBeenCalled();
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(d.sendFailureDigests).toHaveBeenCalledWith(log);
    expect(d.sendOverdue).toHaveBeenCalledWith(log, new Date('2026-10-01T06:00:00Z'));
    expect(summary.period).toBeNull();
  });

  it('one fleet failing to enqueue does not stop the others (fail-open)', async () => {
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce(undefined);
    const summary = await runFleetInvoiceCron(log, deps({ enqueue }));
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ enqueued: 2, enqueueFailed: 1 });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('reports the failure digest in the summary', async () => {
    const sendFailureDigests = vi.fn(() => Promise.resolve({ periods: 1, fleets: 2 }));
    const summary = await runFleetInvoiceCron(log, deps({ sendFailureDigests }));
    expect(summary.failureDigest).toEqual({ periods: 1, fleets: 2 });
  });

  it('each step is fail-open: a failing step does not stop the others', async () => {
    const sendOverdue = vi.fn(() => Promise.resolve({ sent: 2, noContacts: 0, failed: 0 }));
    const sendFailureDigests = vi.fn(() => Promise.resolve({ periods: 0, fleets: 0 }));
    const summary = await runFleetInvoiceCron(
      log,
      deps({
        loadFleets: vi.fn(() => Promise.reject(new Error('db down'))),
        sendFailureDigests,
        sendOverdue,
      }),
    );
    expect(sendFailureDigests).toHaveBeenCalled();
    expect(sendOverdue).toHaveBeenCalled();
    expect(summary.overdue).toEqual({ sent: 2, noContacts: 0, failed: 0 });

    const d = deps({
      sendFailureDigests: vi.fn(() => Promise.reject(new Error('db down'))),
      sendOverdue: vi.fn(() => Promise.reject(new Error('db down'))),
    });
    const second = await runFleetInvoiceCron(log, d);
    expect(second).toMatchObject({ enqueued: 3, failureDigest: null, overdue: null });
    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it('a rerun enqueues the same job ids again, which BullMQ ignores (P7)', async () => {
    const d = deps();
    await runFleetInvoiceCron(log, d);
    await runFleetInvoiceCron(log, d);
    const calls = vi.mocked(d.enqueue).mock.calls.map((c) => c[0]);
    expect(calls.slice(0, 3)).toEqual(calls.slice(3));
  });
});
