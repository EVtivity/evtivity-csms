// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type postgres from 'postgres';
import type { ProjectionDeps } from '../../server/projection-support/context.js';

const { calls, mockFaultUnbilledSession, mockPublishOcppCommand, mockDispatchOneShot } = vi.hoisted(
  () => ({
    calls: [] as string[],
    mockFaultUnbilledSession: vi.fn(),
    mockPublishOcppCommand: vi.fn(),
    mockDispatchOneShot: vi.fn(),
  }),
);

vi.mock('@evtivity/database', () => ({
  faultUnbilledSession: mockFaultUnbilledSession,
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  publishOcppCommand: mockPublishOcppCommand,
  dispatchOneShotStationMessage: mockDispatchOneShot,
}));

const { stopSessionForPayment, costLimitReported } =
  await import('../../server/session-lifecycle/payment-stop.js');

const target = {
  sessionId: 'sess-1',
  transactionId: 'tx-1',
  ocppStationId: 'CS-1',
  stationDbId: 'station-uuid',
};

function sqlText(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?');
}

type SqlMock = Mock<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>;

interface Harness {
  deps: ProjectionDeps;
  sql: SqlMock;
  pubsub: { publish: ReturnType<typeof vi.fn> };
  logger: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  audit: ReturnType<typeof vi.fn>;
}

function makeHarness(settingsRows: unknown[] = []): Harness {
  const sql: SqlMock = vi.fn((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('UPDATE charging_sessions')) calls.push('claim');
    else if (text.includes('FROM settings')) {
      calls.push('settings');
      return Promise.resolve(settingsRows);
    } else if (text.includes('session_tariff_segments')) calls.push('segments');
    else calls.push('sql');
    return Promise.resolve([] as unknown[]);
  });
  const pubsub = { publish: vi.fn() };
  const logger = { error: vi.fn(), warn: vi.fn() };
  const audit = vi.fn(() => {
    calls.push('audit');
    return Promise.resolve();
  });
  const deps = {
    sql,
    pubsub,
    logger,
    notify: { auditLinkedReservationFault: audit },
  } as unknown as ProjectionDeps;
  return { deps, sql, pubsub, logger, audit };
}

describe('stopSessionForPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    mockPublishOcppCommand.mockImplementation(() => {
      calls.push('publish');
      return Promise.resolve();
    });
    mockDispatchOneShot.mockImplementation(() => {
      calls.push('message');
      return Promise.resolve();
    });
    mockFaultUnbilledSession.mockImplementation(() => {
      calls.push('fault');
      return Promise.resolve(true);
    });
  });

  for (const reason of ['PrepaidCreditExhausted', 'GuestHoldExhausted'] as const) {
    describe(reason, () => {
      it('claims the session, then publishes the stop with no message and no fault', async () => {
        const h = makeHarness();
        h.sql.mockImplementationOnce((strings: TemplateStringsArray) => {
          calls.push('claim');
          expect(strings.join('?')).toContain('stopped_reason IS NULL');
          return Promise.resolve([{ id: 'sess-1' }]);
        });
        await stopSessionForPayment(h.deps, target, reason);
        expect(calls).toEqual(['claim', 'publish']);
        expect(h.sql.mock.calls[0]?.slice(1)).toEqual([reason, 'sess-1']);
        expect(mockPublishOcppCommand).toHaveBeenCalledWith(h.pubsub, {
          stationId: 'CS-1',
          action: 'RequestStopTransaction',
          payload: { transactionId: 'tx-1' },
        });
        expect(mockDispatchOneShot).not.toHaveBeenCalled();
        expect(mockFaultUnbilledSession).not.toHaveBeenCalled();
      });

      it('does nothing else when the claim returns no row', async () => {
        const h = makeHarness();
        await stopSessionForPayment(h.deps, target, reason);
        expect(calls).toEqual(['claim']);
        expect(mockPublishOcppCommand).not.toHaveBeenCalled();
        expect(mockFaultUnbilledSession).not.toHaveBeenCalled();
      });

      it('logs a failed claim and publishes nothing', async () => {
        const h = makeHarness();
        h.sql.mockImplementationOnce(() => Promise.reject(new Error('db down')));
        await stopSessionForPayment(h.deps, target, reason);
        expect(h.logger.error).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'sess-1' }),
          'Failed to record the payment stop of the session',
        );
        expect(mockPublishOcppCommand).not.toHaveBeenCalled();
      });
    });
  }

  for (const [reason, state] of [
    ['PaymentFailed', 'payment_failed'],
    ['MissingPaymentMethod', 'payment_required'],
  ] as const) {
    describe(reason, () => {
      it('faults and closes segments before it publishes, then shows the message and audits', async () => {
        const h = makeHarness();
        await stopSessionForPayment(h.deps, target, reason);
        expect(calls).toEqual(['fault', 'segments', 'publish', 'settings', 'message', 'audit']);
        expect(mockDispatchOneShot).toHaveBeenCalledWith(
          h.pubsub,
          h.sql,
          {
            stationOcppId: 'CS-1',
            stationDbId: 'station-uuid',
            state,
            context: { companyName: 'EVtivity', stationOcppId: 'CS-1' },
          },
          { ttlSeconds: 30, autoClearMs: 30_000 },
        );
        expect(mockFaultUnbilledSession).toHaveBeenCalledWith(h.sql, {
          sessionId: 'sess-1',
          reason,
          endedAt: expect.any(Date) as Date,
        });
        expect(h.audit).toHaveBeenCalledWith('sess-1', `faulted: ${reason}`);
      });
    });
  }

  it('skips the audit when the session was not faulted', async () => {
    const h = makeHarness();
    mockFaultUnbilledSession.mockResolvedValueOnce(false);
    await stopSessionForPayment(h.deps, target, 'PaymentFailed');
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('leaves the session faulted when the stop publish fails', async () => {
    const h = makeHarness();
    mockPublishOcppCommand.mockImplementationOnce(() => {
      calls.push('publish');
      return Promise.reject(new Error('redis down'));
    });
    await stopSessionForPayment(h.deps, target, 'PaymentFailed');
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as Error }),
      'Failed to publish RequestStopTransaction',
    );
    expect(calls).toEqual(['fault', 'segments', 'publish', 'settings', 'message', 'audit']);
    await expect(mockFaultUnbilledSession.mock.results[0]?.value).resolves.toBe(true);
  });

  it('logs a station message failure at warn and still faults', async () => {
    const h = makeHarness();
    mockDispatchOneShot.mockRejectedValueOnce(new Error('render failed'));
    await stopSessionForPayment(h.deps, target, 'MissingPaymentMethod');
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'MissingPaymentMethod' }),
      'Failed to publish payment-failure display message',
    );
    expect(mockFaultUnbilledSession).toHaveBeenCalled();
  });

  it('only publishes and shows the message for an anonymous session', async () => {
    const h = makeHarness();
    await stopSessionForPayment(h.deps, target, 'AnonymousSession');
    expect(calls).toEqual(['publish', 'settings', 'message']);
    expect(mockDispatchOneShot.mock.calls[0]?.[2]).toMatchObject({ state: 'unauthorized' });
  });

  it('publishes and shows the guest message for an unauthorized guest, with no eager fault', async () => {
    const h = makeHarness();
    await stopSessionForPayment(h.deps, target, 'GuestPaymentNotAuthorized');
    expect(calls).toEqual(['publish', 'settings', 'message']);
    expect(mockDispatchOneShot.mock.calls[0]?.[2]).toMatchObject({ state: 'guest_unauthorized' });
    expect(mockFaultUnbilledSession).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('logs a failed eager fault, still publishes the stop and skips the audit', async () => {
    const h = makeHarness();
    mockFaultUnbilledSession.mockRejectedValueOnce(new Error('db down'));
    await stopSessionForPayment(h.deps, target, 'PaymentFailed');
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', reason: 'PaymentFailed' }),
      'Failed to mark session faulted',
    );
    expect(calls).toEqual(['publish', 'settings', 'message']);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('passes the company name, support phone and message TTL from settings', async () => {
    const h = makeHarness([
      { key: 'company.name', value: 'Acme Charging' },
      { key: 'company.supportPhone', value: '+1 555 0100' },
      { key: 'stationMessage.eventMessageTtlSeconds', value: 45 },
    ]);
    await stopSessionForPayment(h.deps, target, 'PaymentFailed');
    expect(sqlText(h.sql.mock.calls[1] as unknown[])).toContain('FROM settings');
    expect(mockDispatchOneShot).toHaveBeenCalledWith(
      h.pubsub,
      h.sql,
      {
        stationOcppId: 'CS-1',
        stationDbId: 'station-uuid',
        state: 'payment_failed',
        context: {
          companyName: 'Acme Charging',
          stationOcppId: 'CS-1',
          supportPhone: '+1 555 0100',
        },
      },
      { ttlSeconds: 45, autoClearMs: 45_000 },
    );
  });

  for (const ttl of [0, -5]) {
    it(`falls back to the default TTL for a stored TTL of ${String(ttl)}`, async () => {
      const h = makeHarness([{ key: 'stationMessage.eventMessageTtlSeconds', value: ttl }]);
      await stopSessionForPayment(h.deps, target, 'PaymentFailed');
      expect(mockDispatchOneShot.mock.calls[0]?.[3]).toEqual({
        ttlSeconds: 30,
        autoClearMs: 30_000,
      });
    });
  }
});

describe('costLimitReported', () => {
  it('is true when a CostLimitReached event exists for the session', async () => {
    const sql = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
    await expect(costLimitReported(sql as unknown as postgres.Sql, 'sess-1')).resolves.toBe(true);
    const call = sql.mock.calls[0] as unknown[];
    expect(sqlText(call)).toContain("trigger_reason = 'CostLimitReached'");
    expect(call.slice(1)).toEqual(['sess-1']);
  });

  it('is false when none exists', async () => {
    const sql = vi.fn().mockResolvedValue([]);
    await expect(costLimitReported(sql as unknown as postgres.Sql, 'sess-1')).resolves.toBe(false);
  });
});
