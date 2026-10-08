// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type postgres from 'postgres';
import type { ProjectionDeps } from '../../server/projection-support/context.js';

const {
  calls,
  mockFaultUnbilledSession,
  mockPublishOcppCommand,
  mockDispatchOneShot,
  mockDispatchDriver,
} = vi.hoisted(() => ({
  calls: [] as string[],
  mockFaultUnbilledSession: vi.fn(),
  mockPublishOcppCommand: vi.fn(),
  mockDispatchOneShot: vi.fn(),
  mockDispatchDriver: vi.fn(),
}));

vi.mock('../../server/notification-dispatcher.js', () => ({
  dispatchDriverNotification: mockDispatchDriver,
  ALL_TEMPLATES_DIRS: ['templates'],
}));

vi.mock('@evtivity/database', () => ({
  faultUnbilledSession: mockFaultUnbilledSession,
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  publishOcppCommand: mockPublishOcppCommand,
  dispatchOneShotStationMessage: mockDispatchOneShot,
}));

const { stopSessionForPayment, costLimitReported, noteCostLimitReached, ceilingStopReason } =
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
  track: ReturnType<typeof vi.fn>;
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
  const track = vi.fn();
  const deps = {
    sql,
    eventBus: { track },
    pubsub,
    logger,
    notify: { auditLinkedReservationFault: audit },
  } as unknown as ProjectionDeps;
  return { deps, sql, pubsub, logger, audit, track };
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
    mockDispatchDriver.mockResolvedValue(undefined);
    mockFaultUnbilledSession.mockImplementation(() => {
      calls.push('fault');
      return Promise.resolve(true);
    });
    mockDispatchDriver.mockImplementation(() => {
      calls.push('notice');
      return Promise.resolve();
    });
  });

  const claimRow = {
    driver_id: 'drv-1',
    id_token: 'PREPAID-1',
    cost_ceiling_cents: 2500,
    currency: 'EUR',
    site_name: 'Main Site',
  };

  it('GuestHoldExhausted: claims the session, then publishes the stop with no message, notice or fault', async () => {
    const h = makeHarness();
    h.sql.mockImplementationOnce((strings: TemplateStringsArray) => {
      calls.push('claim');
      expect(strings.join('?')).toContain('stopped_reason IS NULL');
      return Promise.resolve([{ ...claimRow, driver_id: null, id_token: null }]);
    });
    await stopSessionForPayment(h.deps, target, 'GuestHoldExhausted');
    expect(calls).toEqual(['claim', 'publish']);
    expect(h.sql.mock.calls[0]?.slice(1)).toEqual(['GuestHoldExhausted', 'sess-1', 'any', 'any']);
    expect(mockPublishOcppCommand).toHaveBeenCalledWith(h.pubsub, {
      stationId: 'CS-1',
      action: 'RequestStopTransaction',
      payload: { transactionId: 'tx-1' },
    });
    expect(mockDispatchOneShot).not.toHaveBeenCalled();
    expect(mockDispatchDriver).not.toHaveBeenCalled();
    expect(mockFaultUnbilledSession).not.toHaveBeenCalled();
  });

  it('PrepaidCreditExhausted: claims, publishes the stop, shows the prepaid message and notifies the driver once', async () => {
    const h = makeHarness();
    h.sql.mockImplementationOnce((strings: TemplateStringsArray) => {
      calls.push('claim');
      expect(strings.join('?')).toContain('stopped_reason IS NULL');
      return Promise.resolve([claimRow]);
    });
    await stopSessionForPayment(h.deps, target, 'PrepaidCreditExhausted');
    expect(calls).toEqual(['claim', 'publish', 'settings', 'message', 'notice']);
    expect(h.sql.mock.calls[0]?.slice(1)).toEqual([
      'PrepaidCreditExhausted',
      'sess-1',
      'any',
      'any',
    ]);
    expect(mockDispatchOneShot).toHaveBeenCalledWith(
      h.pubsub,
      h.sql,
      expect.objectContaining({ state: 'prepaid_exhausted', stationOcppId: 'CS-1' }),
      expect.any(Object),
    );
    expect(mockDispatchDriver).toHaveBeenCalledWith(
      h.sql,
      'prepaid.CreditExhausted',
      'drv-1',
      {
        idToken: 'PREPAID-1',
        siteName: 'Main Site',
        stationId: 'CS-1',
        transactionId: 'tx-1',
        creditFormatted: { cents: 2500, currency: 'EUR' },
        currency: 'EUR',
      },
      ['templates'],
      h.pubsub,
    );
    expect(h.track).toHaveBeenCalledTimes(1);
    expect(mockFaultUnbilledSession).not.toHaveBeenCalled();

    // A second stop for the same session finds it claimed: no second notice.
    calls.length = 0;
    await stopSessionForPayment(h.deps, target, 'PrepaidCreditExhausted');
    expect(calls).toEqual(['claim']);
    expect(mockDispatchDriver).toHaveBeenCalledTimes(1);
  });

  it('PrepaidCreditExhausted: a token without a driver notifies nobody', async () => {
    const h = makeHarness();
    h.sql.mockImplementationOnce(() => {
      calls.push('claim');
      return Promise.resolve([{ ...claimRow, driver_id: null }]);
    });
    await stopSessionForPayment(h.deps, target, 'PrepaidCreditExhausted');
    expect(mockDispatchDriver).not.toHaveBeenCalled();
    expect(mockDispatchOneShot).toHaveBeenCalledTimes(1);
  });

  it('PrepaidCreditExhausted: a notice that fails is logged at warn', async () => {
    const h = makeHarness();
    h.sql.mockImplementationOnce(() => {
      calls.push('claim');
      return Promise.resolve([claimRow]);
    });
    mockDispatchDriver.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    await stopSessionForPayment(h.deps, target, 'PrepaidCreditExhausted');
    expect(h.track).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-1' }),
        'Prepaid credit exhausted notice failed; continuing',
      );
    });
  });

  for (const reason of ['PrepaidCreditExhausted', 'GuestHoldExhausted'] as const) {
    describe(reason, () => {
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

  describe('AccountCreditLimit', () => {
    const noticeRow = { driver_id: 'drv-1', fleet_name: 'Acme', site_name: 'Main Site' };

    function accountHarness(rows: unknown[] = [noticeRow]): Harness {
      const h = makeHarness();
      h.sql.mockImplementation((strings: TemplateStringsArray) => {
        const text = strings.join('?');
        if (text.includes('FROM settings')) {
          calls.push('settings');
        } else if (text.includes('session_tariff_segments')) {
          calls.push('segments');
        } else if (text.includes('LEFT JOIN fleets')) {
          calls.push('notice-read');
          return Promise.resolve(rows);
        }
        return Promise.resolve([] as unknown[]);
      });
      return h;
    }

    it('faults before it publishes, shows the limit message and notifies the driver once', async () => {
      const h = accountHarness();
      await stopSessionForPayment(h.deps, target, 'AccountCreditLimit');
      expect(calls).toEqual([
        'fault',
        'segments',
        'publish',
        'settings',
        'message',
        'notice-read',
        'notice',
        'audit',
      ]);
      expect(mockFaultUnbilledSession).toHaveBeenCalledWith(h.sql, {
        sessionId: 'sess-1',
        reason: 'AccountCreditLimit',
        endedAt: expect.any(Date) as Date,
      });
      expect(mockDispatchOneShot).toHaveBeenCalledWith(
        h.pubsub,
        h.sql,
        expect.objectContaining({ state: 'account_credit_limit' }),
        { ttlSeconds: 30, autoClearMs: 30_000 },
      );
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        h.sql,
        'payment.AccountCreditLimit',
        'drv-1',
        { fleetName: 'Acme', siteName: 'Main Site', stationId: 'CS-1', transactionId: 'tx-1' },
        ['templates'],
        h.pubsub,
      );
      expect(h.track).toHaveBeenCalledTimes(1);
    });

    it('sends no second notice when the session was already faulted', async () => {
      const h = accountHarness();
      mockFaultUnbilledSession.mockResolvedValueOnce(false);
      await stopSessionForPayment(h.deps, target, 'AccountCreditLimit');
      expect(mockDispatchDriver).not.toHaveBeenCalled();
      expect(calls).toContain('publish');
    });

    it('notifies nobody for a session without a driver', async () => {
      const h = accountHarness([{ driver_id: null, fleet_name: 'Acme', site_name: null }]);
      await stopSessionForPayment(h.deps, target, 'AccountCreditLimit');
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });

    it('logs a failed notice at warn', async () => {
      const h = accountHarness();
      mockDispatchDriver.mockRejectedValueOnce(new Error('smtp down'));
      await stopSessionForPayment(h.deps, target, 'AccountCreditLimit');
      await (h.track.mock.calls[0]?.[0] as Promise<unknown>);
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-1' }),
        'Account credit limit notice failed; continuing',
      );
    });

    describe('at the ceiling (plan S8)', () => {
      function ceilingHarness(claimed: boolean): Harness {
        const h = accountHarness();
        const read = h.sql.getMockImplementation();
        h.sql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join('?').includes('SET stopped_reason')) {
            calls.push('claim');
            return Promise.resolve(claimed ? [claimRow] : []);
          }
          return read != null ? read(strings, ...values) : Promise.resolve([]);
        });
        return h;
      }

      it('claims the session without a fault, publishes, then shows the message and notifies', async () => {
        const h = ceilingHarness(true);
        await stopSessionForPayment(h.deps, target, 'AccountCreditLimit', { atCeiling: true });
        expect(calls).toEqual(['claim', 'publish', 'settings', 'message', 'notice-read', 'notice']);
        expect(h.sql.mock.calls[0]?.slice(1)).toEqual([
          'AccountCreditLimit',
          'sess-1',
          'any',
          'any',
        ]);
        expect(mockFaultUnbilledSession).not.toHaveBeenCalled();
        expect(mockDispatchOneShot).toHaveBeenCalledWith(
          h.pubsub,
          h.sql,
          expect.objectContaining({ state: 'account_credit_limit' }),
          expect.any(Object),
        );
        expect(mockDispatchDriver).toHaveBeenCalledWith(
          h.sql,
          'payment.AccountCreditLimit',
          'drv-1',
          expect.objectContaining({ fleetName: 'Acme' }),
          ['templates'],
          h.pubsub,
        );
        expect(h.audit).not.toHaveBeenCalled();
      });

      it('sends nothing when another call claimed the session', async () => {
        const h = ceilingHarness(false);
        await stopSessionForPayment(h.deps, target, 'AccountCreditLimit', { atCeiling: true });
        expect(calls).toEqual(['claim']);
        expect(mockPublishOcppCommand).not.toHaveBeenCalled();
        expect(mockDispatchDriver).not.toHaveBeenCalled();
      });
    });
  });

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
      expect.objectContaining({ state: 'payment_required' }),
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

  describe('noteCostLimitReached', () => {
    it('claims a prepaid session with the stop claim, then shows the message and notifies, without a stop', async () => {
      const h = makeHarness();
      h.sql.mockImplementationOnce((strings: TemplateStringsArray) => {
        calls.push('claim');
        const text = strings.join('?');
        expect(text).toContain('stopped_reason IS NULL');
        expect(text).toContain('token_id IS NOT NULL AND cost_ceiling_cents IS NOT NULL');
        expect(text).toContain("billing_mode IS DISTINCT FROM 'account'");
        return Promise.resolve([claimRow]);
      });
      await expect(noteCostLimitReached(h.deps, target)).resolves.toBe(true);
      expect(calls).toEqual(['claim', 'settings', 'message', 'notice']);
      expect(h.sql.mock.calls[0]?.slice(1)).toEqual([
        'PrepaidCreditExhausted',
        'sess-1',
        'prepaid',
        'prepaid',
      ]);
      expect(mockPublishOcppCommand).not.toHaveBeenCalled();
      expect(mockDispatchOneShot).toHaveBeenCalledWith(
        h.pubsub,
        h.sql,
        expect.objectContaining({ state: 'prepaid_exhausted' }),
        expect.any(Object),
      );
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        h.sql,
        'prepaid.CreditExhausted',
        'drv-1',
        expect.objectContaining({ creditFormatted: { cents: 2500, currency: 'EUR' } }),
        ['templates'],
        h.pubsub,
      );

      // A later CSMS stop finds the session claimed: no stop, no second notice.
      calls.length = 0;
      await stopSessionForPayment(h.deps, target, 'PrepaidCreditExhausted');
      expect(calls).toEqual(['claim']);
      expect(mockDispatchDriver).toHaveBeenCalledTimes(1);
      expect(mockDispatchOneShot).toHaveBeenCalledTimes(1);
    });

    it('claims an account session once with the account reason (plan S8)', async () => {
      const h = makeHarness();
      h.sql.mockImplementationOnce(() => {
        calls.push('claim');
        return Promise.resolve([]);
      });
      h.sql.mockImplementationOnce(() => {
        calls.push('claim');
        return Promise.resolve([{ ...claimRow, id_token: null }]);
      });
      h.sql.mockImplementationOnce(() => {
        calls.push('settings');
        return Promise.resolve([]);
      });
      h.sql.mockImplementationOnce(() => {
        calls.push('notice-read');
        return Promise.resolve([{ driver_id: 'drv-1', fleet_name: 'Acme', site_name: null }]);
      });
      await expect(noteCostLimitReached(h.deps, target)).resolves.toBe(true);
      expect(calls).toEqual(['claim', 'claim', 'settings', 'message', 'notice-read', 'notice']);
      expect(h.sql.mock.calls[1]?.slice(1)).toEqual([
        'AccountCreditLimit',
        'sess-1',
        'account',
        'account',
      ]);
      expect(sqlText(h.sql.mock.calls[1] ?? [])).toContain(
        "billing_mode = 'account' AND cost_ceiling_cents IS NOT NULL",
      );
      expect(mockPublishOcppCommand).not.toHaveBeenCalled();
      expect(mockDispatchOneShot).toHaveBeenCalledWith(
        h.pubsub,
        h.sql,
        expect.objectContaining({ state: 'account_credit_limit' }),
        expect.any(Object),
      );
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        h.sql,
        'payment.AccountCreditLimit',
        'drv-1',
        expect.objectContaining({ fleetName: 'Acme' }),
        ['templates'],
        h.pubsub,
      );
    });

    it('leaves an account session unclaimed when its ceiling was raised at the report', async () => {
      const h = makeHarness();
      await expect(
        noteCostLimitReached(h.deps, target, { accountCeilingRaised: true }),
      ).resolves.toBe(false);
      // Only the prepaid claim ran (a prepaid session is unchanged); no account claim.
      expect(calls).toEqual(['claim']);
      expect(h.sql.mock.calls[0]?.slice(1)).toEqual([
        'PrepaidCreditExhausted',
        'sess-1',
        'prepaid',
        'prepaid',
      ]);
      expect(mockDispatchOneShot).not.toHaveBeenCalled();
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });

    it('sends nothing when the session is already claimed or has no prepaid or account ceiling', async () => {
      const h = makeHarness();
      await expect(noteCostLimitReached(h.deps, target)).resolves.toBe(false);
      expect(calls).toEqual(['claim', 'claim']);
      expect(mockDispatchOneShot).not.toHaveBeenCalled();
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });

    it('throws a failed claim to the caller', async () => {
      const h = makeHarness();
      const lost = new Error('connection lost');
      h.sql.mockImplementationOnce(() => Promise.reject(lost));
      await expect(noteCostLimitReached(h.deps, target)).rejects.toBe(lost);
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });
  });
});

describe('ceilingStopReason', () => {
  it('derives the stop reason from how the session is paid', () => {
    expect(ceilingStopReason({ billingMode: 'account', tokenId: 'tok-1' })).toBe(
      'AccountCreditLimit',
    );
    expect(ceilingStopReason({ billingMode: null, tokenId: 'tok-1' })).toBe(
      'PrepaidCreditExhausted',
    );
    expect(ceilingStopReason({ billingMode: null, tokenId: null })).toBe('GuestHoldExhausted');
    expect(ceilingStopReason({ billingMode: 'card', tokenId: null })).toBe('GuestHoldExhausted');
  });
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
