// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PaymentProviderRegistry } from './registry.js';
import type { ModificationResult } from './types.js';

/** The logger shape the services write to (pino and the Fastify logger both fit). */
export interface PaymentLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * What every payment service needs from the calling process: its provider
 * registry (built once with the process's SETTINGS_ENCRYPTION_KEY and
 * PAYMENTS_ALLOW_SIMULATED) and a logger. The services read and write the
 * database through the shared `db` client of @evtivity/database, and return
 * outcomes; notifications and pub/sub stay with the caller.
 */
export interface PaymentContext {
  registry: PaymentProviderRegistry;
  logger: PaymentLogger;
}

/**
 * The provider's reference of an operation it confirms later by webhook
 * (async providers), or null when the result is final now.
 */
export function pendingRef(result: ModificationResult<object>): string | null {
  return result.state === 'pending' ? result.operationRef : null;
}

/** The error message stored as a failure reason, cut to the column width. */
export function errorMessage(err: unknown, fallback: string, max = 500): string {
  return err instanceof Error ? err.message.slice(0, max) : fallback;
}
