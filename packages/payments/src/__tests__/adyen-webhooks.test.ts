// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import {
  adyenHmacPayload,
  adyenHmacSignature,
  isValidAdyenHmac,
  isValidBasicAuth,
} from '../providers/adyen/hmac.js';
import type { AdyenNotificationItem } from '../providers/adyen/hmac.js';
import { normalizeAdyenItem } from '../providers/adyen/webhooks.js';
import {
  ADYEN_BLOCKED_CURRENCIES,
  fromAdyenAmount,
  toAdyenAmount,
} from '../providers/adyen/amounts.js';
import {
  PaymentValidationError,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from '../errors.js';
import {
  basicAuth,
  DOC_HMAC_KEY,
  fakeAdyenProvider,
  MERCHANT,
  signedNotification,
} from '../testing/fake-adyen.js';

// The example of https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures
const DOC_ITEM: AdyenNotificationItem = {
  additionalData: { hmacSignature: 'coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=' },
  amount: { value: 1130, currency: 'EUR' },
  pspReference: '7914073381342284',
  eventCode: 'AUTHORISATION',
  merchantAccountCode: 'TestMerchant',
  merchantReference: 'TestPayment-1407325143704',
  success: 'true',
};
const DOC_BODY = JSON.stringify({
  live: 'false',
  notificationItems: [{ NotificationRequestItem: DOC_ITEM }],
});
const AUTH = { authorization: basicAuth('adyen-hook', 'hook-password') };
const OTHER_KEY = '0F'.repeat(32);

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('Expected a throw');
}

describe('Adyen HMAC (documented example)', () => {
  it('builds the documented signing string', () => {
    expect(adyenHmacPayload(DOC_ITEM)).toBe(
      '7914073381342284::TestMerchant:TestPayment-1407325143704:1130:EUR:AUTHORISATION:true',
    );
  });

  it('computes the documented signature', () => {
    expect(adyenHmacSignature(DOC_ITEM, DOC_HMAC_KEY)).toBe(
      'coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=',
    );
  });

  it('accepts the current or the previous key only', () => {
    const signature = 'coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=';
    expect(isValidAdyenHmac(DOC_ITEM, signature, [DOC_HMAC_KEY])).toBe(true);
    expect(isValidAdyenHmac(DOC_ITEM, signature, [OTHER_KEY, DOC_HMAC_KEY])).toBe(true);
    expect(isValidAdyenHmac(DOC_ITEM, signature, [OTHER_KEY])).toBe(false);
    expect(isValidAdyenHmac({ ...DOC_ITEM, success: 'false' }, signature, [DOC_HMAC_KEY])).toBe(
      false,
    );
    expect(isValidAdyenHmac(DOC_ITEM, 'short', [DOC_HMAC_KEY])).toBe(false);
  });

  it('checks Basic auth', () => {
    expect(isValidBasicAuth(basicAuth('u', 'p:w'), 'u', 'p:w')).toBe(true);
    expect(isValidBasicAuth(`basic ${Buffer.from('u:p').toString('base64')}`, 'u', 'p')).toBe(true);
    expect(isValidBasicAuth(basicAuth('u', 'wrong'), 'u', 'p')).toBe(false);
    expect(isValidBasicAuth('Bearer token', 'u', 'p')).toBe(false);
  });
});

describe('AdyenPaymentProvider.verifyWebhook', () => {
  it('accepts the documented webhook and normalizes it', () => {
    const { provider } = fakeAdyenProvider();
    expect(provider.verifyWebhook(DOC_BODY, AUTH)).toEqual([
      {
        eventId: 'AUTHORISATION:7914073381342284:true',
        type: 'payment.authorized',
        paymentId: '7914073381342284',
        amountCents: 1130,
        merchantReference: 'TestPayment-1407325143704',
        occurredAt: expect.any(Date) as Date,
      },
    ]);
  });

  it('accepts an item signed with the previous key during rotation', () => {
    const { provider } = fakeAdyenProvider({ hmacKey: OTHER_KEY, hmacKeyPrevious: DOC_HMAC_KEY });
    expect(provider.verifyWebhook(DOC_BODY, AUTH)).toHaveLength(1);
  });

  it('rejects a wrong or missing HMAC signature', () => {
    const { provider } = fakeAdyenProvider();
    const wrong = signedNotification([{ ...DOC_ITEM, additionalData: {} }], { hexKey: OTHER_KEY });
    expect(errorOf(() => provider.verifyWebhook(wrong, AUTH))).toMatchObject({
      name: 'WebhookSignatureError',
      reason: 'invalid',
    });
    const tampered = DOC_BODY.replace('1130', '9999');
    expect(errorOf(() => provider.verifyWebhook(tampered, AUTH))).toMatchObject({
      reason: 'invalid',
      // The claimed event and payment, for the refusal log (no secrets).
      unverified: { eventCode: 'AUTHORISATION', pspReference: '7914073381342284' },
    });
    const unsigned = JSON.stringify({
      live: 'false',
      notificationItems: [{ NotificationRequestItem: { ...DOC_ITEM, additionalData: {} } }],
    });
    expect(errorOf(() => provider.verifyWebhook(unsigned, AUTH))).toMatchObject({
      reason: 'missing',
    });
  });

  it('requires Basic auth, reported as a credential failure', () => {
    const { provider } = fakeAdyenProvider();
    expect(errorOf(() => provider.verifyWebhook(DOC_BODY, {}))).toMatchObject({
      reason: 'missing',
      kind: 'auth',
    });
    expect(
      errorOf(() =>
        provider.verifyWebhook(DOC_BODY, { authorization: basicAuth('adyen-hook', 'nope') }),
      ),
    ).toMatchObject({ reason: 'invalid', kind: 'auth' });
  });

  it('reports HMAC and body failures as signature failures', () => {
    const { provider } = fakeAdyenProvider();
    const unsigned = JSON.stringify({
      live: 'false',
      notificationItems: [{ NotificationRequestItem: { ...DOC_ITEM, additionalData: {} } }],
    });
    expect(errorOf(() => provider.verifyWebhook(unsigned, AUTH))).toMatchObject({
      reason: 'missing',
      kind: 'signature',
    });
    expect(errorOf(() => provider.verifyWebhook('not json', AUTH))).toMatchObject({
      reason: 'invalid',
      kind: 'signature',
    });
  });

  it('is not configured without an HMAC key, a valid hex key, or Basic auth credentials', () => {
    for (const overrides of [
      { hmacKey: null },
      { hmacKey: 'not-hex' },
      { webhookUsername: null },
      { webhookPassword: null },
    ]) {
      const { provider } = fakeAdyenProvider(overrides);
      expect(errorOf(() => provider.verifyWebhook(DOC_BODY, AUTH))).toBeInstanceOf(
        WebhookNotConfiguredError,
      );
    }
  });

  it('rejects the other environment, another merchant account and a malformed body', () => {
    const { provider } = fakeAdyenProvider();
    const live = signedNotification([{ ...DOC_ITEM, additionalData: {} }], { live: 'true' });
    expect(errorOf(() => provider.verifyWebhook(live, AUTH))).toBeInstanceOf(WebhookSignatureError);
    const other = signedNotification([
      { ...DOC_ITEM, merchantAccountCode: 'OtherMerchant', additionalData: {} },
    ]);
    expect(errorOf(() => provider.verifyWebhook(other, AUTH))).toBeInstanceOf(
      WebhookSignatureError,
    );
    for (const body of [
      'not json',
      '{}',
      '{"live":"false","notificationItems":[]}',
      '{"live":"false","notificationItems":[{}]}',
    ]) {
      expect(errorOf(() => provider.verifyWebhook(body, AUTH))).toMatchObject({
        reason: 'invalid',
      });
    }
  });

  it('verifies and normalizes every item of a batch, rejecting it when one item is bad', () => {
    const { provider } = fakeAdyenProvider();
    const capture: AdyenNotificationItem = {
      pspReference: 'QJ7GWQ756L2GWR86',
      originalReference: 'KHQC5N7G84BLNK43',
      merchantAccountCode: MERCHANT,
      merchantReference: 'sess_s1',
      amount: { value: 4000, currency: 'EUR' },
      eventCode: 'CAPTURE',
      eventDate: '2026-10-03T12:00:00+02:00',
      success: 'true',
    };
    const body = signedNotification([{ ...DOC_ITEM, additionalData: {} }, capture]);
    const events = provider.verifyWebhook(body, AUTH);
    expect(events.map((e) => e.type)).toEqual(['payment.authorized', 'payment.captured']);
    expect(events[1]).toEqual({
      eventId: 'CAPTURE:QJ7GWQ756L2GWR86:true',
      type: 'payment.captured',
      paymentId: 'KHQC5N7G84BLNK43',
      operationRef: 'QJ7GWQ756L2GWR86',
      amountCents: 4000,
      occurredAt: new Date('2026-10-03T10:00:00Z'),
    });

    const parsed = JSON.parse(body) as {
      notificationItems: Array<{ NotificationRequestItem: AdyenNotificationItem }>;
    };
    const second = parsed.notificationItems[1];
    if (second != null) second.NotificationRequestItem.success = 'false';
    expect(errorOf(() => provider.verifyWebhook(JSON.stringify(parsed), AUTH))).toMatchObject({
      reason: 'invalid',
    });
  });

  it('acknowledges with [accepted]', () => {
    expect(fakeAdyenProvider().provider.webhookAck()).toEqual({
      status: 200,
      contentType: 'text/plain',
      body: '[accepted]',
    });
  });
});

describe('normalizeAdyenItem', () => {
  const base: AdyenNotificationItem = {
    pspReference: 'MODPSP0000000001',
    originalReference: 'KHQC5N7G84BLNK43',
    merchantAccountCode: MERCHANT,
    merchantReference: 'sess_s1',
    amount: { value: 700, currency: 'EUR' },
    eventDate: '2026-10-03T10:00:00Z',
    success: 'true',
  };
  const at = new Date('2026-10-03T10:00:00Z');
  const modification = {
    paymentId: 'KHQC5N7G84BLNK43',
    operationRef: 'MODPSP0000000001',
    occurredAt: at,
  };
  const n = (overrides: AdyenNotificationItem) => normalizeAdyenItem({ ...base, ...overrides });

  it('AUTHORISATION: authorized with the stored method, or failed', () => {
    expect(
      n({
        eventCode: 'AUTHORISATION',
        pspReference: 'KHQC5N7G84BLNK43',
        originalReference: '',
        paymentMethod: 'visa',
        additionalData: {
          'tokenization.storedPaymentMethodId': 'M5N7TQ4TG5PFWR50',
          'tokenization.shopperReference': 'evt_1',
          cardSummary: '1111',
        },
      }),
    ).toEqual({
      eventId: 'AUTHORISATION:KHQC5N7G84BLNK43:true',
      type: 'payment.authorized',
      paymentId: 'KHQC5N7G84BLNK43',
      amountCents: 700,
      merchantReference: 'sess_s1',
      method: { methodId: 'M5N7TQ4TG5PFWR50', customerId: 'evt_1', brand: 'visa', last4: '1111' },
      occurredAt: at,
    });
    expect(
      n({
        eventCode: 'AUTHORISATION',
        pspReference: 'KHQC5N7G84BLNK43',
        success: 'false',
        reason: 'Refused',
      }),
    ).toEqual({
      eventId: 'AUTHORISATION:KHQC5N7G84BLNK43:false',
      type: 'payment.failed',
      paymentId: 'KHQC5N7G84BLNK43',
      reason: 'Refused',
      occurredAt: at,
    });
  });

  it('AUTHORISATION_ADJUSTMENT: adjusted with the new total, or not', () => {
    expect(
      n({ eventCode: 'AUTHORISATION_ADJUSTMENT', amount: { value: 7000, currency: 'EUR' } }),
    ).toEqual({
      eventId: 'AUTHORISATION_ADJUSTMENT:MODPSP0000000001:true',
      type: 'payment.adjusted',
      ...modification,
      authorizedCents: 7000,
      success: true,
    });
    expect(n({ eventCode: 'AUTHORISATION_ADJUSTMENT', success: 'false' })).toMatchObject({
      type: 'payment.adjusted',
      authorizedCents: 0,
      success: false,
    });
  });

  it('CAPTURE, CAPTURE with success false, and CAPTURE_FAILED', () => {
    expect(n({ eventCode: 'CAPTURE' })).toEqual({
      eventId: 'CAPTURE:MODPSP0000000001:true',
      type: 'payment.captured',
      ...modification,
      amountCents: 700,
    });
    expect(
      n({ eventCode: 'CAPTURE', success: 'false', reason: 'Insufficient balance' }),
    ).toMatchObject({
      type: 'payment.capture_failed',
      paymentId: 'KHQC5N7G84BLNK43',
      reason: 'Insufficient balance',
    });
    expect(n({ eventCode: 'CAPTURE_FAILED', reason: 'Card expired' })).toEqual({
      eventId: 'CAPTURE_FAILED:MODPSP0000000001:true',
      type: 'payment.capture_failed',
      ...modification,
      reason: 'Card expired',
    });
  });

  it('CANCELLATION, TECHNICAL_CANCEL and EXPIRE cancel; a failed cancellation is cancel_failed', () => {
    for (const eventCode of ['CANCELLATION', 'TECHNICAL_CANCEL']) {
      expect(n({ eventCode })).toEqual({
        eventId: `${eventCode}:MODPSP0000000001:true`,
        type: 'payment.cancelled',
        ...modification,
      });
    }
    // EXPIRE is the authorisation lapsing, not a cancel request of ours.
    expect(n({ eventCode: 'EXPIRE' })).toEqual({
      eventId: 'EXPIRE:MODPSP0000000001:true',
      type: 'payment.cancelled',
      ...modification,
      expired: true,
    });
    expect(
      n({ eventCode: 'CANCELLATION', success: 'false', reason: 'Already captured' }),
    ).toMatchObject({
      type: 'payment.cancel_failed',
      reason: 'Already captured',
    });
  });

  it('REFUND is one refund; failures are refund_failed', () => {
    expect(n({ eventCode: 'REFUND' })).toEqual({
      eventId: 'REFUND:MODPSP0000000001:true',
      type: 'payment.refunded',
      ...modification,
      refundId: 'MODPSP0000000001',
      amountCents: 700,
      cumulativeRefundedCents: null,
      capturedCents: null,
    });
    expect(
      n({ eventCode: 'REFUND', success: 'false', reason: 'Not enough balance' }),
    ).toMatchObject({
      type: 'payment.refund_failed',
      refundId: 'MODPSP0000000001',
      amountCents: 700,
      reason: 'Not enough balance',
    });
    expect(n({ eventCode: 'REFUND_FAILED' })).toMatchObject({
      type: 'payment.refund_failed',
      refundId: 'MODPSP0000000001',
      amountCents: 700,
      reason: null,
    });
  });

  it('CHARGEBACK is a dispute on the original payment', () => {
    expect(
      n({
        eventCode: 'CHARGEBACK',
        pspReference: '9915555555555555',
        originalReference: '9913333333333333',
        reason: 'Card Not Present Fraud',
      }),
    ).toEqual({
      eventId: 'CHARGEBACK:9915555555555555:true',
      type: 'payment.disputed',
      paymentId: '9913333333333333',
      disputeId: '9915555555555555',
      reason: 'Card Not Present Fraud',
      occurredAt: at,
    });
  });

  it('ignores other codes and items it cannot attribute', () => {
    for (const eventCode of [
      'RECURRING_CONTRACT',
      'REFUNDED_REVERSED',
      'NOTIFICATION_OF_CHARGEBACK',
      'REPORT_AVAILABLE',
    ]) {
      expect(n({ eventCode })).toMatchObject({ type: 'ignored', providerType: eventCode });
    }
    expect(n({ eventCode: 'CAPTURE', originalReference: '' })).toMatchObject({ type: 'ignored' });
    expect(n({ eventCode: 'REFUND', amount: { value: 700, currency: 'IDR' } })).toMatchObject({
      type: 'ignored',
    });
    const noDate = n({ eventCode: 'CAPTURE', eventDate: 'not a date' });
    expect(noDate.occurredAt.getTime()).not.toBeNaN();
  });
});

describe('Adyen amounts', () => {
  it('keeps cents as minor units and uppercases the currency', () => {
    expect(toAdyenAmount(1130, 'eur')).toEqual({ value: 1130, currency: 'EUR' });
    expect(fromAdyenAmount({ value: 1130, currency: 'EUR' })).toBe(1130);
  });

  it('blocks IDR, unsupported currencies and invalid amounts', () => {
    expect(ADYEN_BLOCKED_CURRENCIES).toEqual(['IDR']);
    expect(() => toAdyenAmount(100, 'IDR')).toThrow(PaymentValidationError);
    expect(() => toAdyenAmount(100, 'JPY')).toThrow(PaymentValidationError);
    expect(() => toAdyenAmount(-1, 'EUR')).toThrow(PaymentValidationError);
    expect(() => fromAdyenAmount({ value: 100, currency: 'IDR' })).toThrow(PaymentValidationError);
    expect(() => fromAdyenAmount({ value: 1.5, currency: 'EUR' })).toThrow(PaymentValidationError);
  });
});
