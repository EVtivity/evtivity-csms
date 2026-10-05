// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  adjustKey,
  cancelKey,
  captureKey,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  refundKey,
  reservationFeeKey,
  topUpKey,
  topUpRetryKey,
} from '../idempotency-keys.js';

// An Adyen pspReference and a Stripe PaymentIntent id.
const PSP = 'MQ4PX7JD4DJXKN75';
const PI = 'pi_3PabcdefGHIJKLMNOP123456';

describe('idempotency keys of operations on a provider payment', () => {
  it('are built from the provider payment id', () => {
    expect(captureKey(PSP)).toBe(`capture_${PSP}`);
    expect(cancelKey(PSP)).toBe(`cancel_${PSP}`);
    expect(topUpKey(PSP)).toBe(`topup_${PSP}`);
    expect(topUpRetryKey(PSP, 5000)).toBe(`topup_retry_${PSP}_5000`);
    expect(adjustKey(PSP, 7000)).toBe(`adjust_${PSP}_7000`);
    const parts = { refundedSoFarCents: 1000, amountCents: 500, ledgerEntries: 2 };
    expect(refundKey(PSP, parts)).toBe(`refund_${PSP}_1000_500_2`);
    expect(refundKey(PSP, parts, 1)).toBe(`refund_${PSP}_1000_500_2_topup_1`);
  });

  it('differ between payments, so two databases never share a key', () => {
    expect(captureKey(PSP)).not.toBe(captureKey('NC6HT9CRT65ZGN82'));
  });

  it('tell apart refunds after a failed one by the ledger size', () => {
    const before = refundKey(PI, { refundedSoFarCents: 0, amountCents: 500, ledgerEntries: 0 });
    const after = refundKey(PI, { refundedSoFarCents: 0, amountCents: 500, ledgerEntries: 1 });
    expect(after).not.toBe(before);
  });

  it('hash a key above the Adyen limit, deterministically', () => {
    const longId = `pi_${'x'.repeat(70)}`;
    const key = captureKey(longId);
    expect(key).toMatch(/^capture_[0-9a-f]{40}$/);
    expect(key.length).toBeLessThanOrEqual(MAX_IDEMPOTENCY_KEY_LENGTH);
    expect(captureKey(longId)).toBe(key);
    const refund = refundKey(
      PI,
      { refundedSoFarCents: 1234567890, amountCents: 1234567890, ledgerEntries: 12 },
      3,
    );
    expect(refund).toMatch(/^refund_[0-9a-f]{40}$/);
    expect(refund).not.toBe(
      refundKey(PI, { refundedSoFarCents: 1234567890, amountCents: 1234567890, ledgerEntries: 12 }),
    );
  });

  it('fit the Adyen limit for Stripe intents and realistic amounts unhashed', () => {
    const key = refundKey(
      PI,
      { refundedSoFarCents: 99999, amountCents: 99999, ledgerEntries: 9 },
      9,
    );
    expect(key).toBe(`refund_${PI}_99999_99999_9_topup_9`);
    expect(key.length).toBeLessThanOrEqual(MAX_IDEMPOTENCY_KEY_LENGTH);
  });
});

describe('reservationFeeKey', () => {
  it('keeps the key reservation fees were always charged with', () => {
    expect(reservationFeeKey('reservation_cancellation', 'rsv_1')).toBe('cancellation-fee-rsv_1');
    expect(reservationFeeKey('reservation_no_show', 'rsv_1')).toBe('no-show-fee-rsv_1');
  });
});
