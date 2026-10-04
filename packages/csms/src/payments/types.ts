// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type * as React from 'react';

/** A provider's browser-safe client config (`provider.clientConfig()` on the API). */
export interface ClientConfig {
  provider: string;
  [key: string]: unknown;
}

/** The provider's method setup session from the setup-intent response (`session`). */
export interface SetupSession extends ClientConfig {
  customerId: string;
}

/** `POST /v1/drivers/:id/payment-methods/setup-intent` (the fields the provider UI reads). */
export interface SetupIntentResponse {
  session: SetupSession;
}

/** A driver's saved card as the operator API returns it. */
export interface DriverPaymentMethodItem {
  id: string;
  driverId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  isDefault: boolean;
  [key: string]: unknown;
}

/** Body of a successful `setup/submit` or `setup/details` response. */
export type SetupStepResponse =
  | { status: 'saved'; method: DriverPaymentMethodItem }
  | { status: 'action_required'; action: { provider: string; data: unknown } };

export type SetupStepResult =
  | { status: 'saved' }
  | { status: 'action_required'; action: { provider: string; data: unknown } }
  | { status: 'refused'; reason: string };

/**
 * The browser a card UI runs in, for a 3D Secure step (Adyen). The API checks
 * the origin against CSMS_URL and builds the return URL itself.
 */
export interface ShopperBrowser {
  origin: string;
  info?: unknown;
}

export interface CardSetupProps {
  session: SetupSession;
  /**
   * Host posts setup/submit with its attemptId (and `browser` when the provider can
   * ask for 3D Secure); API errors are thrown as ApiError.
   */
  submit: (payload: unknown, browser?: ShopperBrowser) => Promise<SetupStepResult>;
  /** Host posts setup/details (3DS or simulated challenge result). */
  submitDetails: (details: unknown) => Promise<SetupStepResult>;
  onSaved: () => void;
  onCancel: () => void;
}

export interface PaymentProviderModule {
  id: string;
  CardSetup: React.ComponentType<CardSetupProps>;
}
