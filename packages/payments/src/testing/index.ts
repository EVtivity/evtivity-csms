// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Test support for code that moves money through Stripe: the golden
 * Stripe-call recorder used by the API, worker and OCPP integration tests
 * (`@evtivity/payments/testing`). Not part of the runtime API.
 */
export {
  FakeStripeError,
  fakeStripeModule,
  fakeStripeSignature,
  goldenJson,
  normalizeGolden,
  stripeRecorder,
} from './stripe-recorder.js';
export type { FakeIntent, RecordedStripeCall } from './stripe-recorder.js';
