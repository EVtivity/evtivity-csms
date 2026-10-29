// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ID TECH Payment Service Gateway (PSG): the ASSUMED cloud contract.
//
// ID TECH publishes no PSG API documentation (plan 2026-10-29, Section 2.2).
// Every name, path, field, state and header below is an assumption made
// before the sandbox exists. They live in this one module, so the real
// contract replaces this file and the mock fixtures, and nothing else. A
// live sandbox run confirms or replaces each one.

import type { ProviderTxnState, TerminalProviderErrorKind } from '../types.js';

/**
 * False until a recorded live run against the PSG sandbox passes (owner
 * decision 2026-10-29). While false the adapter is built only under NODE_ENV
 * development or test, and the settings route refuses to turn it on elsewhere.
 */
export const IDTECH_LIVE_VERIFIED: boolean = false;

/** Assumed base URLs, fixed in code per environment (the setting is only the environment). */
export const IDTECH_BASE_URLS = Object.freeze({
  sandbox: 'https://psg-sandbox.idtechproducts.com/api/v1',
  production: 'https://psg.idtechproducts.com/api/v1',
});

export type IdtechEnvironment = keyof typeof IDTECH_BASE_URLS;

/** The path prefix a mock serves the contract under (`<PAYMENT_TERMINAL_TEST_BASE_URL>/idtech/api/v1`). */
export const IDTECH_TEST_PATH = '/idtech/api/v1';

/** Assumed authentication: HTTP Basic with the API key and secret, the merchant in a header. */
export const IDTECH_HEADERS = Object.freeze({
  merchant: 'X-Merchant-Id',
  idempotency: 'Idempotency-Key',
  /** Assumed webhook signature header, value `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
  signature: 'x-psg-signature',
});

/** Assumed routes. `{id}` and `{ref}` are path-encoded. */
export const IDTECH_PATHS = Object.freeze({
  ping: '/merchants/{merchant}',
  devices: '/devices',
  device: '/devices/{id}',
  display: '/devices/{id}/display',
  preauth: '/transactions/preauth',
  transaction: '/transactions/{ref}',
  capture: '/transactions/{ref}/capture',
  void: '/transactions/{ref}/void',
  refund: '/transactions/{ref}/refund',
});

/** Assumed transaction states and how they map. */
export const IDTECH_TXN_STATES: Readonly<Record<string, ProviderTxnState>> = Object.freeze({
  PENDING_CARD: 'presenting',
  CARD_PRESENTED: 'presenting',
  AUTHORIZED: 'authorized',
  DECLINED: 'declined',
  TIMED_OUT: 'expired',
  CANCELLED_BY_CARDHOLDER: 'expired',
  CAPTURED: 'captured',
  VOIDED: 'voided',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
  ERROR: 'failed',
});

/** Assumed device states. */
export const IDTECH_DEVICE_ONLINE: Readonly<Record<string, boolean>> = Object.freeze({
  ONLINE: true,
  OFFLINE: false,
});

/** Assumed webhook event types. */
export const IDTECH_EVENT_TYPES = Object.freeze({
  transaction: 'transaction.updated',
  device: 'device.status',
  refund: 'refund.updated',
});

/** Assumed error codes in a 409 or 422 body (`{ "error": { "code": ... } }`). */
export const IDTECH_ERROR_CODES: Readonly<Record<string, TerminalProviderErrorKind>> =
  Object.freeze({
    DEVICE_BUSY: 'device_busy',
    DEVICE_OFFLINE: 'device_offline',
    AMOUNT_ABOVE_AUTHORIZED: 'validation',
    INVALID_STATE: 'validation',
    CARD_DECLINED: 'declined',
  });

/** HTTP status to error kind when the body names no known code. */
export function idtechStatusKind(status: number): TerminalProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'declined';
  if (status === 404) return 'not_found';
  if (status === 409) return 'device_busy';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'validation';
}

/**
 * Assumed request bodies (amounts in minor units, currency ISO 4217).
 * `connectorChoices` asks a station-wide VP6825 to show a connector pick;
 * the authorized transaction then carries `connectorId`.
 */
export interface IdtechPreauthBody {
  deviceId: string;
  amount: number;
  currency: string;
  reference: string;
  timeoutSeconds: number;
  connectorChoices?: number[];
}

/** Assumed reply shapes, read through the allow-list in adapter.ts. */
export interface IdtechTransaction {
  transactionId?: unknown;
  status?: unknown;
  authorizedAmount?: unknown;
  capturedAmount?: unknown;
  currency?: unknown;
  card?: { last4?: unknown; bin?: unknown; brand?: unknown } | null;
  responseCode?: unknown;
  receiptUrl?: unknown;
  connectorId?: unknown;
  reference?: unknown;
}

export interface IdtechDevice {
  deviceId?: unknown;
  serialNumber?: unknown;
  model?: unknown;
  firmwareVersion?: unknown;
  status?: unknown;
  lastSeen?: unknown;
  iccid?: unknown;
}

/** The manufacturer of every PSG device (the PSG serves ID TECH terminals only). */
export const IDTECH_VENDOR = 'ID TECH';

/** The models the plan targets; the CSMS shows their card entry list. */
export const IDTECH_MODELS = Object.freeze({
  VP6825: Object.freeze({
    display: true,
    entry: Object.freeze(['chip', 'contactless', 'swipe', 'pin']),
  }),
  VP7200: Object.freeze({ display: false, entry: Object.freeze(['contactless']) }),
});

export type IdtechModel = keyof typeof IDTECH_MODELS;

/** True when the model has its own screen (prompts go there instead of the station display). */
export function idtechModelHasDisplay(model: string | null): boolean {
  return model !== 'VP7200';
}
