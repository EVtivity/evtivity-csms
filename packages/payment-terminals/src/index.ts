// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export type {
  PaymentTerminalProvider,
  ProviderTxnState,
  StartTerminalPaymentInput,
  TerminalDevice,
  TerminalDisplayMessage,
  TerminalEvent,
  TerminalIntegrationMode,
  TerminalProviderCapabilities,
  TerminalProviderErrorKind,
  TerminalProviderId,
  TerminalRefundResult,
  TerminalTxnResult,
  TerminalTxnState,
} from './types.js';
export {
  isTerminalAmount,
  isTerminalProviderId,
  TERMINAL_AMOUNT_MAX_CENTS,
  TERMINAL_AMOUNT_MIN_CENTS,
  TERMINAL_PROVIDER_IDS,
  TERMINAL_TXN_STATES,
  TerminalProviderError,
} from './types.js';
export {
  cardBin,
  cardBrand,
  cardLast4,
  looksLikePan,
  redactPanRuns,
  safeText,
} from './card-fields.js';
export {
  TERMINAL_HTTP_TIMEOUT_MS,
  TERMINAL_MAX_REPLY_BYTES,
  TERMINAL_MAX_WEBHOOK_BYTES,
} from './http.js';
export {
  signWebhookBody,
  verifyWebhookSignature,
  WEBHOOK_TOLERANCE_SECONDS,
} from './webhook-signature.js';
export type { SimulatedTerminalEventSink, SimulatedTerminalOptions } from './simulated/provider.js';
export {
  SIMULATED_CARD,
  SIMULATED_DEVICES,
  SIMULATED_DEVICE_VENDOR,
  SIMULATED_FIRMWARE_VERSIONS,
  SIMULATED_SIGNATURE_HEADER,
  SimulatedTerminalProvider,
  simulatedWebhookSecret,
} from './simulated/provider.js';
export type { IdtechProviderOptions } from './idtech/adapter.js';
export { IdtechTerminalProvider, mapIdtechDevice, mapIdtechTransaction } from './idtech/adapter.js';
export {
  IDTECH_BASE_URLS,
  IDTECH_HEADERS,
  IDTECH_LIVE_VERIFIED,
  IDTECH_MODELS,
  IDTECH_TEST_PATH,
  idtechModelHasDisplay,
} from './idtech/contract.js';
export type { IdtechEnvironment, IdtechModel } from './idtech/contract.js';
export type { PaymentTerminalRegistryOptions, TerminalProviderSettings } from './registry.js';
export { idtechBuildAllowed, idtechConfigured, PaymentTerminalRegistry } from './registry.js';
