// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A fake Adyen Checkout API behind a fetch function. Default answers follow
// the documented samples (docs.adyen.com: adjust-with-preauth, create-tokens,
// managing-tokens); a test queues its own answers with `next`.

import { adyenHmacSignature } from '../../providers/adyen/hmac.js';
import type { AdyenNotificationItem } from '../../providers/adyen/hmac.js';
import { AdyenPaymentProvider } from '../../providers/adyen/index.js';
import type { AdyenProviderOptions } from '../../providers/adyen/index.js';

/** The HMAC key of the Adyen verify-hmac-signatures example. */
export const DOC_HMAC_KEY = '44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056';
export const MERCHANT = 'TestMerchant';
export const PAYMENT_PSP = 'KHQC5N7G84BLNK43';
export const MODIFICATION_PSP = 'QJ7GWQ756L2GWR86';
export const TOKEN_ID = 'M5N7TQ4TG5PFWR50';

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export interface FakeAnswer {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Reject like a network failure instead of answering. */
  networkError?: boolean;
}

export interface FakeAdyen {
  fetch: typeof fetch;
  calls: RecordedCall[];
  /** Queue answers for the next calls, in order, before the defaults apply. */
  next(...answers: FakeAnswer[]): void;
  last(): RecordedCall;
}

function defaultAnswer(call: RecordedCall): FakeAnswer {
  const { method, path, body } = call;
  if (method === 'POST' && path.endsWith('/paymentMethods')) {
    return {
      body: { paymentMethods: [{ type: 'scheme', name: 'Cards', brands: ['visa', 'mc'] }] },
    };
  }
  if (method === 'POST' && (path.endsWith('/payments') || path.endsWith('/payments/details'))) {
    const amount = (body?.['amount'] as { value: number; currency: string } | undefined) ?? {
      value: 5000,
      currency: 'USD',
    };
    if (body?.['storePaymentMethod'] === true) {
      return {
        body: {
          pspReference: 'V4HZ4RBFJGXXGN82',
          resultCode: 'Authorised',
          amount,
          paymentMethod: { brand: 'visa', type: 'scheme' },
          additionalData: {
            'tokenization.shopperReference': String(body['shopperReference']),
            'tokenization.storedPaymentMethodId': TOKEN_ID,
            'tokenization.store.operationType': 'created',
            cardSummary: '1111',
          },
        },
      };
    }
    return {
      body: {
        pspReference: PAYMENT_PSP,
        resultCode: 'Authorised',
        amount,
        merchantReference: body?.['reference'],
      },
    };
  }
  const modification = /\/payments\/([^/]+)\/(captures|cancels|refunds|amountUpdates)$/.exec(path);
  if (method === 'POST' && modification != null) {
    return {
      body: {
        merchantAccount: MERCHANT,
        paymentPspReference: modification[1],
        pspReference: MODIFICATION_PSP,
        reference: body?.['reference'],
        status: 'received',
        ...(body?.['amount'] != null ? { amount: body['amount'] } : {}),
      },
    };
  }
  if (method === 'POST' && path.endsWith('/cancels')) {
    return {
      body: {
        merchantAccount: MERCHANT,
        paymentReference: body?.['paymentReference'],
        pspReference: MODIFICATION_PSP,
        status: 'received',
      },
    };
  }
  if (method === 'GET' && path.endsWith('/storedPaymentMethods')) {
    return {
      body: {
        merchantAccount: MERCHANT,
        shopperReference: call.query['shopperReference'],
        storedPaymentMethods: [
          {
            id: TOKEN_ID,
            brand: 'visa',
            lastFour: '1111',
            expiryMonth: '03',
            expiryYear: '2030',
            type: 'scheme',
            supportedRecurringProcessingModels: ['CardOnFile', 'UnscheduledCardOnFile'],
          },
        ],
      },
    };
  }
  if (method === 'DELETE' && path.includes('/storedPaymentMethods/')) return { status: 204 };
  return {
    status: 404,
    body: { status: 404, errorCode: '000', message: 'Not found', errorType: 'validation' },
  };
}

export function fakeAdyen(): FakeAdyen {
  const calls: RecordedCall[] = [];
  const queue: FakeAnswer[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      url: url.toString(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    };
    calls.push(call);
    const answer = queue.shift() ?? defaultAnswer(call);
    if (answer.networkError === true) return Promise.reject(new TypeError('fetch failed'));
    const status = answer.status ?? 200;
    const text =
      answer.body === undefined
        ? null
        : typeof answer.body === 'string'
          ? answer.body
          : JSON.stringify(answer.body);
    return Promise.resolve(
      new Response(status === 204 ? null : text, { status, headers: answer.headers ?? {} }),
    );
  };
  return {
    fetch: fetchFn,
    calls,
    next: (...answers) => {
      queue.push(...answers);
    },
    last: () => {
      const call = calls[calls.length - 1];
      if (call == null) throw new Error('No Adyen call was made');
      return call;
    },
  };
}

export function adyenOptions(
  fake: FakeAdyen,
  overrides: Partial<AdyenProviderOptions> = {},
): AdyenProviderOptions {
  return {
    apiKey: 'AQE_test_key',
    merchantAccount: MERCHANT,
    clientKey: 'test_CLIENTKEY',
    environment: 'test',
    liveUrlPrefix: null,
    liveRegion: 'eu',
    hmacKey: DOC_HMAC_KEY,
    hmacKeyPrevious: null,
    webhookUsername: 'adyen-hook',
    webhookPassword: 'hook-password',
    authorisationAdjustment: false,
    fetch: fake.fetch,
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

export function fakeAdyenProvider(overrides: Partial<AdyenProviderOptions> = {}): {
  provider: AdyenPaymentProvider;
  adyen: FakeAdyen;
} {
  const adyen = fakeAdyen();
  return { provider: new AdyenPaymentProvider(adyenOptions(adyen, overrides)), adyen };
}

export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/** A Standard JSON webhook body with each item signed under `hexKey`. */
export function signedNotification(
  items: AdyenNotificationItem[],
  options: { hexKey?: string; live?: string } = {},
): string {
  const hexKey = options.hexKey ?? DOC_HMAC_KEY;
  return JSON.stringify({
    live: options.live ?? 'false',
    notificationItems: items.map((item) => ({
      NotificationRequestItem: {
        ...item,
        additionalData: { ...item.additionalData, hmacSignature: adyenHmacSignature(item, hexKey) },
      },
    })),
  });
}
