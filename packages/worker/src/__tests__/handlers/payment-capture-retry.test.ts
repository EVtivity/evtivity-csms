// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// db.execute is the only db method this handler uses. It is called for the
// SELECT (rows needing retry) and per-row UPDATEs. We queue results FIFO and
// record every call so tests can assert on the SQL.
const executeResults: unknown[][] = [];
let executeIndex = 0;
const executeCalls: unknown[] = [];
function queueExecute(...results: unknown[][]): void {
  executeResults.length = 0;
  executeResults.push(...results);
  executeIndex = 0;
}
const mockExecute = vi.fn((arg: unknown) => {
  executeCalls.push(arg);
  const r = executeResults[executeIndex] ?? [];
  executeIndex++;
  return Promise.resolve(r);
});

const mockFeePercent = vi.fn((_siteId: string | null) => Promise.resolve(0));
// The shared cached Stripe client (@evtivity/database stripe-client).
const mockRetrieve = vi.fn();
const mockCreate = vi.fn();
const stripeClient = { paymentIntents: { retrieve: mockRetrieve, create: mockCreate } };
const mockGetStripeClient = vi.fn(
  (_key: string): Promise<unknown> => Promise.resolve(stripeClient),
);
vi.mock('@evtivity/database', () => ({
  db: { execute: mockExecute },
  getPlatformFeePercent: (siteId: string | null) => mockFeePercent(siteId),
  getStripeClient: (key: string) => mockGetStripeClient(key),
}));

vi.mock('../../lib/config.js', () => ({
  config: { SETTINGS_ENCRYPTION_KEY: 'enc-key' },
}));

// `sql` tagged template returns a marker object so the handler's calls don't
// throw. We don't need real SQL parsing.
vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    __sql: strings.join('?'),
    values,
  }),
}));

const mockIsSimulated = vi.fn((..._args: unknown[]) => false);
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSimulatedCustomer: (...args: unknown[]) => mockIsSimulated(...args),
}));

function makeLog(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function shortfallRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pr_id: 1,
    stripe_payment_intent_id: 'pi_123',
    stripe_customer_id: 'cus_real',
    captured_amount_cents: 500,
    currency: 'USD',
    final_cost_cents: 800,
    tariff_tax_rate: null,
    site_id: 'sit_1',
    session_id: 'ses_1',
    ...over,
  };
}

describe('paymentCaptureRetryHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueExecute();
    executeCalls.length = 0;
    mockIsSimulated.mockReturnValue(false);
    mockGetStripeClient.mockResolvedValue(stripeClient);
    mockRetrieve.mockResolvedValue({
      customer: 'cus_real',
      payment_method: 'pm_1',
      on_behalf_of: null,
    });
    mockCreate.mockResolvedValue({ id: 'pi_topup_1' });
    mockFeePercent.mockResolvedValue(0);
  });

  it('returns early when no shortfall rows are found', async () => {
    queueExecute([]); // SELECT shortfall rows -> none
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(log);

    expect(log.debug).toHaveBeenCalledWith('No payment records with capture shortfall to retry');
    // Only the shortfall SELECT ran; no Stripe client.
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockGetStripeClient).not.toHaveBeenCalled();
  });

  it('warns and aborts when Stripe secret key is not configured', async () => {
    mockGetStripeClient.mockResolvedValue(null);
    queueExecute([shortfallRow()]);
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(log);

    expect(log.warn).toHaveBeenCalledWith('Stripe is not configured; cannot retry capture');
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('fails loud when the secret key cannot be decrypted', async () => {
    mockGetStripeClient.mockRejectedValue(
      new Error('Unsupported state or unable to authenticate data'),
    );
    queueExecute([shortfallRow()]);
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await expect(paymentCaptureRetryHandler(makeLog())).rejects.toThrow('unable to authenticate');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('recovers a shortfall: creates the top-up with a deterministic idempotency key and updates the row to final cost', async () => {
    queueExecute(
      [shortfallRow({ pr_id: 7, captured_amount_cents: 500, final_cost_cents: 800 })],
      [], // UPDATE result (success)
    );
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(log);

    // The worker's configured encryption key, not process.env.
    expect(mockGetStripeClient).toHaveBeenCalledWith('enc-key');
    expect(mockRetrieve).toHaveBeenCalledWith('pi_123');

    // Top-up is for exactly the shortfall delta (800 - 500 = 300), off_session.
    const [params, options] = mockCreate.mock.calls[0]!;
    expect(params).toMatchObject({
      amount: 300,
      currency: 'usd',
      customer: 'cus_real',
      payment_method: 'pm_1',
      confirm: true,
      off_session: true,
      capture_method: 'automatic',
      description: 'Capture retry for session ses_1',
    });
    // Idempotency key derived from pr_id + captured amount so retries are safe.
    expect(options).toEqual({ idempotencyKey: 'topup_retry_7_500' });

    // The success UPDATE was issued (2nd execute call) and recovered logged.
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRecordId: 7, topUpIntentId: 'pi_topup_1' }),
      'Recovered capture shortfall via cron retry',
    );
    expect(log.info).toHaveBeenCalledWith(
      { recovered: 1, stillFailed: 0, total: 1 },
      'Capture retry pass complete',
    );
  });

  it('passes on_behalf_of and transfer_data through to the top-up for connected accounts (string form)', async () => {
    mockRetrieve.mockResolvedValue({
      customer: 'cus_real',
      payment_method: 'pm_1',
      on_behalf_of: 'acct_connected',
    });
    queueExecute([shortfallRow()], []);
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(makeLog());

    const [params] = mockCreate.mock.calls[0]!;
    expect(params).toMatchObject({
      on_behalf_of: 'acct_connected',
      transfer_data: { destination: 'acct_connected' },
    });
  });

  it('charges the platform fee of the increment on its net amount for connected accounts', async () => {
    mockRetrieve.mockResolvedValue({
      customer: 'cus_real',
      payment_method: 'pm_1',
      on_behalf_of: 'acct_connected',
      transfer_data: { destination: 'acct_connected' },
    });
    mockFeePercent.mockResolvedValue(10);
    // 5950 captured of 11900 at 19%: net 5000 of 10000, so the increment's fee
    // is 10% of 10000 minus 10% of 5000 = 500.
    queueExecute(
      [
        shortfallRow({
          captured_amount_cents: 5950,
          final_cost_cents: 11900,
          tariff_tax_rate: '0.19',
        }),
      ],
      [],
    );
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(makeLog());

    expect(mockFeePercent).toHaveBeenCalledWith('sit_1');
    const [params, options] = mockCreate.mock.calls[0]!;
    expect(params).toMatchObject({ amount: 5950, application_fee_amount: 500 });
    expect(options).toEqual({ idempotencyKey: 'topup_retry_1_5950' });
  });

  it('resolves on_behalf_of and customer/payment_method when Stripe returns expanded objects', async () => {
    mockRetrieve.mockResolvedValue({
      customer: { id: 'cus_obj' },
      payment_method: { id: 'pm_obj' },
      on_behalf_of: { id: 'acct_obj' },
    });
    queueExecute([shortfallRow()], []);
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(makeLog());

    const [params] = mockCreate.mock.calls[0]!;
    expect(params).toMatchObject({
      customer: 'cus_obj',
      payment_method: 'pm_obj',
      transfer_data: { destination: 'acct_obj' },
    });
  });

  it('records failure_reason and counts the row as stillFailed when the top-up is declined (fail-open)', async () => {
    mockCreate.mockRejectedValue(new Error('Your card was declined.'));
    queueExecute(
      [shortfallRow({ pr_id: 9 })],
      [], // best-effort failure UPDATE
    );
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await expect(paymentCaptureRetryHandler(log)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRecordId: 9 }),
      'Capture retry failed; will try again next run',
    );
    // failure UPDATE issued (2nd execute call)
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      { recovered: 0, stillFailed: 1, total: 1 },
      'Capture retry pass complete',
    );
  });

  it('logs and continues when the failure_reason UPDATE fails, so the batch is not aborted', async () => {
    mockCreate.mockRejectedValue('not-an-error-object');
    // The failure UPDATE itself rejects; the handler logs it at warn.
    mockExecute
      .mockImplementationOnce(() => Promise.resolve([shortfallRow()])) // SELECT
      .mockImplementationOnce(() => Promise.reject(new Error('db down'))); // failure UPDATE
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await expect(paymentCaptureRetryHandler(log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRecordId: 1 }),
      'Failed to record the capture retry failure reason',
    );
    expect(log.info).toHaveBeenCalledWith(
      { recovered: 0, stillFailed: 1, total: 1 },
      'Capture retry pass complete',
    );
  });

  it('isolates per-row failures: one decline does not stop a later row from recovering', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('declined')) // row 1 fails
      .mockResolvedValueOnce({ id: 'pi_topup_2' }); // row 2 succeeds
    queueExecute(
      [shortfallRow({ pr_id: 1 }), shortfallRow({ pr_id: 2, captured_amount_cents: 100 })],
      [], // failure UPDATE for row 1
      [], // success UPDATE for row 2
    );
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(log);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      { recovered: 1, stillFailed: 1, total: 2 },
      'Capture retry pass complete',
    );
  });

  it('skips a row whose shortfall is non-positive', async () => {
    queueExecute([shortfallRow({ captured_amount_cents: 800, final_cost_cents: 800 })]);
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(makeLog());

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('skips a row with a null payment intent id', async () => {
    queueExecute([shortfallRow({ stripe_payment_intent_id: null })]);
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(makeLog());

    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('skips simulated customers (cus_sim_*) so the cron never hits Stripe for them', async () => {
    mockIsSimulated.mockReturnValue(true);
    queueExecute([shortfallRow({ stripe_customer_id: 'cus_sim_1' })]);
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(makeLog());

    expect(mockIsSimulated).toHaveBeenCalledWith('cus_sim_1');
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('records a failure when the original PaymentIntent has no customer or payment_method', async () => {
    mockRetrieve.mockResolvedValue({ customer: null, payment_method: null, on_behalf_of: null });
    queueExecute([shortfallRow({ pr_id: 5 })], []);
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(log);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRecordId: 5 }),
      'Capture retry failed; will try again next run',
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('treats null final/captured amounts as zero in the shortfall math and skips', async () => {
    queueExecute([shortfallRow({ final_cost_cents: null, captured_amount_cents: null })]);
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(makeLog());

    expect(mockRetrieve).not.toHaveBeenCalled();
  });
});
