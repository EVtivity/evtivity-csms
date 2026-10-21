// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { db, writeAudit, userAuditLog, driverAuditLog } from '@evtivity/database';

/** How the account proved its identity. */
export type AuthMethod =
  | 'password'
  | 'mfa'
  | 'recovery_code'
  | 'webauthn'
  | 'passkey'
  | 'mfa_enrollment'
  | 'sso'
  | 'reset_token'
  | 'verification_token';

export type AuthAuditAction =
  | 'login_succeeded'
  | 'login_failed'
  | 'password_reset'
  | 'email_verified';

export interface AuthAuditArgs {
  kind: 'user' | 'driver';
  /**
   * The account the request names. A login for an unknown email writes no row; null
   * records a failure that names no account (an unknown passkey) with no account id.
   */
  accountId: string | null;
  action: AuthAuditAction;
  method: AuthMethod;
  /** Why a login failed (bad_password, inactive, mfa_code_invalid, ...). */
  reason?: string;
}

const USER_AGENT_MAX = 255;

/** The account id snapshot of a failure that names no account. */
const UNKNOWN_ACCOUNT = 'unknown';

/**
 * The request origin recorded on an auth row: the client IP and user agent,
 * never a password, code or token.
 */
export function authRequestOrigin(request: FastifyRequest): {
  ip: string;
  userAgent: string | null;
} {
  const ua = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof ua === 'string' && ua !== '' ? ua.slice(0, USER_AGENT_MAX) : null,
  };
}

/**
 * Writes an authentication audit row (login success or failure, password reset
 * by token, email verification) on the user or driver audit log. The request is
 * not authenticated yet, so the actor is the account itself on success and
 * `system` labelled `login` on a failure (the caller has not proved it owns the
 * account). Fail-open like every audit write.
 */
export async function recordAuthAudit(request: FastifyRequest, args: AuthAuditArgs): Promise<void> {
  const failed = args.action === 'login_failed';
  if (!failed && args.accountId == null) return;
  const actor =
    failed || args.accountId == null
      ? ({ actor: 'system', actorLabel: 'login' } as const)
      : args.kind === 'user'
        ? ({ actor: 'operator', actorUserId: args.accountId } as const)
        : ({ actor: 'driver', actorDriverId: args.accountId } as const);
  const config =
    args.kind === 'user'
      ? { table: userAuditLog, idColumn: 'user_id' }
      : { table: driverAuditLog, idColumn: 'driver_id' };
  await writeAudit(
    config,
    {
      entityId: args.accountId,
      entityIdSnapshot: args.accountId ?? UNKNOWN_ACCOUNT,
      action: args.action,
      ...actor,
      after: { method: args.method, ...authRequestOrigin(request) },
      notes: args.reason ?? null,
    },
    db,
    request.log,
  );
}
