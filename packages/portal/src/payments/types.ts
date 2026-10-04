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

/** `GET /v1/portal/payment-provider`. */
export interface PaymentProviderDescriptor {
  paymentEnabled: boolean;
  provider: ClientConfig | null;
  capabilities: {
    savedMethods: boolean;
    clientActions: boolean;
    nativeMobileSheet: boolean;
  } | null;
}

/** `POST /v1/portal/payment-methods/setup-intent` (the fields the provider UI reads). */
export interface SetupIntentResponse {
  session: SetupSession;
}

/** A saved card as the portal lists it. */
export interface PaymentMethodItem {
  id: string;
  driverId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  isDefault: boolean;
}

/** Body of a successful `setup/submit` or `setup/details` response. */
export type SetupStepResponse =
  | { status: 'saved'; method: PaymentMethodItem }
  | { status: 'action_required'; action: { provider: string; data: unknown } };

export type SetupStepResult =
  | { status: 'saved' }
  | { status: 'action_required'; action: { provider: string; data: unknown } }
  | { status: 'refused'; reason: string };

/**
 * The browser a card UI runs in, for a 3D Secure step (Adyen). The API checks
 * the origin against PORTAL_URL and builds the return URL itself.
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

/**
 * Outcome of a guest payment step the host handled. `done`: the host navigated
 * (charging started) or showed its own field error. `action_required`: the card
 * needs 3D Secure; the module runs the action and sends its result to payDetails.
 */
export type GuestPayResult =
  | { status: 'done' }
  | {
      status: 'action_required';
      sessionToken: string;
      action: { provider: string; data: unknown };
    };

export interface GuestPaymentProps {
  /** charger-config `paymentProvider`. */
  config: ClientConfig;
  /** Pre-auth amount shown to the guest. */
  amountCents: number;
  currency: string;
  /** Company country (charger-config countryCode), for card UIs that need it (Adyen Web). */
  countryCode?: string;
  disabled: boolean;
  /**
   * Host calls guest start with { provider, payload, browser? } and navigates on success.
   * Resolves when the host handled the outcome (navigation, or its own field error) or
   * with the 3D Secure action; rejects with an error the module shows (ApiError or Error).
   */
  pay: (payload: unknown, browser?: ShopperBrowser) => Promise<GuestPayResult>;
  /**
   * Host posts the 3D Secure result to the guest payment-details route of the session
   * and navigates once charging starts. A refused card rejects (400 PAYMENT_FAILED) and
   * fails the session: the next pay starts a new one.
   */
  payDetails: (sessionToken: string, details: unknown) => Promise<GuestPayResult>;
}

export interface PaymentProviderModule {
  id: string;
  CardSetup: React.ComponentType<CardSetupProps>;
  GuestPayment?: React.ComponentType<GuestPaymentProps>;
}
