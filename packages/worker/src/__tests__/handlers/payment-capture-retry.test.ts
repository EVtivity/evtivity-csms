// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';

// db.execute is the only db method this handler uses. It is called for the
// SELECT (rows needing retry), the settings SELECT, and per-row UPDATEs. We
// queue results FIFO and record every call so tests can assert on the SQL.
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

vi.mock('@evtivity/database', () => ({
  db: { execute: mockExecute },
}));

// `sql` tagged template returns a marker object so the handler's calls don't
// throw. We don't need real SQL parsing.
vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    __sql: strings.join('?'),
    values,
  }),
}));

const mockDecrypt = vi.fn((..._args: unknown[]) => 'sk_test_decrypted');
const mockIsSimulated = vi.fn((..._args: unknown[]) => false);
vi.mock('@evtivity/lib', () => ({
  decryptString: (...args: unknown[]) => mockDecrypt(...args),
  isSimulatedCustomer: (...args: unknown[]) => mockIsSimulated(...args),
}));

// Lazy-imported Stripe SDK. The handler does `(await import('stripe')).default`
// then `new Stripe(secretKey)`. We expose retrieve/create spies.
const mockRetrieve = vi.fn();
const mockCreate = vi.fn();
const StripeCtor = vi.fn(function (this: Record<string, unknown>) {
  this['paymentIntents'] = { retrieve: mockRetrieve, create: mockCreate };
});
vi.mock('stripe', () => ({ default: StripeCtor }));

function makeLog(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

const SETTINGS_ROWS = [{ key: 'stripe.secretKeyEnc', value: 'enc_secret' }];

function shortfallRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pr_id: 1,
    stripe_payment_intent_id: 'pi_123',
    stripe_customer_id: 'cus_real',
    captured_amount_cents: 500,
    currency: 'USD',
    final_cost_cents: 800,
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
    mockDecrypt.mockReturnValue('sk_test_decrypted');
    mockIsSimulated.mockReturnValue(false);
    process.env['SETTINGS_ENCRYPTION_KEY'] = 'enc-key';
    mockRetrieve.mockResolvedValue({
      customer: 'cus_real',
      payment_method: 'pm_1',
      on_behalf_of: null,
    });
    mockCreate.mockResolvedValue({ id: 'pi_topup_1' });
  });

  afterEach(() => {
    delete process.env['SETTINGS_ENCRYPTION_KEY'];
  });

  it('returns early when no shortfall rows are found', async () => {
    queueExecute([]); // SELECT shortfall rows -> none
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(log);

    expect(log.debug).toHaveBeenCalledWith('No payment records with capture shortfall to retry');
    // Only the shortfall SELECT ran; no settings query, no Stripe.
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(StripeCtor).not.toHaveBeenCalled();
  });

  it('warns and aborts when Stripe secret key is not configured', async () => {
    queueExecute(
      [shortfallRow()], // shortfall rows
      [{ key: 'stripe.secretKeyEnc', value: '' }], // settings with empty secret
    );
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(log);

    expect(log.warn).toHaveBeenCalledWith('Stripe is not configured; cannot retry capture');
    expect(StripeCtor).not.toHaveBeenCalled();
  });

  it('warns and aborts when the secret key setting row is missing entirely', async () => {
    queueExecute([shortfallRow()], []); // settings query returns no rows
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(log);

    expect(log.warn).toHaveBeenCalledWith('Stripe is not configured; cannot retry capture');
    expect(StripeCtor).not.toHaveBeenCalled();
  });

  it('warns and aborts when SETTINGS_ENCRYPTION_KEY is missing', async () => {
    delete process.env['SETTINGS_ENCRYPTION_KEY'];
    queueExecute([shortfallRow()], SETTINGS_ROWS);
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(log);

    expect(log.warn).toHaveBeenCalledWith('SETTINGS_ENCRYPTION_KEY missing; cannot retry capture');
    expect(mockDecrypt).not.toHaveBeenCalled();
    expect(StripeCtor).not.toHaveBeenCalled();
  });

  it('recovers a shortfall: creates the top-up with a deterministic idempotency key and updates the row to final cost', async () => {
    queueExecute(
      [shortfallRow({ pr_id: 7, captured_amount_cents: 500, final_cost_cents: 800 })],
      SETTINGS_ROWS,
      [], // UPDATE result (success)
    );
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(log);

    expect(mockDecrypt).toHaveBeenCalledWith('enc_secret', 'enc-key');
    expect(StripeCtor).toHaveBeenCalledWith('sk_test_decrypted');
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

    // The success UPDATE was issued (3rd execute call) and recovered logged.
    expect(mockExecute).toHaveBeenCalledTimes(3);
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
    queueExecute([shortfallRow()], SETTINGS_ROWS, []);
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(makeLog());

    const [params] = mockCreate.mock.calls[0]!;
    expect(params).toMatchObject({
      on_behalf_of: 'acct_connected',
      transfer_data: { destination: 'acct_connected' },
    });
  });

  it('resolves on_behalf_of and customer/payment_method when Stripe returns expanded objects', async () => {
    mockRetrieve.mockResolvedValue({
      customer: { id: 'cus_obj' },
      payment_method: { id: 'pm_obj' },
      on_behalf_of: { id: 'acct_obj' },
    });
    queueExecute([shortfallRow()], SETTINGS_ROWS, []);
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
      SETTINGS_ROWS,
      [], // best-effort failure UPDATE
    );
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await expect(paymentCaptureRetryHandler(log)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRecordId: 9 }),
      'Capture retry failed; will try again next run',
    );
    // failure UPDATE issued (3rd execute call)
    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith(
      { recovered: 0, stillFailed: 1, total: 1 },
      'Capture retry pass complete',
    );
  });

  it('swallows a failing failure_reason UPDATE so the batch is not aborted', async () => {
    mockCreate.mockRejectedValue('not-an-error-object');
    // The failure UPDATE itself rejects; the handler .catch()es it.
    mockExecute
      .mockImplementationOnce(() => Promise.resolve([shortfallRow()])) // SELECT
      .mockImplementationOnce(() => Promise.resolve(SETTINGS_ROWS)) // settings
      .mockImplementationOnce(() => Promise.reject(new Error('db down'))); // failure UPDATE
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await expect(paymentCaptureRetryHandler(log)).resolves.toBeUndefined();
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
      SETTINGS_ROWS,
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
    queueExecute(
      [shortfallRow({ captured_amount_cents: 800, final_cost_cents: 800 })],
      SETTINGS_ROWS,
    );
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(makeLog());

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('skips a row with a null payment intent id', async () => {
    queueExecute([shortfallRow({ stripe_payment_intent_id: null })], SETTINGS_ROWS);
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(makeLog());

    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('skips simulated customers (cus_sim_*) so the cron never hits Stripe for them', async () => {
    mockIsSimulated.mockReturnValue(true);
    queueExecute([shortfallRow({ stripe_customer_id: 'cus_sim_1' })], SETTINGS_ROWS);
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(makeLog());

    expect(mockIsSimulated).toHaveBeenCalledWith('cus_sim_1');
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('skips when the original PaymentIntent has no customer or payment_method', async () => {
    mockRetrieve.mockResolvedValue({ customer: null, payment_method: null, on_behalf_of: null });
    queueExecute([shortfallRow({ pr_id: 5 })], SETTINGS_ROWS);
    const log = makeLog();
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(log);

    expect(log.warn).toHaveBeenCalledWith(
      { paymentRecordId: 5 },
      'Original PaymentIntent missing customer or payment_method; skipping',
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('treats null final/captured amounts as zero in the shortfall math and skips', async () => {
    queueExecute(
      [shortfallRow({ final_cost_cents: null, captured_amount_cents: null })],
      SETTINGS_ROWS,
    );
    const { paymentCaptureRetryHandler } = await import('../../handlers/payment-capture-retry.js');

    await paymentCaptureRetryHandler(makeLog());

    expect(mockRetrieve).not.toHaveBeenCalled();
  });
});
