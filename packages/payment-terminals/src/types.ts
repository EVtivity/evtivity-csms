// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The payment terminal provider contract. A provider is the cloud API that
// drives a card terminal (ID TECH PSG) or the simulated provider. It never
// touches the database: @evtivity/payments owns the money records.

/** `cloud`: the CSMS calls the terminal provider's cloud. `hardware`: the charger drives the terminal over OCPP (later). */
export type TerminalIntegrationMode = 'cloud' | 'hardware';

/** A later provider adds its id here and its factory to the registry. */
export type TerminalProviderId = 'simulated' | 'idtech';

export const TERMINAL_PROVIDER_IDS: readonly TerminalProviderId[] = Object.freeze([
  'simulated',
  'idtech',
]);

export function isTerminalProviderId(value: unknown): value is TerminalProviderId {
  return TERMINAL_PROVIDER_IDS.includes(value as TerminalProviderId);
}

export interface TerminalProviderCapabilities {
  modes: readonly TerminalIntegrationMode[];
  /** The hold can be raised while the session runs (OCPP C23 analog). */
  incrementalAuthorization: boolean;
  /** A capture may be less than the authorized amount. */
  partialCapture: boolean;
  refunds: 'full_and_partial' | 'full' | 'none';
  events: 'webhook' | 'polling' | 'both';
  /** `getTransaction` reports the current state of a transaction. */
  stateLookup: boolean;
  receipts: 'provider_url' | 'data' | 'none';
  /** `getDevice` reports online or offline. */
  deviceStatus: boolean;
  /** `displayMessage` shows a prompt or a receipt link on the terminal's own screen. */
  display: boolean;
}

export interface TerminalDevice {
  providerDeviceId: string;
  /** Manufacturer, such as `ID TECH`; null when the provider does not say. */
  vendor: string | null;
  serialNumber: string | null;
  /** `VP6825`, `VP7200`, or the provider's own model name. */
  model: string | null;
  firmwareVersion: string | null;
  online: boolean | null;
  lastSeenAt: Date | null;
  /** The device's own SIM, when the provider reports it. */
  iccid: string | null;
}

export const TERMINAL_TXN_STATES = [
  'requested',
  'presenting',
  'authorized',
  'declined',
  'expired',
  'capture_requested',
  'captured',
  'void_requested',
  'voided',
  'refund_pending',
  'partially_refunded',
  'refunded',
  'failed',
] as const;

export type TerminalTxnState = (typeof TERMINAL_TXN_STATES)[number];

/** The provider-side state of a transaction (a subset: the CSMS states add the `*_requested` claims). */
export type ProviderTxnState =
  | 'presenting'
  | 'authorized'
  | 'declined'
  | 'expired'
  | 'captured'
  | 'voided'
  | 'refunded'
  | 'partially_refunded'
  | 'failed';

export interface StartTerminalPaymentInput {
  providerDeviceId: string;
  /** Hold amount in cents, 1 to 1,000,000. */
  amountCents: number;
  currency: string;
  /** `terminal_auth_<terminalTransactionId>`. */
  idempotencyKey: string;
  /** The CSMS terminal transaction id, echoed in events. */
  reference: string;
  /** How long the device waits for a card. */
  timeoutSeconds: number;
  /**
   * A station-wide terminal: the connectors the driver may pick from on the
   * terminal screen (OCPP EVSE ids). Empty: the terminal is paired to one
   * connector, or the device has no screen.
   */
  evseChoices: readonly number[];
}

export interface TerminalTxnResult {
  /** The provider's transaction reference; it becomes the OCPP pspRef. */
  providerTxnRef: string;
  state: ProviderTxnState;
  authorizedCents: number | null;
  capturedCents: number | null;
  /** ISO 4217, upper case; null when the provider did not say. */
  currency: string | null;
  /** Last 4 digits only. */
  cardLast4: string | null;
  /** First 6 digits (BIN) only. */
  cardBin: string | null;
  cardBrand: string | null;
  declineCode: string | null;
  receiptUrl: string | null;
  /** The connector the driver picked on the terminal screen (station-wide terminals), else null. */
  evseId: number | null;
}

export interface TerminalRefundResult {
  refundRef: string;
  state: 'pending' | 'succeeded';
}

export interface TerminalEvent {
  /** The provider's event id, the dedupe key. */
  eventId: string;
  providerTxnRef: string | null;
  providerDeviceId: string | null;
  /** The CSMS reference sent with the payment, when the provider echoes it. */
  reference: string | null;
  kind: 'txn_state' | 'device_status' | 'refund';
  txn?: TerminalTxnResult;
  device?: Pick<TerminalDevice, 'online' | 'lastSeenAt' | 'iccid'>;
  refund?: { refundRef: string; amountCents: number; state: 'succeeded' | 'failed' };
}

/** A prompt shown on the terminal's own screen (VP6825). */
export interface TerminalDisplayMessage {
  kind: 'present_card' | 'result' | 'receipt';
  text: string;
  /** A link the screen shows as a QR code (the receipt). */
  qrUrl?: string;
}

export interface PaymentTerminalProvider {
  readonly id: TerminalProviderId;
  readonly capabilities: TerminalProviderCapabilities;
  testConnection(): Promise<{ ok: true } | { ok: false; reason: string }>;
  listDevices(cursor?: string): Promise<{ devices: TerminalDevice[]; next: string | null }>;
  getDevice(providerDeviceId: string): Promise<TerminalDevice | null>;
  startPayment(input: StartTerminalPaymentInput): Promise<TerminalTxnResult>;
  /** Null when the provider does not know the reference. Throws `unsupported` without `stateLookup`. */
  getTransaction(providerTxnRef: string): Promise<TerminalTxnResult | null>;
  /** Captures at most the authorized amount; the provider refuses more. */
  capture(providerTxnRef: string, amountCents: number, key: string): Promise<TerminalTxnResult>;
  void(providerTxnRef: string, key: string): Promise<TerminalTxnResult>;
  refund(providerTxnRef: string, amountCents: number, key: string): Promise<TerminalRefundResult>;
  /** Shows a prompt on the device screen. Throws `unsupported` without `display`. */
  displayMessage(providerDeviceId: string, message: TerminalDisplayMessage): Promise<void>;
  /** The events of a webhook body. Throws `TerminalProviderError('auth')` on a bad signature. */
  verifyWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
    now?: Date,
  ): TerminalEvent[];
}

export type TerminalProviderErrorKind =
  | 'auth'
  | 'declined'
  | 'not_found'
  | 'device_offline'
  | 'device_busy'
  | 'rate_limited'
  | 'unavailable'
  | 'validation'
  | 'unsupported';

/** Kinds worth asking again later with the same key. */
const RETRYABLE: ReadonlySet<TerminalProviderErrorKind> = new Set([
  'rate_limited',
  'unavailable',
  'device_busy',
]);

export class TerminalProviderError extends Error {
  readonly kind: TerminalProviderErrorKind;
  /** Set for `rate_limited`: the wait the provider asked for, capped at one hour. */
  readonly retryAfterSeconds: number | null;
  /** The processor's decline code for `declined`. */
  readonly declineCode: string | null;

  constructor(
    kind: TerminalProviderErrorKind,
    message: string,
    options: {
      retryAfterSeconds?: number | null;
      declineCode?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause != null ? { cause: options.cause } : undefined);
    this.name = 'TerminalProviderError';
    this.kind = kind;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.declineCode = options.declineCode ?? null;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/** Every terminal hold and capture amount is 1 to 1,000,000 cents (security case 102). */
export const TERMINAL_AMOUNT_MIN_CENTS = 1;
export const TERMINAL_AMOUNT_MAX_CENTS = 1_000_000;

export function isTerminalAmount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TERMINAL_AMOUNT_MIN_CENTS &&
    value <= TERMINAL_AMOUNT_MAX_CENTS
  );
}
