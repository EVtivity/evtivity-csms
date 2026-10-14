// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { AuditActor } from '@evtivity/database';
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
 * Who runs a payment operation, recorded on the audit rows the services write
 * (`payment_audit_log`, the driver payment method and site payout rows): the
 * operator, API key or driver of a request, or `system` / `ocpp` with the job,
 * webhook or message in `actorLabel`.
 */
export interface PaymentActor {
  actor: AuditActor;
  actorUserId?: string | null;
  actorDriverId?: string | null;
  actorApiKeyId?: string | null;
  actorLabel?: string | null;
}

/** The actor of a context without one: a system write of the payment services. */
export const PAYMENT_SYSTEM_ACTOR: PaymentActor = { actor: 'system', actorLabel: 'payments' };

/**
 * What every payment service needs from the calling process: its provider
 * registry (built once with the process's SETTINGS_ENCRYPTION_KEY and
 * PAYMENTS_ALLOW_SIMULATED), a logger and the actor its audit rows name. The
 * services read and write the database through the shared `db` client of
 * @evtivity/database, and return outcomes; notifications and pub/sub stay
 * with the caller.
 */
export interface PaymentContext {
  registry: PaymentProviderRegistry;
  logger: PaymentLogger;
  /** Defaults to PAYMENT_SYSTEM_ACTOR. Each process's `paymentContext` requires it. */
  actor?: PaymentActor;
}

/** The context with another actor: a step that names itself on the audit rows. */
export function withPaymentActor<T extends PaymentContext>(ctx: T, actor: PaymentActor): T {
  return { ...ctx, actor };
}

/** What an audited payment write needs from its caller: the actor and a logger for a failed audit insert. */
export type PaymentAuditContext = Pick<PaymentContext, 'logger' | 'actor'>;

/**
 * The `writeAudit` arguments for a payment service write: the context's actor
 * (PAYMENT_SYSTEM_ACTOR without one) and its logger in the shape writeAudit takes.
 */
export function auditActorOf(audit: PaymentAuditContext): {
  actor: PaymentActor;
  logger: { warn: (obj: unknown, msg?: string) => void };
} {
  return {
    actor: audit.actor ?? PAYMENT_SYSTEM_ACTOR,
    logger: {
      warn: (obj: unknown, msg?: string) => {
        audit.logger.warn(typeof obj === 'object' && obj != null ? obj : { detail: obj }, msg);
      },
    },
  };
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
