// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Test support for code that moves money through a provider: the golden
 * Stripe-call recorder used by the API, worker and OCPP integration tests,
 * and the fake Adyen Checkout API with signed webhook bodies
 * (`@evtivity/payments/testing`). Not part of the runtime API.
 */
export {
  FAKE_LINK_CREATED,
  FAKE_LINK_EXPIRES_AT,
  FakeStripeError,
  fakeStripeModule,
  fakeStripeSignature,
  goldenJson,
  normalizeGolden,
  stripeRecorder,
} from './stripe-recorder.js';
export {
  adyenOptions,
  basicAuth,
  DOC_HMAC_KEY,
  fakeAdyen,
  fakeAdyenProvider,
  MERCHANT,
  MODIFICATION_PSP,
  PAYMENT_PSP,
  signedNotification,
  TOKEN_ID,
} from './fake-adyen.js';
export type { FakeAdyen, FakeAnswer, RecordedCall } from './fake-adyen.js';
export type {
  FakeIntent,
  FakePayoutAccount,
  FakeWebhookEndpoint,
  RecordedStripeCall,
} from './stripe-recorder.js';
