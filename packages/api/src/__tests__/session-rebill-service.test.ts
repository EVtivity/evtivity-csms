// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => {
  const answers: { session: Record<string, unknown>[]; record: Record<string, unknown>[][] } = {
    session: [],
    record: [],
  };
  const client = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const text = strings.join('?');
    if (text.includes('FROM charging_sessions s')) return Promise.resolve(answers.session);
    if (text.includes('FROM payment_records')) return Promise.resolve(answers.record.shift() ?? []);
    return Promise.resolve([]);
  };
  return {
    answers,
    client,
    claimSessionRebill: vi.fn(),
    releaseSessionRebill: vi.fn(),
    priceRebill: vi.fn(),
    completeRebilledSession: vi.fn(),
    writeAudit: vi.fn(),
    chargeSessionRebill: vi.fn(),
    settlePrepaidSession: vi.fn(),
    dispatchPrepaidLowCreditNotice: vi.fn(),
    dispatchDriverNotification: vi.fn(),
    publish: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  SESSION_END_FAILED_REASON: 'EndRequestFailed',
  SESSION_REBILL_LEASE_SECONDS: 300,
  client: m.client,
  claimSessionRebill: m.claimSessionRebill,
  releaseSessionRebill: m.releaseSessionRebill,
  priceRebill: m.priceRebill,
  completeRebilledSession: m.completeRebilledSession,
  writeAudit: m.writeAudit,
  sessionAuditLog: { __table: 'session_audit_log' },
}));

vi.mock('@evtivity/payments', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/payments')>('@evtivity/payments');
  return {
    chargeSessionRebill: m.chargeSessionRebill,
    settlePrepaidSession: m.settlePrepaidSession,
    dispatchPrepaidLowCreditNotice: m.dispatchPrepaidLowCreditNotice,
    classifySessionPayment: actual.classifySessionPayment,
    isRebillRecord: actual.isRebillRecord,
    isStaleRebillCharge: actual.isStaleRebillCharge,
  };
});

vi.mock('@evtivity/lib', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib')>('@evtivity/lib');
  return { ...actual, dispatchDriverNotification: m.dispatchDriverNotification };
});
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish: m.publish }) }));
vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: ['templates'] }));
vi.mock('../lib/payments.js', () => ({
  paymentContext: (logger: unknown) => ({ registry: {}, logger }),
}));

import { AppError } from '@evtivity/lib';
import {
  getSessionRebillState,
  rebillSession,
  SessionRebillRefusedError,
  type SessionRebillContext,
} from '../services/session-rebill.service.js';

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const ctx = {
  actor: {
    actor: 'operator',
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  },
  log,
  siteIds: null,
} as unknown as SessionRebillContext;

const SESSION = {
  id: 'ses_1',
  status: 'faulted',
  stopped_reason: 'EndRequestFailed',
  rebill_status: null,
  rebill_claimed_at: null,
  driver_id: 'drv_1',
  is_roaming: false,
  free_vend: false,
  tariff_id: 'trf_1',
  transaction_id: 'tx-1',
  started_at: '2026-06-04T00:00:00Z',
  currency: 'EUR',
  tariff_tax_rate: '0.19',
  energy_delivered_wh: '10000',
  station_uuid: 'sta_1',
  station_ocpp_id: 'CS-1',
  site_id: 'sit_1',
  site_name: 'Main',
  prepaid: false,
  guest_session: false,
};

const BREAKDOWN = {
  basis: 'net',
  grossCents: 1190,
  netCents: 1000,
  taxCents: 190,
  taxLines: [{ rate: 0.19, netCents: 1000, taxCents: 190, grossCents: 1190 }],
  components: null,
};
const ENDED_AT = new Date('2026-06-04T01:00:00Z');

function useSession(
  overrides: Record<string, unknown> = {},
  record: Record<string, unknown> | null = null,
): void {
  m.answers.session = [{ ...SESSION, ...overrides }];
  m.answers.record = record == null ? [[]] : [[record]];
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SessionRebillRefusedError) return `NOT_ELIGIBLE:${err.reason}`;
    if (err instanceof AppError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.clearAllMocks();
  useSession();
  m.claimSessionRebill.mockResolvedValue(true);
  m.priceRebill.mockResolvedValue({ breakdown: BREAKDOWN, endedAt: ENDED_AT, energyWh: 10000 });
  m.completeRebilledSession.mockResolvedValue(true);
  m.chargeSessionRebill.mockResolvedValue({
    status: 'charged',
    paymentRecordId: 9,
    provider: 'stripe',
    amountCents: 1190,
    recorded: true,
  });
  m.dispatchDriverNotification.mockResolvedValue(undefined);
  m.publish.mockResolvedValue(undefined);
});

describe('rebillSession', () => {
  it('charges the recomputed cost, completes the session, audits and sends the receipt', async () => {
    const result = await rebillSession('ses_1', ctx);
    expect(result).toEqual({
      sessionId: 'ses_1',
      rebillStatus: 'billed',
      result: 'charged',
      manualReason: null,
      finalCostCents: 1190,
      currency: 'EUR',
      endedAt: ENDED_AT,
      paymentRecordId: 9,
      failureReason: null,
    });
    expect(m.chargeSessionRebill).toHaveBeenCalledWith(
      {
        sessionId: 'ses_1',
        driverId: 'drv_1',
        siteId: 'sit_1',
        grossCents: 1190,
        currency: 'EUR',
        taxRate: 0.19,
      },
      expect.objectContaining({ logger: log }),
    );
    expect(m.completeRebilledSession).toHaveBeenCalledWith(m.client, {
      sessionId: 'ses_1',
      breakdown: BREAKDOWN,
      endedAt: ENDED_AT,
      outcome: 'billed',
    });
    expect(m.writeAudit).toHaveBeenCalledWith(
      { table: { __table: 'session_audit_log' }, idColumn: 'session_id' },
      expect.objectContaining({
        entityId: 'ses_1',
        action: 'rebilled',
        actor: 'operator',
        actorUserId: 'usr_1',
        after: expect.objectContaining({ status: 'completed', result: 'charged' }) as unknown,
      }),
      undefined,
      log,
    );
    expect(m.dispatchDriverNotification).toHaveBeenCalledWith(
      m.client,
      'session.Receipt',
      'drv_1',
      expect.objectContaining({ finalCostCents: 1190, stationId: 'CS-1', notCharged: false }),
      ['templates'],
      expect.anything(),
    );
    const events = m.publish.mock.calls.map(
      (c) => JSON.parse(c[1] as string) as { eventType: string },
    );
    expect(events.map((e) => e.eventType)).toEqual(['session.updated', 'payment.settled']);
  });

  it.each([
    [{ status: 'completed', stopped_reason: 'EVDisconnected' }, 'NOT_ELIGIBLE:status'],
    [{ status: 'faulted', stopped_reason: 'PaymentFailed' }, 'NOT_ELIGIBLE:status'],
    [{ status: 'completed', rebill_status: 'billed' }, 'NOT_ELIGIBLE:already_rebilled'],
    [{ rebill_status: 'manual' }, 'NOT_ELIGIBLE:already_rebilled'],
    [{ is_roaming: true }, 'NOT_ELIGIBLE:roaming'],
    [{ free_vend: true }, 'NOT_ELIGIBLE:free_vend'],
    [{ tariff_id: null }, 'NOT_ELIGIBLE:no_tariff'],
    [{ rebill_status: 'in_progress', rebill_claimed_at: new Date() }, 'SESSION_REBILL_IN_PROGRESS'],
  ])('refuses an ineligible session (%j)', async (overrides, code) => {
    useSession(overrides);
    expect(await refusal(rebillSession('ses_1', ctx))).toBe(code);
    expect(m.claimSessionRebill).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'pre_authorized' }, 'SESSION_REBILL_PAYMENT_PENDING'],
    [{ status: 'cancelled', pending_operation: 'cancel' }, 'SESSION_REBILL_PAYMENT_PENDING'],
    [{ status: 'captured' }, 'NOT_ELIGIBLE:paid'],
    [{ status: 'refunded' }, 'NOT_ELIGIBLE:paid'],
  ])('refuses a session whose record holds a payment (%j)', async (record, code) => {
    useSession({}, { id: 4, payment_source: 'web_portal', pending_operation: null, ...record });
    expect(await refusal(rebillSession('ses_1', ctx))).toBe(code);
    expect(m.claimSessionRebill).not.toHaveBeenCalled();
  });

  it('takes over a cancelled hold and resumes a record the re-bill wrote', async () => {
    useSession({}, { id: 4, status: 'cancelled', payment_source: 'web_portal' });
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({ result: 'charged' });
    useSession({}, { id: 4, status: 'pending', metadata: { rebill: {} } });
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({ result: 'charged' });
  });

  it('answers 404 for a session on a site the operator cannot access', async () => {
    expect(await refusal(rebillSession('ses_1', { ...ctx, siteIds: ['sit_other'] }))).toBe(
      'SESSION_NOT_FOUND',
    );
    m.answers.session = [];
    expect(await refusal(rebillSession('ses_1', ctx))).toBe('SESSION_NOT_FOUND');
  });

  it('charges once: a second request finds the claim taken', async () => {
    m.claimSessionRebill.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const [first, second] = await Promise.allSettled([
      rebillSession('ses_1', ctx),
      rebillSession('ses_1', ctx),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') {
      expect((second.reason as AppError).code).toBe('SESSION_REBILL_IN_PROGRESS');
    }
    expect(m.chargeSessionRebill).toHaveBeenCalledOnce();
  });

  it('falls back to manual billing on a decline, without a receipt', async () => {
    m.chargeSessionRebill.mockResolvedValue({
      status: 'failed',
      paymentRecordId: 9,
      reason: 'Your card was declined.',
      code: 'card_declined',
    });
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({
      rebillStatus: 'manual',
      result: 'manual',
      manualReason: 'payment_failed',
      paymentRecordId: 9,
      failureReason: 'Your card was declined.',
    });
    expect(m.completeRebilledSession).toHaveBeenCalledWith(
      m.client,
      expect.objectContaining({ outcome: 'manual' }),
    );
    expect(m.writeAudit.mock.calls[0]?.[1]).toMatchObject({ action: 'manual_billing' });
    expect(m.dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('falls back to manual billing when the card needs authentication off session', async () => {
    m.chargeSessionRebill.mockResolvedValue({
      status: 'failed',
      paymentRecordId: 9,
      reason: 'Your card requires authentication.',
      code: 'authentication_required',
    });
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({
      rebillStatus: 'manual',
      manualReason: 'payment_failed',
    });
  });

  it('falls back to manual billing without a saved method, for a guest and without a driver', async () => {
    m.chargeSessionRebill.mockResolvedValue({ status: 'no_payment_method' });
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({
      manualReason: 'no_payment_method',
    });
    useSession({ driver_id: null, guest_session: true });
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({ manualReason: 'guest' });
    useSession({ driver_id: null });
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({
      manualReason: 'no_driver',
    });
  });

  it('bills an account session to its fleet without a card charge', async () => {
    useSession({ billing_mode: 'account', billing_fleet_name: 'Acme' });
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({
      rebillStatus: 'billed',
      result: 'account',
      manualReason: null,
      paymentRecordId: null,
    });
    expect(m.chargeSessionRebill).not.toHaveBeenCalled();
    expect(m.settlePrepaidSession).not.toHaveBeenCalled();
    expect(m.dispatchDriverNotification).toHaveBeenCalledWith(
      m.client,
      'session.Receipt',
      'drv_1',
      expect.objectContaining({ billingMode: 'account', billedTo: 'Acme' }),
      ['templates'],
      expect.anything(),
    );
  });

  it('charges the card of an account session that has a payment record', async () => {
    useSession(
      { billing_mode: 'account', billing_fleet_name: 'Acme' },
      { id: 4, status: 'cancelled', payment_source: 'web_portal' },
    );
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({ result: 'charged' });
    expect(m.chargeSessionRebill).toHaveBeenCalled();
    expect(m.dispatchDriverNotification).toHaveBeenCalledWith(
      m.client,
      'session.Receipt',
      'drv_1',
      expect.objectContaining({ billingMode: 'card', billedTo: '' }),
      ['templates'],
      expect.anything(),
    );
  });

  it('debits a prepaid balance with the recomputed cost', async () => {
    useSession({ prepaid: true });
    m.answers.record = [[], [{ id: 12, status: 'captured', payment_source: 'prepaid' }]];
    m.settlePrepaidSession.mockResolvedValue({
      tokenId: 't1',
      debitedCents: 1190,
      balanceCents: 10,
    });
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({
      rebillStatus: 'billed',
      result: 'prepaid',
      paymentRecordId: 12,
    });
    expect(m.settlePrepaidSession).toHaveBeenCalledWith('ses_1', log, {
      costCents: 1190,
      rebill: true,
    });
    expect(m.chargeSessionRebill).not.toHaveBeenCalled();
    expect(m.dispatchPrepaidLowCreditNotice).toHaveBeenCalledWith(
      { tokenId: 't1', debitedCents: 1190, balanceCents: 10 },
      expect.objectContaining({ templatesDirs: expect.any(Array) }),
    );
  });

  it('bills a prepaid debit when the low credit notice fails', async () => {
    useSession({ prepaid: true });
    m.answers.record = [[], [{ id: 12, status: 'captured', payment_source: 'prepaid' }]];
    m.settlePrepaidSession.mockResolvedValue({
      tokenId: 't1',
      debitedCents: 1190,
      balanceCents: 10,
    });
    m.dispatchPrepaidLowCreditNotice.mockRejectedValueOnce(new Error('smtp down'));
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({
      rebillStatus: 'billed',
      result: 'prepaid',
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_1' }),
      'Prepaid low credit notice failed; continuing',
    );
  });

  it('leaves a prepaid session it cannot debit to manual billing', async () => {
    useSession({ prepaid: true });
    m.settlePrepaidSession.mockResolvedValue(null);
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({
      manualReason: 'prepaid_not_debited',
    });
  });

  it('bills a cost of 0 without a payment', async () => {
    m.priceRebill.mockResolvedValue({
      breakdown: { ...BREAKDOWN, grossCents: 0, netCents: 0, taxCents: 0 },
      endedAt: ENDED_AT,
      energyWh: 0,
    });
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({
      rebillStatus: 'billed',
      result: 'no_charge',
      paymentRecordId: null,
    });
    expect(m.chargeSessionRebill).not.toHaveBeenCalled();
    expect(m.dispatchDriverNotification).toHaveBeenCalledOnce();
  });

  it('releases the claim when the provider of the card is not configured', async () => {
    m.chargeSessionRebill.mockResolvedValue({ status: 'not_configured' });
    expect(await refusal(rebillSession('ses_1', ctx))).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
    expect(m.releaseSessionRebill).toHaveBeenCalledWith(m.client, 'ses_1');
    expect(m.completeRebilledSession).not.toHaveBeenCalled();
  });

  it('releases the claim when the record changed meanwhile', async () => {
    m.chargeSessionRebill.mockResolvedValue({ status: 'record_refused', recordStatus: 'pending' });
    expect(await refusal(rebillSession('ses_1', ctx))).toBe('SESSION_REBILL_PAYMENT_PENDING');
    expect(m.releaseSessionRebill).toHaveBeenCalledOnce();
  });

  it('releases the claim when the session has nothing to price', async () => {
    m.priceRebill.mockResolvedValue(null);
    expect(await refusal(rebillSession('ses_1', ctx))).toBe('NOT_ELIGIBLE:no_tariff');
    expect(m.releaseSessionRebill).toHaveBeenCalledOnce();
  });

  it('keeps the claim when the provider outcome is unknown', async () => {
    m.chargeSessionRebill.mockRejectedValue(new Error('provider timeout'));
    await expect(rebillSession('ses_1', ctx)).rejects.toThrow('provider timeout');
    expect(m.releaseSessionRebill).not.toHaveBeenCalled();
    expect(m.completeRebilledSession).not.toHaveBeenCalled();
  });

  it('reports a completion another request took over', async () => {
    m.completeRebilledSession.mockResolvedValue(false);
    expect(await refusal(rebillSession('ses_1', ctx))).toBe('SESSION_REBILL_IN_PROGRESS');
    expect(log.error).toHaveBeenCalled();
    expect(m.writeAudit).not.toHaveBeenCalled();
  });

  it('refuses to retry a re-bill charge without an answer for 23 hours (key retention)', async () => {
    const requestedAt = new Date(Date.now() - 23 * 3_600_000 - 1000).toISOString();
    useSession(
      {},
      {
        id: 4,
        status: 'pending',
        payment_source: 'web_portal',
        provider_payment_id: null,
        metadata: { rebill: { requestedAt } },
      },
    );
    expect(await refusal(rebillSession('ses_1', ctx))).toBe('SESSION_REBILL_PAYMENT_PENDING');
    expect(m.claimSessionRebill).not.toHaveBeenCalled();
    expect(m.chargeSessionRebill).not.toHaveBeenCalled();
  });

  it('bills the session at the amount an earlier attempt charged, not a recomputed one', async () => {
    useSession({}, { id: 4, status: 'captured', metadata: { rebill: {} } });
    m.chargeSessionRebill.mockResolvedValue({
      status: 'charged',
      paymentRecordId: 4,
      provider: 'stripe',
      amountCents: 1000,
      recorded: true,
    });
    m.priceRebill.mockResolvedValue({
      breakdown: {
        basis: 'net',
        grossCents: 1190,
        netCents: 1000,
        taxCents: 190,
        taxLines: [{ rate: 0.19, netCents: 1000, taxCents: 190, grossCents: 1190 }],
        components: null,
      },
      endedAt: ENDED_AT,
      energyWh: 10000,
    });
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({
      result: 'charged',
      finalCostCents: 1000,
    });
    const completion = m.completeRebilledSession.mock.calls[0]?.[1] as {
      breakdown: { grossCents: number; netCents: number; taxCents: number };
    };
    expect(completion.breakdown.grossCents).toBe(1000);
    expect(completion.breakdown.netCents + completion.breakdown.taxCents).toBe(1000);
  });

  it('bills a declined resumed charge at its requested amount', async () => {
    m.chargeSessionRebill.mockResolvedValue({
      status: 'failed',
      paymentRecordId: 9,
      reason: 'declined',
      code: null,
      amountCents: 900,
    });
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({
      rebillStatus: 'manual',
      finalCostCents: 900,
    });
  });

  it('answers in progress when the payment step finds the claim lost', async () => {
    m.chargeSessionRebill.mockResolvedValue({ status: 'session_not_claimed' });
    expect(await refusal(rebillSession('ses_1', ctx))).toBe('SESSION_REBILL_IN_PROGRESS');
    expect(m.completeRebilledSession).not.toHaveBeenCalled();
  });

  it('leaves a prepaid session with another payment record to manual billing', async () => {
    useSession({ prepaid: true }, { id: 4, status: 'cancelled', payment_source: 'web_portal' });
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({
      rebillStatus: 'manual',
      manualReason: 'prepaid_record_exists',
      paymentRecordId: 4,
    });
    expect(m.settlePrepaidSession).not.toHaveBeenCalled();
  });

  it('bills a resumed prepaid re-bill at the amount it debited', async () => {
    useSession(
      { prepaid: true },
      {
        id: 12,
        status: 'captured',
        payment_source: 'prepaid',
        captured_amount_cents: 800,
        metadata: { rebill: {} },
      },
    );
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({
      result: 'prepaid',
      finalCostCents: 800,
    });
    expect(m.settlePrepaidSession).not.toHaveBeenCalled();
  });

  it('rethrows the pricing error when releasing the claim also fails', async () => {
    m.priceRebill.mockRejectedValue(new Error('pricing failed'));
    m.releaseSessionRebill.mockRejectedValue(new Error('release failed'));
    await expect(rebillSession('ses_1', ctx)).rejects.toThrow('pricing failed');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_1' }),
      'Session re-bill claim not released after a pricing failure; it expires with its lease',
    );
  });

  it('keeps the result when the receipt or the SSE publish fails', async () => {
    m.dispatchDriverNotification.mockRejectedValue(new Error('smtp down'));
    m.publish.mockRejectedValue(new Error('redis down'));
    await expect(rebillSession('ses_1', ctx)).resolves.toMatchObject({ result: 'charged' });
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

describe('getSessionRebillState', () => {
  it('is rebillable after a dead claim expired and with the re-bill record pending', async () => {
    useSession(
      { rebill_status: 'in_progress', rebill_claimed_at: new Date(Date.now() - 301_000) },
      {
        id: 4,
        status: 'pending',
        provider_payment_id: null,
        metadata: { rebill: { requestedAt: new Date().toISOString() } },
      },
    );
    expect(await getSessionRebillState('ses_1')).toEqual({
      rebillable: true,
      blockedReason: null,
    });
  });

  it.each([
    [{ rebill_status: 'in_progress', rebill_claimed_at: new Date() }, null, 'in_progress'],
    [{}, { id: 4, status: 'pre_authorized' }, 'payment_pending'],
    [{ status: 'completed', rebill_status: 'billed' }, null, 'already_rebilled'],
    [{ is_roaming: true }, null, 'roaming'],
  ])('reports why the session cannot be re-billed (%j %j)', async (session, record, reason) => {
    useSession(session, record);
    expect(await getSessionRebillState('ses_1')).toEqual({
      rebillable: false,
      blockedReason: reason,
    });
  });

  it('returns null for an unknown session', async () => {
    m.answers.session = [];
    expect(await getSessionRebillState('ses_x')).toBeNull();
  });
});
