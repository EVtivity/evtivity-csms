// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { client, db, drivers, users } from '@evtivity/database';
import { dispatchSystemNotification, type NotificationDispatchResult } from '@evtivity/lib';
import type { SecurityNoticeEventType } from '@evtivity/lib/notification-events';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import type { MfaAccount } from '../services/mfa-factor.service.js';

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface SecurityNoticeOptions {
  /** Email this address instead of the account's (the previous address of an email change). */
  email?: string | null;
  /**
   * Text this number (the previous number of a phone change), or nobody with null.
   * Omitted: the account's number while the account signs in with SMS codes.
   */
  phone?: string | null;
  /**
   * Text the account's number even though the account no longer signs in with SMS
   * codes: the change that ended SMS sign-in (MFA turned off, an admin reset).
   */
  textAccountPhone?: boolean;
}

interface NoticeAccount {
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  language: string | null;
  timezone: string | null;
  mfaEnabled: boolean;
  mfaMethod: string | null;
}

async function loadAccount(account: MfaAccount): Promise<NoticeAccount | null> {
  if ('driverId' in account) {
    const [driver] = await db
      .select({
        email: drivers.email,
        phone: drivers.phone,
        firstName: drivers.firstName,
        lastName: drivers.lastName,
        language: drivers.language,
        timezone: drivers.timezone,
        mfaEnabled: drivers.mfaEnabled,
        mfaMethod: drivers.mfaMethod,
      })
      .from(drivers)
      .where(eq(drivers.id, account.driverId));
    return driver ?? null;
  }
  const [user] = await db
    .select({
      email: users.email,
      phone: users.phone,
      firstName: users.firstName,
      lastName: users.lastName,
      language: users.language,
      timezone: users.timezone,
      mfaEnabled: users.mfaEnabled,
      mfaMethod: users.mfaMethod,
    })
    .from(users)
    .where(eq(users.id, account.userId));
  return user ?? null;
}

/**
 * Tells the account holder that the account's security changed: by email, and by
 * text message when the account signs in with SMS codes (or to the number in
 * `options.phone`). The notice holds no secret. It ignores the operator's SMS
 * opt-out (no `userId` on the recipient) and is always on, like every system event.
 */
export async function notifySecurityChange(
  account: MfaAccount,
  eventType: SecurityNoticeEventType,
  variables: Record<string, unknown>,
  options: SecurityNoticeOptions = {},
): Promise<NotificationDispatchResult | null> {
  const holder = await loadAccount(account);
  if (holder == null) return null;
  const smsAccount = holder.mfaEnabled && holder.mfaMethod === 'sms';
  const phone =
    options.phone !== undefined
      ? options.phone
      : smsAccount || options.textAccountPhone === true
        ? holder.phone
        : null;
  const email = options.email !== undefined ? options.email : holder.email;
  return dispatchSystemNotification(
    client,
    eventType,
    {
      email: email ?? undefined,
      phone: phone ?? undefined,
      firstName: holder.firstName ?? undefined,
      lastName: holder.lastName ?? undefined,
      language: holder.language ?? undefined,
      timezone: holder.timezone ?? undefined,
    },
    { isDriver: 'driverId' in account, ...variables },
    ALL_TEMPLATES_DIRS,
  );
}

/**
 * `notifySecurityChange` without waiting: the change already happened, so a
 * failed notice is logged at warn and nothing else (fail-open).
 */
export function sendSecurityNotice(
  account: MfaAccount,
  eventType: SecurityNoticeEventType,
  variables: Record<string, unknown>,
  log: Logger,
  options: SecurityNoticeOptions = {},
): void {
  void notifySecurityChange(account, eventType, variables, options).catch((err: unknown) => {
    log.warn({ err, account, eventType }, 'Security notice failed, the change stands');
  });
}

/** The factor flags of `security.FactorAdded` for an MFA method or a passkey. */
export function factorFlags(factor: string): Record<string, boolean> {
  return {
    factorPasskey: factor === 'passkey',
    factorTotp: factor === 'totp',
    factorSms: factor === 'sms',
    factorEmail: factor === 'email',
  };
}
