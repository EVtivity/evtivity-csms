// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { and, eq, isNull } from 'drizzle-orm';
import {
  db,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
  userAuditLog,
  users,
  writeAudit,
} from '@evtivity/database';
import { createRedisClient } from '@evtivity/lib';
import { config } from './config.js';

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * The IdP subject an SSO sign-in will bind once the account passes its MFA step:
 * keyed by the SHA-256 of the MFA pending or
 * enrollment token the callback handed out, so only the sign-in that started with
 * that token, and completed it, binds. Under the API user's single-use nonce
 * prefix (`attest:nonce:*` in the Redis ACL), as the SAML request ids.
 */
export const SSO_LINK_KEY_PREFIX = 'attest:nonce:sso-link:';

/** Longer than the MFA pending (3 minutes) and enrollment (10 minutes) tokens. */
export const SSO_LINK_TTL_SECONDS = 15 * 60;

let redis: Redis | null = null;
function client(): Redis {
  if (redis == null) {
    redis = createRedisClient(config.REDIS_URL, 'sso-links', { maxRetriesPerRequest: 2 });
  }
  return redis;
}

const keyOf = (token: string): string =>
  `${SSO_LINK_KEY_PREFIX}${crypto.createHash('sha256').update(token).digest('hex')}`;

// The pending bind of an account, so an unlink or a withdrawn link can void it.
const userKeyOf = (userId: string): string => `${SSO_LINK_KEY_PREFIX}user:${userId}`;

/**
 * Binds an account without a subject to this one, once: the UPDATE matches only
 * while the subject is unset and the link is allowed, checked at bind time, and
 * the unique index refuses a subject another account holds. Clears the link
 * permission. False when it did not bind. An SSO-created account holds its
 * subject from the insert, so only the link permission opens a bind: an admin
 * who clears a binding re-grants it, for SSO-created and password accounts alike
 * (migration 0479 grants it to SSO accounts created unbound before v0.1.48).
 */
export async function linkSsoSubject(
  userId: string,
  subject: string,
  log: Logger,
): Promise<boolean> {
  let rows: Array<{ id: string }>;
  try {
    rows = await db
      .update(users)
      .set({ ssoSubject: subject, ssoLinkAllowed: false, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.ssoSubject), eq(users.ssoLinkAllowed, true)))
      .returning({ id: users.id });
  } catch (err) {
    if (pgErrorCode(err) !== PG_UNIQUE_VIOLATION) throw err;
    log.warn({ userId }, 'SSO subject already bound to another account, not linking');
    return false;
  }
  if (rows.length === 0) return false;
  await writeAudit(
    { table: userAuditLog, idColumn: 'user_id' },
    {
      entityId: userId,
      entityIdSnapshot: userId,
      action: 'updated',
      actor: 'system',
      actorLabel: 'sso',
      after: { ssoLinked: true },
      notes: 'SSO subject bound at the first SSO sign-in',
    },
    db,
    log,
  );
  return true;
}

/** Keeps the subject an SSO sign-in binds when the MFA step behind `token` completes. */
export async function rememberPendingSsoLink(
  token: string,
  userId: string,
  subject: string,
): Promise<void> {
  await client()
    .multi()
    .set(keyOf(token), JSON.stringify({ userId, subject }), 'EX', SSO_LINK_TTL_SECONDS)
    .set(userKeyOf(userId), keyOf(token), 'EX', SSO_LINK_TTL_SECONDS)
    .exec();
}

/**
 * Voids the pending bind of an account (an admin cleared its binding or withdrew
 * the link). The caller also raises the session version, which ends the MFA
 * pending and enrollment tokens the bind waits on.
 */
export async function voidPendingSsoLink(userId: string, log: Logger): Promise<void> {
  try {
    const tokenKey = await client().getdel(userKeyOf(userId));
    if (tokenKey != null) await client().del(tokenKey);
  } catch (err) {
    log.warn({ err, userId }, 'The pending SSO bind was not voided; the session version ends it');
  }
}

/**
 * Binds the subject an SSO sign-in left for this MFA pending or enrollment token,
 * once the step completed for the same account. Read once (GETDEL); a token of a
 * password sign-in has nothing stored, so it binds nothing. A failure is logged:
 * the session stands, and the next SSO sign-in asks for the link again.
 */
export async function completePendingSsoLink(
  token: string,
  userId: string,
  log: Logger,
): Promise<void> {
  try {
    const stored = await client().getdel(keyOf(token));
    if (stored == null) return;
    const pending = JSON.parse(stored) as { userId?: unknown; subject?: unknown };
    if (pending.userId !== userId || typeof pending.subject !== 'string') return;
    await linkSsoSubject(userId, pending.subject, log);
  } catch (err) {
    log.warn({ err, userId }, 'The SSO subject of the completed MFA step was not bound');
  }
}

/** The raw Bearer token of a request (the MFA enrollment token of the setup routes), or ''. */
export function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  return typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
}
