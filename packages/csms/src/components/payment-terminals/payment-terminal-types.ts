// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';

/** One terminal of `GET /v1/payment-terminals` and `GET /v1/payment-terminals/:id`. */
export interface PaymentTerminal {
  id: string;
  label: string | null;
  provider: string;
  integrationMode: 'cloud' | 'hardware';
  providerDeviceId: string | null;
  vendor: string | null;
  model: string | null;
  serialNumber: string | null;
  firmwareVersion: string | null;
  siteId: string | null;
  siteName: string | null;
  stationId: string | null;
  stationOcppId: string | null;
  /** The paired connector (internal EVSE ID); null: station-wide. */
  evseId: string | null;
  /** The OCPP EVSE ID of the paired connector. */
  evseNumber: number | null;
  status: 'active' | 'inactive';
  online: boolean | null;
  lastSeenAt: string | null;
  statusFetchedAt: string | null;
  offlineSince: string | null;
  /** The model shows prompts on its own screen; a VP7200 uses the station display. */
  hasDisplay: boolean;
  simAttached: boolean;
  createdAt: string;
  updatedAt: string;
}

export const TERMINAL_TXN_STATES = [
  'requested',
  'presenting',
  'authorized',
  'declined',
  'expired',
  'failed',
  'void_requested',
  'voided',
  'capture_requested',
  'captured',
  'refund_pending',
  'partially_refunded',
  'refunded',
] as const;

export type TerminalTxnState = (typeof TERMINAL_TXN_STATES)[number];

/** States in which the hold can still be released (`POST .../void`). */
export const VOIDABLE_TXN_STATES: ReadonlySet<string> = new Set([
  'requested',
  'presenting',
  'authorized',
]);

/** One payment of `GET /v1/payment-terminals/:id/transactions`. */
export interface TerminalTransaction {
  id: string;
  paymentTerminalId: string;
  state: TerminalTxnState;
  currency: string;
  requestedCents: number;
  authorizedCents: number | null;
  capturedCents: number | null;
  refundedCents: number;
  cardLast4: string | null;
  cardBrand: string | null;
  declineCode: string | null;
  failureReason: string | null;
  siteId: string | null;
  stationId: string | null;
  evseNumber: number | null;
  sessionId: string | null;
  paymentRecordId: number | null;
  requestedAt: string;
  authorizedAt: string | null;
  capturedAt: string | null;
  voidedAt: string | null;
}

/** `GET /v1/payment-terminals/feature`. */
export interface PaymentTerminalFeature {
  available: boolean;
  providers: string[];
  terminalCount: number;
}

export const PAYMENT_TERMINAL_PROVIDERS = ['simulated', 'idtech'] as const;
export type PaymentTerminalProvider = (typeof PAYMENT_TERMINAL_PROVIDERS)[number];

/** Every payment terminal query sits under this key, so a write refreshes them all. */
export const PAYMENT_TERMINALS_KEY = ['payment-terminals'] as const;

export function paymentTerminalKey(id: string): readonly unknown[] {
  return [...PAYMENT_TERMINALS_KEY, id];
}

export const PAYMENT_TERMINAL_FEATURE_KEY = [...PAYMENT_TERMINALS_KEY, 'feature'] as const;

/**
 * Whether the Payment Terminals page applies (`GET /v1/payment-terminals/feature`):
 * a provider is configured or a terminal exists. Sends no request without
 * `paymentTerminals:read`; `available` is false until it answers.
 */
export function usePaymentTerminalFeature(): {
  feature: PaymentTerminalFeature | undefined;
  available: boolean;
  isLoading: boolean;
} {
  const canRead = useHasPermission('paymentTerminals:read');
  const { data, isLoading } = useQuery({
    queryKey: PAYMENT_TERMINAL_FEATURE_KEY,
    queryFn: () => api.get<PaymentTerminalFeature>('/v1/payment-terminals/feature'),
    enabled: canRead,
    staleTime: 60_000,
  });
  return { feature: data, available: data?.available === true, isLoading: canRead && isLoading };
}

/** The product name of a terminal provider. */
export function terminalProviderName(t: TFunction, provider: string): string {
  if (provider === 'simulated') return t('paymentTerminals.providers.simulated');
  if (provider === 'idtech') return 'ID TECH';
  return provider;
}

/** The terminal's label, else its serial number, else its provider device ID. */
export function terminalName(terminal: PaymentTerminal): string {
  return terminal.label ?? terminal.serialNumber ?? terminal.providerDeviceId ?? terminal.id;
}

/** "CS-001, Connector 1", "CS-001, Whole Station", or null when unpaired. */
export function terminalPairingLabel(t: TFunction, terminal: PaymentTerminal): string | null {
  if (terminal.stationId == null) return null;
  const station = terminal.stationOcppId ?? terminal.stationId;
  const connector =
    terminal.evseNumber != null
      ? t('paymentTerminals.connector', { number: terminal.evseNumber })
      : t('paymentTerminals.wholeStation');
  return `${station}, ${connector}`;
}

export function txnStateVariant(
  state: string,
): 'success' | 'secondary' | 'destructive' | 'warning' | 'info' | 'outline' {
  switch (state) {
    case 'captured':
      return 'success';
    case 'authorized':
    case 'capture_requested':
      return 'info';
    case 'requested':
    case 'presenting':
    case 'void_requested':
    case 'refund_pending':
      return 'warning';
    case 'declined':
    case 'failed':
      return 'destructive';
    case 'refunded':
    case 'partially_refunded':
    case 'voided':
    case 'expired':
      return 'secondary';
    default:
      return 'outline';
  }
}

export function txnStateLabel(t: TFunction, state: string): string {
  return (TERMINAL_TXN_STATES as readonly string[]).includes(state)
    ? t(`paymentTerminals.txnStates.${state as TerminalTxnState}`)
    : state;
}
