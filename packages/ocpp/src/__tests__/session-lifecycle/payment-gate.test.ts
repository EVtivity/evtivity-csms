// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetCreditCheck, SessionBilling, TariffPriceSnapshot } from '@evtivity/database';
import type { HoldOutcome } from '@evtivity/payments';
import type { ProjectionDeps } from '../../server/projection-support/context.js';
import {
  decideAfterHold,
  planPaymentGate,
  runPaymentGate,
} from '../../server/session-lifecycle/payment-gate.js';
import type {
  PaymentGateDecision,
  PaymentGateInput,
} from '../../server/session-lifecycle/payment-gate.js';

const {
  calls,
  mockAuthorizeSessionHold,
  mockActivePaymentProvider,
  mockStopSessionForPayment,
  mockDispatchDriverNotification,
  mockDispatchSystemNotification,
  mockStampSessionBilling,
  mockCheckFleetCreditLimit,
  mockDispatchFleetCreditLimitNotices,
} = vi.hoisted(() => ({
  calls: [] as string[],
  mockAuthorizeSessionHold: vi.fn(),
  mockActivePaymentProvider: vi.fn(),
  mockStopSessionForPayment: vi.fn(),
  mockDispatchDriverNotification: vi.fn(),
  mockDispatchSystemNotification: vi.fn(),
  mockStampSessionBilling: vi.fn(),
  mockCheckFleetCreditLimit: vi.fn(),
  mockDispatchFleetCreditLimitNotices: vi.fn(),
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  stampSessionBilling: mockStampSessionBilling,
  checkFleetCreditLimit: mockCheckFleetCreditLimit,
}));

vi.mock('@evtivity/payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/payments')>()),
  authorizeSessionHold: mockAuthorizeSessionHold,
  dispatchFleetCreditLimitNotices: mockDispatchFleetCreditLimitNotices,
}));

vi.mock('../../lib/payments.js', () => ({
  activePaymentProvider: mockActivePaymentProvider,
}));

vi.mock('../../server/session-lifecycle/payment-stop.js', () => ({
  stopSessionForPayment: mockStopSessionForPayment,
}));

vi.mock('../../server/notification-dispatcher.js', () => ({
  dispatchDriverNotification: mockDispatchDriverNotification,
  dispatchSystemNotification: mockDispatchSystemNotification,
  ALL_TEMPLATES_DIRS: [],
}));

const freeTariff: TariffPriceSnapshot = {
  id: 'tariff-free',
  pricePerKwh: '0',
  pricePerMinute: null,
  pricePerSession: '0.00',
  idleFeePricePerMinute: null,
  reservationFeePerMinute: null,
  taxRate: null,
};

const pricedTariff: TariffPriceSnapshot = {
  ...freeTariff,
  id: 'tariff-priced',
  pricePerKwh: '0.35',
};

const reservationFeeTariff: TariffPriceSnapshot = {
  ...freeTariff,
  id: 'tariff-reservation-fee',
  reservationFeePerMinute: '0.10',
};

const input: PaymentGateInput = {
  sessionId: 'sess-1',
  transactionId: 'tx-1',
  driverId: null,
  stationDbId: 'station-uuid',
  ocppStationId: 'CS-1',
  siteId: 'site-1',
  isRoaming: false,
  idToken: 'TOKEN123456',
  guestStatus: null,
  guestEmail: null,
  prepaidBalanceCents: null,
  reserved: false,
  sessionTariff: pricedTariff,
};

describe('planPaymentGate', () => {
  it.each<[string, Partial<PaymentGateInput>, PaymentGateDecision]>([
    [
      'roaming, even with a driver and a priced tariff',
      { isRoaming: true, driverId: 'drv-1' },
      { kind: 'allow', why: 'roaming' },
    ],
    [
      'prepaid with credit',
      { driverId: 'drv-1', prepaidBalanceCents: 500 },
      { kind: 'allow', why: 'prepaid_funded' },
    ],
    [
      'prepaid with a zero balance',
      { driverId: 'drv-1', prepaidBalanceCents: 0 },
      { kind: 'stop', why: 'prepaid_no_credit', reason: 'PaymentFailed', notice: null },
    ],
    [
      'prepaid with a zero balance on a free tariff',
      { driverId: 'drv-1', prepaidBalanceCents: 0, sessionTariff: freeTariff },
      { kind: 'stop', why: 'prepaid_no_credit', reason: 'PaymentFailed', notice: null },
    ],
    [
      'card driver on a free tariff',
      { driverId: 'drv-1', sessionTariff: freeTariff },
      { kind: 'allow', why: 'free_tariff' },
    ],
    [
      'card driver without a tariff',
      { driverId: 'drv-1', sessionTariff: null },
      { kind: 'allow', why: 'free_tariff' },
    ],
    ['card driver on a priced tariff', { driverId: 'drv-1' }, { kind: 'hold', driverId: 'drv-1' }],
    [
      'card driver with a reservation fee, not reserved',
      { driverId: 'drv-1', sessionTariff: reservationFeeTariff },
      { kind: 'allow', why: 'free_tariff' },
    ],
    [
      'card driver with a reservation fee, reserved',
      { driverId: 'drv-1', sessionTariff: reservationFeeTariff, reserved: true },
      { kind: 'hold', driverId: 'drv-1' },
    ],
    [
      'card driver who also matches a guest session',
      { driverId: 'drv-1', guestStatus: 'pending_payment', guestEmail: 'g@example.com' },
      { kind: 'hold', driverId: 'drv-1' },
    ],
    [
      'guest authorized at checkout',
      { guestStatus: 'payment_authorized', guestEmail: 'g@example.com' },
      { kind: 'allow', why: 'guest_authorized' },
    ],
    [
      'guest not authorized, with an email',
      { guestStatus: 'pending_payment', guestEmail: 'g@example.com' },
      {
        kind: 'stop',
        why: 'guest_not_authorized',
        reason: 'GuestPaymentNotAuthorized',
        notice: { kind: 'guestPreAuthFailed', email: 'g@example.com' },
      },
    ],
    [
      'guest not authorized, without an email',
      { guestStatus: 'pending_payment' },
      {
        kind: 'stop',
        why: 'guest_not_authorized',
        reason: 'GuestPaymentNotAuthorized',
        notice: null,
      },
    ],
    [
      'guest not authorized on a free tariff',
      { guestStatus: 'expired', sessionTariff: freeTariff },
      {
        kind: 'stop',
        why: 'guest_not_authorized',
        reason: 'GuestPaymentNotAuthorized',
        notice: null,
      },
    ],
    [
      'no driver, no guest session, no roaming',
      {},
      { kind: 'stop', why: 'anonymous', reason: 'AnonymousSession', notice: null },
    ],
    [
      'no driver on a free tariff',
      { sessionTariff: freeTariff },
      { kind: 'stop', why: 'anonymous', reason: 'AnonymousSession', notice: null },
    ],
  ])('plans %s', (_name, overrides, expected) => {
    expect(planPaymentGate({ ...input, ...overrides })).toEqual(expected);
  });

  const account: SessionBilling = { mode: 'account', fleetId: 'flt-1', fleetName: 'Acme' };
  const card: SessionBilling = { mode: 'card', fleetId: null, fleetName: null };

  it.each<[string, Partial<PaymentGateInput>, SessionBilling, PaymentGateDecision]>([
    [
      'an account driver on a priced tariff (no hold)',
      { driverId: 'drv-1' },
      account,
      { kind: 'allow', why: 'account' },
    ],
    [
      'an account driver on a free tariff',
      { driverId: 'drv-1', sessionTariff: freeTariff },
      account,
      { kind: 'allow', why: 'account' },
    ],
    [
      'a prepaid token of an account driver (prepaid wins)',
      { driverId: 'drv-1', prepaidBalanceCents: 500 },
      account,
      { kind: 'allow', why: 'prepaid_funded' },
    ],
    [
      'a roaming session with an account stamp (roaming wins)',
      { driverId: 'drv-1', isRoaming: true },
      account,
      { kind: 'allow', why: 'roaming' },
    ],
    [
      'a card stamp on a priced tariff',
      { driverId: 'drv-1' },
      card,
      { kind: 'hold', driverId: 'drv-1' },
    ],
    [
      'an account stamp without a driver (anonymous)',
      {},
      account,
      { kind: 'stop', why: 'anonymous', reason: 'AnonymousSession', notice: null },
    ],
  ])('plans %s', (_name, overrides, billing, expected) => {
    expect(planPaymentGate({ ...input, ...overrides }, billing)).toEqual(expected);
  });

  it.each<[FleetCreditCheck['level'], PaymentGateDecision]>([
    ['ok', { kind: 'allow', why: 'account' }],
    ['warning', { kind: 'allow', why: 'account' }],
    [
      'reached',
      {
        kind: 'stop',
        why: 'account_credit_limit',
        reason: 'AccountCreditLimit',
        fleetId: 'flt-1',
        notice: null,
      },
    ],
  ])('plans an account start with the fleet credit %s', (level, expected) => {
    expect(
      planPaymentGate({ ...input, driverId: 'drv-1' }, account, {
        fleetId: 'flt-1',
        level,
        remainingCents: level === 'reached' ? 0 : 1500,
        ceilingCents: level === 'reached' ? 0 : 1500,
      }),
    ).toEqual(expected);
  });

  it('stops an account start whose reserved ceiling is 0 below the limit (plan S8)', () => {
    expect(
      planPaymentGate({ ...input, driverId: 'drv-1' }, account, {
        fleetId: 'flt-1',
        level: 'ok',
        remainingCents: 0,
        ceilingCents: 0,
      }),
    ).toEqual({
      kind: 'stop',
      why: 'account_credit_limit',
      reason: 'AccountCreditLimit',
      fleetId: 'flt-1',
      notice: null,
    });
  });

  it('decides from the stored ceiling of an earlier gate run', () => {
    expect(
      planPaymentGate({ ...input, driverId: 'drv-1' }, account, {
        fleetId: 'flt-1',
        level: 'ok',
        remainingCents: 0,
        ceilingCents: 800,
      }),
    ).toEqual({ kind: 'allow', why: 'account' });
  });

  it('ignores the credit check for a prepaid token of an account driver', () => {
    expect(
      planPaymentGate({ ...input, driverId: 'drv-1', prepaidBalanceCents: 500 }, account, {
        fleetId: 'flt-1',
        level: 'reached',
        remainingCents: 0,
        ceilingCents: null,
      }),
    ).toEqual({ kind: 'allow', why: 'prepaid_funded' });
  });
});

describe('decideAfterHold', () => {
  it.each<[HoldOutcome, PaymentGateDecision]>([
    [
      { outcome: 'authorized', paymentRecordId: 1, paymentId: 'pi_1' },
      { kind: 'allow', why: 'hold_authorized' },
    ],
    [
      { outcome: 'exists', paymentRecordId: 1, status: 'pre_authorized' },
      { kind: 'allow', why: 'hold_exists' },
    ],
    [
      { outcome: 'exists', paymentRecordId: 1, status: 'pending' },
      { kind: 'allow', why: 'hold_exists' },
    ],
    [
      { outcome: 'exists', paymentRecordId: 1, status: 'captured' },
      { kind: 'allow', why: 'hold_exists' },
    ],
    [
      { outcome: 'exists', paymentRecordId: 1, status: 'failed' },
      {
        kind: 'stop',
        why: 'hold_terminal',
        reason: 'PaymentFailed',
        status: 'failed',
        notice: null,
      },
    ],
    [
      { outcome: 'exists', paymentRecordId: 1, status: 'cancelled' },
      {
        kind: 'stop',
        why: 'hold_terminal',
        reason: 'PaymentFailed',
        status: 'cancelled',
        notice: null,
      },
    ],
    [
      { outcome: 'not_configured', providerId: 'adyen' },
      { kind: 'allow', why: 'provider_not_configured', providerId: 'adyen' },
    ],
    [
      { outcome: 'no_method' },
      {
        kind: 'stop',
        why: 'no_payment_method',
        reason: 'MissingPaymentMethod',
        notice: { kind: 'missingPaymentMethod', driverId: 'drv-1' },
      },
    ],
    [
      { outcome: 'declined', reason: 'card_declined', paymentRecordId: 7, failure: 'declined' },
      {
        kind: 'stop',
        why: 'hold_declined',
        reason: 'PaymentFailed',
        failure: 'declined',
        notice: { kind: 'preAuthFailed', driverId: 'drv-1', reason: 'card_declined' },
      },
    ],
    [
      {
        outcome: 'declined',
        reason: 'provider unreachable',
        paymentRecordId: 7,
        failure: 'provider_error',
      },
      {
        kind: 'stop',
        why: 'hold_declined',
        reason: 'PaymentFailed',
        failure: 'provider_error',
        notice: { kind: 'preAuthFailed', driverId: 'drv-1', reason: 'provider unreachable' },
      },
    ],
    [
      {
        outcome: 'declined',
        reason: 'Payout account not ready',
        paymentRecordId: null,
        failure: 'declined',
        code: 'payout_account_not_ready',
      },
      {
        kind: 'stop',
        why: 'hold_declined',
        reason: 'PaymentFailed',
        failure: 'declined',
        notice: { kind: 'preAuthFailed', driverId: 'drv-1', reason: 'Payout account not ready' },
      },
    ],
    [
      { outcome: 'record_failed', reason: 'insert failed' },
      {
        kind: 'stop',
        why: 'hold_record_failed',
        reason: 'PaymentFailed',
        notice: {
          kind: 'preAuthFailed',
          driverId: 'drv-1',
          reason: 'Payment recording failed. Please contact support.',
        },
      },
    ],
  ])('decides $outcome', (outcome, expected) => {
    expect(decideAfterHold(outcome, 'drv-1')).toEqual(expected);
  });

  it('throws on an unknown outcome instead of returning no decision', () => {
    const unknown = { outcome: 'surprise' } as unknown as HoldOutcome;
    expect(() => decideAfterHold(unknown, 'drv-1')).toThrow('Unknown hold outcome: surprise');
  });
});

describe('runPaymentGate', () => {
  let logger: {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  let deps: ProjectionDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    mockActivePaymentProvider.mockResolvedValue({ id: 'stripe' });
    mockStopSessionForPayment.mockImplementation(() => {
      calls.push('stop');
      return Promise.resolve();
    });
    mockDispatchDriverNotification.mockResolvedValue(undefined);
    mockDispatchSystemNotification.mockResolvedValue(undefined);
    mockStampSessionBilling.mockResolvedValue({ mode: 'card', fleetId: null, fleetName: null });
    mockCheckFleetCreditLimit.mockResolvedValue(null);
    mockDispatchFleetCreditLimitNotices.mockResolvedValue(null);
    logger = {
      warn: vi.fn(() => calls.push('log')),
      error: vi.fn(() => calls.push('log')),
      debug: vi.fn(),
    };
    deps = {
      sql: vi.fn(),
      eventBus: { track: vi.fn(() => calls.push('track')) },
      pubsub: {
        publish: vi.fn(() => {
          calls.push('publish');
          return Promise.resolve();
        }),
      },
      logger,
      payments: {},
      lookups: {},
      notify: {},
    } as unknown as ProjectionDeps;
  });

  it.each<[string, Partial<PaymentGateInput>]>([
    ['a card driver on a priced tariff', { driverId: 'drv-1' }],
    [
      'a reserved card driver on a reservation fee tariff',
      { driverId: 'drv-1', sessionTariff: reservationFeeTariff, reserved: true },
    ],
  ])(
    'skips the hold with a warning when no payment provider is active, for %s',
    async (_name, overrides) => {
      mockActivePaymentProvider.mockResolvedValue(null);

      const decision = await runPaymentGate(deps, { ...input, ...overrides });

      expect(decision).toEqual({ kind: 'allow', why: 'payments_off' });
      expect(mockActivePaymentProvider).toHaveBeenCalledWith(logger);
      expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
      expect(mockStopSessionForPayment).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { sessionId: 'sess-1' },
        'No active payment provider; session not pre-authorized',
      );
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it('logs at warn, stops, then tracks the notice, then publishes, for a declined hold', async () => {
    mockAuthorizeSessionHold.mockResolvedValue({
      outcome: 'declined',
      reason: 'card_declined',
      paymentRecordId: 7,
      failure: 'declined',
    });

    const decision = await runPaymentGate(deps, { ...input, driverId: 'drv-1' });

    expect(decision).toMatchObject({ kind: 'stop', why: 'hold_declined' });
    expect(calls).toEqual(['log', 'stop', 'track', 'publish']);
    expect(logger.warn).toHaveBeenCalledWith(
      { sessionId: 'sess-1', reason: 'card_declined' },
      'Auto pre-auth declined, stopping session',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs at error and stops when the provider call failed', async () => {
    mockAuthorizeSessionHold.mockResolvedValue({
      outcome: 'declined',
      reason: 'provider unreachable',
      paymentRecordId: 7,
      failure: 'provider_error',
    });

    const decision = await runPaymentGate(deps, { ...input, driverId: 'drv-1' });

    expect(decision).toMatchObject({ kind: 'stop', why: 'hold_declined' });
    expect(calls).toEqual(['log', 'stop', 'track', 'publish']);
    expect(logger.error).toHaveBeenCalledWith(
      { sessionId: 'sess-1', reason: 'provider unreachable' },
      'Auto pre-auth failed, stopping session',
    );
  });

  it.each(['failed', 'cancelled'] as const)(
    'logs at warn and stops with PaymentFailed, without a notice, when the hold record is %s',
    async (status) => {
      mockAuthorizeSessionHold.mockResolvedValue({
        outcome: 'exists',
        paymentRecordId: 3,
        status,
      });

      const decision = await runPaymentGate(deps, { ...input, driverId: 'drv-1' });

      expect(decision).toEqual({
        kind: 'stop',
        why: 'hold_terminal',
        reason: 'PaymentFailed',
        status,
        notice: null,
      });
      expect(calls).toEqual(['log', 'stop']);
      expect(mockStopSessionForPayment).toHaveBeenCalledWith(
        deps,
        expect.objectContaining({ sessionId: 'sess-1' }),
        'PaymentFailed',
        { transactionEnded: false },
      );
      expect(logger.warn).toHaveBeenCalledWith(
        { sessionId: 'sess-1', status },
        'Session hold record is not valid, stopping session',
      );
    },
  );

  it('allows the session when the existing hold record is pre-authorized', async () => {
    mockAuthorizeSessionHold.mockResolvedValue({
      outcome: 'exists',
      paymentRecordId: 3,
      status: 'pre_authorized',
    });

    const decision = await runPaymentGate(deps, { ...input, driverId: 'drv-1' });

    expect(decision).toEqual({ kind: 'allow', why: 'hold_exists' });
    expect(mockStopSessionForPayment).not.toHaveBeenCalled();
  });

  it('logs, stops, then tracks the notice, for a guest without an authorized payment', async () => {
    const decision = await runPaymentGate(deps, {
      ...input,
      guestStatus: 'pending_payment',
      guestEmail: 'g@example.com',
    });

    expect(decision).toMatchObject({ kind: 'stop', why: 'guest_not_authorized' });
    // The guest notice has no csms_events publish.
    expect(calls).toEqual(['log', 'stop', 'track']);
    expect(mockDispatchSystemNotification).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<PaymentGateInput>, PaymentGateDecision['kind']]>([
    ['a guest without an authorized payment', { guestStatus: 'pending_payment' }, 'stop'],
    ['an authorized guest', { guestStatus: 'payment_authorized' }, 'allow'],
    ['an anonymous session', {}, 'stop'],
    ['a roaming session', { isRoaming: true, driverId: 'drv-1' }, 'allow'],
    ['a funded prepaid token', { driverId: 'drv-1', prepaidBalanceCents: 500 }, 'allow'],
    ['a prepaid token without credit', { driverId: 'drv-1', prepaidBalanceCents: 0 }, 'stop'],
    ['a card driver on a free tariff', { driverId: 'drv-1', sessionTariff: freeTariff }, 'allow'],
  ])('never reads the active provider for %s', async (_name, overrides, kind) => {
    const decision = await runPaymentGate(deps, { ...input, ...overrides });

    expect(decision.kind).toBe(kind);
    expect(mockActivePaymentProvider).not.toHaveBeenCalled();
    expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
  });

  it('places the hold when a payment provider is active', async () => {
    mockAuthorizeSessionHold.mockResolvedValue({
      outcome: 'authorized',
      paymentRecordId: 1,
      paymentId: 'pi_1',
    });

    const decision = await runPaymentGate(deps, { ...input, driverId: 'drv-1' });

    expect(decision).toEqual({ kind: 'allow', why: 'hold_authorized' });
    expect(mockActivePaymentProvider).toHaveBeenCalledWith(logger);
    expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stamps an account driver and allows the session without a provider or a hold', async () => {
    mockStampSessionBilling.mockResolvedValue({
      mode: 'account',
      fleetId: 'flt-1',
      fleetName: 'Acme',
    });
    mockActivePaymentProvider.mockResolvedValue(null);

    const decision = await runPaymentGate(deps, { ...input, driverId: 'drv-1' });

    expect(decision).toEqual({ kind: 'allow', why: 'account' });
    expect(mockStampSessionBilling).toHaveBeenCalledWith(deps.sql, 'sess-1', 'drv-1');
    expect(mockActivePaymentProvider).not.toHaveBeenCalled();
    expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
    expect(mockStopSessionForPayment).not.toHaveBeenCalled();
  });

  function creditCheck(level: FleetCreditCheck['level'], totalCents: number): FleetCreditCheck {
    return {
      fleetId: 'flt-1',
      fleetName: 'Acme',
      limitCents: 10_000,
      warningPercent: 80,
      exposure: {
        unbilledCents: totalCents,
        invoicedCents: 0,
        runningCents: 0,
        totalCents,
        currency: 'EUR',
      },
      level,
      remainingCents: Math.max(10_000 - totalCents, 0),
      ceilingCents: Math.max(10_000 - totalCents, 0),
    };
  }

  it('reserves the billing fleet credit for the session under the fleet lock', async () => {
    mockStampSessionBilling.mockResolvedValue({
      mode: 'account',
      fleetId: 'flt-1',
      fleetName: 'Acme',
    });
    mockCheckFleetCreditLimit.mockResolvedValue(creditCheck('ok', 1000));

    const decision = await runPaymentGate(deps, { ...input, driverId: 'drv-1' });

    expect(decision).toEqual({ kind: 'allow', why: 'account' });
    expect(mockCheckFleetCreditLimit).toHaveBeenCalledWith(deps.sql, 'flt-1', {
      reserveForSessionId: 'sess-1',
    });
    expect(mockDispatchFleetCreditLimitNotices).not.toHaveBeenCalled();
  });

  it('allows an account start at the warning percent and notifies the fleet', async () => {
    mockStampSessionBilling.mockResolvedValue({
      mode: 'account',
      fleetId: 'flt-1',
      fleetName: 'Acme',
    });
    const check = creditCheck('warning', 8500);
    mockCheckFleetCreditLimit.mockResolvedValue(check);

    const decision = await runPaymentGate(deps, { ...input, driverId: 'drv-1' });

    expect(decision).toEqual({ kind: 'allow', why: 'account' });
    expect(mockDispatchFleetCreditLimitNotices).toHaveBeenCalledWith(
      check,
      { templatesDirs: [] },
      logger,
    );
    expect(mockStopSessionForPayment).not.toHaveBeenCalled();
  });

  it('stops an account start at the credit limit and notifies the fleet', async () => {
    mockStampSessionBilling.mockResolvedValue({
      mode: 'account',
      fleetId: 'flt-1',
      fleetName: 'Acme',
    });
    const check = creditCheck('reached', 10_000);
    mockCheckFleetCreditLimit.mockResolvedValue(check);

    const decision = await runPaymentGate(deps, { ...input, driverId: 'drv-1' });

    expect(decision).toEqual({
      kind: 'stop',
      why: 'account_credit_limit',
      reason: 'AccountCreditLimit',
      fleetId: 'flt-1',
      notice: null,
    });
    expect(mockStopSessionForPayment).toHaveBeenCalledWith(
      deps,
      {
        sessionId: 'sess-1',
        transactionId: 'tx-1',
        ocppStationId: 'CS-1',
        stationDbId: 'station-uuid',
      },
      'AccountCreditLimit',
      { transactionEnded: false },
    );
    expect(mockDispatchFleetCreditLimitNotices).toHaveBeenCalledWith(
      check,
      { templatesDirs: [] },
      logger,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { sessionId: 'sess-1', fleetId: 'flt-1' },
      'Fleet credit limit reached, stopping account session',
    );
    expect(mockDispatchDriverNotification).not.toHaveBeenCalled();
    expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
  });

  it('fails the gate when the credit check fails (P9)', async () => {
    mockStampSessionBilling.mockResolvedValue({
      mode: 'account',
      fleetId: 'flt-1',
      fleetName: 'Acme',
    });
    mockCheckFleetCreditLimit.mockRejectedValue(new Error('db down'));

    await expect(runPaymentGate(deps, { ...input, driverId: 'drv-1' })).rejects.toThrow('db down');
    expect(mockStopSessionForPayment).not.toHaveBeenCalled();
  });

  it('checks no credit limit for a card driver', async () => {
    mockAuthorizeSessionHold.mockResolvedValue({
      outcome: 'authorized',
      paymentRecordId: 1,
      paymentId: 'pi_1',
    });
    await runPaymentGate(deps, { ...input, driverId: 'drv-1' });
    expect(mockCheckFleetCreditLimit).not.toHaveBeenCalled();
  });

  it('stamps a card driver before the hold', async () => {
    mockAuthorizeSessionHold.mockResolvedValue({
      outcome: 'authorized',
      paymentRecordId: 1,
      paymentId: 'pi_1',
    });

    const decision = await runPaymentGate(deps, { ...input, driverId: 'drv-1' });

    expect(decision).toEqual({ kind: 'allow', why: 'hold_authorized' });
    expect(mockStampSessionBilling).toHaveBeenCalledTimes(1);
    expect(mockStampSessionBilling.mock.invocationCallOrder[0]).toBeLessThan(
      mockAuthorizeSessionHold.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each<[string, Partial<PaymentGateInput>]>([
    ['a prepaid token', { driverId: 'drv-1', prepaidBalanceCents: 500 }],
    ['a roaming session', { driverId: 'drv-1', isRoaming: true }],
    ['a session without a driver', { guestStatus: 'payment_authorized' }],
  ])('writes no billing stamp for %s', async (_name, overrides) => {
    await runPaymentGate(deps, { ...input, ...overrides });
    expect(mockStampSessionBilling).not.toHaveBeenCalled();
  });
});
